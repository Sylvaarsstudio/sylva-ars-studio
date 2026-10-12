import { getDatabase } from "@netlify/database";

import { hasValidAdminSession } from "../shared/admin-session.mjs";
import {
  addCalendarDays,
  buildCommissionTimeline,
  loadCommissionCalendarContext,
  parseCalendarBoundary,
  readCalendarEntries
} from "../shared/commission-calendar.mjs";

const CALENDAR_API_PATH = "/admin/api/calendar";
const commissionTimelinePattern = /^\/admin\/api\/commissions\/([^/]+)\/timeline\/?$/;
const commissionIdPattern = /^[1-9][0-9]*$/;
const maximumRangeDays = 370;

function jsonResponse(status, body) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}

function readEnvironmentVariable(name) {
  if (globalThis.Netlify?.env?.get) return globalThis.Netlify.env.get(name);
  return process.env[name];
}

function getCommissionTimelineId(pathname) {
  const match = pathname.match(commissionTimelinePattern);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

function normalizeCalendarRange(searchParams, now = new Date()) {
  const fromValue = searchParams.get("from");
  const toValue = searchParams.get("to");
  const from = fromValue
    ? parseCalendarBoundary(fromValue)
    : addCalendarDays(now, -30);
  const to = toValue
    ? parseCalendarBoundary(toValue, { endOfDay: /^\d{4}-\d{2}-\d{2}$/.test(toValue) })
    : addCalendarDays(now, 30);
  if (!from || !to) return { error: "from and to must be valid ISO dates or date-times." };
  if (from.getTime() > to.getTime()) return { error: "from must be before or equal to to." };
  if (to.getTime() - from.getTime() > maximumRangeDays * 86400000) {
    return { error: `Calendar range cannot exceed ${maximumRangeDays} days.` };
  }
  return { from, to };
}

function logFailure(action, error, details = {}) {
  console.error("Admin calendar request failed.", {
    action,
    ...details,
    error_type: error?.name || "Error",
    error_code: error?.code || "unknown"
  });
}

function createHandler({
  databaseFactory = getDatabase,
  environmentReader = readEnvironmentVariable,
  now = () => new Date()
} = {}) {
  return async function handler(request) {
    const adminPassword = environmentReader("ADMIN_PASSWORD");
    const sessionSecret = environmentReader("ADMIN_SESSION_SECRET") || adminPassword;
    if (!adminPassword) {
      return jsonResponse(500, { success: false, message: "Admin authentication is not configured." });
    }
    if (!(await hasValidAdminSession(request, adminPassword, sessionSecret))) {
      return jsonResponse(401, { success: false, message: "Unauthorized." });
    }
    if (request.method !== "GET") {
      return jsonResponse(405, { success: false, message: "Method not allowed. Use GET." });
    }

    const url = new URL(request.url);
    const timelineId = getCommissionTimelineId(url.pathname);
    const requestNow = now();

    if (timelineId !== null) {
      if (timelineId === undefined || !commissionIdPattern.test(timelineId)) {
        return jsonResponse(400, { success: false, message: "Invalid commission id." });
      }
      try {
        const context = await loadCommissionCalendarContext(databaseFactory(), timelineId);
        if (!context) {
          return jsonResponse(404, { success: false, message: "Commission not found." });
        }
        const entries = buildCommissionTimeline(context, { now: requestNow });
        return jsonResponse(200, {
          success: true,
          commission: {
            id: String(context.commission.id),
            commission_number: context.commission.commission_number,
            title: context.commission.title
          },
          total: entries.length,
          entries
        });
      } catch (error) {
        logFailure("commission_timeline", error, { commission_id: timelineId });
        return jsonResponse(500, { success: false, message: "Unable to load the commission timeline." });
      }
    }

    if (url.pathname.replace(/\/+$/, "") !== CALENDAR_API_PATH) {
      return jsonResponse(404, { success: false, message: "Not found." });
    }
    const range = normalizeCalendarRange(url.searchParams, requestNow);
    if (range.error) return jsonResponse(400, { success: false, message: range.error });
    try {
      const entries = await readCalendarEntries(databaseFactory(), {
        ...range,
        now: requestNow
      });
      return jsonResponse(200, {
        success: true,
        range: {
          from: range.from.toISOString(),
          to: range.to.toISOString()
        },
        total: entries.length,
        entries
      });
    } catch (error) {
      logFailure("calendar", error);
      return jsonResponse(500, { success: false, message: "Unable to load the calendar." });
    }
  };
}

export const config = {
  path: [
    "/admin/api/calendar",
    "/admin/api/commissions/:id/timeline"
  ]
};

export {
  CALENDAR_API_PATH,
  createHandler,
  getCommissionTimelineId,
  maximumRangeDays,
  normalizeCalendarRange
};

export default createHandler();
