import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { getDatabase } from "@netlify/database";
import { NetlifyDB } from "@netlify/database-dev";

import {
  appendCommissionEvent,
  commissionEventActorTypes,
  commissionEventSourceTypes,
  commissionEventTypes
} from "../../netlify/shared/commission-events.mjs";

let database;
let db;
let clientId;
let commissionId;

before(async () => {
  database = new NetlifyDB({ logger: () => {} });
  const connectionString = await database.start();
  await database.applyMigrations("./netlify/database/migrations");
  db = getDatabase({ connectionString });
  clientId = (await db.pool.query(
    "INSERT INTO clients (full_name, email) VALUES ('Event Client', 'events@example.invalid') RETURNING id"
  )).rows[0].id;
  commissionId = (await db.pool.query(
    `INSERT INTO commissions (
       commission_number, client_id, title, description, medium, price
     ) VALUES ('SAS-COM-2026-9501', $1, 'Event Test', 'Audit test', 'Oil', 100)
     RETURNING id`,
    [clientId]
  )).rows[0].id;
});

after(async () => {
  await db?.pool.query("TRUNCATE commission_events RESTART IDENTITY");
  await db?.pool.query("DELETE FROM commissions");
  await db?.pool.query("DELETE FROM clients");
  await db?.pool.end();
  await database?.stop();
});

test("commission_events migration creates the approved append-only schema", async () => {
  const result = await db.pool.query(
    `SELECT column_name, is_nullable, data_type
     FROM information_schema.columns
     WHERE table_name = 'commission_events'`
  );
  const columns = new Map(result.rows.map((row) => [row.column_name, row]));
  for (const name of [
    "id", "commission_id", "event_type", "occurred_at", "actor_type",
    "actor_id", "source_type", "source_id", "payload", "request_id", "created_at"
  ]) assert.ok(columns.has(name), name);
  assert.equal(columns.get("commission_id").is_nullable, "NO");
  assert.equal(columns.get("payload").data_type, "jsonb");
});

test("commission event vocabulary is controlled by the database", async () => {
  for (const eventType of commissionEventTypes) {
    await db.pool.query(
      `INSERT INTO commission_events (
         commission_id, event_type, occurred_at, actor_type, source_type, source_id
       ) VALUES ($1, $2, NOW(), 'system', 'commission', $3)`,
      [commissionId, eventType, String(commissionId)]
    );
  }
  await assert.rejects(db.pool.query(
    `INSERT INTO commission_events (
       commission_id, event_type, occurred_at, actor_type
     ) VALUES ($1, 'updated', NOW(), 'system')`,
    [commissionId]
  ));
});

test("actor and source vocabularies are controlled", async () => {
  for (const actorType of commissionEventActorTypes) {
    await db.pool.query(
      `INSERT INTO commission_events (
         commission_id, event_type, occurred_at, actor_type
       ) VALUES ($1, 'commission_status_changed', NOW(), $2)`,
      [commissionId, actorType]
    );
  }
  for (const sourceType of commissionEventSourceTypes) {
    await db.pool.query(
      `INSERT INTO commission_events (
         commission_id, event_type, occurred_at, actor_type, source_type, source_id
       ) VALUES ($1, 'commission_status_changed', NOW(), 'admin', $2, '1')`,
      [commissionId, sourceType]
    );
  }
  await assert.rejects(db.pool.query(
    `INSERT INTO commission_events (
       commission_id, event_type, occurred_at, actor_type
     ) VALUES ($1, 'commission_status_changed', NOW(), 'artist')`,
    [commissionId]
  ));
  await assert.rejects(db.pool.query(
    `INSERT INTO commission_events (
       commission_id, event_type, occurred_at, actor_type, source_type, source_id
     ) VALUES ($1, 'commission_status_changed', NOW(), 'admin', 'email', '1')`,
    [commissionId]
  ));
});

test("commission foreign key and source pairing are enforced", async () => {
  await assert.rejects(db.pool.query(
    `INSERT INTO commission_events (
       commission_id, event_type, occurred_at, actor_type
     ) VALUES (999999, 'commission_status_changed', NOW(), 'admin')`
  ));
  await assert.rejects(db.pool.query(
    `INSERT INTO commission_events (
       commission_id, event_type, occurred_at, actor_type, source_type
     ) VALUES ($1, 'commission_status_changed', NOW(), 'admin', 'commission')`,
    [commissionId]
  ));
});

test("payload defaults to an empty JSON object", async () => {
  const row = (await db.pool.query(
    `INSERT INTO commission_events (
       commission_id, event_type, occurred_at, actor_type
     ) VALUES ($1, 'commission_status_changed', NOW(), 'admin')
     RETURNING payload`,
    [commissionId]
  )).rows[0];
  assert.deepEqual(row.payload, {});
});

test("commission events cannot be updated or deleted", async () => {
  const id = (await db.pool.query(
    `INSERT INTO commission_events (
       commission_id, event_type, occurred_at, actor_type
     ) VALUES ($1, 'commission_status_changed', NOW(), 'admin') RETURNING id`,
    [commissionId]
  )).rows[0].id;
  await assert.rejects(db.pool.query(
    "UPDATE commission_events SET actor_type = 'system' WHERE id = $1",
    [id]
  ), /append-only/i);
  await assert.rejects(db.pool.query(
    "DELETE FROM commission_events WHERE id = $1",
    [id]
  ), /append-only/i);
});

test("request event source tuple is idempotent without restricting sibling events", async () => {
  const requestId = randomUUID();
  const input = {
    commissionId,
    eventType: "payment_recorded",
    actorType: "admin",
    sourceType: "payment",
    sourceId: "50",
    requestId,
    payload: { payment_type: "deposit", amount: "50.00" }
  };
  assert.ok(await appendCommissionEvent(db.pool, input));
  assert.equal(await appendCommissionEvent(db.pool, input), null);
  assert.ok(await appendCommissionEvent(db.pool, {
    ...input,
    eventType: "receipt_issued",
    sourceType: "document",
    sourceId: "70"
  }));
});

test("required indexes are present without an event_type-only index", async () => {
  const result = await db.pool.query(
    "SELECT indexname FROM pg_indexes WHERE tablename = 'commission_events'"
  );
  const names = new Set(result.rows.map((row) => row.indexname));
  assert.ok(names.has("commission_events_commission_occurred_index"));
  assert.ok(names.has("commission_events_source_index"));
  assert.ok(names.has("commission_events_request_event_source_unique"));
  assert.equal([...names].some((name) => name === "commission_events_event_type_index"), false);
});
