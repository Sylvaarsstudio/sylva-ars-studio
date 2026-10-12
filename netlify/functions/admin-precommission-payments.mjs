import { getDatabase } from "@netlify/database";

import { hasValidAdminSession } from "../shared/admin-session.mjs";
import { activateCommissionFromRequiredDeposit } from "../shared/commission-activation.mjs";
import { createGmailEmailProvider } from "../shared/email-provider.mjs";
import {
  deliverPrecommissionReceiptCommunication,
  recordPrecommissionDepositPayment
} from "../shared/precommission-payment.mjs";

const API_PATH = "/admin/api/payments/precommission-deposit";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const idPattern = /^[1-9][0-9]*$/;
const allowedPaymentMethods = new Set([
  "cash", "card", "bank_transfer", "check", "zelle", "paypal"
]);
const inputFields = new Set([
  "obligation_id", "request_id", "amount", "payment_method",
  "payment_date", "external_reference", "notes"
]);

function jsonResponse(status, body) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function readEnvironmentVariable(name) {
  return globalThis.Netlify?.env?.get
    ? globalThis.Netlify.env.get(name)
    : process.env[name];
}

async function parseJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function optionalText(value) {
  if (value === undefined || value === null) return { value: null };
  if (typeof value !== "string") return { error: "Optional text fields must be strings." };
  return { value: value.trim() || null };
}

function normalizeMoney(value) {
  if (value === undefined || value === null || value === "") return { value: null };
  const normalized = typeof value === "string" ? value.trim() : String(value);
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    return { error: "Amount must be a valid positive monetary amount." };
  }
  const [whole, fraction = ""] = normalized.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    return { error: "Amount must be a valid positive monetary amount." };
  }
  return { value: `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}` };
}

function normalizeDate(value) {
  if (value === undefined || value === null || value === "") return { value: null };
  if (typeof value !== "string") return { error: "Payment date must be a valid date." };
  const normalized = value.trim();
  const date = new Date(`${normalized}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(normalized)
    || Number.isNaN(date.getTime())
    || date.toISOString().slice(0, 10) !== normalized
  ) return { error: "Payment date must be a valid date." };
  return { value: normalized };
}

function normalizePrecommissionPaymentCreate(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { error: "Request body must be a JSON object." };
  }
  if (Object.keys(data).some((field) => !inputFields.has(field))) {
    return { error: "Request body contains unsupported fields." };
  }
  const obligationId = String(data.obligation_id ?? "").trim();
  if (!idPattern.test(obligationId)) return { error: "Obligation id is invalid." };
  if (typeof data.request_id !== "string" || !uuidPattern.test(data.request_id.trim())) {
    return { error: "Request id must be a valid UUID." };
  }
  if (typeof data.payment_method !== "string" || !allowedPaymentMethods.has(data.payment_method.trim())) {
    return { error: "Payment method is unsupported." };
  }
  const amount = normalizeMoney(data.amount);
  const paymentDate = normalizeDate(data.payment_date);
  const externalReference = optionalText(data.external_reference);
  const notes = optionalText(data.notes);
  const failure = [amount, paymentDate, externalReference, notes].find((item) => item.error);
  if (failure) return { error: failure.error };
  return {
    payment: {
      obligation_id: obligationId,
      request_id: data.request_id.trim().toLowerCase(),
      amount: amount.value,
      payment_method: data.payment_method.trim(),
      payment_date: paymentDate.value,
      external_reference: externalReference.value,
      notes: notes.value
    }
  };
}

function logFailure(error, obligationId = null) {
  console.error("Pre-Commission deposit payment request failed.", {
    obligation_id: obligationId,
    error_type: error?.name || "Error",
    error_code: error?.code || "unknown"
  });
}

function createHandler({
  databaseFactory = getDatabase,
  environmentReader = readEnvironmentVariable,
  emailProvider = null,
  providerFetch = globalThis.fetch?.bind(globalThis),
  now = () => new Date(),
  activationHandler = activateCommissionFromRequiredDeposit,
  activationOptions = {},
  errorReporter = logFailure
} = {}) {
  const sendingProvider = emailProvider || createGmailEmailProvider({
    environmentReader,
    fetchImplementation: providerFetch,
    now
  });
  return async function handler(request) {
    const adminPassword = environmentReader("ADMIN_PASSWORD");
    const sessionSecret = environmentReader("ADMIN_SESSION_SECRET") || adminPassword;
    if (!adminPassword) {
      return jsonResponse(500, { success: false, message: "Admin authentication is not configured." });
    }
    if (!(await hasValidAdminSession(request, adminPassword, sessionSecret))) {
      return jsonResponse(401, { success: false, message: "Unauthorized." });
    }
    if (new URL(request.url).pathname !== API_PATH) {
      return jsonResponse(404, { success: false, message: "Admin endpoint not found." });
    }
    if (request.method !== "POST") {
      return jsonResponse(405, { success: false, message: "Method not allowed. Use POST." });
    }

    const normalized = normalizePrecommissionPaymentCreate(await parseJsonBody(request));
    if (normalized.error) {
      return jsonResponse(400, { success: false, message: normalized.error });
    }

    try {
      const database = databaseFactory();
      const result = await recordPrecommissionDepositPayment(
        database,
        normalized.payment,
        {
          now,
          onRequiredDepositSatisfied: (context) => activationHandler(context, activationOptions)
        }
      );
      const statuses = {
        obligation_not_found: 404,
        quotation_expired_for_deposit: 409,
        obligation_not_open: 409,
        request_id_conflict: 409,
        amount_mismatch: 422,
        obligation_context_mismatch: 422
      };
      if (result.outcome !== "success") {
        return jsonResponse(statuses[result.outcome] || 422, {
          success: false,
          code: result.outcome,
          message: result.outcome === "amount_mismatch"
            ? "Payment amount must equal the full required deposit."
            : "The required deposit payment could not be recorded."
        });
      }

      await deliverPrecommissionReceiptCommunication(
        database,
        result.communication_id,
        sendingProvider,
        now
      );

      return jsonResponse(result.created ? 201 : 200, {
        success: true,
        created: result.created,
        payment: result.payment,
        allocation: result.allocation,
        obligation: result.obligation,
        receipt: result.receipt,
        commission: result.commission
      });
    } catch (error) {
      errorReporter(error, normalized.payment.obligation_id);
      return jsonResponse(500, { success: false, message: "Unable to record required deposit payment." });
    }
  };
}

export const config = { path: API_PATH };

export {
  API_PATH,
  allowedPaymentMethods,
  createHandler,
  normalizePrecommissionPaymentCreate
};

export default createHandler();
