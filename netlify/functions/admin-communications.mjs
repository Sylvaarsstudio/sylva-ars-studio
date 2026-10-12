import { getDatabase } from "@netlify/database";

import { hasValidAdminSession } from "../shared/admin-session.mjs";
import { createGmailEmailProvider } from "../shared/email-provider.mjs";
import {
  communicationChannels,
  communicationStatuses,
  communicationTypes,
  createCommunication,
  getCommunication,
  listCommunications,
  markCommunicationReady,
  normalizeCommunicationInput,
  normalizeDraftUpdate,
  reconcileCommunication,
  resolveQueuedCommunicationManually,
  sendCommunication,
  updateDraftCommunication
} from "../shared/communications.mjs";
import {
  listCommunicationTemplates,
  normalizeTemplateRequest,
  resolveCommunicationTemplate
} from "../shared/communication-templates.mjs";

const API_PATH = "/admin/api/communications";
const idPattern = /^[1-9][0-9]*$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function jsonResponse(status, body) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function readEnvironmentVariable(name) {
  if (globalThis.Netlify?.env?.get) return globalThis.Netlify.env.get(name);
  return process.env[name];
}

async function parseJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function parseRoute(pathname) {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  if (normalized === API_PATH) return { action: "collection" };
  if (normalized === `${API_PATH}/manual`) return { action: "manual" };
  if (normalized === `${API_PATH}/templates`) return { action: "templates" };
  if (normalized === `${API_PATH}/template-preview`) return { action: "template_preview" };
  if (normalized === `${API_PATH}/from-template`) return { action: "from_template" };
  const readyMatch = normalized.match(/^\/admin\/api\/communications\/([^/]+)\/ready$/);
  if (readyMatch) {
    try {
      return { action: "ready", id: decodeURIComponent(readyMatch[1]) };
    } catch {
      return null;
    }
  }
  const sendMatch = normalized.match(/^\/admin\/api\/communications\/([^/]+)\/send$/);
  if (sendMatch) {
    try {
      return { action: "send", id: decodeURIComponent(sendMatch[1]) };
    } catch {
      return null;
    }
  }
  const manualReconciliationMatch = normalized.match(/^\/admin\/api\/communications\/([^/]+)\/reconcile\/(manual-sent|manual-failed)$/);
  if (manualReconciliationMatch) {
    try {
      return {
        action: manualReconciliationMatch[2] === "manual-sent" ? "reconcile_manual_sent" : "reconcile_manual_failed",
        id: decodeURIComponent(manualReconciliationMatch[1])
      };
    } catch {
      return null;
    }
  }
  const reconcileMatch = normalized.match(/^\/admin\/api\/communications\/([^/]+)\/reconcile$/);
  if (reconcileMatch) {
    try {
      return { action: "reconcile", id: decodeURIComponent(reconcileMatch[1]) };
    } catch {
      return null;
    }
  }
  const match = normalized.match(/^\/admin\/api\/communications\/([^/]+)$/);
  if (!match) return null;
  try {
    return { action: "detail", id: decodeURIComponent(match[1]) };
  } catch {
    return null;
  }
}

function normalizeFilters(url) {
  const filters = {
    commission_id: url.searchParams.get("commission_id") || null,
    client_id: url.searchParams.get("client_id") || null,
    inquiry_id: url.searchParams.get("inquiry_id") || null,
    status: url.searchParams.get("status") || null,
    type: url.searchParams.get("type") || null,
    channel: url.searchParams.get("channel") || null
  };
  if (filters.commission_id && !idPattern.test(filters.commission_id)) return { error: "Invalid commission_id." };
  if (filters.client_id && !idPattern.test(filters.client_id)) return { error: "Invalid client_id." };
  if (filters.inquiry_id && !uuidPattern.test(filters.inquiry_id)) return { error: "Invalid inquiry_id." };
  if (filters.status && !communicationStatuses.includes(filters.status)) return { error: "Invalid status filter." };
  if (filters.type && !communicationTypes.includes(filters.type)) return { error: "Invalid type filter." };
  if (filters.channel && !communicationChannels.includes(filters.channel)) return { error: "Invalid channel filter." };
  return { filters };
}

function logFailure(action, error, details = {}) {
  console.error("Admin communication request failed.", {
    action,
    ...details,
    error_type: error?.name || "Error",
    error_code: error?.code || "unknown"
  });
}

function createHandler({
  databaseFactory = getDatabase,
  environmentReader = readEnvironmentVariable,
  emailProvider = null,
  providerFetch = globalThis.fetch?.bind(globalThis),
  providerTimeoutMs = 9000,
  clock = () => new Date()
} = {}) {
  const sendingProvider = emailProvider || createGmailEmailProvider({
    environmentReader,
    fetchImplementation: providerFetch,
    timeoutMs: providerTimeoutMs,
    now: clock
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

    const url = new URL(request.url);
    const route = parseRoute(url.pathname);
    if (!route) return jsonResponse(404, { success: false, message: "Admin endpoint not found." });

    try {
      if (route.action === "templates") {
        if (request.method !== "GET") {
          return jsonResponse(405, { success: false, message: "Method not allowed. Use GET." });
        }
        return jsonResponse(200, { success: true, templates: listCommunicationTemplates() });
      }

      if (route.action === "template_preview" || route.action === "from_template") {
        if (request.method !== "POST") {
          return jsonResponse(405, { success: false, message: "Method not allowed. Use POST." });
        }
        const normalized = normalizeTemplateRequest(await parseJsonBody(request), {
          requestId: route.action === "from_template"
        });
        if (normalized.error) return jsonResponse(400, { success: false, message: normalized.error });
        const resolved = await resolveCommunicationTemplate(databaseFactory(), normalized.request);
        if (resolved.outcome === "unknown_template") {
          return jsonResponse(404, { success: false, code: "unknown_template", message: "Communication template not found." });
        }
        if (resolved.outcome === "template_context_incomplete") {
          const body = {
            success: route.action === "template_preview",
            complete: false,
            code: "template_context_incomplete",
            template: resolved.template?.key || normalized.request.template_key,
            version: resolved.template?.version || null,
            recipient: null,
            subject: null,
            body: null,
            missing_context: resolved.missing_context || []
          };
          return jsonResponse(route.action === "template_preview" ? 200 : 422, body);
        }

        if (route.action === "template_preview") {
          return jsonResponse(200, {
            success: true,
            complete: true,
            template: resolved.template.key,
            version: resolved.template.version,
            recipient: resolved.recipient,
            subject: resolved.subject,
            body: resolved.body,
            missing_context: []
          });
        }

        const result = await createCommunication(databaseFactory(), {
          ...resolved.relationships,
          channel: resolved.template.channel,
          communication_type: resolved.template.communication_type,
          recipient: resolved.recipient,
          subject: resolved.subject,
          body_snapshot: resolved.body,
          request_id: normalized.request.request_id,
          template_key: resolved.template.key,
          template_version: resolved.template.version
        }, { templateGenerated: true });
        if (result.outcome === "invalid_relationship") {
          return jsonResponse(400, { success: false, message: result.message });
        }
        if (result.outcome === "request_conflict") {
          return jsonResponse(409, { success: false, message: "request_id was already used for different content." });
        }
        return jsonResponse(result.created ? 201 : 200, {
          success: true, created: result.created, communication: result.communication
        });
      }

      if (route.action === "ready") {
        if (!idPattern.test(route.id)) {
          return jsonResponse(400, { success: false, message: "Invalid communication id." });
        }
        if (request.method !== "POST") {
          return jsonResponse(405, { success: false, message: "Method not allowed. Use POST." });
        }
        const result = await markCommunicationReady(databaseFactory(), route.id);
        if (result.outcome === "not_found") {
          return jsonResponse(404, { success: false, message: "Communication not found." });
        }
        if (result.outcome === "invalid_status") {
          return jsonResponse(409, { success: false, message: "Only draft communications may be marked ready." });
        }
        if (result.outcome === "invalid_content") {
          return jsonResponse(400, { success: false, message: result.message });
        }
        return jsonResponse(200, {
          success: true, changed: result.changed, communication: result.communication
        });
      }

      if (route.action === "send") {
        if (!idPattern.test(route.id)) {
          return jsonResponse(400, { success: false, message: "Invalid communication id." });
        }
        if (request.method !== "POST") {
          return jsonResponse(405, { success: false, message: "Method not allowed. Use POST." });
        }
        const result = await sendCommunication(databaseFactory(), route.id, sendingProvider, clock);
        if (result.outcome === "not_found") {
          return jsonResponse(404, { success: false, message: "Communication not found." });
        }
        if (result.outcome === "invalid_channel") {
          return jsonResponse(409, { success: false, code: "invalid_channel", message: "Manual communications do not use the email sending engine." });
        }
        if (result.outcome === "invalid_status") {
          return jsonResponse(409, { success: false, code: "not_ready", message: "Only ready communications may be sent." });
        }
        if (result.outcome === "invalid_content") {
          return jsonResponse(400, { success: false, code: "invalid_reviewed_content", message: "Reviewed email content is incomplete." });
        }
        if (result.outcome === "in_progress") {
          return jsonResponse(409, { success: false, code: "send_in_progress", message: "This communication is already being processed." });
        }
        if (result.outcome === "failed_terminal") {
          return jsonResponse(409, { success: false, code: result.error_code || "send_failed", message: "This communication previously failed. Create a new Draft to try again." });
        }
        if (result.outcome === "provider_not_configured") {
          return jsonResponse(503, { success: false, code: "provider_not_configured", message: "Email sending is not configured." });
        }
        if (result.outcome === "provider_failed") {
          const status = result.error_code === "send_timeout"
            ? 504
            : ["provider_rate_limit", "provider_unavailable"].includes(result.error_code) ? 503 : 502;
          return jsonResponse(status, {
            success: false,
            code: result.error_code,
            message: "The email provider did not accept this communication. Create a new Draft before trying again."
          });
        }
        return jsonResponse(200, {
          success: true,
          changed: result.changed,
          communication: result.communication,
          provider: result.provider || null
        });
      }

      if (route.action === "reconcile") {
        if (!idPattern.test(route.id)) {
          return jsonResponse(400, { success: false, message: "Invalid communication id." });
        }
        if (request.method !== "POST") {
          return jsonResponse(405, { success: false, message: "Method not allowed. Use POST." });
        }
        const result = await reconcileCommunication(databaseFactory(), route.id, sendingProvider, clock);
        if (result.outcome === "not_found") {
          return jsonResponse(404, { success: false, message: "Communication not found." });
        }
        if (result.outcome === "invalid_status") {
          return jsonResponse(409, { success: false, code: "reconciliation_not_allowed", message: "Only queued communications may be reconciled." });
        }
        if (result.outcome === "not_stale") {
          return jsonResponse(409, { success: false, code: "queued_not_stale", message: "This communication is still within the normal sending window." });
        }
        if (result.outcome === "in_progress") {
          return jsonResponse(409, { success: false, code: "reconciliation_in_progress", message: "Reconciliation is already in progress." });
        }
        return jsonResponse(200, {
          success: true,
          changed: result.changed,
          result: result.result,
          communication: result.communication
        });
      }

      if (route.action === "reconcile_manual_sent" || route.action === "reconcile_manual_failed") {
        if (!idPattern.test(route.id)) {
          return jsonResponse(400, { success: false, message: "Invalid communication id." });
        }
        if (request.method !== "POST") {
          return jsonResponse(405, { success: false, message: "Method not allowed. Use POST." });
        }
        const body = await parseJsonBody(request);
        const resolution = route.action === "reconcile_manual_sent" ? "sent" : "failed";
        const result = await resolveQueuedCommunicationManually(
          databaseFactory(), route.id, resolution, body?.confirmation, clock
        );
        if (result.outcome === "confirmation_required") {
          return jsonResponse(400, { success: false, code: "confirmation_required", message: "The exact reconciliation confirmation is required." });
        }
        if (result.outcome === "not_found") {
          return jsonResponse(404, { success: false, message: "Communication not found." });
        }
        if (result.outcome === "not_eligible") {
          return jsonResponse(409, { success: false, code: "manual_reconciliation_not_allowed", message: "Manual resolution requires a stale queued communication with an inconclusive reconciliation." });
        }
        return jsonResponse(200, {
          success: true,
          result: result.result,
          communication: result.communication
        });
      }

      if (route.action === "collection") {
        if (request.method === "GET") {
          const normalized = normalizeFilters(url);
          if (normalized.error) return jsonResponse(400, { success: false, message: normalized.error });
          const communications = await listCommunications(databaseFactory(), normalized.filters, clock());
          return jsonResponse(200, {
            success: true,
            total: communications.length,
            communications,
            email_provider_configured: sendingProvider.configured === true
          });
        }
        if (request.method === "POST") {
          const normalized = normalizeCommunicationInput(await parseJsonBody(request));
          if (normalized.error) return jsonResponse(400, { success: false, message: normalized.error });
          const result = await createCommunication(databaseFactory(), normalized.communication);
          if (result.outcome === "invalid_relationship") {
            return jsonResponse(400, { success: false, message: result.message });
          }
          if (result.outcome === "request_conflict") {
            return jsonResponse(409, { success: false, message: "request_id was already used for different content." });
          }
          return jsonResponse(result.created ? 201 : 200, { success: true, created: result.created, communication: result.communication });
        }
        return jsonResponse(405, { success: false, message: "Method not allowed. Use GET or POST." });
      }

      if (route.action === "manual") {
        if (request.method !== "POST") {
          return jsonResponse(405, { success: false, message: "Method not allowed. Use POST." });
        }
        const normalized = normalizeCommunicationInput(await parseJsonBody(request), { manual: true });
        if (normalized.error) return jsonResponse(400, { success: false, message: normalized.error });
        const result = await createCommunication(databaseFactory(), normalized.communication, { manual: true });
        if (result.outcome === "invalid_relationship") {
          return jsonResponse(400, { success: false, message: result.message });
        }
        if (result.outcome === "request_conflict") {
          return jsonResponse(409, { success: false, message: "request_id was already used for different content." });
        }
        return jsonResponse(result.created ? 201 : 200, { success: true, created: result.created, communication: result.communication });
      }

      if (!idPattern.test(route.id)) {
        return jsonResponse(400, { success: false, message: "Invalid communication id." });
      }
      if (request.method === "GET") {
        const communication = await getCommunication(databaseFactory(), route.id, clock());
        return communication
          ? jsonResponse(200, {
            success: true,
            communication,
            email_provider_configured: sendingProvider.configured === true
          })
          : jsonResponse(404, { success: false, message: "Communication not found." });
      }
      if (request.method === "PATCH") {
        const normalized = normalizeDraftUpdate(await parseJsonBody(request));
        if (normalized.error) return jsonResponse(400, { success: false, message: normalized.error });
        const result = await updateDraftCommunication(databaseFactory(), route.id, normalized.update);
        if (result.outcome === "not_found") return jsonResponse(404, { success: false, message: "Communication not found." });
        if (result.outcome === "not_editable") return jsonResponse(409, { success: false, message: "Only draft communications may be edited." });
        if (result.outcome === "invalid_content") return jsonResponse(400, { success: false, message: result.message });
        return jsonResponse(200, { success: true, communication: result.communication });
      }
      return jsonResponse(405, { success: false, message: "Method not allowed. Use GET or PATCH." });
    } catch (error) {
      logFailure(route.action, error, route.id ? { communication_id: route.id } : {});
      return jsonResponse(500, { success: false, message: "Unable to process the communication request." });
    }
  };
}

export const config = {
  path: [
    "/admin/api/communications",
    "/admin/api/communications/manual",
    "/admin/api/communications/templates",
    "/admin/api/communications/template-preview",
    "/admin/api/communications/from-template",
    "/admin/api/communications/:id/ready",
    "/admin/api/communications/:id/send",
    "/admin/api/communications/:id/reconcile",
    "/admin/api/communications/:id/reconcile/manual-sent",
    "/admin/api/communications/:id/reconcile/manual-failed",
    "/admin/api/communications/:id"
  ]
};

export { API_PATH, createHandler, normalizeFilters, parseRoute };
export default createHandler();
