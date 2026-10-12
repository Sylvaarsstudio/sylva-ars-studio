import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, afterEach, before, beforeEach, test } from "node:test";

import { getDatabase } from "@netlify/database";
import { NetlifyDB } from "@netlify/database-dev";

import {
  createCommission,
  createHandler,
  getCommissionDeliveryId
} from "../../netlify/functions/admin-commissions.mjs";
import {
  deliveryMethods,
  deliveryStatuses,
  readCommissionDelivery
} from "../../netlify/shared/commission-delivery.mjs";
import {
  COOKIE_NAME,
  createSessionToken
} from "../../netlify/shared/admin-session.mjs";

const migrationPath = new URL(
  "../../netlify/database/migrations/20261011180000_create_deliveries.sql",
  import.meta.url
);

let database;
let db;
let clientId;
let commissionId;
let paymentId;
let handler;
let sessionCookie;

before(async () => {
  database = new NetlifyDB({ logger: () => {} });
  const connectionString = await database.start();
  await database.applyMigrations("./netlify/database/migrations");
  db = getDatabase({ connectionString });
  const password = "phase-30-password";
  const secret = "phase-30-secret";
  handler = createHandler({
    databaseFactory: () => db,
    environmentReader(name) {
      return { ADMIN_PASSWORD: password, ADMIN_SESSION_SECRET: secret }[name];
    }
  });
  sessionCookie = `${COOKIE_NAME}=${await createSessionToken(password, secret)}`;
});

beforeEach(async () => {
  clientId = (await db.pool.query(
    "INSERT INTO clients (full_name, email) VALUES ('Delivery Client', 'delivery@example.invalid') RETURNING id"
  )).rows[0].id;
  commissionId = (await db.pool.query(
    `INSERT INTO commissions (
       commission_number, client_id, title, description, medium,
       price, sales_tax, shipping, status
     ) VALUES (
       'SAS-COM-2026-9801', $1, 'Delivery Foundation',
       'Phase 10A delivery test', 'Oil', 500, 30, 25, 'completed'
     ) RETURNING id`,
    [clientId]
  )).rows[0].id;
  paymentId = (await db.pool.query(
    `INSERT INTO payments (
       commission_id, payment_type, amount, status, request_id
     ) VALUES ($1, 'balance', 100, 'completed', $2)
     RETURNING id`,
    [commissionId, randomUUID()]
  )).rows[0].id;
});

afterEach(async () => {
  await db.pool.query("DELETE FROM deliveries");
  await db.pool.query("DELETE FROM payment_allocations");
  await db.pool.query("DELETE FROM commission_obligations");
  await db.pool.query("DELETE FROM acceptances");
  await db.pool.query("DELETE FROM documents");
  await db.pool.query("DELETE FROM quotations");
  await db.pool.query("DELETE FROM payments");
  await db.pool.query("TRUNCATE commission_events RESTART IDENTITY");
  await db.pool.query("DELETE FROM commission_production");
  await db.pool.query("DELETE FROM commission_inquiries");
  await db.pool.query("DELETE FROM commissions");
  await db.pool.query("DELETE FROM clients");
});

after(async () => {
  await db?.pool.end();
  await database?.stop();
});

function adminRequest(method = "GET", id = commissionId, authenticated = true) {
  return handler(new Request(
    `http://localhost/admin/api/commissions/${id}/delivery`,
    {
      method,
      headers: authenticated ? { Cookie: sessionCookie } : {}
    }
  ));
}

async function insertDelivery(overrides = {}) {
  const values = {
    commissionId,
    method: "shipping",
    status: "pending",
    recipient: "Historical Recipient",
    line1: "100 Delivery Avenue",
    line2: null,
    city: "Pittsburgh",
    state: "PA",
    postalCode: "15222",
    country: "US",
    carrier: "Test Carrier",
    serviceLevel: "Ground",
    trackingNumber: "TRACK-001",
    actualShippingCost: "42.50",
    protectionCost: "8.00",
    ...overrides
  };
  return (await db.pool.query(
    `INSERT INTO deliveries (
       commission_id, delivery_method, delivery_status,
       recipient_name, address_line1, address_line2, city, state_region,
       postal_code, country, carrier, service_level, tracking_number,
       actual_shipping_cost, protection_cost
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
     ) RETURNING *`,
    [
      values.commissionId, values.method, values.status, values.recipient,
      values.line1, values.line2, values.city, values.state, values.postalCode,
      values.country, values.carrier, values.serviceLevel, values.trackingNumber,
      values.actualShippingCost, values.protectionCost
    ]
  )).rows[0];
}

test("phase 10A migration creates the approved zero-or-one Delivery schema", async () => {
  const columns = new Map((await db.pool.query(
    `SELECT column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_name = 'deliveries'`
  )).rows.map((row) => [row.column_name, row]));
  for (const name of [
    "id", "commission_id", "delivery_method", "delivery_status",
    "recipient_name", "address_line1", "address_line2", "city",
    "state_region", "postal_code", "country", "carrier", "service_level",
    "tracking_number", "actual_shipping_cost", "protection_cost", "ready_at",
    "scheduled_at", "shipped_at", "delivered_at", "picked_up_at",
    "storage_start_at", "notes", "created_at", "updated_at"
  ]) assert.ok(columns.has(name), name);
  assert.equal(columns.get("commission_id").is_nullable, "NO");
  assert.equal(columns.get("actual_shipping_cost").data_type, "numeric");

  const foreignKey = (await db.pool.query(
    `SELECT delete_rule
     FROM information_schema.referential_constraints
     WHERE constraint_name = 'deliveries_commission_id_fkey'`
  )).rows[0];
  assert.equal(foreignKey.delete_rule, "RESTRICT");

  await insertDelivery();
  await assert.rejects(insertDelivery({ method: "pickup" }), (error) => error.code === "23505");
});

test("database controls Delivery method, status, defaults, and non-negative actual costs", async () => {
  for (const method of deliveryMethods) {
    const row = await insertDelivery({ method, actualShippingCost: null, protectionCost: null });
    assert.equal(row.delivery_status, "pending");
    await db.pool.query("DELETE FROM deliveries WHERE id = $1", [row.id]);
  }
  for (const status of deliveryStatuses) {
    const row = await insertDelivery({ status });
    assert.equal(row.delivery_status, status);
    await db.pool.query("DELETE FROM deliveries WHERE id = $1", [row.id]);
  }
  await assert.rejects(insertDelivery({ method: "courier" }), (error) => error.code === "23514");
  await assert.rejects(insertDelivery({ status: "completed" }), (error) => error.code === "23514");
  await assert.rejects(insertDelivery({ actualShippingCost: "-0.01" }), (error) => error.code === "23514");
  await assert.rejects(insertDelivery({ protectionCost: "-0.01" }), (error) => error.code === "23514");
});

test("existing Commission is valid without Delivery and migration performs no backfill", async () => {
  const result = await readCommissionDelivery(db, commissionId);
  const migration = readFileSync(migrationPath, "utf8");
  assert.deepEqual(result, { initialized: false, delivery: null });
  assert.doesNotMatch(migration, /INSERT\s+INTO\s+deliveries[\s\S]*SELECT/i);
});

test("Commission creation does not create or infer a Delivery", async () => {
  const created = await createCommission(db, {
    client_id: String(clientId),
    title: "No Automatic Delivery",
    description: "Delivery remains uninitialized.",
    medium: "Oil",
    width: "20.00",
    height: "24.00",
    price: "400.00",
    sales_tax: "24.00",
    shipping: "20.00",
    estimated_completion: null,
    origin_inquiry_id: null
  }, 2026);
  assert.equal(created.outcome, "success");
  assert.deepEqual(await readCommissionDelivery(db, created.commission.id), {
    initialized: false,
    delivery: null
  });
});

test("populated Delivery read model preserves historical destination and actual fulfillment costs", async () => {
  await insertDelivery({ status: "shipped" });
  const result = await readCommissionDelivery(db, commissionId);
  assert.equal(result.initialized, true);
  assert.deepEqual({
    method: result.delivery.delivery_method,
    status: result.delivery.delivery_status,
    recipient: result.delivery.recipient_name,
    address: [
      result.delivery.address_line1,
      result.delivery.city,
      result.delivery.state_region,
      result.delivery.postal_code,
      result.delivery.country
    ],
    carrier: result.delivery.carrier,
    service: result.delivery.service_level,
    tracking: result.delivery.tracking_number,
    actualShippingCost: result.delivery.actual_shipping_cost,
    protectionCost: result.delivery.protection_cost
  }, {
    method: "shipping",
    status: "shipped",
    recipient: "Historical Recipient",
    address: ["100 Delivery Avenue", "Pittsburgh", "PA", "15222", "US"],
    carrier: "Test Carrier",
    service: "Ground",
    tracking: "TRACK-001",
    actualShippingCost: "42.50",
    protectionCost: "8.00"
  });
  assert.equal(await readCommissionDelivery(db, 999999), null);
});

test("Commission foreign key uses RESTRICT", async () => {
  await insertDelivery();
  await assert.rejects(
    db.pool.query("DELETE FROM commissions WHERE id = $1", [commissionId]),
    (error) => error.code === "23503"
  );
});

test("Delivery foundation API preserves Admin auth and exposes release eligibility", async () => {
  assert.equal(
    getCommissionDeliveryId(`/admin/api/commissions/${commissionId}/delivery`),
    String(commissionId)
  );
  assert.equal((await adminRequest("GET", commissionId, false)).status, 401);
  let response = await adminRequest();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    success: true,
    commission_id: String(commissionId),
    initialized: false,
    delivery: null,
    release_eligibility: {
      eligible: false,
      reason: "production_not_completed",
      message: "Canonical Production must be completed before Delivery can be created."
    }
  });

  await insertDelivery({ status: "ready" });
  response = await adminRequest();
  const body = await response.json();
  assert.equal(body.initialized, true);
  assert.equal(body.delivery.delivery_status, "ready");
  assert.equal(body.delivery.actual_shipping_cost, "42.50");
  assert.equal((await adminRequest("DELETE")).status, 405);
  assert.equal((await adminRequest("GET", 999999)).status, 404);
});

test("Delivery reads do not alter commercial shipping, financial records, Events, or Next Action", async () => {
  const before = {
    commission: (await db.pool.query(
      "SELECT shipping, deposit_amount, amount_paid, balance FROM commissions WHERE id = $1",
      [commissionId]
    )).rows[0],
    payments: (await db.pool.query("SELECT count(*)::integer AS count FROM payments")).rows[0].count,
    obligations: (await db.pool.query("SELECT count(*)::integer AS count FROM commission_obligations")).rows[0].count,
    events: (await db.pool.query("SELECT count(*)::integer AS count FROM commission_events")).rows[0].count
  };
  await insertDelivery();
  await readCommissionDelivery(db, commissionId);
  const after = {
    commission: (await db.pool.query(
      "SELECT shipping, deposit_amount, amount_paid, balance FROM commissions WHERE id = $1",
      [commissionId]
    )).rows[0],
    payments: (await db.pool.query("SELECT count(*)::integer AS count FROM payments")).rows[0].count,
    obligations: (await db.pool.query("SELECT count(*)::integer AS count FROM commission_obligations")).rows[0].count,
    events: (await db.pool.query("SELECT count(*)::integer AS count FROM commission_events")).rows[0].count
  };
  assert.deepEqual(after, before);
  assert.equal(after.commission.shipping, "25.00");
  assert.equal(paymentId > 0, true);

  const nextActionSource = readFileSync(
    new URL("../../netlify/shared/commission-next-action.mjs", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(nextActionSource, /arrange_delivery|schedule_pickup|ship_artwork|mark_delivered|readCommissionDelivery/);
});
