import { getDatabase } from "@netlify/database";

import { hasValidAdminSession } from "../shared/admin-session.mjs";
import { attemptAutomaticCommunicationSend } from "../shared/communication-automations.mjs";
import { getCommunicationAutomationRule } from "../shared/communication-automation-policy.mjs";
import { getCommunicationTemplate, renderCommunicationTemplate } from "../shared/communication-templates.mjs";
import { createGmailEmailProvider } from "../shared/email-provider.mjs";
import { hashQuotationSnapshot } from "../shared/quotation-snapshot.mjs";
import { isQuotationExpired } from "../shared/quotation-state.mjs";

const idPattern = /^[1-9][0-9]*$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const allowedFields = new Set([
  "request_id", "acceptance_method", "client_name_entered",
  "client_email", "accepted_by_client_confirmation"
]);

function jsonResponse(status, body) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function readEnvironmentVariable(name) {
  return globalThis.Netlify?.env?.get?.(name) ?? process.env[name];
}

function parseRoute(pathname) {
  const path = pathname.replace(/\/+$/, "") || "/";
  let match = path.match(/^\/admin\/api\/quotations\/([^/]+)\/(acceptance|accept)$/);
  if (match) return { kind: match[2], id: decodeURIComponent(match[1]) };
  match = path.match(/^\/admin\/api\/acceptances\/([^/]+)$/);
  if (match) return { kind: "acceptance_record", id: decodeURIComponent(match[1]) };
  return null;
}

function normalizeIdentity(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function normalizeEmail(value) {
  return normalizeIdentity(value).toLowerCase();
}

function normalizeAcceptance(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { error: "Request body must be a JSON object." };
  }
  if (Object.keys(data).some((key) => !allowedFields.has(key))) {
    return { error: "Request body contains unsupported fields." };
  }
  if (!uuidPattern.test(String(data.request_id || ""))) {
    return { error: "Request id must be a valid UUID." };
  }
  if (data.acceptance_method !== "admin_recorded") {
    return { error: "Acceptance method must be admin_recorded." };
  }
  if (data.accepted_by_client_confirmation !== true) {
    return { error: "Written client acceptance confirmation is required." };
  }
  const name = normalizeIdentity(data.client_name_entered);
  const email = normalizeEmail(data.client_email);
  if (!name || !email || !email.includes("@")) {
    return { error: "Client name and email are required." };
  }
  return {
    value: {
      request_id: data.request_id,
      acceptance_method: data.acceptance_method,
      client_name_entered: name,
      client_email: email
    }
  };
}

const acceptanceSelect = `
  a.id, a.acceptance_type, a.quotation_id, a.document_id,
  a.commission_id, a.client_id, a.client_name_entered, a.client_email,
  a.accepted, a.accepted_at, a.acceptance_method,
  a.subject_number, a.subject_version, a.snapshot_hash,
  a.terms_version, a.request_id, a.created_at`;

async function getQuotationAcceptance(queryable, quotationId) {
  const result = await queryable.query(
    `SELECT ${acceptanceSelect}
     FROM acceptances a
     WHERE a.acceptance_type = 'quotation'
       AND a.quotation_id = $1
       AND a.accepted = TRUE
     LIMIT 1`,
    [quotationId]
  );
  return result.rows[0] || null;
}

async function getAcceptance(queryable, id) {
  const result = await queryable.query(
    `SELECT ${acceptanceSelect} FROM acceptances a WHERE a.id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

function prepareQuotationAcceptanceAutomation(quotation) {
  const policy = getCommunicationAutomationRule("quotation_acceptance_confirmation");
  const template = getCommunicationTemplate(policy?.template_key);
  const snapshot = quotation.quotation_snapshot;
  const rendered = renderCommunicationTemplate(template, {
    client_name: snapshot?.client?.full_name,
    quotation_number: snapshot?.quotation_number,
    quotation_version: snapshot?.version,
    commission_title: snapshot?.artwork?.title || snapshot?.commission?.title
  });
  if (
    !policy?.enabled
    || policy.mode !== "auto_send"
    || !template
    || rendered.error
    || !snapshot?.client?.email
  ) {
    throw new Error("Quotation acceptance confirmation automation context is incomplete.");
  }
  return {
    policy,
    recipient: snapshot.client.email,
    rendered,
    template
  };
}

async function recordQuotationAcceptance(db, quotationId, input, now = () => new Date()) {
  const connection = await db.pool.connect();
  try {
    await connection.query("BEGIN");
    await connection.query(
      "SELECT pg_advisory_xact_lock(hashtext('sylva-quotation-acceptance'), hashtext($1::text))",
      [quotationId]
    );
    await connection.query(
      "SELECT pg_advisory_xact_lock(hashtext('sylva-acceptance-request'), hashtext($1::text))",
      [input.request_id]
    );

    const existingRequest = await connection.query(
      "SELECT id, quotation_id, acceptance_type FROM acceptances WHERE request_id = $1",
      [input.request_id]
    );
    if (existingRequest.rows[0]) {
      const existing = existingRequest.rows[0];
      if (existing.acceptance_type !== "quotation" || String(existing.quotation_id) !== String(quotationId)) {
        await connection.query("ROLLBACK");
        return { outcome: "request_conflict" };
      }
      const acceptance = await getAcceptance(connection, existing.id);
      const communication = (await connection.query(
        "SELECT id FROM communications WHERE automation_source_key = $1",
        [`quotation-acceptance:${existing.id}`]
      )).rows[0] || null;
      await connection.query("COMMIT");
      return { outcome: "success", created: false, acceptance, communication_id: communication?.id || null };
    }

    const quotationResult = await connection.query(
      `SELECT q.*, cl.full_name AS client_name, cl.email AS client_email
       FROM quotations q
       JOIN clients cl ON cl.id = q.client_id
       WHERE q.id = $1
       FOR UPDATE OF q`,
      [quotationId]
    );
    const quotation = quotationResult.rows[0];
    if (!quotation) {
      await connection.query("ROLLBACK");
      return { outcome: "not_found" };
    }

    const existingAcceptance = await getQuotationAcceptance(connection, quotationId);
    if (existingAcceptance) {
      await connection.query("COMMIT");
      return existingAcceptance.request_id === input.request_id
        ? { outcome: "success", created: false, acceptance: existingAcceptance }
        : { outcome: "already_accepted", acceptance: existingAcceptance };
    }
    if (!["issued", "sent"].includes(quotation.quotation_status)) {
      await connection.query("ROLLBACK");
      return { outcome: "invalid_status" };
    }
    const acceptedAt = now();
    if (!quotation.expires_at || isQuotationExpired(quotation, acceptedAt)) {
      await connection.query("ROLLBACK");
      return { outcome: "expired" };
    }
    if (!quotation.quotation_snapshot || !quotation.snapshot_hash) {
      await connection.query("ROLLBACK");
      return { outcome: "missing_snapshot" };
    }
    if (hashQuotationSnapshot(quotation.quotation_snapshot) !== quotation.snapshot_hash) {
      await connection.query("ROLLBACK");
      return { outcome: "hash_mismatch" };
    }
    if (
      normalizeIdentity(input.client_name_entered).toLowerCase()
        !== normalizeIdentity(quotation.client_name).toLowerCase()
      || normalizeEmail(input.client_email) !== normalizeEmail(quotation.client_email)
    ) {
      await connection.query("ROLLBACK");
      return { outcome: "client_mismatch" };
    }

    const prepared = prepareQuotationAcceptanceAutomation(quotation);
    const mutation = await connection.query(
      `WITH operation_locks AS MATERIALIZED (
         SELECT
           pg_advisory_xact_lock(hashtext('sylva-quotation-acceptance'), hashtext($1::text)),
           pg_advisory_xact_lock(hashtext('sylva-acceptance-request'), hashtext($2::text))
       ),
       eligible_quotation AS MATERIALIZED (
         SELECT q.id, q.commission_id, q.client_id,
                q.quotation_number, q.version, q.snapshot_hash
         FROM quotations q
         CROSS JOIN operation_locks
         WHERE q.id = $1::bigint
           AND q.quotation_status IN ('issued', 'sent')
           AND q.expires_at > $6::timestamptz
           AND q.quotation_number = $7
           AND q.version = $8::integer
           AND q.snapshot_hash = $9
         FOR UPDATE OF q
       ),
       inserted_acceptance AS (
         INSERT INTO acceptances (
           acceptance_type, quotation_id, commission_id, client_id,
           client_name_entered, client_email, accepted, accepted_at,
           acceptance_method, subject_number, subject_version,
           snapshot_hash, terms_version, request_id
         )
         SELECT
           'quotation', q.id, q.commission_id, q.client_id,
           $4, $5, TRUE, $6::timestamptz,
           $3, q.quotation_number, q.version,
           q.snapshot_hash, NULL, $2::uuid
         FROM eligible_quotation q
         ON CONFLICT DO NOTHING
         RETURNING *
       ),
       updated_quotation AS (
         UPDATE quotations q
         SET quotation_status = 'accepted', accepted_at = $6::timestamptz
         FROM inserted_acceptance acceptance
         WHERE q.id = acceptance.quotation_id
         RETURNING q.id
       ),
       inserted_acceptance_event AS (
         INSERT INTO commission_events (
           commission_id, event_type, occurred_at, actor_type,
           source_type, source_id, payload, request_id
         )
         SELECT
           acceptance.commission_id, 'quotation_accepted', $6::timestamptz,
           'admin', 'acceptance', acceptance.id::text,
           jsonb_build_object(
             'acceptance_id', acceptance.id::text,
             'quotation_number', acceptance.subject_number,
             'version', acceptance.subject_version
           ),
           $2::uuid
         FROM inserted_acceptance acceptance
         WHERE acceptance.commission_id IS NOT NULL
         ON CONFLICT (request_id, event_type, source_type, source_id)
           WHERE request_id IS NOT NULL
             AND source_type IS NOT NULL
             AND source_id IS NOT NULL
         DO NOTHING
         RETURNING id
       ),
       inserted_communication AS (
         INSERT INTO communications (
           client_id, commission_id, quotation_id,
           channel, communication_type, communication_status,
           recipient, subject, body_snapshot, ready_at,
           template_key, template_version,
           automation_key, automation_mode, automation_source_key
         )
         SELECT
           acceptance.client_id, acceptance.commission_id, acceptance.quotation_id,
           $10, $11, 'ready', $12, $13, $14, $6::timestamptz,
           $15, $16, $17, 'auto_send',
           'quotation-acceptance:' || acceptance.id::text
         FROM inserted_acceptance acceptance
         RETURNING id, automation_key, template_key, template_version,
                   communication_type
       ),
       inserted_communication_event AS (
         INSERT INTO commission_events (
           commission_id, event_type, occurred_at, actor_type,
           source_type, source_id, payload
         )
         SELECT
           acceptance.commission_id,
           'communication_automation_created',
           $6::timestamptz,
           'system',
           'communication',
           communication.id::text,
           jsonb_build_object(
             'communication_id', communication.id::text,
             'automation_key', communication.automation_key,
             'template_key', communication.template_key,
             'template_version', communication.template_version,
             'communication_type', communication.communication_type
           )
         FROM inserted_acceptance acceptance
         CROSS JOIN inserted_communication communication
         WHERE acceptance.commission_id IS NOT NULL
         RETURNING id
       )
       SELECT row_to_json(acceptance) AS acceptance,
              communication.id AS communication_id
       FROM inserted_acceptance acceptance
       CROSS JOIN inserted_communication communication`,
      [
        quotation.id,
        input.request_id,
        input.acceptance_method,
        input.client_name_entered,
        input.client_email,
        acceptedAt,
        quotation.quotation_number,
        quotation.version,
        quotation.snapshot_hash,
        prepared.template.channel,
        prepared.template.communication_type,
        prepared.recipient,
        prepared.rendered.subject,
        prepared.rendered.body,
        prepared.template.key,
        prepared.template.version,
        prepared.policy.key
      ]
    );
    if (!mutation.rows[0]) {
      await connection.query("ROLLBACK");
      const existingByRequest = (await db.pool.query(
        "SELECT id, quotation_id, acceptance_type FROM acceptances WHERE request_id = $1",
        [input.request_id]
      )).rows[0];
      if (existingByRequest) {
        if (
          existingByRequest.acceptance_type !== "quotation"
          || String(existingByRequest.quotation_id) !== String(quotationId)
        ) return { outcome: "request_conflict" };
        const acceptance = await getAcceptance(db.pool, existingByRequest.id);
        const communication = (await db.pool.query(
          "SELECT id FROM communications WHERE automation_source_key = $1",
          [`quotation-acceptance:${existingByRequest.id}`]
        )).rows[0] || null;
        return {
          outcome: "success",
          created: false,
          acceptance,
          communication_id: communication?.id || null
        };
      }
      const accepted = await getQuotationAcceptance(db.pool, quotationId);
      if (accepted) return { outcome: "already_accepted", acceptance: accepted };
      return { outcome: "invalid_status" };
    }
    const acceptance = mutation.rows[0].acceptance;
    for (const field of ["id", "quotation_id", "document_id", "commission_id", "client_id"]) {
      if (acceptance[field] !== null && acceptance[field] !== undefined) {
        acceptance[field] = String(acceptance[field]);
      }
    }
    await connection.query("COMMIT");
    return {
      outcome: "success",
      created: true,
      acceptance,
      communication_id: mutation.rows[0].communication_id
    };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

function logFailure(action, error, details = {}) {
  console.error("Admin acceptance request failed.", {
    action, ...details, error_type: error?.name || "Error", error_code: error?.code || "unknown"
  });
}

function createHandler({
  databaseFactory = getDatabase,
  environmentReader = readEnvironmentVariable,
  now = () => new Date(),
  emailProvider = null,
  providerFetch = globalThis.fetch?.bind(globalThis)
} = {}) {
  const sendingProvider = emailProvider || createGmailEmailProvider({
    environmentReader,
    fetchImplementation: providerFetch,
    now
  });
  return async function handler(request) {
    const adminPassword = environmentReader("ADMIN_PASSWORD");
    const sessionSecret = environmentReader("ADMIN_SESSION_SECRET") || adminPassword;
    if (!adminPassword) return jsonResponse(500, { success: false, message: "Admin authentication is not configured." });
    if (!(await hasValidAdminSession(request, adminPassword, sessionSecret))) {
      return jsonResponse(401, { success: false, message: "Unauthorized." });
    }
    const route = parseRoute(new URL(request.url).pathname);
    if (!route) return jsonResponse(404, { success: false, message: "Admin endpoint not found." });
    if (!idPattern.test(route.id)) return jsonResponse(400, { success: false, message: "Invalid id." });
    const db = databaseFactory();
    try {
      if (route.kind === "acceptance" && request.method === "GET") {
        const quotationResult = await db.pool.query("SELECT id FROM quotations WHERE id = $1", [route.id]);
        if (!quotationResult.rows[0]) return jsonResponse(404, { success: false, message: "Quotation not found." });
        return jsonResponse(200, { success: true, acceptance: await getQuotationAcceptance(db.pool, route.id) });
      }
      if (route.kind === "accept" && request.method === "POST") {
        const normalized = normalizeAcceptance(await request.json().catch(() => null));
        if (normalized.error) return jsonResponse(400, { success: false, message: normalized.error });
        const result = await recordQuotationAcceptance(db, route.id, normalized.value, now);
        if (result.outcome === "not_found") return jsonResponse(404, { success: false, message: "Quotation not found." });
        if (result.outcome === "request_conflict") return jsonResponse(409, { success: false, message: "Request id is already used for another acceptance." });
        if (result.outcome === "already_accepted") return jsonResponse(409, { success: false, code: "quotation_already_accepted", message: "Quotation already has an effective acceptance.", acceptance: result.acceptance });
        if (result.outcome === "expired") return jsonResponse(409, { success: false, message: "Expired quotations cannot be accepted." });
        if (result.outcome === "hash_mismatch") return jsonResponse(409, { success: false, message: "Quotation snapshot integrity validation failed." });
        if (result.outcome === "client_mismatch") return jsonResponse(409, { success: false, message: "Entered client identity does not match this quotation." });
        if (result.outcome !== "success") return jsonResponse(409, { success: false, message: "Quotation is not eligible for acceptance." });
        await attemptAutomaticCommunicationSend(db, result.communication_id, sendingProvider, now);
        return jsonResponse(result.created ? 201 : 200, {
          success: true, created: result.created, acceptance: result.acceptance,
          quotation_status: "accepted"
        });
      }
      if (route.kind === "acceptance_record" && request.method === "GET") {
        const acceptance = await getAcceptance(db.pool, route.id);
        return acceptance
          ? jsonResponse(200, { success: true, acceptance })
          : jsonResponse(404, { success: false, message: "Acceptance not found." });
      }
      return jsonResponse(405, { success: false, message: "Method not allowed." });
    } catch (error) {
      logFailure(route.kind, error, { record_id: route.id });
      return jsonResponse(500, { success: false, message: "Unable to complete acceptance request." });
    }
  };
}

export const config = {
  path: [
    "/admin/api/quotations/:id/acceptance",
    "/admin/api/quotations/:id/accept",
    "/admin/api/acceptances/:id"
  ]
};

export {
  createHandler,
  getAcceptance,
  getQuotationAcceptance,
  normalizeAcceptance,
  parseRoute,
  recordQuotationAcceptance
};

export default createHandler();
