import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";

import { getDatabase } from "@netlify/database";
import { NetlifyDB } from "@netlify/database-dev";

import {
  createHandler,
  getCommissionDeliveryTransitionId
} from "../../netlify/functions/admin-commissions.mjs";
import {
  createCommissionDelivery,
  evaluateDeliveryReleaseEligibility,
  normalizeDeliveryCreate,
  normalizeDeliveryTransition,
  normalizeDeliveryUpdate,
  transitionCommissionDelivery,
  updateCommissionDelivery
} from "../../netlify/shared/commission-delivery.mjs";
import {
  commissionEventSourceTypes,
  commissionEventTypes
} from "../../netlify/shared/commission-events.mjs";
import {
  COOKIE_NAME,
  createSessionToken
} from "../../netlify/shared/admin-session.mjs";

let database;
let db;
let clientId;
let commissionId;
let handler;
let sessionCookie;

const fixedNow = new Date("2026-10-11T18:30:00.000Z");

before(async () => {
  database = new NetlifyDB({ logger: () => {} });
  const connectionString = await database.start();
  await database.applyMigrations("./netlify/database/migrations");
  db = getDatabase({ connectionString });
  const password = "phase-31-password";
  const secret = "phase-31-secret";
  handler = createHandler({
    databaseFactory: () => db,
    environmentReader(name) {
      return { ADMIN_PASSWORD: password, ADMIN_SESSION_SECRET: secret }[name];
    },
    now: () => fixedNow
  });
  sessionCookie = `${COOKIE_NAME}=${await createSessionToken(password, secret)}`;
});

beforeEach(async () => {
  clientId = (await db.pool.query(
    "INSERT INTO clients (full_name, email) VALUES ('Workflow Client', 'workflow@example.invalid') RETURNING id"
  )).rows[0].id;
  commissionId = (await db.pool.query(
    `INSERT INTO commissions (
       commission_number, client_id, title, description, medium,
       price, sales_tax, shipping, status
     ) VALUES (
       'SAS-COM-2026-9901', $1, 'Delivery Workflow',
       'Phase 10B delivery test', 'Oil', 500, 30, 25, 'completed'
     ) RETURNING id`,
    [clientId]
  )).rows[0].id;
});

afterEach(async () => {
  await db.pool.query("TRUNCATE commission_events RESTART IDENTITY");
  await db.pool.query("DELETE FROM deliveries");
  await db.pool.query("DELETE FROM payment_allocations");
  await db.pool.query("DELETE FROM commission_obligations");
  await db.pool.query("DELETE FROM acceptances");
  await db.pool.query("DELETE FROM documents");
  await db.pool.query("DELETE FROM quotations");
  await db.pool.query("DELETE FROM payments");
  await db.pool.query("DELETE FROM commission_production");
  await db.pool.query("DELETE FROM commission_inquiries");
  await db.pool.query("DELETE FROM commissions");
  await db.pool.query("DELETE FROM clients");
});

after(async () => {
  await db?.pool.end();
  await database?.stop();
});

function deliveryPayload(method = "shipping") {
  return {
    delivery_method: method,
    recipient_name: "Historical Recipient",
    address_line1: method === "shipping" ? "100 Delivery Avenue" : null,
    address_line2: null,
    city: method === "shipping" ? "Pittsburgh" : null,
    state_region: method === "shipping" ? "PA" : null,
    postal_code: method === "shipping" ? "15222" : null,
    country: method === "shipping" ? "US" : null,
    carrier: method === "shipping" ? "Test Carrier" : null,
    service_level: method === "shipping" ? "Ground" : null,
    tracking_number: null,
    notes: "Operational note"
  };
}

async function completeProduction(id = commissionId) {
  await db.pool.query(
    `INSERT INTO commission_production (
       commission_id, production_status, completed_at
     ) VALUES ($1, 'completed', $2)`,
    [id, fixedNow]
  );
}

async function addObligation(status = "satisfied", id = commissionId) {
  const timestampColumn = {
    satisfied: "satisfied_at",
    waived: "waived_at",
    voided: "voided_at"
  }[status];
  const columns = timestampColumn ? `, ${timestampColumn}` : "";
  const values = timestampColumn ? ", $3" : "";
  return (await db.pool.query(
    `INSERT INTO commission_obligations (
       commission_id, obligation_type, obligation_status, amount${columns}
     ) VALUES ($1, 'final_balance', $2, 100${values})
     RETURNING *`,
    timestampColumn ? [id, status, fixedNow] : [id, status]
  )).rows[0];
}

async function releaseCommission(id = commissionId, obligationStatus = "satisfied") {
  await completeProduction(id);
  await addObligation(obligationStatus, id);
}

async function createDelivery(method = "shipping", id = commissionId) {
  return createCommissionDelivery(db, id, deliveryPayload(method), {
    now: () => fixedNow
  });
}

function request(method, path, body, authenticated = true) {
  const headers = authenticated ? { Cookie: sessionCookie } : {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return handler(new Request(`http://localhost${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  }));
}

async function events() {
  return (await db.pool.query(
    `SELECT event_type, actor_type, source_type, source_id, payload
     FROM commission_events
     WHERE commission_id = $1
     ORDER BY id`,
    [commissionId]
  )).rows;
}

test("phase 10B extends the controlled Event vocabulary and Delivery source", async () => {
  for (const eventType of [
    "delivery_created", "delivery_ready", "delivery_scheduled",
    "delivery_shipped", "delivery_delivered", "delivery_picked_up",
    "delivery_cancelled"
  ]) assert.ok(commissionEventTypes.includes(eventType), eventType);
  assert.ok(commissionEventSourceTypes.includes("delivery"));

  await db.pool.query(
    `INSERT INTO commission_events (
       commission_id, event_type, occurred_at, actor_type, source_type, source_id
     ) VALUES ($1, 'delivery_created', $2, 'admin', 'delivery', '1')`,
    [commissionId, fixedNow]
  );
  await assert.rejects(
    db.pool.query("UPDATE commission_events SET actor_type = 'system'"),
    /append-only/i
  );
  await assert.rejects(
    db.pool.query("DELETE FROM commission_events"),
    /append-only/i
  );
});

test("release eligibility requires completed Production and canonical financial clearance", async () => {
  assert.deepEqual(
    await evaluateDeliveryReleaseEligibility(db.pool, commissionId),
    {
      eligible: false,
      reason: "production_not_completed",
      message: "Canonical Production must be completed before Delivery can be created."
    }
  );
  await completeProduction();
  assert.equal(
    (await evaluateDeliveryReleaseEligibility(db.pool, commissionId)).reason,
    "canonical_financial_clearance_unavailable"
  );
  await addObligation("open");
  assert.equal(
    (await evaluateDeliveryReleaseEligibility(db.pool, commissionId)).reason,
    "canonical_obligations_outstanding"
  );
  await db.pool.query(
    `UPDATE commission_obligations
     SET obligation_status = 'satisfied', satisfied_at = $2, updated_at = $2
     WHERE commission_id = $1`,
    [commissionId, fixedNow]
  );
  assert.equal(
    (await evaluateDeliveryReleaseEligibility(db.pool, commissionId)).eligible,
    true
  );
  await db.pool.query(
    `UPDATE commission_obligations
     SET obligation_status = 'waived', satisfied_at = NULL, waived_at = $2, updated_at = $2
     WHERE commission_id = $1`,
    [commissionId, fixedNow]
  );
  assert.equal(
    (await evaluateDeliveryReleaseEligibility(db.pool, commissionId)).eligible,
    true
  );
  await db.pool.query(
    `UPDATE commission_obligations
     SET obligation_status = 'voided', waived_at = NULL, voided_at = $2, updated_at = $2
     WHERE commission_id = $1`,
    [commissionId, fixedNow]
  );
  assert.equal(
    (await evaluateDeliveryReleaseEligibility(db.pool, commissionId)).eligible,
    true
  );
});

test("Delivery creation validates snapshots, is atomic, and cannot be duplicated", async () => {
  assert.equal(normalizeDeliveryCreate({
    ...deliveryPayload("shipping"),
    delivery_status: "ready"
  }).error, "Unsupported field: delivery_status.");
  assert.equal(normalizeDeliveryCreate({
    ...deliveryPayload("shipping"),
    city: null
  }).error, "City is required for shipping.");

  assert.equal((await createDelivery()).outcome, "blocked");
  await releaseCommission();
  const created = await createDelivery();
  assert.equal(created.outcome, "success");
  assert.equal(created.delivery.delivery_status, "pending");
  assert.equal(created.delivery.actual_shipping_cost, null);
  assert.equal(created.delivery.ready_at, null);
  assert.equal((await createDelivery()).outcome, "already_initialized");

  const audit = await events();
  assert.equal(audit.length, 1);
  assert.deepEqual(audit[0], {
    event_type: "delivery_created",
    actor_type: "admin",
    source_type: "delivery",
    source_id: created.delivery.id,
    payload: {
      new_status: "pending",
      delivery_method: "shipping",
      previous_status: null
    }
  });
});

test("shipping follows pending to ready to shipped to delivered with server timestamps", async () => {
  await releaseCommission();
  await createDelivery("shipping");
  const ready = await transitionCommissionDelivery(
    db,
    commissionId,
    { next_status: "ready", scheduled_at: null },
    { now: () => new Date("2026-10-11T19:00:00.000Z") }
  );
  assert.equal(ready.outcome, "success");
  assert.equal(ready.delivery.ready_at.toISOString(), "2026-10-11T19:00:00.000Z");
  const shipped = await transitionCommissionDelivery(
    db,
    commissionId,
    { next_status: "shipped", scheduled_at: null },
    { now: () => new Date("2026-10-11T20:00:00.000Z") }
  );
  assert.equal(shipped.outcome, "success");
  assert.equal(shipped.delivery.shipped_at.toISOString(), "2026-10-11T20:00:00.000Z");
  assert.equal(shipped.delivery.tracking_number, null);
  const delivered = await transitionCommissionDelivery(
    db,
    commissionId,
    { next_status: "delivered", scheduled_at: null },
    { now: () => new Date("2026-10-11T21:00:00.000Z") }
  );
  assert.equal(delivered.outcome, "success");
  assert.equal(delivered.delivery.delivered_at.toISOString(), "2026-10-11T21:00:00.000Z");
  assert.deepEqual((await events()).map((event) => event.event_type), [
    "delivery_created", "delivery_ready", "delivery_shipped", "delivery_delivered"
  ]);
});

test("shipping requires a complete destination and carrier at the shipped transition", async () => {
  await releaseCommission();
  await createDelivery("shipping");
  await transitionCommissionDelivery(db, commissionId, { next_status: "ready", scheduled_at: null });
  await db.pool.query(
    "UPDATE deliveries SET carrier = NULL WHERE commission_id = $1",
    [commissionId]
  );
  assert.equal(
    (await transitionCommissionDelivery(
      db,
      commissionId,
      { next_status: "shipped", scheduled_at: null }
    )).outcome,
    "carrier_required"
  );
  await db.pool.query(
    "UPDATE deliveries SET carrier = 'Carrier', city = NULL WHERE commission_id = $1",
    [commissionId]
  );
  assert.equal(
    (await transitionCommissionDelivery(
      db,
      commissionId,
      { next_status: "shipped", scheduled_at: null }
    )).outcome,
    "shipping_destination_incomplete"
  );
});

test("pickup supports future scheduling, direct pickup, cancellation, and rejects Storage", async () => {
  await releaseCommission();
  await createDelivery("pickup");
  assert.equal(
    (await transitionCommissionDelivery(
      db,
      commissionId,
      { next_status: "shipped", scheduled_at: null }
    )).outcome,
    "invalid_transition"
  );
  await transitionCommissionDelivery(db, commissionId, { next_status: "ready", scheduled_at: null });
  const future = new Date("2026-10-12T18:00:00.000Z");
  const scheduled = await transitionCommissionDelivery(
    db,
    commissionId,
    { next_status: "scheduled", scheduled_at: future },
    { now: () => fixedNow }
  );
  assert.equal(scheduled.outcome, "success");
  assert.equal(scheduled.delivery.scheduled_at.toISOString(), future.toISOString());
  const pickedUp = await transitionCommissionDelivery(
    db,
    commissionId,
    { next_status: "picked_up", scheduled_at: null },
    { now: () => new Date("2026-10-12T19:00:00.000Z") }
  );
  assert.equal(pickedUp.outcome, "success");

  assert.equal(
    normalizeDeliveryTransition({ next_status: "scheduled", scheduled_at: fixedNow }, fixedNow).error,
    "Scheduled date and time must be valid and in the future."
  );
  assert.equal(
    normalizeDeliveryTransition({ next_status: "in_storage" }, fixedNow).error,
    "Unsupported Delivery transition."
  );
});

test("shipping rejects pickup-only scheduling transitions", async () => {
  await releaseCommission();
  await createDelivery("shipping");
  await transitionCommissionDelivery(db, commissionId, { next_status: "ready", scheduled_at: null });
  assert.equal(
    (await transitionCommissionDelivery(
      db,
      commissionId,
      {
        next_status: "scheduled",
        scheduled_at: new Date("2026-10-12T18:00:00.000Z")
      }
    )).outcome,
    "invalid_transition"
  );
});

test("operational edits are pre-terminal, method-safe, and financially isolated", async () => {
  await releaseCommission();
  await createDelivery("shipping");
  const before = (await db.pool.query(
    "SELECT shipping, price, sales_tax, deposit_amount, amount_paid, balance FROM commissions WHERE id = $1",
    [commissionId]
  )).rows[0];
  const obligationCount = (await db.pool.query(
    "SELECT count(*)::integer AS count FROM commission_obligations"
  )).rows[0].count;
  const normalized = normalizeDeliveryUpdate({
    actual_shipping_cost: "42.50",
    protection_cost: "8",
    tracking_number: "TRACK-100"
  });
  assert.equal(normalized.error, undefined);
  const updated = await updateCommissionDelivery(db, commissionId, normalized.delivery);
  assert.equal(updated.outcome, "success");
  assert.equal(updated.delivery.actual_shipping_cost, "42.50");
  assert.equal(updated.delivery.protection_cost, "8.00");
  assert.deepEqual((await db.pool.query(
    "SELECT shipping, price, sales_tax, deposit_amount, amount_paid, balance FROM commissions WHERE id = $1",
    [commissionId]
  )).rows[0], before);
  assert.equal(
    (await db.pool.query("SELECT count(*)::integer AS count FROM payments")).rows[0].count,
    0
  );
  assert.equal(
    (await db.pool.query("SELECT count(*)::integer AS count FROM payment_allocations")).rows[0].count,
    0
  );
  assert.equal(
    (await db.pool.query("SELECT count(*)::integer AS count FROM commission_obligations")).rows[0].count,
    obligationCount
  );

  assert.equal(normalizeDeliveryUpdate({ delivery_method: "pickup" }).error, "Unsupported field: delivery_method.");
  await transitionCommissionDelivery(db, commissionId, { next_status: "ready", scheduled_at: null });
  await transitionCommissionDelivery(db, commissionId, { next_status: "cancelled", scheduled_at: null });
  assert.equal(
    (await updateCommissionDelivery(db, commissionId, { notes: "Too late" })).outcome,
    "terminal"
  );
});

test("pickup rejects actual fulfillment costs", async () => {
  await releaseCommission();
  await createDelivery("pickup");
  assert.equal(
    (await updateCommissionDelivery(db, commissionId, {
      actual_shipping_cost: "1.00"
    })).outcome,
    "costs_not_allowed_for_pickup"
  );
});

test("concurrent transitions produce one winner and one audit event", async () => {
  await releaseCommission();
  await createDelivery("shipping");
  const results = await Promise.all([
    transitionCommissionDelivery(db, commissionId, { next_status: "ready", scheduled_at: null }),
    transitionCommissionDelivery(db, commissionId, { next_status: "ready", scheduled_at: null })
  ]);
  assert.deepEqual(results.map((result) => result.outcome).sort(), [
    "invalid_transition", "success"
  ]);
  const readyEvents = (await events()).filter((event) => event.event_type === "delivery_ready");
  assert.equal(readyEvents.length, 1);
});

test("event failure rolls back the Delivery transition atomically", async () => {
  await releaseCommission();
  await createDelivery("shipping");
  await assert.rejects(
    transitionCommissionDelivery(
      db,
      commissionId,
      { next_status: "ready", scheduled_at: null },
      { actorType: "invalid_actor" }
    ),
    (error) => error.code === "23514"
  );
  assert.equal((await db.pool.query(
    "SELECT delivery_status FROM deliveries WHERE commission_id = $1",
    [commissionId]
  )).rows[0].delivery_status, "pending");
  assert.equal(
    (await events()).filter((event) => event.event_type === "delivery_ready").length,
    0
  );
});

test("cancellation is terminal and does not mutate Commission, Production, obligations, Payments, or Documents", async () => {
  await releaseCommission(commissionId, "satisfied");
  await createDelivery("pickup");
  const before = {
    commission: (await db.pool.query("SELECT * FROM commissions WHERE id = $1", [commissionId])).rows[0],
    production: (await db.pool.query("SELECT * FROM commission_production WHERE commission_id = $1", [commissionId])).rows[0],
    obligations: (await db.pool.query("SELECT * FROM commission_obligations WHERE commission_id = $1", [commissionId])).rows,
    payments: (await db.pool.query("SELECT * FROM payments WHERE commission_id = $1", [commissionId])).rows,
    documents: (await db.pool.query("SELECT * FROM documents WHERE commission_id = $1", [commissionId])).rows
  };
  const cancelled = await transitionCommissionDelivery(
    db,
    commissionId,
    { next_status: "cancelled", scheduled_at: null }
  );
  assert.equal(cancelled.outcome, "success");
  assert.equal(cancelled.delivery.delivery_status, "cancelled");
  assert.equal((await transitionCommissionDelivery(
    db,
    commissionId,
    { next_status: "ready", scheduled_at: null }
  )).outcome, "terminal");
  const after = {
    commission: (await db.pool.query("SELECT * FROM commissions WHERE id = $1", [commissionId])).rows[0],
    production: (await db.pool.query("SELECT * FROM commission_production WHERE commission_id = $1", [commissionId])).rows[0],
    obligations: (await db.pool.query("SELECT * FROM commission_obligations WHERE commission_id = $1", [commissionId])).rows,
    payments: (await db.pool.query("SELECT * FROM payments WHERE commission_id = $1", [commissionId])).rows,
    documents: (await db.pool.query("SELECT * FROM documents WHERE commission_id = $1", [commissionId])).rows
  };
  assert.deepEqual(after, before);
  assert.equal((await events()).at(-1).event_type, "delivery_cancelled");
});

test("Admin API supports protected create, edit, and transition routes with stable errors", async () => {
  assert.equal(
    getCommissionDeliveryTransitionId(`/admin/api/commissions/${commissionId}/delivery/transition`),
    String(commissionId)
  );
  const base = `/admin/api/commissions/${commissionId}/delivery`;
  assert.equal((await request("POST", base, deliveryPayload("shipping"), false)).status, 401);
  assert.equal((await request("POST", base, deliveryPayload("shipping"))).status, 409);
  await releaseCommission();
  let response = await request("POST", base, deliveryPayload("shipping"));
  assert.equal(response.status, 201);
  assert.equal((await response.json()).delivery.delivery_status, "pending");
  response = await request("PATCH", base, { tracking_number: "TRACK-API" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).delivery.tracking_number, "TRACK-API");
  response = await request("POST", `${base}/transition`, { next_status: "ready" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).delivery.delivery_status, "ready");
  assert.equal((await request("POST", `${base}/transition`, { next_status: "delivered" })).status, 409);
  assert.equal((await request("DELETE", base)).status, 405);
});
