import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";

import { getDatabase } from "@netlify/database";
import { NetlifyDB } from "@netlify/database-dev";

import {
  addCalendarDays,
  buildQuotationSnapshot,
  calculateCommercials,
  config,
  createHandler
} from "../../netlify/functions/admin-quotations.mjs";
import { canonicalSerialize, hashQuotationSnapshot } from "../../netlify/shared/quotation-snapshot.mjs";
import { COOKIE_NAME, createSessionToken } from "../../netlify/shared/admin-session.mjs";
import { listDocuments } from "../../netlify/functions/admin-documents.mjs";

const password = "local-admin-password";
const secret = "local-session-secret";
const fixedNow = new Date("2026-10-11T16:00:00.000Z");
let database;
let db;
let handler;
let cookie;
let clientId;
let commissionId;

before(async () => {
  database = new NetlifyDB({ logger: () => {} });
  const connectionString = await database.start();
  await database.applyMigrations("./netlify/database/migrations");
  db = getDatabase({ connectionString });
  cookie = `${COOKIE_NAME}=${await createSessionToken(password, secret)}`;
  handler = createHandler({
    databaseFactory: () => db,
    environmentReader: (name) => ({ ADMIN_PASSWORD: password, ADMIN_SESSION_SECRET: secret })[name],
    now: () => new Date(fixedNow)
  });
});

beforeEach(async () => {
  clientId = (await db.pool.query(
    "INSERT INTO clients (full_name, email, phone) VALUES ('Quote Client', 'quote@example.invalid', '555-0101') RETURNING id"
  )).rows[0].id;
  commissionId = (await db.pool.query(
    `INSERT INTO commissions (
       commission_number, client_id, title, description, medium, width, height,
       price, sales_tax, shipping, estimated_completion
     ) VALUES ('SAS-COM-2026-8801', $1, 'Portrait', 'Commission scope', 'Oil', 20, 24,
       400, 24, 20, '2027-02-15') RETURNING id`,
    [clientId]
  )).rows[0].id;
});

afterEach(async () => {
  await db.pool.query("TRUNCATE commission_events RESTART IDENTITY");
  await db.pool.query("DELETE FROM documents");
  await db.pool.query("DELETE FROM quotations");
  await db.pool.query("DELETE FROM commissions");
  await db.pool.query("DELETE FROM clients");
});

after(async () => {
  await db?.pool.end();
  await database?.stop();
});

function request(path, method = "GET", body) {
  return handler(new Request(`http://localhost${path}`, {
    method,
    headers: { Cookie: cookie, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  }));
}

async function createDraft(body = {}) {
  return request(`/admin/api/commissions/${commissionId}/quotations`, "POST", body);
}

test("quotation migration creates the versioned schema and document relationship", async () => {
  const columns = await db.pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'quotations'"
  );
  const names = new Set(columns.rows.map((row) => row.column_name));
  for (const name of ["quotation_number", "version", "quotation_status", "quotation_snapshot", "snapshot_hash", "supersedes_quotation_id", "request_id"]) {
    assert.ok(names.has(name), name);
  }
  const documentColumn = await db.pool.query(
    "SELECT is_nullable FROM information_schema.columns WHERE table_name = 'documents' AND column_name = 'quotation_id'"
  );
  assert.equal(documentColumn.rows[0].is_nullable, "YES");
});

test("quotation status, commercial checks, and supersedes FK are enforced", async () => {
  await assert.rejects(
    db.pool.query(`INSERT INTO quotations (
      commission_id, quotation_number, version, quotation_status, price,
      sales_tax_rate, sales_tax, shipping_charge, required_deposit_rate, required_deposit
    ) VALUES ($1, 'SAS-QUO-2026-9901', 1, 'cancelled', 100, .06, 6, 0, .50, 50)`, [commissionId])
  );
  await assert.rejects(
    db.pool.query(`INSERT INTO quotations (
      commission_id, quotation_number, version, price, sales_tax_rate,
      sales_tax, shipping_charge, required_deposit_rate, required_deposit
    ) VALUES ($1, 'SAS-QUO-2026-9902', 1, -1, .06, 0, 0, .50, 0)`, [commissionId])
  );
  await assert.rejects(
    db.pool.query(`INSERT INTO quotations (
      commission_id, quotation_number, version, supersedes_quotation_id,
      price, sales_tax_rate, sales_tax, shipping_charge,
      required_deposit_rate, required_deposit
    ) VALUES ($1, 'SAS-QUO-2026-9903', 2, 999999, 100, .06, 6, 0, .50, 50)`, [commissionId])
  );
});

test("quotation family versions and request ids are unique", async () => {
  const requestId = randomUUID();
  await db.pool.query(`INSERT INTO quotations (
    commission_id, quotation_number, version, price, sales_tax_rate,
    sales_tax, shipping_charge, required_deposit_rate, required_deposit, request_id
  ) VALUES ($1, 'SAS-QUO-2026-9904', 1, 100, .06, 6, 0, .50, 50, $2)`, [commissionId, requestId]);
  await assert.rejects(
    db.pool.query(`INSERT INTO quotations (
      commission_id, quotation_number, version, price, sales_tax_rate,
      sales_tax, shipping_charge, required_deposit_rate, required_deposit
    ) VALUES ($1, 'SAS-QUO-2026-9904', 1, 100, .06, 6, 0, .50, 50)`, [commissionId])
  );
  await assert.rejects(
    db.pool.query(`INSERT INTO quotations (
      commission_id, quotation_number, version, price, sales_tax_rate,
      sales_tax, shipping_charge, required_deposit_rate, required_deposit, request_id
    ) VALUES ($1, 'SAS-QUO-2026-9905', 1, 100, .06, 6, 0, .50, 50, $2)`, [commissionId, requestId])
  );
});

test("quotation routes are protected valid strings", () => {
  assert.ok(Array.isArray(config.path));
  assert.equal(config.path.length, 6);
  assert.ok(config.path.every((path) => typeof path === "string" && path.startsWith("/admin/")));
});

test("30-calendar-day expiry preserves America/New_York wall time across DST", () => {
  assert.equal(
    addCalendarDays(new Date("2026-10-11T16:00:00.000Z"), 30).toISOString(),
    "2026-11-10T17:00:00.000Z"
  );
});

test("draft initializes from mutable commission commercial values", async () => {
  const response = await createDraft({ request_id: randomUUID() });
  assert.equal(response.status, 201);
  const quotation = (await response.json()).quotation;
  assert.match(quotation.quotation_number, /^SAS-QUO-2026-\d{4,}$/);
  assert.equal(quotation.version, 1);
  assert.equal(quotation.quotation_status, "draft");
  assert.equal(quotation.price, "400.00");
  assert.equal(quotation.sales_tax_rate, "0.0600");
  assert.equal(quotation.sales_tax, "24.00");
  assert.equal(quotation.shipping_charge, "20.00");
  assert.equal(quotation.required_deposit, "200.00");
});

test("draft request id is idempotent and unique across intent", async () => {
  const requestId = randomUUID();
  const first = await createDraft({ request_id: requestId });
  const second = await createDraft({ request_id: requestId });
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal((await first.json()).quotation.id, (await second.json()).quotation.id);
});

test("concurrent draft retries create one quotation", async () => {
  const requestId = randomUUID();
  const responses = await Promise.all([
    createDraft({ request_id: requestId }),
    createDraft({ request_id: requestId })
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 201]);
  const count = await db.pool.query("SELECT count(*)::integer AS count FROM quotations WHERE request_id = $1", [requestId]);
  assert.equal(count.rows[0].count, 1);
  assert.equal((await db.pool.query(
    "SELECT count(*)::integer AS count FROM commission_events WHERE event_type = 'quotation_created' AND request_id = $1",
    [requestId]
  )).rows[0].count, 1);
});

test("concurrent distinct drafts receive distinct quotation numbers", async () => {
  const responses = await Promise.all([
    createDraft({ request_id: randomUUID() }),
    createDraft({ request_id: randomUUID() })
  ]);
  assert.deepEqual(responses.map((response) => response.status), [201, 201]);
  const bodies = await Promise.all(responses.map((response) => response.json()));
  assert.equal(new Set(bodies.map((body) => body.quotation.quotation_number)).size, 2);
});

test("draft can be edited and server recalculates tax and required deposit", async () => {
  const quotation = (await (await createDraft()).json()).quotation;
  const response = await request(`/admin/api/quotations/${quotation.id}`, "PATCH", {
    price: "500.00", sales_tax_rate: "0.0700", shipping_charge: "30.00",
    estimated_completion: "2027-03-01", special_terms: "One revision included."
  });
  const updated = (await response.json()).quotation;
  assert.equal(updated.sales_tax, "35.00");
  assert.equal(updated.required_deposit_rate, "0.5000");
  assert.equal(updated.required_deposit, "250.00");
});

test("issue freezes snapshot, hash, expiry, and matching quotation document", async () => {
  const draft = (await (await createDraft()).json()).quotation;
  const response = await request(`/admin/api/quotations/${draft.id}/issue`, "POST");
  assert.equal(response.status, 201);
  const quotation = (await response.json()).quotation;
  assert.equal(quotation.quotation_status, "issued");
  assert.equal(new Date(quotation.expires_at).toISOString(), "2026-11-10T17:00:00.000Z");
  assert.equal(quotation.snapshot_hash, hashQuotationSnapshot(quotation.quotation_snapshot));
  assert.equal(quotation.quotation_snapshot.commercial.total, "444.00");
  assert.equal(quotation.quotation_snapshot.client.email, "quote@example.invalid");
  const document = (await db.pool.query(
    "SELECT * FROM documents WHERE quotation_id = $1", [draft.id]
  )).rows[0];
  assert.equal(document.document_type, "quotation");
  assert.equal(document.document_number, quotation.quotation_number);
  assert.equal(document.version, 1);
  assert.deepEqual(document.document_snapshot, quotation.quotation_snapshot);
  const listed = await listDocuments(db, { commissionId: String(commissionId), documentType: "quotation" });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].quotation.id, draft.id);
});

test("snapshot hash is deterministic across object key order", () => {
  const left = { b: 2, a: { d: 4, c: 3 } };
  const right = { a: { c: 3, d: 4 }, b: 2 };
  assert.equal(canonicalSerialize(left), canonicalSerialize(right));
  assert.equal(hashQuotationSnapshot(left), hashQuotationSnapshot(right));
});

test("issued quotation cannot be edited through API or database", async () => {
  const draft = (await (await createDraft()).json()).quotation;
  await request(`/admin/api/quotations/${draft.id}/issue`, "POST");
  assert.equal((await request(`/admin/api/quotations/${draft.id}`, "PATCH", { price: "1.00" })).status, 409);
  await assert.rejects(
    db.pool.query("UPDATE quotations SET price = 1 WHERE id = $1", [draft.id]),
    /immutable/i
  );
});

test("concurrent issue is idempotent and creates one document", async () => {
  const draft = (await (await createDraft()).json()).quotation;
  const responses = await Promise.all([
    request(`/admin/api/quotations/${draft.id}/issue`, "POST"),
    request(`/admin/api/quotations/${draft.id}/issue`, "POST")
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 201]);
  const count = await db.pool.query("SELECT count(*)::integer AS count FROM documents WHERE quotation_id = $1", [draft.id]);
  assert.equal(count.rows[0].count, 1);
  assert.equal((await db.pool.query(
    "SELECT count(*)::integer AS count FROM commission_events WHERE event_type = 'quotation_issued' AND source_id = $1",
    [String(draft.id)]
  )).rows[0].count, 1);
});

test("mark sent and withdraw enforce the approved transitions", async () => {
  const draft = (await (await createDraft()).json()).quotation;
  await request(`/admin/api/quotations/${draft.id}/issue`, "POST");
  const sent = await request(`/admin/api/quotations/${draft.id}/mark-sent`, "POST");
  assert.equal((await sent.json()).quotation.quotation_status, "sent");
  const withdrawn = await request(`/admin/api/quotations/${draft.id}/withdraw`, "POST");
  assert.equal((await withdrawn.json()).quotation.quotation_status, "withdrawn");
  assert.equal((await request(`/admin/api/quotations/${draft.id}/withdraw`, "POST")).status, 409);
});

test("new version copies values and supersedes old only when replacement is issued", async () => {
  const first = (await (await createDraft()).json()).quotation;
  await request(`/admin/api/quotations/${first.id}/issue`, "POST");
  const nextResponse = await request(`/admin/api/quotations/${first.id}/new-version`, "POST");
  const next = (await nextResponse.json()).quotation;
  assert.equal(next.version, 2);
  assert.equal(next.quotation_number, first.quotation_number);
  assert.equal(next.supersedes_quotation_id, first.id);
  assert.equal((await (await request(`/admin/api/quotations/${first.id}`)).json()).quotation.quotation_status, "issued");
  await request(`/admin/api/quotations/${next.id}/issue`, "POST");
  assert.equal((await (await request(`/admin/api/quotations/${first.id}`)).json()).quotation.quotation_status, "superseded");
});

test("concurrent new-version requests return one draft version", async () => {
  const first = (await (await createDraft()).json()).quotation;
  await request(`/admin/api/quotations/${first.id}/issue`, "POST");
  const responses = await Promise.all([
    request(`/admin/api/quotations/${first.id}/new-version`, "POST"),
    request(`/admin/api/quotations/${first.id}/new-version`, "POST")
  ]);
  const ids = await Promise.all(responses.map(async (response) => (await response.json()).quotation.id));
  assert.equal(new Set(ids).size, 1);
  const count = await db.pool.query("SELECT count(*)::integer AS count FROM quotations WHERE quotation_number = $1", [
    (await (await request(`/admin/api/quotations/${first.id}`)).json()).quotation.quotation_number
  ]);
  assert.equal(count.rows[0].count, 2);
});

test("legacy commission remains unchanged and can have zero quotations", async () => {
  assert.deepEqual(await calculateCommercials({ price: "400", sales_tax_rate: "0.06", shipping_charge: "20" }), {
    price: "400.00", sales_tax_rate: "0.0600", sales_tax: "24.00", shipping_charge: "20.00",
    required_deposit_rate: "0.5000", required_deposit: "200.00", total: "444.00"
  });
  const before = (await db.pool.query("SELECT status, price, sales_tax, shipping FROM commissions WHERE id = $1", [commissionId])).rows[0];
  const list = await request(`/admin/api/commissions/${commissionId}/quotations`);
  assert.deepEqual((await list.json()).quotations, []);
  const afterRow = (await db.pool.query("SELECT status, price, sales_tax, shipping FROM commissions WHERE id = $1", [commissionId])).rows[0];
  assert.deepEqual(afterRow, before);
});

test("snapshot builder contains no live dependency fields", () => {
  const snapshot = buildQuotationSnapshot({
    quotation: {
      quotation_number: "SAS-QUO-2026-0001", version: 1, client_id: 1,
      client_name: "Client", client_email: "client@example.invalid", client_phone: null,
      commission_id: 1, commission_number: "SAS-COM-2026-0001", commission_title: "Title",
      commission_description: "Scope", commission_medium: "Oil", commission_width: "20.00",
      commission_height: "24.00", price: "400", sales_tax_rate: "0.06",
      shipping_charge: "20", estimated_completion: null, special_terms: null
    },
    issuedAt: fixedNow,
    expiresAt: new Date("2026-11-10T17:00:00.000Z")
  });
  assert.equal(snapshot.commercial.required_deposit, "200.00");
  assert.equal(snapshot.commercial.total, "444.00");
});
