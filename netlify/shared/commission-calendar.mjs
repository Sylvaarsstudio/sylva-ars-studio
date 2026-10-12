const calendarTimeZone = "America/New_York";
const calendarDomains = Object.freeze([
  "commission", "quotation", "production", "financial", "delivery"
]);
const deadlineTypes = new Set([
  "obligation_due", "estimated_completion", "pickup_scheduled"
]);

const entryDefinitions = Object.freeze({
  commission_created: ["commission", "Commission created"],
  quotation_issued: ["quotation", "Quotation issued"],
  quotation_expires: ["quotation", "Quotation expires"],
  quotation_accepted: ["quotation", "Quotation accepted"],
  production_reserved: ["production", "Production reserved"],
  production_started: ["production", "Production started"],
  estimated_completion: ["production", "Estimated completion"],
  final_presented: ["production", "Final presented"],
  inspection_window_ends: ["production", "Inspection window ends"],
  production_completed: ["production", "Production completed"],
  obligation_due: ["financial", "Financial obligation due"],
  delivery_ready: ["delivery", "Artwork ready for delivery"],
  pickup_scheduled: ["delivery", "Pickup scheduled"],
  shipped: ["delivery", "Artwork shipped"],
  delivered: ["delivery", "Artwork delivered"],
  picked_up: ["delivery", "Artwork picked up"],
  free_storage_ends: ["delivery", "Free storage ends"],
  storage_fee_begins: ["delivery", "Storage fees begin"],
  final_notice: ["delivery", "Final written notice recorded"],
  abandonment_review_eligible: ["delivery", "Abandonment review eligible"]
});

const eventFallbackTypes = Object.freeze({
  quotation_issued: "quotation_issued",
  quotation_accepted: "quotation_accepted",
  production_reserved: "production_reserved",
  production_started: "production_started",
  production_final_presented: "final_presented",
  production_completed: "production_completed",
  delivery_ready: "delivery_ready",
  delivery_shipped: "shipped",
  delivery_delivered: "delivered",
  delivery_picked_up: "picked_up"
});

function getTimeZoneParts(date, timeZone = calendarTimeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  return Object.fromEntries(
    parts.filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );
}

function getTimeZoneOffset(date, timeZone = calendarTimeZone) {
  const parts = getTimeZoneParts(date, timeZone);
  return Date.UTC(
    parts.year, parts.month - 1, parts.day,
    parts.hour, parts.minute, parts.second
  ) - Math.floor(date.getTime() / 1000) * 1000;
}

function fromTimeZoneParts(parts, timeZone = calendarTimeZone) {
  const wallClock = new Date(Date.UTC(
    parts.year, parts.month - 1, parts.day,
    parts.hour || 0, parts.minute || 0, parts.second || 0,
    parts.millisecond || 0
  ));
  let result = new Date(wallClock.getTime() - getTimeZoneOffset(wallClock, timeZone));
  result = new Date(wallClock.getTime() - getTimeZoneOffset(result, timeZone));
  return result;
}

function addCalendarDays(value, days, timeZone = calendarTimeZone) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = getTimeZoneParts(date, timeZone);
  const target = new Date(Date.UTC(
    parts.year, parts.month - 1, parts.day + days,
    parts.hour, parts.minute, parts.second,
    date.getUTCMilliseconds()
  ));
  return fromTimeZoneParts({
    year: target.getUTCFullYear(),
    month: target.getUTCMonth() + 1,
    day: target.getUTCDate(),
    hour: target.getUTCHours(),
    minute: target.getUTCMinutes(),
    second: target.getUTCSeconds(),
    millisecond: target.getUTCMilliseconds()
  }, timeZone);
}

function normalizeDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeAllDayDate(value) {
  const datePart = value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value || "").slice(0, 10);
  const match = datePart.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return fromTimeZoneParts({
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3])
  });
}

function parseCalendarBoundary(value, { endOfDay = false } = {}) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const normalized = String(value).trim();
  const dateOnly = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const start = fromTimeZoneParts({
      year: Number(dateOnly[1]), month: Number(dateOnly[2]), day: Number(dateOnly[3])
    });
    if (calendarDayKey(start) !== normalized) return null;
    return endOfDay
      ? new Date(addCalendarDays(start, 1).getTime() - 1)
      : start;
  }
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function calendarDayKey(value, timeZone = calendarTimeZone) {
  const parts = getTimeZoneParts(value instanceof Date ? value : new Date(value), timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function isDeadlineOutstanding(type, metadata = {}) {
  if (type === "obligation_due") return metadata.obligation_status === "open";
  if (type === "estimated_completion") {
    return !["completed", "cancelled"].includes(metadata.production_status);
  }
  if (type === "pickup_scheduled") {
    return !["picked_up", "cancelled"].includes(metadata.delivery_status);
  }
  return false;
}

function classifyCalendarEntry(entry, now = new Date()) {
  const startsAt = normalizeDate(entry.starts_at);
  const current = normalizeDate(now);
  if (!startsAt || !current) return "historical";
  if (calendarDayKey(startsAt) === calendarDayKey(current)) return "today";
  if (startsAt.getTime() > current.getTime()) return "upcoming";
  if (deadlineTypes.has(entry.type) && isDeadlineOutstanding(entry.type, entry.metadata)) {
    return "overdue";
  }
  return "historical";
}

function safeMetadata(context, extra = {}) {
  return {
    commission_number: context.commission.commission_number,
    commission_title: context.commission.title,
    ...extra
  };
}

function makeEntry(context, {
  type,
  startsAt,
  allDay = false,
  sourceType,
  sourceId,
  metadata = {},
  now
}) {
  const date = allDay ? normalizeAllDayDate(startsAt) : normalizeDate(startsAt);
  if (!date || !entryDefinitions[type]) return null;
  const [domain, title] = entryDefinitions[type];
  const entry = {
    id: `${type}:${sourceType}:${sourceId}`,
    commission_id: String(context.commission.id),
    type,
    domain,
    title,
    starts_at: date.toISOString(),
    ends_at: null,
    all_day: allDay,
    status: null,
    source_type: sourceType,
    source_id: String(sourceId),
    derived: true,
    metadata: safeMetadata(context, metadata)
  };
  entry.status = classifyCalendarEntry(entry, now);
  return entry;
}

function buildCommissionTimeline(context, { now = new Date() } = {}) {
  if (!context?.commission) return [];
  const entries = [];
  const push = (definition) => {
    const entry = makeEntry(context, { ...definition, now });
    if (entry) entries.push(entry);
  };

  push({
    type: "commission_created",
    startsAt: context.commission.created_at,
    sourceType: "commission",
    sourceId: context.commission.id,
    metadata: { commission_status: context.commission.status }
  });

  for (const quotation of context.quotations || []) {
    const quotationMetadata = {
      quotation_number: quotation.quotation_number,
      quotation_version: quotation.version,
      quotation_status: quotation.quotation_status
    };
    if (quotation.issued_at) push({
      type: "quotation_issued", startsAt: quotation.issued_at,
      sourceType: "quotation", sourceId: quotation.id,
      metadata: quotationMetadata
    });
    if (quotation.expires_at) push({
      type: "quotation_expires", startsAt: quotation.expires_at,
      sourceType: "quotation", sourceId: quotation.id,
      metadata: quotationMetadata
    });
    if (quotation.quotation_status === "accepted" && quotation.estimated_completion) push({
      type: "estimated_completion", startsAt: quotation.estimated_completion,
      allDay: true, sourceType: "quotation", sourceId: quotation.id,
      metadata: {
        ...quotationMetadata,
        production_status: context.production?.production_status || null
      }
    });
  }

  for (const acceptance of context.acceptances || []) {
    if (acceptance.acceptance_type !== "quotation" || !acceptance.accepted) continue;
    push({
      type: "quotation_accepted", startsAt: acceptance.accepted_at,
      sourceType: "acceptance", sourceId: acceptance.id,
      metadata: {
        quotation_id: acceptance.quotation_id ? String(acceptance.quotation_id) : null,
        subject_number: acceptance.subject_number,
        subject_version: acceptance.subject_version
      }
    });
  }

  const production = context.production;
  if (production) {
    const productionMetadata = { production_status: production.production_status };
    if (production.reserved_at) push({
      type: "production_reserved", startsAt: production.reserved_at,
      sourceType: "production", sourceId: context.commission.id,
      metadata: productionMetadata
    });
    if (production.started_at) push({
      type: "production_started", startsAt: production.started_at,
      sourceType: "production", sourceId: context.commission.id,
      metadata: productionMetadata
    });
    if (production.final_presented_at) {
      push({
        type: "final_presented", startsAt: production.final_presented_at,
        sourceType: "production", sourceId: context.commission.id,
        metadata: productionMetadata
      });
      push({
        type: "inspection_window_ends",
        startsAt: addCalendarDays(production.final_presented_at, 7),
        sourceType: "production", sourceId: context.commission.id,
        metadata: productionMetadata
      });
    }
    if (production.completed_at) push({
      type: "production_completed", startsAt: production.completed_at,
      sourceType: "production", sourceId: context.commission.id,
      metadata: productionMetadata
    });
  }

  for (const obligation of context.obligations || []) {
    if (!obligation.due_at) continue;
    push({
      type: "obligation_due", startsAt: obligation.due_at,
      sourceType: "obligation", sourceId: obligation.id,
      metadata: {
        obligation_type: obligation.obligation_type,
        obligation_status: obligation.obligation_status
      }
    });
  }

  const delivery = context.delivery;
  if (delivery) {
    const deliveryMetadata = {
      delivery_method: delivery.delivery_method,
      delivery_status: delivery.delivery_status
    };
    for (const [type, column] of [
      ["delivery_ready", "ready_at"],
      ["pickup_scheduled", "scheduled_at"],
      ["shipped", "shipped_at"],
      ["delivered", "delivered_at"],
      ["picked_up", "picked_up_at"]
    ]) {
      if (delivery[column]) push({
        type, startsAt: delivery[column], sourceType: "delivery",
        sourceId: delivery.id, metadata: deliveryMetadata
      });
    }
    if (delivery.storage_fee_start_at) {
      push({
        type: "free_storage_ends", startsAt: delivery.storage_fee_start_at,
        sourceType: "delivery", sourceId: delivery.id, metadata: deliveryMetadata
      });
      push({
        type: "storage_fee_begins", startsAt: delivery.storage_fee_start_at,
        sourceType: "delivery", sourceId: delivery.id, metadata: deliveryMetadata
      });
    }
    if (delivery.final_notice_at) push({
      type: "final_notice", startsAt: delivery.final_notice_at,
      sourceType: "delivery", sourceId: delivery.id, metadata: deliveryMetadata
    });
    if (delivery.abandonment_eligible_at) push({
      type: "abandonment_review_eligible", startsAt: delivery.abandonment_eligible_at,
      sourceType: "delivery", sourceId: delivery.id, metadata: deliveryMetadata
    });
  }

  const canonicalTypes = new Set(entries.map((entry) => entry.type));
  for (const event of context.events || []) {
    const type = eventFallbackTypes[event.event_type];
    if (!type || canonicalTypes.has(type)) continue;
    push({
      type,
      startsAt: event.occurred_at,
      sourceType: "commission_event",
      sourceId: event.id,
      metadata: { historical_fallback: true }
    });
    canonicalTypes.add(type);
  }

  const uniqueEntries = new Map(entries.map((entry) => [entry.id, entry]));
  return [...uniqueEntries.values()].sort((left, right) =>
    new Date(left.starts_at) - new Date(right.starts_at) || left.id.localeCompare(right.id)
  );
}

function buildCalendarEntries(contexts, { now = new Date(), from = null, to = null } = {}) {
  const entries = (Array.isArray(contexts) ? contexts : [contexts])
    .flatMap((context) => buildCommissionTimeline(context, { now }));
  const fromTime = normalizeDate(from)?.getTime() ?? Number.NEGATIVE_INFINITY;
  const toTime = normalizeDate(to)?.getTime() ?? Number.POSITIVE_INFINITY;
  return entries.filter((entry) => {
    const time = new Date(entry.starts_at).getTime();
    return time >= fromTime && time <= toTime;
  }).sort((left, right) =>
    new Date(left.starts_at) - new Date(right.starts_at) || left.id.localeCompare(right.id)
  );
}

function baseContext(commission) {
  return {
    commission,
    quotations: [], acceptances: [], production: null,
    obligations: [], delivery: null, events: []
  };
}

async function loadCommissionCalendarContext(db, commissionId) {
  const commission = (await db.pool.query(
    `SELECT id, commission_number, title, status, created_at
     FROM commissions WHERE id = $1`,
    [commissionId]
  )).rows[0];
  if (!commission) return null;
  const [quotations, acceptances, production, obligations, delivery, events] = await Promise.all([
    db.pool.query(
      `SELECT id, commission_id, quotation_number, version, quotation_status,
              issued_at, expires_at, estimated_completion
       FROM quotations WHERE commission_id = $1`, [commissionId]
    ),
    db.pool.query(
      `SELECT id, commission_id, acceptance_type, quotation_id, accepted,
              accepted_at, subject_number, subject_version
       FROM acceptances WHERE commission_id = $1`, [commissionId]
    ),
    db.pool.query(
      `SELECT commission_id, production_status, reserved_at, started_at,
              final_presented_at, completed_at
       FROM commission_production WHERE commission_id = $1`, [commissionId]
    ),
    db.pool.query(
      `SELECT id, commission_id, obligation_type, obligation_status, due_at
       FROM commission_obligations WHERE commission_id = $1`, [commissionId]
    ),
    db.pool.query(
      `SELECT id, commission_id, delivery_method, delivery_status, ready_at,
              scheduled_at, shipped_at, delivered_at, picked_up_at,
              storage_fee_start_at, final_notice_at, abandonment_eligible_at
       FROM deliveries WHERE commission_id = $1`, [commissionId]
    ),
    db.pool.query(
      `SELECT id, commission_id, event_type, occurred_at
       FROM commission_events WHERE commission_id = $1`, [commissionId]
    )
  ]);
  return {
    ...baseContext(commission),
    quotations: quotations.rows,
    acceptances: acceptances.rows,
    production: production.rows[0] || null,
    obligations: obligations.rows,
    delivery: delivery.rows[0] || null,
    events: events.rows
  };
}

function groupGlobalRows(resultSets) {
  const contexts = new Map();
  const ensure = (row) => {
    const id = String(row.commission_id);
    if (!contexts.has(id)) {
      contexts.set(id, baseContext({
        id,
        commission_number: row.commission_number,
        title: row.commission_title,
        status: row.commission_status,
        created_at: row.commission_created_at
      }));
    }
    return contexts.get(id);
  };
  for (const row of resultSets.commissions) ensure({
    ...row,
    commission_id: row.id,
    commission_title: row.title,
    commission_status: row.status,
    commission_created_at: row.created_at
  });
  for (const [key, singular] of [
    ["quotations", null], ["acceptances", null], ["obligations", null], ["events", null]
  ]) {
    for (const row of resultSets[key]) ensure(row)[key].push(row);
  }
  for (const row of resultSets.productions) ensure(row).production = row;
  for (const row of resultSets.deliveries) ensure(row).delivery = row;
  return [...contexts.values()];
}

async function readCalendarEntries(db, { from, to, now = new Date() }) {
  const common = `c.commission_number, c.title AS commission_title,
                  c.status AS commission_status, c.created_at AS commission_created_at`;
  const [commissions, quotations, acceptances, productions, obligations, deliveries, events] = await Promise.all([
    db.pool.query(
      `SELECT id, commission_number, title, status, created_at
       FROM commissions WHERE created_at BETWEEN $1 AND $2`, [from, to]
    ),
    db.pool.query(
      `SELECT q.id, q.commission_id, q.quotation_number, q.version,
              q.quotation_status, q.issued_at, q.expires_at,
              q.estimated_completion, ${common}
       FROM quotations AS q JOIN commissions AS c ON c.id = q.commission_id
       WHERE q.issued_at BETWEEN $1 AND $2
          OR q.expires_at BETWEEN $1 AND $2
          OR (q.quotation_status = 'accepted' AND q.estimated_completion BETWEEN
              ($1 AT TIME ZONE 'America/New_York')::date AND
              ($2 AT TIME ZONE 'America/New_York')::date)`, [from, to]
    ),
    db.pool.query(
      `SELECT a.id, a.commission_id, a.acceptance_type, a.quotation_id,
              a.accepted, a.accepted_at, a.subject_number, a.subject_version,
              ${common}
       FROM acceptances AS a JOIN commissions AS c ON c.id = a.commission_id
       WHERE a.accepted_at BETWEEN $1 AND $2`, [from, to]
    ),
    db.pool.query(
      `SELECT p.commission_id, p.production_status, p.reserved_at, p.started_at,
              p.final_presented_at, p.completed_at, ${common}
       FROM commission_production AS p JOIN commissions AS c ON c.id = p.commission_id
       WHERE p.reserved_at BETWEEN $1 AND $2
          OR p.started_at BETWEEN $1 AND $2
          OR p.final_presented_at BETWEEN $1 AND $2
          OR (((p.final_presented_at AT TIME ZONE 'America/New_York') + INTERVAL '7 days')
              AT TIME ZONE 'America/New_York') BETWEEN $1 AND $2
          OR p.completed_at BETWEEN $1 AND $2`, [from, to]
    ),
    db.pool.query(
      `SELECT o.id, o.commission_id, o.obligation_type, o.obligation_status,
              o.due_at, ${common}
       FROM commission_obligations AS o JOIN commissions AS c ON c.id = o.commission_id
       WHERE o.due_at BETWEEN $1 AND $2`, [from, to]
    ),
    db.pool.query(
      `SELECT d.id, d.commission_id, d.delivery_method, d.delivery_status,
              d.ready_at, d.scheduled_at, d.shipped_at, d.delivered_at,
              d.picked_up_at, d.storage_fee_start_at, d.final_notice_at,
              d.abandonment_eligible_at, ${common}
       FROM deliveries AS d JOIN commissions AS c ON c.id = d.commission_id
       WHERE d.ready_at BETWEEN $1 AND $2 OR d.scheduled_at BETWEEN $1 AND $2
          OR d.shipped_at BETWEEN $1 AND $2 OR d.delivered_at BETWEEN $1 AND $2
          OR d.picked_up_at BETWEEN $1 AND $2 OR d.storage_fee_start_at BETWEEN $1 AND $2
          OR d.final_notice_at BETWEEN $1 AND $2 OR d.abandonment_eligible_at BETWEEN $1 AND $2`,
      [from, to]
    ),
    db.pool.query(
      `SELECT e.id, e.commission_id, e.event_type, e.occurred_at, ${common}
       FROM commission_events AS e JOIN commissions AS c ON c.id = e.commission_id
       WHERE e.occurred_at BETWEEN $1 AND $2`, [from, to]
    )
  ]);
  const contexts = groupGlobalRows({
    commissions: commissions.rows,
    quotations: quotations.rows,
    acceptances: acceptances.rows,
    productions: productions.rows,
    obligations: obligations.rows,
    deliveries: deliveries.rows,
    events: events.rows
  });
  return buildCalendarEntries(contexts, { now, from, to });
}

export {
  addCalendarDays,
  buildCalendarEntries,
  buildCommissionTimeline,
  calendarDomains,
  calendarTimeZone,
  classifyCalendarEntry,
  entryDefinitions,
  loadCommissionCalendarContext,
  parseCalendarBoundary,
  readCalendarEntries
};
