import { appendCommissionEvent } from "./commission-events.mjs";

const deliveryMethods = Object.freeze(["pickup", "shipping"]);
const deliveryStatuses = Object.freeze([
  "pending", "ready", "scheduled", "shipped", "delivered",
  "picked_up", "in_storage", "cancelled"
]);
const terminalDeliveryStatuses = new Set(["delivered", "picked_up", "cancelled"]);
const storageTimeZone = "America/New_York";
const storageFreeDays = 30;
const abandonmentReviewDays = 180;
const storageWeeklyFeeCents = 1000;
const deliveryTransitionMap = Object.freeze({
  shipping: Object.freeze({
    pending: Object.freeze(["ready"]),
    ready: Object.freeze(["shipped", "cancelled"]),
    in_storage: Object.freeze(["ready", "shipped"]),
    shipped: Object.freeze(["delivered"]),
    delivered: Object.freeze([]),
    cancelled: Object.freeze([])
  }),
  pickup: Object.freeze({
    pending: Object.freeze(["ready", "cancelled"]),
    ready: Object.freeze(["scheduled", "picked_up", "cancelled"]),
    scheduled: Object.freeze(["picked_up", "cancelled"]),
    in_storage: Object.freeze(["scheduled", "picked_up"]),
    picked_up: Object.freeze([]),
    cancelled: Object.freeze([])
  })
});
const transitionEventTypes = Object.freeze({
  ready: "delivery_ready",
  scheduled: "delivery_scheduled",
  shipped: "delivery_shipped",
  delivered: "delivery_delivered",
  picked_up: "delivery_picked_up",
  cancelled: "delivery_cancelled"
});
const transitionTimestampColumns = Object.freeze({
  ready: "ready_at",
  scheduled: "scheduled_at",
  shipped: "shipped_at",
  delivered: "delivered_at",
  picked_up: "picked_up_at"
});
const createFields = new Set([
  "delivery_method", "recipient_name", "address_line1", "address_line2",
  "city", "state_region", "postal_code", "country", "carrier",
  "service_level", "tracking_number", "notes"
]);
const updateFields = new Set([
  "recipient_name", "address_line1", "address_line2", "city", "state_region",
  "postal_code", "country", "carrier", "service_level", "tracking_number",
  "actual_shipping_cost", "protection_cost", "notes"
]);

function hasContent(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function normalizeNullableText(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  return String(value).trim();
}

function normalizeRequiredText(value, label) {
  const normalized = normalizeNullableText(value);
  return normalized ? { value: normalized } : { error: `${label} is required.` };
}

function normalizeMoney(value, label) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return { value: null };
  }
  const normalized = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    return { error: `${label} must be 0 or greater with no more than 2 decimals.` };
  }
  const [whole, fraction = ""] = normalized.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents > 999999999999) {
    return { error: `${label} is outside the supported range.` };
  }
  return {
    value: `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`
  };
}

function getTimeZoneParts(date, timeZone = storageTimeZone) {
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

function getTimeZoneOffset(date, timeZone = storageTimeZone) {
  const parts = getTimeZoneParts(date, timeZone);
  return Date.UTC(
    parts.year, parts.month - 1, parts.day,
    parts.hour, parts.minute, parts.second
  ) - Math.floor(date.getTime() / 1000) * 1000;
}

function addStorageCalendarDays(date, days, timeZone = storageTimeZone) {
  const parts = getTimeZoneParts(date, timeZone);
  const wallClock = new Date(Date.UTC(
    parts.year, parts.month - 1, parts.day + days,
    parts.hour, parts.minute, parts.second, date.getUTCMilliseconds()
  ));
  let result = new Date(wallClock.getTime() - getTimeZoneOffset(wallClock, timeZone));
  result = new Date(wallClock.getTime() - getTimeZoneOffset(result, timeZone));
  return result;
}

function elapsedStorageDays(start, end, timeZone = storageTimeZone) {
  const startParts = getTimeZoneParts(start, timeZone);
  const endParts = getTimeZoneParts(end, timeZone);
  const startWallClock = Date.UTC(
    startParts.year, startParts.month - 1, startParts.day,
    startParts.hour, startParts.minute, startParts.second,
    start.getUTCMilliseconds()
  );
  const endWallClock = Date.UTC(
    endParts.year, endParts.month - 1, endParts.day,
    endParts.hour, endParts.minute, endParts.second,
    end.getUTCMilliseconds()
  );
  return Math.max(0, (endWallClock - startWallClock) / 86400000);
}

function calculateStorageState(delivery, now = new Date()) {
  const inStorage = delivery?.delivery_status === "in_storage";
  const storageStartAt = delivery?.storage_start_at
    ? new Date(delivery.storage_start_at)
    : null;
  const configuredFeeStart = delivery?.storage_fee_start_at
    ? new Date(delivery.storage_fee_start_at)
    : null;
  const freeStorageEndsAt = configuredFeeStart || (
    storageStartAt ? addStorageCalendarDays(storageStartAt, storageFreeDays) : null
  );
  const currentTime = now instanceof Date ? now : new Date(now);
  const elapsedBillableDays = inStorage && freeStorageEndsAt
    ? elapsedStorageDays(freeStorageEndsAt, currentTime)
    : 0;
  const storageFeeActive = Boolean(
    inStorage && freeStorageEndsAt && currentTime.getTime() > freeStorageEndsAt.getTime()
  );
  const billableWeeks = storageFeeActive
    ? Math.ceil(elapsedBillableDays / 7)
    : 0;
  const finalNoticeAt = delivery?.final_notice_at
    ? new Date(delivery.final_notice_at)
    : null;
  const abandonmentEligibleAt = delivery?.abandonment_eligible_at
    ? new Date(delivery.abandonment_eligible_at)
    : finalNoticeAt
      ? addStorageCalendarDays(finalNoticeAt, abandonmentReviewDays)
      : null;

  return {
    in_storage: inStorage,
    free_storage_ends_at: freeStorageEndsAt,
    storage_fee_active: storageFeeActive,
    billable_weeks: billableWeeks,
    estimated_storage_fee: `${Math.floor((billableWeeks * storageWeeklyFeeCents) / 100)}.00`,
    final_notice_required: Boolean(inStorage && storageFeeActive && !finalNoticeAt),
    final_notice_at: finalNoticeAt,
    abandonment_eligible_at: abandonmentEligibleAt,
    abandonment_eligible: Boolean(
      abandonmentEligibleAt && currentTime.getTime() >= abandonmentEligibleAt.getTime()
    )
  };
}

function rejectUnexpectedFields(data, allowed) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "Request body must be a JSON object.";
  }
  const unexpected = Object.keys(data).filter((field) => !allowed.has(field));
  return unexpected.length ? `Unsupported field: ${unexpected[0]}.` : null;
}

function normalizeDeliveryCreate(data) {
  const fieldError = rejectUnexpectedFields(data, createFields);
  if (fieldError) return { error: fieldError };
  if (!deliveryMethods.includes(data.delivery_method)) {
    return { error: "Delivery method must be pickup or shipping." };
  }
  const recipient = normalizeRequiredText(data.recipient_name, "Recipient name");
  if (recipient.error) return recipient;

  const delivery = {
    delivery_method: data.delivery_method,
    recipient_name: recipient.value
  };
  for (const field of createFields) {
    if (!["delivery_method", "recipient_name"].includes(field)) {
      delivery[field] = normalizeNullableText(data[field]);
    }
  }
  if (delivery.delivery_method === "shipping") {
    for (const [field, label] of [
      ["address_line1", "Address line 1"], ["city", "City"],
      ["state_region", "State / region"], ["postal_code", "Postal code"],
      ["country", "Country"]
    ]) {
      if (!delivery[field]) return { error: `${label} is required for shipping.` };
    }
  }
  return { delivery };
}

function normalizeDeliveryUpdate(data) {
  const fieldError = rejectUnexpectedFields(data, updateFields);
  if (fieldError) return { error: fieldError };
  const keys = Object.keys(data);
  if (!keys.length) return { error: "At least one editable Delivery field is required." };

  const delivery = {};
  for (const field of keys) {
    if (["actual_shipping_cost", "protection_cost"].includes(field)) {
      const money = normalizeMoney(
        data[field],
        field === "actual_shipping_cost" ? "Actual shipping cost" : "Protection cost"
      );
      if (money.error) return money;
      delivery[field] = money.value;
    } else {
      delivery[field] = normalizeNullableText(data[field]);
    }
  }
  return { delivery };
}

function normalizeDeliveryTransition(data, now = new Date()) {
  const fieldError = rejectUnexpectedFields(data, new Set(["next_status", "scheduled_at"]));
  if (fieldError) return { error: fieldError };
  if (!hasContent(data.next_status)) return { error: "Next status is required." };
  const nextStatus = String(data.next_status).trim();
  if (nextStatus === "in_storage" || !deliveryStatuses.includes(nextStatus)) {
    return { error: "Unsupported Delivery transition." };
  }

  let scheduledAt = null;
  if (nextStatus === "scheduled") {
    if (!hasContent(data.scheduled_at)) return { error: "Scheduled date and time are required." };
    scheduledAt = new Date(data.scheduled_at);
    if (Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() <= now.getTime()) {
      return { error: "Scheduled date and time must be valid and in the future." };
    }
  } else if (hasContent(data.scheduled_at)) {
    return { error: "Scheduled date and time are only allowed for scheduled pickup." };
  }
  return { transition: { next_status: nextStatus, scheduled_at: scheduledAt } };
}

function normalizeDeliveryRow(row, now = new Date()) {
  if (!row) return null;
  return {
    id: String(row.id),
    commission_id: String(row.commission_id),
    delivery_method: row.delivery_method,
    delivery_status: row.delivery_status,
    recipient_name: row.recipient_name,
    address_line1: row.address_line1,
    address_line2: row.address_line2,
    city: row.city,
    state_region: row.state_region,
    postal_code: row.postal_code,
    country: row.country,
    carrier: row.carrier,
    service_level: row.service_level,
    tracking_number: row.tracking_number,
    actual_shipping_cost: row.actual_shipping_cost === null ? null : String(row.actual_shipping_cost),
    protection_cost: row.protection_cost === null ? null : String(row.protection_cost),
    ready_at: row.ready_at,
    scheduled_at: row.scheduled_at,
    shipped_at: row.shipped_at,
    delivered_at: row.delivered_at,
    picked_up_at: row.picked_up_at,
    storage_start_at: row.storage_start_at,
    storage_notice_at: row.storage_notice_at,
    storage_fee_start_at: row.storage_fee_start_at,
    final_notice_at: row.final_notice_at,
    abandonment_eligible_at: row.abandonment_eligible_at,
    abandoned_at: row.abandoned_at,
    storage_state: calculateStorageState(row, now),
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

async function evaluateDeliveryReleaseEligibility(queryable, commissionId, { lock = false } = {}) {
  const commission = (await queryable.query(
    `SELECT id FROM commissions WHERE id = $1${lock ? " FOR UPDATE" : ""}`,
    [commissionId]
  )).rows[0];
  if (!commission) return null;

  const production = (await queryable.query(
    `SELECT production_status FROM commission_production
     WHERE commission_id = $1${lock ? " FOR UPDATE" : ""}`,
    [commissionId]
  )).rows[0];
  if (production?.production_status !== "completed") {
    return {
      eligible: false,
      reason: "production_not_completed",
      message: "Canonical Production must be completed before Delivery can be created."
    };
  }

  const obligations = (await queryable.query(
    `SELECT obligation_status FROM commission_obligations
     WHERE commission_id = $1${lock ? " FOR UPDATE" : ""}`,
    [commissionId]
  )).rows;
  if (!obligations.length) {
    return {
      eligible: false,
      reason: "canonical_financial_clearance_unavailable",
      message: "Canonical financial clearance is unavailable because no Financial Obligations exist."
    };
  }
  if (obligations.some((obligation) => obligation.obligation_status === "open")) {
    return {
      eligible: false,
      reason: "canonical_obligations_outstanding",
      message: "Every canonical Financial Obligation must be satisfied, waived, or voided before Delivery can be created."
    };
  }
  return {
    eligible: true,
    reason: null,
    message: "Canonical Production and financial release requirements are satisfied."
  };
}

async function readCommissionDelivery(db, commissionId, { now = new Date() } = {}) {
  const result = await db.pool.query(
    `SELECT c.id AS existing_commission_id, d.*
     FROM commissions AS c
     LEFT JOIN deliveries AS d ON d.commission_id = c.id
     WHERE c.id = $1`,
    [commissionId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return row.id === null
    ? { initialized: false, delivery: null }
    : { initialized: true, delivery: normalizeDeliveryRow(row, now) };
}

async function syncStorageFeeObligationInTransaction(
  connection,
  delivery,
  occurredAt,
  { actorType = "system" } = {}
) {
  const storageState = calculateStorageState(delivery, occurredAt);
  if (!storageState.storage_fee_active || storageState.billable_weeks === 0) {
    return { outcome: "no_fee", storage_state: storageState, obligation: null };
  }

  const existing = (await connection.query(
    `SELECT * FROM commission_obligations
     WHERE obligation_type = 'storage_fee'
       AND source_type = 'delivery'
       AND source_id = $1
     FOR UPDATE`,
    [String(delivery.id)]
  )).rows[0];

  if (!existing) {
    const created = (await connection.query(
      `INSERT INTO commission_obligations (
         commission_id, obligation_type, obligation_status, amount, due_at,
         source_type, source_id, description, created_at, updated_at
       ) VALUES (
         $1, 'storage_fee', 'open', $2, $3,
         'delivery', $4, 'Storage fees accrued after the 30-day free storage period.',
         $5, $5
       ) RETURNING *`,
      [
        delivery.commission_id,
        storageState.estimated_storage_fee,
        storageState.free_storage_ends_at,
        String(delivery.id),
        occurredAt
      ]
    )).rows[0];
    await appendCommissionEvent(connection, {
      commissionId: delivery.commission_id,
      eventType: "storage_fee_created",
      occurredAt,
      actorType,
      sourceType: "delivery",
      sourceId: delivery.id,
      payload: {
        amount: storageState.estimated_storage_fee,
        billable_weeks: storageState.billable_weeks
      }
    });
    return { outcome: "created", storage_state: storageState, obligation: created };
  }

  if (existing.obligation_status !== "open") {
    return { outcome: "inactive", storage_state: storageState, obligation: existing };
  }
  const existingCents = Math.round(Number(existing.amount) * 100);
  const estimatedCents = storageState.billable_weeks * storageWeeklyFeeCents;
  if (estimatedCents <= existingCents) {
    return { outcome: "unchanged", storage_state: storageState, obligation: existing };
  }

  const updated = (await connection.query(
    `UPDATE commission_obligations
     SET amount = $2, updated_at = $3
     WHERE id = $1 AND obligation_status = 'open' AND amount < $2
     RETURNING *`,
    [existing.id, storageState.estimated_storage_fee, occurredAt]
  )).rows[0];
  if (!updated) {
    return { outcome: "unchanged", storage_state: storageState, obligation: existing };
  }
  await appendCommissionEvent(connection, {
    commissionId: delivery.commission_id,
    eventType: "storage_fee_updated",
    occurredAt,
    actorType,
    sourceType: "delivery",
    sourceId: delivery.id,
    payload: {
      previous_amount: String(existing.amount),
      new_amount: storageState.estimated_storage_fee,
      billable_weeks: storageState.billable_weeks
    }
  });
  return { outcome: "updated", storage_state: storageState, obligation: updated };
}

async function syncStorageFeeObligation(db, commissionId, {
  now = () => new Date(), actorType = "system"
} = {}) {
  const connection = await db.pool.connect();
  try {
    await connection.query("BEGIN");
    await connection.query(
      "SELECT pg_advisory_xact_lock(hashtext('commission-storage-fee'), hashtext($1::text))",
      [commissionId]
    );
    const delivery = (await connection.query(
      "SELECT * FROM deliveries WHERE commission_id = $1 FOR UPDATE",
      [commissionId]
    )).rows[0];
    if (!delivery) {
      const exists = (await connection.query(
        "SELECT id FROM commissions WHERE id = $1",
        [commissionId]
      )).rows[0];
      await connection.query("ROLLBACK");
      return { outcome: exists ? "not_initialized" : "not_found" };
    }
    const occurredAt = now();
    const result = await syncStorageFeeObligationInTransaction(
      connection,
      delivery,
      occurredAt,
      { actorType }
    );
    await connection.query("COMMIT");
    return result;
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

async function enterCommissionStorage(db, commissionId, {
  now = () => new Date(), actorType = "admin"
} = {}) {
  const connection = await db.pool.connect();
  try {
    await connection.query("BEGIN");
    await connection.query(
      "SELECT pg_advisory_xact_lock(hashtext('commission-delivery'), hashtext($1::text))",
      [commissionId]
    );
    const current = (await connection.query(
      "SELECT * FROM deliveries WHERE commission_id = $1 FOR UPDATE",
      [commissionId]
    )).rows[0];
    if (!current) {
      const exists = (await connection.query(
        "SELECT id FROM commissions WHERE id = $1",
        [commissionId]
      )).rows[0];
      await connection.query("ROLLBACK");
      return { outcome: exists ? "not_initialized" : "not_found" };
    }
    const allowed = current.delivery_method === "pickup"
      ? ["ready", "scheduled"]
      : ["ready"];
    if (!allowed.includes(current.delivery_status)) {
      await connection.query("ROLLBACK");
      return { outcome: "invalid_transition", current_status: current.delivery_status };
    }

    const occurredAt = now();
    const storageFeeStartAt = addStorageCalendarDays(occurredAt, storageFreeDays);
    const updated = (await connection.query(
      `UPDATE deliveries
       SET delivery_status = 'in_storage', storage_start_at = $2,
           storage_fee_start_at = $3, updated_at = $2
       WHERE commission_id = $1 AND delivery_status = $4
       RETURNING *`,
      [commissionId, occurredAt, storageFeeStartAt, current.delivery_status]
    )).rows[0];
    if (!updated) {
      await connection.query("ROLLBACK");
      return { outcome: "invalid_transition", current_status: current.delivery_status };
    }
    await appendCommissionEvent(connection, {
      commissionId,
      eventType: "delivery_in_storage",
      occurredAt,
      actorType,
      sourceType: "delivery",
      sourceId: current.id,
      payload: {
        previous_status: current.delivery_status,
        new_status: "in_storage",
        delivery_method: current.delivery_method
      }
    });
    await connection.query("COMMIT");
    return {
      outcome: "success",
      delivery: normalizeDeliveryRow(updated, occurredAt)
    };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

async function recordStorageNotice(db, commissionId, {
  now = () => new Date(), actorType = "admin", final = false
} = {}) {
  const connection = await db.pool.connect();
  try {
    await connection.query("BEGIN");
    await connection.query(
      "SELECT pg_advisory_xact_lock(hashtext('commission-delivery'), hashtext($1::text))",
      [commissionId]
    );
    const current = (await connection.query(
      "SELECT * FROM deliveries WHERE commission_id = $1 FOR UPDATE",
      [commissionId]
    )).rows[0];
    if (!current) {
      const exists = (await connection.query(
        "SELECT id FROM commissions WHERE id = $1",
        [commissionId]
      )).rows[0];
      await connection.query("ROLLBACK");
      return { outcome: exists ? "not_initialized" : "not_found" };
    }
    if (current.delivery_status !== "in_storage") {
      await connection.query("ROLLBACK");
      return { outcome: "not_in_storage" };
    }
    const timestampField = final ? "final_notice_at" : "storage_notice_at";
    if (current[timestampField]) {
      await connection.query("COMMIT");
      return {
        outcome: "idempotent",
        delivery: normalizeDeliveryRow(current, now())
      };
    }

    const occurredAt = now();
    await syncStorageFeeObligationInTransaction(connection, current, occurredAt);
    const abandonmentEligibleAt = final
      ? addStorageCalendarDays(occurredAt, abandonmentReviewDays)
      : null;
    const updated = final
      ? (await connection.query(
          `UPDATE deliveries
           SET final_notice_at = $2, abandonment_eligible_at = $3, updated_at = $2
           WHERE commission_id = $1 AND final_notice_at IS NULL
           RETURNING *`,
          [commissionId, occurredAt, abandonmentEligibleAt]
        )).rows[0]
      : (await connection.query(
          `UPDATE deliveries
           SET storage_notice_at = $2, updated_at = $2
           WHERE commission_id = $1 AND storage_notice_at IS NULL
           RETURNING *`,
          [commissionId, occurredAt]
        )).rows[0];
    if (!updated) {
      await connection.query("ROLLBACK");
      return { outcome: "conflict" };
    }
    await appendCommissionEvent(connection, {
      commissionId,
      eventType: final ? "storage_final_notice_recorded" : "storage_notice_recorded",
      occurredAt,
      actorType,
      sourceType: "delivery",
      sourceId: current.id,
      payload: final ? { abandonment_eligible_at: abandonmentEligibleAt.toISOString() } : {}
    });
    await connection.query("COMMIT");
    return {
      outcome: "success",
      delivery: normalizeDeliveryRow(updated, occurredAt)
    };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

async function createCommissionDelivery(db, commissionId, delivery, {
  now = () => new Date(), actorType = "admin"
} = {}) {
  const connection = await db.pool.connect();
  try {
    await connection.query("BEGIN");
    await connection.query(
      "SELECT pg_advisory_xact_lock(hashtext('commission-delivery'), hashtext($1::text))",
      [commissionId]
    );
    const eligibility = await evaluateDeliveryReleaseEligibility(connection, commissionId, { lock: true });
    if (!eligibility) {
      await connection.query("ROLLBACK");
      return { outcome: "not_found" };
    }
    const existing = (await connection.query(
      "SELECT id FROM deliveries WHERE commission_id = $1 FOR UPDATE",
      [commissionId]
    )).rows[0];
    if (existing) {
      await connection.query("ROLLBACK");
      return { outcome: "already_initialized" };
    }
    if (!eligibility.eligible) {
      await connection.query("ROLLBACK");
      return { outcome: "blocked", ...eligibility };
    }

    const occurredAt = now();
    const created = (await connection.query(
      `INSERT INTO deliveries (
         commission_id, delivery_method, delivery_status, recipient_name,
         address_line1, address_line2, city, state_region, postal_code, country,
         carrier, service_level, tracking_number, notes, created_at, updated_at
       ) VALUES (
         $1, $2, 'pending', $3, $4, $5, $6, $7, $8, $9,
         $10, $11, $12, $13, $14, $14
       ) RETURNING *`,
      [
        commissionId, delivery.delivery_method, delivery.recipient_name,
        delivery.address_line1, delivery.address_line2, delivery.city,
        delivery.state_region, delivery.postal_code, delivery.country,
        delivery.carrier, delivery.service_level, delivery.tracking_number,
        delivery.notes, occurredAt
      ]
    )).rows[0];
    await appendCommissionEvent(connection, {
      commissionId,
      eventType: "delivery_created",
      occurredAt,
      actorType,
      sourceType: "delivery",
      sourceId: created.id,
      payload: {
        previous_status: null,
        new_status: "pending",
        delivery_method: created.delivery_method
      }
    });
    await connection.query("COMMIT");
    return { outcome: "success", delivery: normalizeDeliveryRow(created, occurredAt) };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

async function updateCommissionDelivery(db, commissionId, changes, { now = () => new Date() } = {}) {
  const connection = await db.pool.connect();
  try {
    await connection.query("BEGIN");
    await connection.query(
      "SELECT pg_advisory_xact_lock(hashtext('commission-delivery'), hashtext($1::text))",
      [commissionId]
    );
    const current = (await connection.query(
      "SELECT * FROM deliveries WHERE commission_id = $1 FOR UPDATE",
      [commissionId]
    )).rows[0];
    if (!current) {
      const exists = (await connection.query(
        "SELECT id FROM commissions WHERE id = $1",
        [commissionId]
      )).rows[0];
      await connection.query("ROLLBACK");
      return { outcome: exists ? "not_initialized" : "not_found" };
    }
    if (terminalDeliveryStatuses.has(current.delivery_status)) {
      await connection.query("ROLLBACK");
      return { outcome: "terminal", current_status: current.delivery_status };
    }
    if (current.delivery_method === "pickup" && (
      (changes.actual_shipping_cost !== undefined && changes.actual_shipping_cost !== null)
      || (changes.protection_cost !== undefined && changes.protection_cost !== null)
    )) {
      await connection.query("ROLLBACK");
      return { outcome: "costs_not_allowed_for_pickup" };
    }

    const fields = Object.keys(changes);
    const values = fields.map((field) => changes[field]);
    const assignments = fields.map((field, index) => `${field} = $${index + 2}`);
    const updatedAtIndex = fields.length + 2;
    const updatedAt = now();
    const updated = (await connection.query(
      `UPDATE deliveries
       SET ${assignments.join(", ")}, updated_at = $${updatedAtIndex}
       WHERE commission_id = $1
       RETURNING *`,
      [commissionId, ...values, updatedAt]
    )).rows[0];
    await connection.query("COMMIT");
    return { outcome: "success", delivery: normalizeDeliveryRow(updated, updatedAt) };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

function validateMethodTransition(current, transition) {
  const allowed = deliveryTransitionMap[current.delivery_method]?.[current.delivery_status] || [];
  if (!allowed.includes(transition.next_status)) return { outcome: "invalid_transition" };
  if (transition.next_status === "scheduled" && current.delivery_method !== "pickup") {
    return { outcome: "invalid_transition" };
  }
  if (transition.next_status === "shipped") {
    if (!current.recipient_name || !current.address_line1 || !current.city
      || !current.state_region || !current.postal_code || !current.country) {
      return { outcome: "shipping_destination_incomplete" };
    }
    if (!current.carrier) return { outcome: "carrier_required" };
  }
  return { outcome: "valid" };
}

async function transitionCommissionDelivery(db, commissionId, transition, {
  now = () => new Date(), actorType = "admin"
} = {}) {
  const connection = await db.pool.connect();
  try {
    await connection.query("BEGIN");
    await connection.query(
      "SELECT pg_advisory_xact_lock(hashtext('commission-delivery'), hashtext($1::text))",
      [commissionId]
    );
    const current = (await connection.query(
      "SELECT * FROM deliveries WHERE commission_id = $1 FOR UPDATE",
      [commissionId]
    )).rows[0];
    if (!current) {
      const exists = (await connection.query(
        "SELECT id FROM commissions WHERE id = $1",
        [commissionId]
      )).rows[0];
      await connection.query("ROLLBACK");
      return { outcome: exists ? "not_initialized" : "not_found" };
    }
    if (terminalDeliveryStatuses.has(current.delivery_status)) {
      await connection.query("ROLLBACK");
      return { outcome: "terminal", current_status: current.delivery_status };
    }
    const validation = validateMethodTransition(current, transition);
    if (validation.outcome !== "valid") {
      await connection.query("ROLLBACK");
      return { ...validation, current_status: current.delivery_status };
    }

    const occurredAt = now();
    if (current.delivery_status === "in_storage") {
      await syncStorageFeeObligationInTransaction(connection, current, occurredAt);
    }
    if (["shipped", "picked_up"].includes(transition.next_status)) {
      const openObligation = (await connection.query(
        `SELECT id FROM commission_obligations
         WHERE commission_id = $1 AND obligation_status = 'open'
         LIMIT 1
         FOR UPDATE`,
        [commissionId]
      )).rows[0];
      if (openObligation) {
        await connection.query("COMMIT");
        return {
          outcome: "canonical_obligations_outstanding",
          current_status: current.delivery_status
        };
      }
    }
    const timestampColumn = transitionTimestampColumns[transition.next_status];
    const timestamp = transition.next_status === "scheduled"
      ? transition.scheduled_at
      : occurredAt;
    const updated = timestampColumn
      ? (await connection.query(
          `UPDATE deliveries
           SET delivery_status = $2, updated_at = $3, ${timestampColumn} = $4
           WHERE commission_id = $1 AND delivery_status = $5
           RETURNING *`,
          [commissionId, transition.next_status, occurredAt, timestamp, current.delivery_status]
        )).rows[0]
      : (await connection.query(
          `UPDATE deliveries
           SET delivery_status = $2, updated_at = $3
           WHERE commission_id = $1 AND delivery_status = $4
           RETURNING *`,
          [commissionId, transition.next_status, occurredAt, current.delivery_status]
        )).rows[0];
    if (!updated) {
      await connection.query("ROLLBACK");
      return { outcome: "invalid_transition", current_status: current.delivery_status };
    }
    await appendCommissionEvent(connection, {
      commissionId,
      eventType: transitionEventTypes[transition.next_status],
      occurredAt,
      actorType,
      sourceType: "delivery",
      sourceId: current.id,
      payload: {
        previous_status: current.delivery_status,
        new_status: transition.next_status,
        delivery_method: current.delivery_method
      }
    });
    await connection.query("COMMIT");
    return { outcome: "success", delivery: normalizeDeliveryRow(updated, occurredAt) };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

export {
  abandonmentReviewDays,
  addStorageCalendarDays,
  calculateStorageState,
  createCommissionDelivery,
  deliveryMethods,
  deliveryStatuses,
  deliveryTransitionMap,
  enterCommissionStorage,
  evaluateDeliveryReleaseEligibility,
  normalizeDeliveryCreate,
  normalizeDeliveryRow,
  normalizeDeliveryTransition,
  normalizeDeliveryUpdate,
  recordStorageNotice,
  readCommissionDelivery,
  storageFreeDays,
  storageWeeklyFeeCents,
  syncStorageFeeObligation,
  terminalDeliveryStatuses,
  transitionCommissionDelivery,
  updateCommissionDelivery,
  validateMethodTransition
};
