import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";

import { getDatabase } from "@netlify/database";
import { NetlifyDB } from "@netlify/database-dev";

import {
  config,
  createHandler,
  getCommissionDeliveryStorageAction
} from "../../netlify/functions/admin-commissions.mjs";
import {
  addStorageCalendarDays,
  calculateStorageState,
  createCommissionDelivery,
  enterCommissionStorage,
  recordStorageNotice,
  syncStorageFeeObligation,
  transitionCommissionDelivery
} from "../../netlify/shared/commission-delivery.mjs";
import {
  commissionEventTypes
} from "../../netlify/shared/commission-events.mjs";
import {
  COOKIE_NAME,
  createSessionToken
} from "../../netlify/shared/admin-session.mjs";

const fixedNow = new Date("2026-10-11T18:30:00.000Z");
const password = "phase-34-password";
const secret = "phase-34-secret";
let database;
let db;
let clientId;
let commissionId;
let sessionCookie;
let requestNow;
let handler;

before(async () => {
  database = new NetlifyDB({ logger: () => {} });
  const connectionString = await database.start();
  await database.applyMigrations("./netlify/database/migrations");
  db = getDatabase({ connectionString });
  sessionCookie = `${COOKIE_NAME}=${await createSessionToken(password, secret)}`;
  handler = createHandler({
    databaseFactory: () => db,
    environmentReader(name) {
      return { ADMIN_PASSWORD: password, ADMIN_SESSION_SECRET: secret }[name];
    },
    now: () => requestNow
  });
});

beforeEach(async () => {
  requestNow = new Date(fixedNow);
  clientId = (await db.pool.query(
    "INSERT INTO clients (full_name, email) VALUES ('Storage Client', 'storage@example.invalid') RETURNING id"
  )).rows[0].id;
  commissionId = (await db.pool.query(
    `INSERT INTO commissions (
       commission_number, client_id, title, description, medium,
       price, sales_tax, shipping, status
     ) VALUES (
       'SAS-COM-2026-9891', $1, 'Storage Workflow',
       'Phase 10C storage test', 'Oil', 500, 30, 25, 'completed'
     ) RETURNING id`,
    [clientId]
  )).rows[0].id;
  await db.pool.query(
    `INSERT INTO commission_production (
       commission_id, production_status, completed_at
     ) VALUES ($1, 'completed', $2)`,
    [commissionId, fixedNow]
  );
  await db.pool.query(
    `INSERT INTO commission_obligations (
       commission_id, obligation_type, obligation_status, amount, satisfied_at
     ) VALUES ($1, 'final_balance', 'satisfied', 500, $2)`,
    [commissionId, fixedNow]
  );
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

function deliveryPayload(method = "pickup") {
  return {
    delivery_method: method,
    recipient_name: "Storage Recipient",
    address_line1: method === "shipping" ? "100 Delivery Avenue" : null,
    address_line2: null,
    city: method === "shipping" ? "Pittsburgh" : null,
    state_region: method === "shipping" ? "PA" : null,
    postal_code: method === "shipping" ? "15222" : null,
    country: method === "shipping" ? "US" : null,
    carrier: method === "shipping" ? "Test Carrier" : null,
    service_level: method === "shipping" ? "Ground" : null,
    tracking_number: null,
    notes: null
  };
}

async function createReadyDelivery(method = "pickup") {
  await createCommissionDelivery(db, commissionId, deliveryPayload(method), {
    now: () => fixedNow
  });
  await transitionCommissionDelivery(
    db,
    commissionId,
    { next_status: "ready", scheduled_at: null },
    { now: () => fixedNow }
  );
  return (await db.pool.query(
    "SELECT * FROM deliveries WHERE commission_id = $1",
    [commissionId]
  )).rows[0];
}

async function enterStorage(method = "pickup") {
  await createReadyDelivery(method);
  return enterCommissionStorage(db, commissionId, { now: () => fixedNow });
}

function adminRequest(method, suffix = "", body) {
  return handler(new Request(
    `http://localhost/admin/api/commissions/${commissionId}/delivery${suffix}`,
    {
      method,
      headers: {
        Cookie: sessionCookie,
        ...(body === undefined ? {} : { "Content-Type": "application/json" })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    }
  ));
}

async function storageEvents() {
  return (await db.pool.query(
    `SELECT event_type, payload FROM commission_events
     WHERE commission_id = $1
       AND event_type LIKE '%storage%'
     ORDER BY id`,
    [commissionId]
  )).rows;
}

test("migration adds Storage timestamps, canonical obligation uniqueness, and controlled Events", async () => {
  const columns = new Map((await db.pool.query(
    `SELECT column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_name = 'deliveries'`
  )).rows.map((row) => [row.column_name, row]));
  for (const name of [
    "storage_notice_at", "storage_fee_start_at", "final_notice_at",
    "abandonment_eligible_at", "abandoned_at"
  ]) {
    assert.equal(columns.get(name).data_type, "timestamp with time zone");
    assert.equal(columns.get(name).is_nullable, "YES");
  }
  const indexes = (await db.pool.query(
    "SELECT indexname FROM pg_indexes WHERE tablename = 'commission_obligations'"
  )).rows.map((row) => row.indexname);
  assert.ok(indexes.includes("commission_obligations_storage_delivery_unique"));
  for (const eventType of [
    "delivery_in_storage", "storage_notice_recorded", "storage_fee_created",
    "storage_fee_updated", "storage_final_notice_recorded"
  ]) assert.ok(commissionEventTypes.includes(eventType), eventType);
  assert.equal(commissionEventTypes.includes("abandonment_review_eligible"), false);
  assert.ok(config.path.includes("/admin/api/commissions/:id/delivery/storage"));
  assert.deepEqual(
    getCommissionDeliveryStorageAction(`/admin/api/commissions/${commissionId}/delivery/final-notice`),
    { commissionId: String(commissionId), action: "final-notice" }
  );
});

test("ready Delivery enters Storage atomically with server timestamps and no immediate fee", async () => {
  await createReadyDelivery("pickup");
  const result = await enterCommissionStorage(db, commissionId, { now: () => fixedNow });
  assert.equal(result.outcome, "success");
  assert.equal(result.delivery.delivery_status, "in_storage");
  assert.equal(result.delivery.storage_start_at.toISOString(), fixedNow.toISOString());
  assert.equal(
    result.delivery.storage_fee_start_at.toISOString(),
    "2026-11-10T19:30:00.000Z"
  );
  assert.equal(result.delivery.storage_state.billable_weeks, 0);
  assert.equal(result.delivery.storage_state.estimated_storage_fee, "0.00");
  assert.equal((await db.pool.query(
    "SELECT count(*)::integer AS count FROM commission_obligations WHERE obligation_type = 'storage_fee'"
  )).rows[0].count, 0);
  assert.deepEqual((await storageEvents()).map((event) => event.event_type), [
    "delivery_in_storage"
  ]);
});

test("Storage entry permits only approved pickup and shipping source states", async () => {
  await createCommissionDelivery(db, commissionId, deliveryPayload("pickup"), {
    now: () => fixedNow
  });
  assert.equal((await enterCommissionStorage(db, commissionId)).outcome, "invalid_transition");
  for (const status of ["shipped", "delivered", "picked_up", "cancelled"]) {
    await db.pool.query(
      "UPDATE deliveries SET delivery_status = $2 WHERE commission_id = $1",
      [commissionId, status]
    );
    assert.equal((await enterCommissionStorage(db, commissionId)).outcome, "invalid_transition");
  }
  await db.pool.query(
    "UPDATE deliveries SET delivery_method = 'shipping', delivery_status = 'ready' WHERE commission_id = $1",
    [commissionId]
  );
  assert.equal((await enterCommissionStorage(db, commissionId)).outcome, "success");
});

test("Storage fee calculation uses 30 free calendar days and $10 per week or fraction", () => {
  const feeStart = addStorageCalendarDays(fixedNow, 30);
  const delivery = {
    delivery_status: "in_storage",
    storage_start_at: fixedNow,
    storage_fee_start_at: feeStart
  };
  for (const [days, expectedWeeks, expectedFee] of [
    [0, 0, "0.00"],
    [1, 1, "10.00"],
    [7, 1, "10.00"],
    [8, 2, "20.00"],
    [14, 2, "20.00"],
    [15, 3, "30.00"]
  ]) {
    const state = calculateStorageState(
      delivery,
      addStorageCalendarDays(feeStart, days)
    );
    assert.equal(state.billable_weeks, expectedWeeks, `${days} days`);
    assert.equal(state.estimated_storage_fee, expectedFee, `${days} days`);
  }
  const fraction = calculateStorageState(delivery, new Date(feeStart.getTime() + 1));
  assert.equal(fraction.billable_weeks, 1);
  assert.equal(fraction.estimated_storage_fee, "10.00");
});

test("Storage fee sync creates one obligation, grows monotonically, and is concurrency-safe", async () => {
  const entered = await enterStorage();
  const feeStart = entered.delivery.storage_fee_start_at;
  const weekOne = addStorageCalendarDays(feeStart, 1);
  assert.equal((await syncStorageFeeObligation(db, commissionId, {
    now: () => weekOne
  })).outcome, "created");
  assert.equal((await syncStorageFeeObligation(db, commissionId, {
    now: () => weekOne
  })).outcome, "unchanged");

  const weekTwo = addStorageCalendarDays(feeStart, 8);
  assert.equal((await syncStorageFeeObligation(db, commissionId, {
    now: () => weekTwo
  })).outcome, "updated");
  await syncStorageFeeObligation(db, commissionId, { now: () => weekOne });
  assert.equal((await db.pool.query(
    `SELECT count(*)::integer AS count, max(amount)::TEXT AS amount
     FROM commission_obligations WHERE obligation_type = 'storage_fee'`
  )).rows[0].amount, "20.00");

  const weekThree = addStorageCalendarDays(feeStart, 15);
  const concurrent = await Promise.all([
    syncStorageFeeObligation(db, commissionId, { now: () => weekThree }),
    syncStorageFeeObligation(db, commissionId, { now: () => weekThree })
  ]);
  assert.equal(concurrent.filter((result) => result.outcome === "updated").length, 1);
  assert.equal((await db.pool.query(
    "SELECT count(*)::integer AS count FROM commission_obligations WHERE obligation_type = 'storage_fee'"
  )).rows[0].count, 1);
  assert.equal((await db.pool.query(
    "SELECT amount::TEXT FROM commission_obligations WHERE obligation_type = 'storage_fee'"
  )).rows[0].amount, "30.00");
  assert.deepEqual((await storageEvents()).map((event) => event.event_type), [
    "delivery_in_storage", "storage_fee_created", "storage_fee_updated",
    "storage_fee_updated"
  ]);
  assert.equal((await db.pool.query(
    "SELECT count(*)::integer AS count FROM payments"
  )).rows[0].count, 0);
  assert.equal((await db.pool.query(
    "SELECT count(*)::integer AS count FROM payment_allocations"
  )).rows[0].count, 0);
});

test("an open Storage Fee blocks physical release but valid non-release exits remain available", async () => {
  const entered = await enterStorage("pickup");
  const feeNow = addStorageCalendarDays(entered.delivery.storage_fee_start_at, 1);
  const blocked = await transitionCommissionDelivery(
    db,
    commissionId,
    { next_status: "picked_up", scheduled_at: null },
    { now: () => feeNow }
  );
  assert.equal(blocked.outcome, "canonical_obligations_outstanding");
  assert.equal((await db.pool.query(
    "SELECT delivery_status FROM deliveries WHERE commission_id = $1",
    [commissionId]
  )).rows[0].delivery_status, "in_storage");
  assert.equal((await db.pool.query(
    "SELECT amount::TEXT FROM commission_obligations WHERE obligation_type = 'storage_fee'"
  )).rows[0].amount, "10.00");

  const scheduled = await transitionCommissionDelivery(
    db,
    commissionId,
    { next_status: "scheduled", scheduled_at: addStorageCalendarDays(feeNow, 1) },
    { now: () => feeNow }
  );
  assert.equal(scheduled.outcome, "success");
  const stillBlocked = await transitionCommissionDelivery(
    db,
    commissionId,
    { next_status: "picked_up", scheduled_at: null },
    { now: () => addStorageCalendarDays(feeNow, 1) }
  );
  assert.equal(stillBlocked.outcome, "canonical_obligations_outstanding");
});

test("shipping can leave Storage through ready while direct shipment still honors obligations", async () => {
  let entered = await enterStorage("shipping");
  const ready = await transitionCommissionDelivery(
    db,
    commissionId,
    { next_status: "ready", scheduled_at: null },
    { now: () => addStorageCalendarDays(entered.delivery.storage_start_at, 10) }
  );
  assert.equal(ready.outcome, "success");

  const reentryTime = addStorageCalendarDays(entered.delivery.storage_start_at, 11);
  entered = await enterCommissionStorage(db, commissionId, {
    now: () => reentryTime
  });
  const feeNow = addStorageCalendarDays(entered.delivery.storage_fee_start_at, 1);
  assert.equal((await transitionCommissionDelivery(
    db,
    commissionId,
    { next_status: "shipped", scheduled_at: null },
    { now: () => feeNow }
  )).outcome, "canonical_obligations_outstanding");
});

test("Storage and Final Written Notices are server-timestamped, idempotent, and never abandon automatically", async () => {
  const entered = await enterStorage();
  const noticeTime = addStorageCalendarDays(entered.delivery.storage_start_at, 35);
  let result = await recordStorageNotice(db, commissionId, { now: () => noticeTime });
  assert.equal(result.outcome, "success");
  assert.equal(result.delivery.storage_notice_at.toISOString(), noticeTime.toISOString());
  assert.equal((await recordStorageNotice(db, commissionId, {
    now: () => addStorageCalendarDays(noticeTime, 1)
  })).outcome, "idempotent");

  const finalNoticeTime = addStorageCalendarDays(noticeTime, 3);
  result = await recordStorageNotice(db, commissionId, {
    now: () => finalNoticeTime,
    final: true
  });
  const eligibilityTime = addStorageCalendarDays(finalNoticeTime, 180);
  assert.equal(result.delivery.final_notice_at.toISOString(), finalNoticeTime.toISOString());
  assert.equal(
    result.delivery.abandonment_eligible_at.toISOString(),
    eligibilityTime.toISOString()
  );
  assert.equal(calculateStorageState(
    result.delivery,
    new Date(eligibilityTime.getTime() - 1)
  ).abandonment_eligible, false);
  assert.equal(calculateStorageState(
    result.delivery,
    eligibilityTime
  ).abandonment_eligible, true);
  assert.equal((await recordStorageNotice(db, commissionId, {
    now: () => addStorageCalendarDays(finalNoticeTime, 1),
    final: true
  })).outcome, "idempotent");
  const row = (await db.pool.query(
    `SELECT abandoned_at, count(*) OVER ()::integer AS count
     FROM deliveries WHERE commission_id = $1`,
    [commissionId]
  )).rows[0];
  assert.equal(row.abandoned_at, null);
  assert.deepEqual((await storageEvents()).map((event) => event.event_type), [
    "delivery_in_storage", "storage_fee_created", "storage_notice_recorded",
    "storage_fee_updated", "storage_final_notice_recorded"
  ]);
  assert.equal((await db.pool.query(
    "SELECT count(*)::integer AS count FROM commission_events WHERE event_type = 'abandonment_review_eligible'"
  )).rows[0].count, 0);
});

test("Storage transition, fee sync, and notices roll back when their Event cannot be appended", async () => {
  await createReadyDelivery();
  await assert.rejects(
    enterCommissionStorage(db, commissionId, {
      now: () => fixedNow,
      actorType: "invalid_actor"
    }),
    (error) => error.code === "23514"
  );
  assert.equal((await db.pool.query(
    "SELECT delivery_status FROM deliveries WHERE commission_id = $1",
    [commissionId]
  )).rows[0].delivery_status, "ready");

  await enterCommissionStorage(db, commissionId, { now: () => fixedNow });
  const feeNow = addStorageCalendarDays(fixedNow, 31);
  await assert.rejects(
    syncStorageFeeObligation(db, commissionId, {
      now: () => feeNow,
      actorType: "invalid_actor"
    }),
    (error) => error.code === "23514"
  );
  assert.equal((await db.pool.query(
    "SELECT count(*)::integer AS count FROM commission_obligations WHERE obligation_type = 'storage_fee'"
  )).rows[0].count, 0);
  await assert.rejects(
    recordStorageNotice(db, commissionId, {
      now: () => feeNow,
      actorType: "invalid_actor"
    }),
    (error) => error.code === "23514"
  );
  assert.equal((await db.pool.query(
    "SELECT storage_notice_at FROM deliveries WHERE commission_id = $1",
    [commissionId]
  )).rows[0].storage_notice_at, null);
});

test("Admin Storage endpoints mutate explicitly while GET remains a read-only derived view", async () => {
  await createReadyDelivery();
  let response = await adminRequest("POST", "/storage");
  assert.equal(response.status, 200);
  let body = await response.json();
  assert.equal(body.delivery.delivery_status, "in_storage");
  assert.equal(body.delivery.storage_state.billable_weeks, 0);

  requestNow = addStorageCalendarDays(fixedNow, 31);
  const before = (await db.pool.query(
    "SELECT count(*)::integer AS count FROM commission_obligations WHERE obligation_type = 'storage_fee'"
  )).rows[0].count;
  response = await adminRequest("GET");
  body = await response.json();
  assert.equal(body.delivery.storage_state.estimated_storage_fee, "10.00");
  assert.equal((await db.pool.query(
    "SELECT count(*)::integer AS count FROM commission_obligations WHERE obligation_type = 'storage_fee'"
  )).rows[0].count, before);

  response = await adminRequest("POST", "/storage-notice");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).delivery.storage_notice_at, requestNow.toISOString());
  response = await adminRequest("POST", "/final-notice");
  assert.equal(response.status, 200);
  body = await response.json();
  assert.equal(body.delivery.final_notice_at, requestNow.toISOString());
  assert.equal(body.delivery.abandoned_at, null);
});
