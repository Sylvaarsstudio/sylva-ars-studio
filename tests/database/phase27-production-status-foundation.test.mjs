import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, afterEach, before, beforeEach, test } from "node:test";

import { getDatabase } from "@netlify/database";
import { NetlifyDB } from "@netlify/database-dev";

import {
  createCommission,
  createHandler
} from "../../netlify/functions/admin-commissions.mjs";
import {
  initializeCommissionProduction,
  productionStatuses,
  productionTransitionMap,
  readCommissionProduction,
  transitionCommissionProduction
} from "../../netlify/shared/commission-production.mjs";
import {
  COOKIE_NAME,
  createSessionToken
} from "../../netlify/shared/admin-session.mjs";

const migrationPath = new URL(
  "../../netlify/database/migrations/20261011160000_create_commission_production.sql",
  import.meta.url
);
const fixedTimes = {
  initialized: new Date("2026-10-11T14:00:00.000Z"),
  reserved: new Date("2026-10-11T15:00:00.000Z"),
  started: new Date("2026-10-11T16:00:00.000Z"),
  paused: new Date("2026-10-11T17:00:00.000Z"),
  resumed: new Date("2026-10-11T18:00:00.000Z"),
  presented: new Date("2026-10-11T19:00:00.000Z"),
  accepted: new Date("2026-10-11T20:00:00.000Z")
};

let database;
let db;
let clientId;
let commissionId;
let handler;
let sessionCookie;

before(async () => {
  database = new NetlifyDB({ logger: () => {} });
  const connectionString = await database.start();
  await database.applyMigrations("./netlify/database/migrations");
  db = getDatabase({ connectionString });
  const password = "phase-27-password";
  const secret = "phase-27-secret";
  handler = createHandler({
    databaseFactory: () => db,
    environmentReader(name) {
      return {
        ADMIN_PASSWORD: password,
        ADMIN_SESSION_SECRET: secret
      }[name];
    }
  });
  sessionCookie = `${COOKIE_NAME}=${await createSessionToken(password, secret)}`;
});

beforeEach(async () => {
  clientId = (await db.pool.query(
    "INSERT INTO clients (full_name, email) VALUES ('Production Client', 'production@example.invalid') RETURNING id"
  )).rows[0].id;
  commissionId = (await db.pool.query(
    `INSERT INTO commissions (
       commission_number, client_id, title, description, medium, price, status
     ) VALUES (
       'SAS-COM-2026-9701', $1, 'Legacy Production Test',
       'Production foundation test', 'Oil', 500, 'draft'
     ) RETURNING id`,
    [clientId]
  )).rows[0].id;
});

afterEach(async () => {
  await db.pool.query("TRUNCATE commission_events RESTART IDENTITY");
  await db.pool.query("DELETE FROM commission_production");
  await db.pool.query("DELETE FROM commissions");
  await db.pool.query("DELETE FROM clients");
});

after(async () => {
  await db?.pool.end();
  await database?.stop();
});

function clock(value) {
  return () => new Date(value);
}

async function initialize(id = commissionId) {
  return initializeCommissionProduction(db.pool, id, fixedTimes.initialized);
}

async function transition(nextStatus, value, id = commissionId) {
  return transitionCommissionProduction(db, id, nextStatus, {
    now: clock(value)
  });
}

async function events(id = commissionId) {
  return (await db.pool.query(
    `SELECT event_type, actor_type, payload
     FROM commission_events
     WHERE commission_id = $1
     ORDER BY id`,
    [id]
  )).rows;
}

function adminRequest(method = "GET", path = `/${commissionId}/production`, authenticated = true) {
  return handler(new Request(`http://localhost/admin/api/commissions${path}`, {
    method,
    headers: authenticated ? { Cookie: sessionCookie } : {}
  }));
}

test("phase 7 migration creates the canonical one-to-one production schema", async () => {
  const columns = new Map((await db.pool.query(
    `SELECT column_name, is_nullable, data_type
     FROM information_schema.columns
     WHERE table_name = 'commission_production'`
  )).rows.map((row) => [row.column_name, row]));
  for (const name of [
    "commission_id", "production_status", "paused_from_status",
    "reserved_at", "started_at", "final_presented_at", "final_accepted_at",
    "completed_at", "paused_at", "created_at", "updated_at"
  ]) assert.ok(columns.has(name), name);
  assert.equal(columns.get("commission_id").is_nullable, "NO");
  assert.equal(columns.get("production_status").is_nullable, "NO");
  const foreignKey = (await db.pool.query(
    `SELECT rc.delete_rule
     FROM information_schema.referential_constraints AS rc
     WHERE rc.constraint_name = 'commission_production_commission_id_fkey'`
  )).rows[0];
  assert.equal(foreignKey.delete_rule, "RESTRICT");
});

test("phase 7 enforces the canonical status and pause vocabularies", async () => {
  for (const status of productionStatuses) {
    await db.pool.query(
      `INSERT INTO commission_production (
         commission_id, production_status, paused_from_status
       ) VALUES ($1, $2, $3)`,
      [commissionId, status, status === "paused" ? "in_progress" : null]
    );
    await db.pool.query("DELETE FROM commission_production WHERE commission_id = $1", [commissionId]);
  }
  await assert.rejects(db.pool.query(
    "INSERT INTO commission_production (commission_id, production_status) VALUES ($1, 'approved')",
    [commissionId]
  ));
  await assert.rejects(db.pool.query(
    "INSERT INTO commission_production (commission_id, production_status) VALUES ($1, 'paused')",
    [commissionId]
  ));
  await assert.rejects(db.pool.query(
    `INSERT INTO commission_production (
       commission_id, production_status, paused_from_status
     ) VALUES ($1, 'in_progress', 'reserved')`,
    [commissionId]
  ));
});

test("phase 7 preserves legacy Commissions without inferring production or backfilling", async () => {
  const production = await readCommissionProduction(db, commissionId);
  const migration = readFileSync(migrationPath, "utf8");

  assert.equal(production.initialized, false);
  assert.equal(production.production_status, null);
  assert.doesNotMatch(migration, /INSERT\s+INTO\s+commission_production[\s\S]*SELECT/i);
});

test("new Commission creation initializes Production and its audit event atomically", async () => {
  const result = await createCommission(db, {
    client_id: String(clientId),
    title: "Canonical Production Commission",
    description: "Created after Phase 7",
    medium: "Oil",
    width: "20.00",
    height: "24.00",
    price: "400.00",
    sales_tax: "24.00",
    shipping: "20.00",
    estimated_completion: "2027-03-01",
    origin_inquiry_id: null
  }, 2026);
  const production = await readCommissionProduction(db, result.commission.id);
  const productionEvents = await events(result.commission.id);

  assert.equal(result.outcome, "success");
  assert.equal(result.commission.status, "draft");
  assert.equal(production.production_status, "not_started");
  assert.deepEqual(productionEvents.map((event) => event.event_type), ["production_initialized"]);
  assert.deepEqual(productionEvents[0].payload, {
    previous_status: null,
    new_status: "not_started"
  });
});

test("the backend owns one coherent production transition map", () => {
  assert.deepEqual(productionTransitionMap, {
    not_started: ["reserved"],
    reserved: ["in_progress", "paused"],
    in_progress: ["awaiting_client_review", "final_presented", "paused"],
    awaiting_client_review: ["revision_in_progress", "final_presented", "paused"],
    revision_in_progress: ["awaiting_client_review", "final_presented", "paused"],
    final_presented: ["revision_in_progress", "final_accepted"],
    final_accepted: [],
    paused: [],
    completed: [],
    cancelled: []
  });
});

test("valid transitions write their milestone and event without changing legacy status", async () => {
  await initialize();
  const result = await transition("reserved", fixedTimes.reserved);
  const legacy = (await db.pool.query(
    "SELECT status FROM commissions WHERE id = $1",
    [commissionId]
  )).rows[0];
  const productionEvents = await events();

  assert.equal(result.outcome, "success");
  assert.equal(result.production.production_status, "reserved");
  assert.equal(new Date(result.production.reserved_at).toISOString(), fixedTimes.reserved.toISOString());
  assert.equal(legacy.status, "draft");
  assert.equal(productionEvents.at(-1).event_type, "production_reserved");
  assert.deepEqual(productionEvents.at(-1).payload, {
    previous_status: "not_started",
    new_status: "reserved"
  });
});

test("invalid and ordinary cancellation transitions are blocked", async () => {
  await initialize();
  assert.equal((await transition("in_progress", fixedTimes.started)).outcome, "invalid_transition");
  assert.equal((await transition("cancelled", fixedTimes.started)).outcome, "invalid_transition");
  assert.equal((await readCommissionProduction(db, commissionId)).production_status, "not_started");
  assert.deepEqual((await events()).map((event) => event.event_type), ["production_initialized"]);
});

test("pause and resume preserve and restore the exact previous production state", async () => {
  await initialize();
  await transition("reserved", fixedTimes.reserved);
  const paused = await transition("paused", fixedTimes.paused);
  assert.equal(paused.production.production_status, "paused");
  assert.equal(paused.production.paused_from_status, "reserved");
  assert.equal((await transition("paused", fixedTimes.resumed)).outcome, "invalid_transition");
  assert.equal((await transition("in_progress", fixedTimes.resumed)).outcome, "invalid_transition");
  const resumed = await transition("reserved", fixedTimes.resumed);

  assert.equal(resumed.production.production_status, "reserved");
  assert.equal(resumed.production.paused_from_status, null);
  assert.equal(new Date(resumed.production.reserved_at).toISOString(), fixedTimes.reserved.toISOString());
  assert.equal(new Date(resumed.production.paused_at).toISOString(), fixedTimes.paused.toISOString());
  assert.deepEqual((await events()).slice(-2).map((event) => event.event_type), [
    "production_paused",
    "production_resumed"
  ]);
});

test("concurrent transitions cannot both leave not_started", async () => {
  await initialize();
  const results = await Promise.all([
    transition("reserved", fixedTimes.reserved),
    transition("reserved", fixedTimes.reserved)
  ]);
  assert.deepEqual(results.map((result) => result.outcome).sort(), [
    "invalid_transition",
    "success"
  ]);
  assert.equal((await readCommissionProduction(db, commissionId)).production_status, "reserved");
  assert.equal((await db.pool.query(
    `SELECT count(*)::integer AS count
     FROM commission_events
     WHERE commission_id = $1 AND event_type = 'production_reserved'`,
    [commissionId]
  )).rows[0].count, 1);
});

test("production state and event roll back together when event insertion fails", async () => {
  await initialize();
  await db.pool.query(`
    CREATE FUNCTION fail_phase27_event() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.event_type = 'production_reserved' THEN
        RAISE EXCEPTION 'phase 27 event failure';
      END IF;
      RETURN NEW;
    END;
    $$
  `);
  await db.pool.query(`
    CREATE TRIGGER fail_phase27_event_trigger
    BEFORE INSERT ON commission_events
    FOR EACH ROW EXECUTE FUNCTION fail_phase27_event()
  `);
  try {
    await assert.rejects(transition("reserved", fixedTimes.reserved), /phase 27 event failure/i);
  } finally {
    await db.pool.query("DROP TRIGGER fail_phase27_event_trigger ON commission_events");
    await db.pool.query("DROP FUNCTION fail_phase27_event()");
  }
  assert.equal((await readCommissionProduction(db, commissionId)).production_status, "not_started");
  assert.deepEqual((await events()).map((event) => event.event_type), ["production_initialized"]);
});

test("final acceptance records its milestone and completes Production atomically", async () => {
  await initialize();
  await transition("reserved", fixedTimes.reserved);
  await transition("in_progress", fixedTimes.started);
  await transition("final_presented", fixedTimes.presented);
  const result = await transition("final_accepted", fixedTimes.accepted);
  const productionEvents = await events();
  const legacy = (await db.pool.query(
    "SELECT status FROM commissions WHERE id = $1",
    [commissionId]
  )).rows[0];

  assert.equal(result.production.production_status, "completed");
  assert.equal(new Date(result.production.final_accepted_at).toISOString(), fixedTimes.accepted.toISOString());
  assert.equal(new Date(result.production.completed_at).toISOString(), fixedTimes.accepted.toISOString());
  assert.deepEqual(productionEvents.slice(-2).map((event) => event.event_type), [
    "production_final_accepted",
    "production_completed"
  ]);
  assert.deepEqual(productionEvents.slice(-2).map((event) => event.actor_type), [
    "admin",
    "system"
  ]);
  assert.equal(legacy.status, "draft");
  assert.equal((await transition("reserved", fixedTimes.accepted)).outcome, "invalid_transition");
});

test("production read API distinguishes legacy and initialized records and has no mutation route", async () => {
  let response = await adminRequest();
  let body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.production.initialized, false);
  assert.equal(body.production.production_status, null);

  await initialize();
  response = await adminRequest();
  body = await response.json();
  assert.equal(body.production.initialized, true);
  assert.equal(body.production.production_status, "not_started");
  assert.equal((await adminRequest("POST")).status, 405);
  assert.equal((await adminRequest("GET", `/${commissionId}/production`, false)).status, 401);
  assert.equal((await adminRequest("GET", "/999999/production")).status, 404);
});
