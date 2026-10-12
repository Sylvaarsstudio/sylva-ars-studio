import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";

import { getDatabase } from "@netlify/database";
import { NetlifyDB } from "@netlify/database-dev";

import {
  addCalendarDays,
  buildCommissionTimeline,
  classifyCalendarEntry,
  loadCommissionCalendarContext,
  readCalendarEntries
} from "../../netlify/shared/commission-calendar.mjs";
import {
  config,
  createHandler,
  getCommissionTimelineId,
  normalizeCalendarRange
} from "../../netlify/functions/admin-calendar.mjs";
import {
  COOKIE_NAME,
  createSessionToken
} from "../../netlify/shared/admin-session.mjs";

let database;
let db;
let commissionId;
let handler;
let sessionCookie;

const now = new Date("2026-10-11T16:00:00.000Z");

before(async () => {
  database = new NetlifyDB({ logger: () => {} });
  const connectionString = await database.start();
  await database.applyMigrations("./netlify/database/migrations");
  db = getDatabase({ connectionString });
  const password = "phase-35-password";
  const secret = "phase-35-secret";
  handler = createHandler({
    databaseFactory: () => db,
    environmentReader(name) {
      return { ADMIN_PASSWORD: password, ADMIN_SESSION_SECRET: secret }[name];
    },
    now: () => now
  });
  sessionCookie = `${COOKIE_NAME}=${await createSessionToken(password, secret)}`;
});

beforeEach(async () => {
  const clientId = (await db.pool.query(
    "INSERT INTO clients (full_name, email) VALUES ('Calendar Client', 'calendar@example.invalid') RETURNING id"
  )).rows[0].id;
  commissionId = (await db.pool.query(
    `INSERT INTO commissions (
       commission_number, client_id, title, description, medium, price, status, created_at
     ) VALUES (
       'SAS-COM-2026-9901', $1, 'Calendar Work', 'Private narrative',
       'Oil', 500, 'approved', '2026-10-01T14:00:00Z'
     ) RETURNING id`,
    [clientId]
  )).rows[0].id;
  const quotationId = (await db.pool.query(
    `INSERT INTO quotations (
       commission_id, client_id, artwork_title, artwork_description, artwork_medium,
       snapshot_version, quotation_number, version, quotation_status,
       issued_at, accepted_at, expires_at, price, sales_tax_rate, sales_tax,
       shipping_charge, estimated_completion, required_deposit,
       quotation_snapshot, snapshot_hash
     ) VALUES (
       $1, $2, 'Calendar Work', 'Private narrative', 'Oil', 1,
       'SAS-QUO-2026-9901', 1, 'accepted',
       '2026-10-02T14:00:00Z', '2026-10-03T14:00:00Z', '2026-10-15T14:00:00Z',
       500, 0.06, 30, 20, '2026-11-15', 250, '{}'::jsonb, $3
     ) RETURNING id`,
    [commissionId, clientId, "a".repeat(64)]
  )).rows[0].id;
  await db.pool.query(
    `INSERT INTO acceptances (
       acceptance_type, quotation_id, commission_id, client_id,
       client_name_entered, client_email, accepted, accepted_at,
       acceptance_method, subject_number, subject_version, snapshot_hash,
       request_id
     ) VALUES (
       'quotation', $1, $2, $3, 'Calendar Client', 'calendar@example.invalid',
       TRUE, '2026-10-03T14:00:00Z', 'admin_recorded',
       'SAS-QUO-2026-9901', 1, $4, '00000000-0000-4000-8000-000000009901'
     )`,
    [quotationId, commissionId, clientId, "a".repeat(64)]
  );
  await db.pool.query(
    `INSERT INTO commission_production (
       commission_id, production_status, reserved_at, started_at,
       final_presented_at, completed_at
     ) VALUES (
       $1, 'completed', '2026-10-04T14:00:00Z',
       '2026-10-05T14:00:00Z', '2026-10-06T14:00:00Z',
       '2026-10-10T14:00:00Z'
     )`,
    [commissionId]
  );
  await db.pool.query(
    `INSERT INTO commission_obligations (
       commission_id, obligation_type, obligation_status, amount, due_at
     ) VALUES ($1, 'final_balance', 'open', 300, '2026-10-07T14:00:00Z')`,
    [commissionId]
  );
  const deliveryId = (await db.pool.query(
    `INSERT INTO deliveries (
       commission_id, delivery_method, delivery_status, recipient_name,
       ready_at, scheduled_at, storage_start_at, storage_fee_start_at,
       final_notice_at, abandonment_eligible_at
     ) VALUES (
       $1, 'pickup', 'scheduled', 'Private Recipient',
       '2026-10-07T15:00:00Z', '2026-10-08T15:00:00Z',
       '2026-10-09T15:00:00Z', '2026-11-08T16:00:00Z',
       '2026-11-10T16:00:00Z', '2027-05-09T15:00:00Z'
     ) RETURNING id`,
    [commissionId]
  )).rows[0].id;
  await db.pool.query(
    `INSERT INTO commission_events (
       commission_id, event_type, occurred_at, actor_type,
       source_type, source_id, payload
     ) VALUES
       ($1, 'quotation_issued', '2026-10-02T14:00:00Z', 'admin', 'quotation', $2, '{}'),
       ($1, 'delivery_shipped', '2026-10-09T18:00:00Z', 'admin', 'delivery', $3, '{}')`,
    [commissionId, String(quotationId), String(deliveryId)]
  );
});

afterEach(async () => {
  await db.pool.query("DELETE FROM deliveries");
  await db.pool.query("DELETE FROM payment_allocations");
  await db.pool.query("DELETE FROM commission_obligations");
  await db.pool.query("TRUNCATE payment_allocations, commission_obligations, acceptances RESTART IDENTITY");
  await db.pool.query("DELETE FROM documents");
  await db.pool.query("DELETE FROM quotations");
  await db.pool.query("TRUNCATE commission_events RESTART IDENTITY");
  await db.pool.query("DELETE FROM commission_production");
  await db.pool.query("DELETE FROM commissions");
  await db.pool.query("DELETE FROM clients");
});

after(async () => {
  await db?.pool.end();
  await database?.stop();
});

function request(path, { method = "GET", authenticated = true } = {}) {
  return handler(new Request(`http://localhost${path}`, {
    method,
    headers: authenticated ? { Cookie: sessionCookie } : {}
  }));
}

test("Phase 10D exposes only protected read-only Calendar and Timeline routes", async () => {
  assert.deepEqual(config.path, [
    "/admin/api/calendar",
    "/admin/api/commissions/:id/timeline"
  ]);
  assert.equal(getCommissionTimelineId(`/admin/api/commissions/${commissionId}/timeline`), String(commissionId));
  assert.equal((await request("/admin/api/calendar", { authenticated: false })).status, 401);
  assert.equal((await request(`/admin/api/commissions/${commissionId}/timeline`, { authenticated: false })).status, 401);
  assert.equal((await request("/admin/api/calendar", { method: "POST" })).status, 405);
});

test("resolver derives the approved Commission, Quotation, Acceptance, and Production milestones", async () => {
  const context = await loadCommissionCalendarContext(db, commissionId);
  const entries = buildCommissionTimeline(context, { now });
  for (const type of [
    "commission_created", "quotation_issued", "quotation_expires",
    "quotation_accepted", "production_reserved", "production_started",
    "estimated_completion", "final_presented", "inspection_window_ends",
    "production_completed"
  ]) assert.ok(entries.some((entry) => entry.type === type), type);
  assert.equal(entries.filter((entry) => entry.type === "quotation_issued").length, 1);
  assert.equal(entries.find((entry) => entry.type === "estimated_completion").source_type, "quotation");
  assert.equal(entries.find((entry) => entry.type === "quotation_accepted").source_type, "acceptance");
});

test("inspection window adds seven New York calendar days across daylight saving changes", () => {
  const presented = new Date("2026-10-30T18:00:00.000Z");
  assert.equal(addCalendarDays(presented, 7).toISOString(), "2026-11-06T19:00:00.000Z");
});

test("resolver derives Financial, Delivery, Storage, and historical fallback milestones", async () => {
  const entries = buildCommissionTimeline(
    await loadCommissionCalendarContext(db, commissionId),
    { now }
  );
  for (const type of [
    "obligation_due", "delivery_ready", "pickup_scheduled", "shipped",
    "free_storage_ends", "storage_fee_begins", "final_notice",
    "abandonment_review_eligible"
  ]) assert.ok(entries.some((entry) => entry.type === type), type);
  assert.equal(entries.find((entry) => entry.type === "shipped").metadata.historical_fallback, true);
});

test("temporal classification marks only unresolved deadlines overdue", async () => {
  const entries = buildCommissionTimeline(
    await loadCommissionCalendarContext(db, commissionId),
    { now }
  );
  assert.equal(entries.find((entry) => entry.type === "obligation_due").status, "overdue");
  assert.equal(entries.find((entry) => entry.type === "pickup_scheduled").status, "overdue");
  assert.equal(entries.find((entry) => entry.type === "quotation_issued").status, "historical");
  assert.equal(entries.find((entry) => entry.type === "quotation_expires").status, "upcoming");
  assert.equal(classifyCalendarEntry({
    type: "storage_fee_begins",
    starts_at: "2026-10-10T16:00:00Z",
    metadata: {}
  }, now), "historical");
});

test("Timeline is chronological, contains no duplicate entries, and excludes PII", async () => {
  const entries = buildCommissionTimeline(
    await loadCommissionCalendarContext(db, commissionId),
    { now }
  );
  assert.deepEqual(
    entries.map((entry) => entry.starts_at),
    [...entries].map((entry) => entry.starts_at).sort()
  );
  assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length);
  const serialized = JSON.stringify(entries);
  assert.doesNotMatch(serialized, /calendar@example|Calendar Client|Private Recipient|Private narrative/);
});

test("global Calendar uses range-filtered aggregate reads", async () => {
  const entries = await readCalendarEntries(db, {
    from: new Date("2026-10-07T00:00:00Z"),
    to: new Date("2026-10-08T23:59:59Z"),
    now
  });
  assert.deepEqual(entries.map((entry) => entry.type), ["obligation_due", "delivery_ready", "pickup_scheduled"]);
});

test("Calendar API validates ranges and applies a bounded default", async () => {
  const invalid = await request("/admin/api/calendar?from=not-a-date&to=2026-10-12");
  assert.equal(invalid.status, 400);
  const reversed = await request("/admin/api/calendar?from=2026-10-12&to=2026-10-01");
  assert.equal(reversed.status, 400);
  const normalized = normalizeCalendarRange(new URLSearchParams(), now);
  assert.equal(normalized.error, undefined);
  assert.ok(normalized.to.getTime() - normalized.from.getTime() <= 61 * 86400000);
});

test("Calendar API returns only entries in the requested range", async () => {
  const response = await request("/admin/api/calendar?from=2026-10-07&to=2026-10-08");
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.deepEqual(body.entries.map((entry) => entry.type), [
    "obligation_due", "delivery_ready", "pickup_scheduled"
  ]);
});

test("Commission Timeline API returns the complete safe timeline and handles unknown Commission", async () => {
  const response = await request(`/admin/api/commissions/${commissionId}/timeline`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.commission.commission_number, "SAS-COM-2026-9901");
  assert.ok(body.entries.length > 10);
  assert.equal((await request("/admin/api/commissions/999999/timeline")).status, 404);
  assert.doesNotMatch(JSON.stringify(body), /calendar@example|Calendar Client|Private Recipient/);
});

test("Calendar and Timeline reads do not mutate canonical tables", async () => {
  const before = (await db.pool.query(
    `SELECT
       (SELECT count(*) FROM commissions) AS commissions,
       (SELECT count(*) FROM commission_events) AS events,
       (SELECT count(*) FROM commission_obligations) AS obligations`
  )).rows[0];
  await request("/admin/api/calendar?from=2026-09-01&to=2027-06-01");
  await request(`/admin/api/commissions/${commissionId}/timeline`);
  const after = (await db.pool.query(
    `SELECT
       (SELECT count(*) FROM commissions) AS commissions,
       (SELECT count(*) FROM commission_events) AS events,
       (SELECT count(*) FROM commission_obligations) AS obligations`
  )).rows[0];
  assert.deepEqual(after, before);
});
