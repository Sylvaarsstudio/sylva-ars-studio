import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";

import { getDatabase } from "@netlify/database";
import { NetlifyDB } from "@netlify/database-dev";

import {
  config,
  createHandler as createAcceptanceHandler
} from "../../netlify/functions/admin-acceptances.mjs";
import { createHandler as createQuotationHandler } from "../../netlify/functions/admin-quotations.mjs";
import { COOKIE_NAME, createSessionToken } from "../../netlify/shared/admin-session.mjs";

const password = "local-admin-password";
const secret = "local-session-secret";
const issuedNow = new Date("2026-10-11T16:00:00.000Z");
const acceptedNow = new Date("2026-10-12T15:30:00.000Z");
let database;
let db;
let quotationHandler;
let acceptanceHandler;
let cookie;
let clientId;
let commissionId;

before(async () => {
  database = new NetlifyDB({ logger: () => {} });
  const connectionString = await database.start();
  await database.applyMigrations("./netlify/database/migrations");
  db = getDatabase({ connectionString });
  cookie = `${COOKIE_NAME}=${await createSessionToken(password, secret)}`;
  const auth = {
    databaseFactory: () => db,
    environmentReader: (name) => ({ ADMIN_PASSWORD: password, ADMIN_SESSION_SECRET: secret })[name]
  };
  quotationHandler = createQuotationHandler({ ...auth, now: () => new Date(issuedNow) });
  acceptanceHandler = createAcceptanceHandler({ ...auth, now: () => new Date(acceptedNow) });
});

beforeEach(async () => {
  clientId = (await db.pool.query(
    "INSERT INTO clients (full_name, email, phone) VALUES ('Acceptance Client', 'acceptance@example.invalid', '555-0123') RETURNING id"
  )).rows[0].id;
  commissionId = (await db.pool.query(
    `INSERT INTO commissions (
       commission_number, client_id, title, description, medium, width, height,
       price, sales_tax, shipping
     ) VALUES ('SAS-COM-2026-8901', $1, 'Acceptance Portrait', 'Scope', 'Oil', 20, 24, 400, 24, 20)
     RETURNING id`,
    [clientId]
  )).rows[0].id;
});

afterEach(async () => {
  await db.pool.query("DELETE FROM communications");
  await db.pool.query("TRUNCATE commission_events RESTART IDENTITY");
  await db.pool.query("TRUNCATE acceptances RESTART IDENTITY");
  await db.pool.query("DELETE FROM documents");
  await db.pool.query("DELETE FROM quotations");
  await db.pool.query("DELETE FROM commissions");
  await db.pool.query("DELETE FROM clients");
});

after(async () => {
  await db?.pool.end();
  await database?.stop();
});

function invoke(handler, path, method = "GET", body, authenticated = true) {
  return handler(new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...(authenticated ? { Cookie: cookie } : {}),
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  }));
}

async function createIssuedQuotation() {
  const draftResponse = await invoke(
    quotationHandler,
    `/admin/api/clients/${clientId}/quotations`,
    "POST",
    {
      artwork_title: "Acceptance Portrait",
      artwork_description: "Scope",
      artwork_medium: "Oil",
      artwork_width: "20",
      artwork_height: "24",
      price: "400.00",
      sales_tax_rate: "0.06",
      shipping_charge: "20.00",
      request_id: randomUUID()
    }
  );
  const draft = (await draftResponse.json()).quotation;
  const issuedResponse = await invoke(quotationHandler, `/admin/api/quotations/${draft.id}/issue`, "POST");
  return (await issuedResponse.json()).quotation;
}

function acceptanceBody(overrides = {}) {
  return {
    request_id: randomUUID(),
    acceptance_method: "admin_recorded",
    client_name_entered: "Acceptance Client",
    client_email: "acceptance@example.invalid",
    accepted_by_client_confirmation: true,
    ...overrides
  };
}

async function accept(quotationId, body = acceptanceBody()) {
  return invoke(acceptanceHandler, `/admin/api/quotations/${quotationId}/accept`, "POST", body);
}

test("acceptances migration creates the approved append-only schema", async () => {
  const columns = await db.pool.query(
    "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'acceptances'"
  );
  const names = new Set(columns.rows.map((row) => row.column_name));
  for (const name of [
    "acceptance_type", "quotation_id", "document_id", "commission_id", "client_id",
    "client_name_entered", "client_email", "accepted", "accepted_at",
    "acceptance_method", "subject_number", "subject_version", "snapshot_hash",
    "terms_version", "request_id", "created_at"
  ]) assert.ok(names.has(name), name);
  const trigger = await db.pool.query(
    "SELECT tgname FROM pg_trigger WHERE tgrelid = 'acceptances'::regclass AND NOT tgisinternal"
  );
  assert.deepEqual(trigger.rows.map((row) => row.tgname), ["acceptances_append_only_trigger"]);
});

test("acceptance routes are protected valid Netlify paths", () => {
  assert.deepEqual(config.path, [
    "/admin/api/quotations/:id/acceptance",
    "/admin/api/quotations/:id/accept",
    "/admin/api/acceptances/:id"
  ]);
  assert.ok(config.path.every((path) => typeof path === "string" && path.startsWith("/admin/")));
});

test("database enforces acceptance type, required subject evidence, and controlled method", async () => {
  const quotation = await createIssuedQuotation();
  const values = [
    quotation.id, commissionId, clientId, quotation.quotation_number,
    quotation.version, quotation.snapshot_hash, randomUUID()
  ];
  const insert = (type, subjectNumber = quotation.quotation_number, subjectVersion = quotation.version,
    hash = quotation.snapshot_hash, method = "admin_recorded") => db.pool.query(
    `INSERT INTO acceptances (
       acceptance_type, quotation_id, commission_id, client_id,
       client_name_entered, client_email, accepted_at, acceptance_method,
       subject_number, subject_version, snapshot_hash, request_id
     ) VALUES ($8, $1, $2, $3, 'Acceptance Client', 'acceptance@example.invalid',
       NOW(), $9, $4, $5, $6, $7)`,
    [values[0], values[1], values[2], subjectNumber, subjectVersion, hash, values[6], type, method]
  );
  await assert.rejects(insert("unknown"));
  await assert.rejects(insert("quotation", ""));
  await assert.rejects(insert("quotation", quotation.quotation_number, 0));
  await assert.rejects(insert("quotation", quotation.quotation_number, quotation.version, "not-a-hash"));
  await assert.rejects(insert("quotation", quotation.quotation_number, quotation.version, quotation.snapshot_hash, "email"));
});

test("database enforces quotation document commission and client foreign keys", async () => {
  const quotation = await createIssuedQuotation();
  const base = [
    quotation.id, commissionId, clientId, quotation.quotation_number,
    quotation.version, quotation.snapshot_hash
  ];
  const insert = (quotationId, commission, client, documentId = null) => db.pool.query(
    `INSERT INTO acceptances (
       acceptance_type, quotation_id, document_id, commission_id, client_id,
       client_name_entered, client_email, accepted_at, acceptance_method,
       subject_number, subject_version, snapshot_hash, request_id
     ) VALUES ('quotation', $1, $7, $2, $3, 'Acceptance Client',
       'acceptance@example.invalid', NOW(), 'admin_recorded', $4, $5, $6, $8)`,
    [quotationId, commission, client, base[3], base[4], base[5], documentId, randomUUID()]
  );
  await assert.rejects(insert(999999, base[1], base[2]));
  await assert.rejects(insert(base[0], 999999, base[2]));
  await assert.rejects(insert(base[0], base[1], 999999));
  await assert.rejects(insert(base[0], base[1], base[2], 999999));
});

test("request id is required and unique", async () => {
  const quotation = await createIssuedQuotation();
  const body = acceptanceBody();
  assert.equal((await accept(quotation.id, body)).status, 201);
  const first = (await db.pool.query("SELECT * FROM acceptances WHERE quotation_id = $1", [quotation.id])).rows[0];
  await assert.rejects(db.pool.query(
    `INSERT INTO acceptances (
       acceptance_type, quotation_id, commission_id, client_id,
       client_name_entered, client_email, accepted, accepted_at,
       acceptance_method, subject_number, subject_version, snapshot_hash, request_id
     ) VALUES ('quotation', $1, $2, $3, $4, $5, FALSE, NOW(),
       'admin_recorded', $6, $7, $8, $9)`,
    [quotation.id, commissionId, clientId, first.client_name_entered, first.client_email,
     first.subject_number, first.subject_version, first.snapshot_hash, body.request_id]
  ));
  await assert.rejects(db.pool.query(
    `INSERT INTO acceptances (
       acceptance_type, quotation_id, commission_id, client_id,
       client_name_entered, client_email, accepted_at, acceptance_method,
       subject_number, subject_version, snapshot_hash
     ) VALUES ('quotation', $1, $2, $3, 'Acceptance Client',
       'acceptance@example.invalid', NOW(), 'admin_recorded', $4, $5, $6)`,
    [quotation.id, commissionId, clientId, quotation.quotation_number,
     quotation.version, quotation.snapshot_hash]
  ));
});

test("quotation acceptance is recorded from immutable server truth", async () => {
  const quotation = await createIssuedQuotation();
  const response = await accept(quotation.id);
  assert.equal(response.status, 201);
  const acceptance = (await response.json()).acceptance;
  assert.equal(acceptance.acceptance_type, "quotation");
  assert.equal(String(acceptance.quotation_id), String(quotation.id));
  assert.equal(acceptance.commission_id, null);
  assert.equal(String(acceptance.client_id), String(clientId));
  assert.equal(acceptance.subject_number, quotation.quotation_number);
  assert.equal(acceptance.subject_version, quotation.version);
  assert.equal(acceptance.snapshot_hash, quotation.snapshot_hash);
  assert.equal(acceptance.acceptance_method, "admin_recorded");
  assert.equal(new Date(acceptance.accepted_at).toISOString(), acceptedNow.toISOString());
});

test("sent quotation can be accepted", async () => {
  const quotation = await createIssuedQuotation();
  const sentResponse = await invoke(quotationHandler, `/admin/api/quotations/${quotation.id}/mark-sent`, "POST");
  assert.equal((await sentResponse.json()).quotation.quotation_status, "sent");
  assert.equal((await accept(quotation.id)).status, 201);
});

test("draft quotation cannot be accepted", async () => {
  const draftResponse = await invoke(
    quotationHandler,
    `/admin/api/clients/${clientId}/quotations`,
    "POST",
    {
      artwork_title: "Acceptance Portrait",
      artwork_description: "Scope",
      artwork_medium: "Oil",
      price: "400.00",
      sales_tax_rate: "0.06",
      shipping_charge: "20.00",
      request_id: randomUUID()
    }
  );
  const draft = (await draftResponse.json()).quotation;
  assert.equal((await accept(draft.id)).status, 409);
});

test("acceptance and quotation accepted transition commit atomically", async () => {
  const quotation = await createIssuedQuotation();
  await accept(quotation.id);
  const row = (await db.pool.query(
    "SELECT quotation_status, accepted_at FROM quotations WHERE id = $1",
    [quotation.id]
  )).rows[0];
  assert.equal(row.quotation_status, "accepted");
  assert.equal(new Date(row.accepted_at).toISOString(), acceptedNow.toISOString());
  assert.equal((await db.pool.query(
    "SELECT count(*)::integer AS count FROM acceptances WHERE quotation_id = $1",
    [quotation.id]
  )).rows[0].count, 1);
  assert.equal((await db.pool.query(
    `SELECT count(*)::integer AS count
     FROM commission_events
     WHERE event_type = 'quotation_accepted'
       AND source_type = 'acceptance'`,
  )).rows[0].count, 0);
});

test("same request id is idempotent", async () => {
  const quotation = await createIssuedQuotation();
  const body = acceptanceBody();
  const first = await accept(quotation.id, body);
  const second = await accept(quotation.id, body);
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal((await first.json()).acceptance.id, (await second.json()).acceptance.id);
});

test("concurrent duplicate acceptance creates one effective record", async () => {
  const quotation = await createIssuedQuotation();
  const body = acceptanceBody();
  const responses = await Promise.all([accept(quotation.id, body), accept(quotation.id, body)]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 201]);
  assert.equal((await db.pool.query(
    "SELECT count(*)::integer AS count FROM acceptances WHERE quotation_id = $1",
    [quotation.id]
  )).rows[0].count, 1);
  assert.equal((await db.pool.query(
    `SELECT count(*)::integer AS count
     FROM commission_events
     WHERE event_type = 'quotation_accepted'
       AND source_type = 'acceptance'`,
  )).rows[0].count, 0);
});

test("a second effective acceptance with a new intent is rejected", async () => {
  const quotation = await createIssuedQuotation();
  assert.equal((await accept(quotation.id)).status, 201);
  const response = await accept(quotation.id);
  assert.equal(response.status, 409);
  assert.match((await response.json()).message, /already has/i);
});

test("expired quotation is rejected using the acceptance clock", async () => {
  const quotation = await createIssuedQuotation();
  const lateHandler = createAcceptanceHandler({
    databaseFactory: () => db,
    environmentReader: (name) => ({ ADMIN_PASSWORD: password, ADMIN_SESSION_SECRET: secret })[name],
    now: () => new Date("2026-12-01T12:00:00.000Z")
  });
  const response = await invoke(lateHandler, `/admin/api/quotations/${quotation.id}/accept`, "POST", acceptanceBody());
  assert.equal(response.status, 409);
  assert.match((await response.json()).message, /expired/i);
});

test("withdrawn declined expired and superseded quotations are rejected", async () => {
  for (const [index, status] of ["withdrawn", "declined", "expired", "superseded"].entries()) {
    const quotation = await createIssuedQuotation();
    await db.pool.query("UPDATE quotations SET quotation_status = $1 WHERE id = $2", [status, quotation.id]);
    const response = await accept(quotation.id);
    assert.equal(response.status, 409, `${index}:${status}`);
  }
});

test("database prevents an issued or sent quotation without snapshot evidence", async () => {
  await assert.rejects(db.pool.query(
    `INSERT INTO quotations (
       commission_id, client_id, artwork_title, artwork_description, artwork_medium,
       quotation_number, version, quotation_status,
       issued_at, expires_at, price, sales_tax_rate, sales_tax,
       shipping_charge, required_deposit_rate, required_deposit
     ) VALUES ($1, $2, 'Acceptance Portrait', 'Scope', 'Oil',
       'SAS-QUO-2026-9993', 1, 'issued', NOW(), NOW() + INTERVAL '30 days',
       400, .06, 24, 20, .50, 200)`,
    [commissionId, clientId]
  ));
});

test("tampered snapshot hash is rejected", async () => {
  const snapshot = { immutable: "snapshot" };
  const quotationId = (await db.pool.query(
    `INSERT INTO quotations (
       commission_id, client_id, artwork_title, artwork_description, artwork_medium,
       quotation_number, version, quotation_status,
       issued_at, expires_at, price, sales_tax_rate, sales_tax,
       shipping_charge, required_deposit_rate, required_deposit,
       quotation_snapshot, snapshot_hash
     ) VALUES ($1, $2, 'Acceptance Portrait', 'Scope', 'Oil',
       'SAS-QUO-2026-9991', 1, 'issued', $3, $4,
       400, .06, 24, 20, .50, 200, $5::jsonb, $6) RETURNING id`,
    [commissionId, clientId, issuedNow, new Date("2026-11-10T17:00:00Z"), JSON.stringify(snapshot), "0".repeat(64)]
  )).rows[0].id;
  const response = await accept(quotationId);
  assert.equal(response.status, 409);
  assert.match((await response.json()).message, /integrity/i);
});

test("written confirmation, method, and client identity are validated", async () => {
  const quotation = await createIssuedQuotation();
  assert.equal((await accept(quotation.id, acceptanceBody({ accepted_by_client_confirmation: false }))).status, 400);
  assert.equal((await accept(quotation.id, acceptanceBody({ acceptance_method: "portal" }))).status, 400);
  assert.equal((await accept(quotation.id, acceptanceBody({ client_email: "other@example.invalid" }))).status, 409);
  assert.equal((await accept(quotation.id, acceptanceBody({ client_name_entered: "Other Client" }))).status, 409);
});

test("acceptance preserves identity after the live client changes", async () => {
  const quotation = await createIssuedQuotation();
  const acceptance = (await (await accept(quotation.id)).json()).acceptance;
  await db.pool.query("UPDATE clients SET full_name = 'Later Name', email = 'later@example.invalid' WHERE id = $1", [clientId]);
  const stored = (await db.pool.query(
    "SELECT client_name_entered, client_email FROM acceptances WHERE id = $1", [acceptance.id]
  )).rows[0];
  assert.deepEqual(stored, {
    client_name_entered: "Acceptance Client",
    client_email: "acceptance@example.invalid"
  });
});

test("acceptance rows cannot be updated or deleted", async () => {
  const quotation = await createIssuedQuotation();
  const acceptance = (await (await accept(quotation.id)).json()).acceptance;
  await assert.rejects(
    db.pool.query("UPDATE acceptances SET client_name_entered = 'Changed' WHERE id = $1", [acceptance.id]),
    /append-only/i
  );
  await assert.rejects(
    db.pool.query("DELETE FROM acceptances WHERE id = $1", [acceptance.id]),
    /append-only/i
  );
});

test("database prevents two effective acceptances for one quotation", async () => {
  const quotation = await createIssuedQuotation();
  await accept(quotation.id);
  const first = (await db.pool.query("SELECT * FROM acceptances WHERE quotation_id = $1", [quotation.id])).rows[0];
  await assert.rejects(db.pool.query(
    `INSERT INTO acceptances (
       acceptance_type, quotation_id, commission_id, client_id,
       client_name_entered, client_email, accepted_at, acceptance_method,
       subject_number, subject_version, snapshot_hash, request_id
     ) VALUES ('quotation', $1, $2, $3, $4, $5, NOW(), 'admin_recorded', $6, $7, $8, $9)`,
    [quotation.id, commissionId, clientId, first.client_name_entered, first.client_email,
     first.subject_number, first.subject_version, first.snapshot_hash, randomUUID()]
  ));
});

test("contract acceptance shape is supported but no contract acceptance API is active", async () => {
  const documentId = (await db.pool.query(
    `INSERT INTO documents (
       commission_id, document_type, document_number, version,
       file_location, document_snapshot
     ) VALUES ($1, 'contract', 'SAS-CON-2026-9991', 1, '/admin/contract.html', '{}'::jsonb)
     RETURNING id`,
    [commissionId]
  )).rows[0].id;
  const row = (await db.pool.query(
    `INSERT INTO acceptances (
       acceptance_type, document_id, commission_id, client_id,
       client_name_entered, client_email, accepted_at, acceptance_method,
       subject_number, subject_version, snapshot_hash, terms_version, request_id
     ) VALUES ('contract', $1, $2, $3, 'Acceptance Client', 'acceptance@example.invalid',
       NOW(), 'admin_recorded', 'SAS-CON-2026-9991', 1, $4, 'commission-agreement-v1', $5)
     RETURNING acceptance_type, quotation_id, document_id`,
    [documentId, commissionId, clientId, "a".repeat(64), randomUUID()]
  )).rows[0];
  assert.equal(row.acceptance_type, "contract");
  assert.equal(row.quotation_id, null);
  assert.equal(String(row.document_id), String(documentId));
  assert.equal(config.path.some((path) => path.includes("contracts") && path.includes("accept")), false);
});

test("type-specific subject references are enforced", async () => {
  await assert.rejects(db.pool.query(
    `INSERT INTO acceptances (
       acceptance_type, commission_id, client_id, client_name_entered,
       client_email, accepted_at, acceptance_method, subject_number,
       subject_version, snapshot_hash, request_id
     ) VALUES ('quotation', $1, $2, 'Acceptance Client', 'acceptance@example.invalid',
       NOW(), 'admin_recorded', 'SAS-QUO-2026-9992', 1, $3, $4)`,
    [commissionId, clientId, "a".repeat(64), randomUUID()]
  ));
  await assert.rejects(db.pool.query(
    `INSERT INTO acceptances (
       acceptance_type, commission_id, client_id, client_name_entered,
       client_email, accepted_at, acceptance_method, subject_number,
       subject_version, snapshot_hash, request_id
     ) VALUES ('contract', $1, $2, 'Acceptance Client', 'acceptance@example.invalid',
       NOW(), 'admin_recorded', 'SAS-CON-2026-9992', 1, $3, $4)`,
    [commissionId, clientId, "a".repeat(64), randomUUID()]
  ));
});

test("acceptance does not change legacy commission or create a new document", async () => {
  const quotation = await createIssuedQuotation();
  const before = (await db.pool.query(
    "SELECT status, price, sales_tax, shipping FROM commissions WHERE id = $1", [commissionId]
  )).rows[0];
  const documentsBefore = (await db.pool.query("SELECT count(*)::integer AS count FROM documents")).rows[0].count;
  await accept(quotation.id);
  const afterRow = (await db.pool.query(
    "SELECT status, price, sales_tax, shipping FROM commissions WHERE id = $1", [commissionId]
  )).rows[0];
  const documentsAfter = (await db.pool.query("SELECT count(*)::integer AS count FROM documents")).rows[0].count;
  assert.deepEqual(afterRow, before);
  assert.equal(documentsAfter, documentsBefore);
});

test("accepted quotation is terminal for edit, withdraw, and new-version actions", async () => {
  const quotation = await createIssuedQuotation();
  await accept(quotation.id);
  assert.equal((await invoke(quotationHandler, `/admin/api/quotations/${quotation.id}`, "PATCH", { price: "1.00" })).status, 409);
  assert.equal((await invoke(quotationHandler, `/admin/api/quotations/${quotation.id}/withdraw`, "POST")).status, 409);
  assert.equal((await invoke(quotationHandler, `/admin/api/quotations/${quotation.id}/new-version`, "POST")).status, 409);
});

test("acceptance and status both roll back if the quotation transition fails", async () => {
  const quotation = await createIssuedQuotation();
  await db.pool.query(`
    CREATE FUNCTION fail_test_acceptance_transition() RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.quotation_status = 'accepted' THEN
        RAISE EXCEPTION 'test transition failure';
      END IF;
      RETURN NEW;
    END;
    $$;
  `);
  await db.pool.query(`
    CREATE TRIGGER fail_test_acceptance_transition_trigger
    BEFORE UPDATE ON quotations
    FOR EACH ROW EXECUTE FUNCTION fail_test_acceptance_transition()
  `);
  try {
    assert.equal((await accept(quotation.id)).status, 500);
  } finally {
    await db.pool.query("DROP TRIGGER fail_test_acceptance_transition_trigger ON quotations");
    await db.pool.query("DROP FUNCTION fail_test_acceptance_transition()");
  }
  assert.equal((await db.pool.query(
    "SELECT count(*)::integer AS count FROM acceptances WHERE quotation_id = $1", [quotation.id]
  )).rows[0].count, 0);
  assert.equal((await db.pool.query(
    "SELECT quotation_status FROM quotations WHERE id = $1", [quotation.id]
  )).rows[0].quotation_status, "issued");
});

test("acceptance endpoints require a valid admin session", async () => {
  const quotation = await createIssuedQuotation();
  assert.equal((await invoke(
    acceptanceHandler,
    `/admin/api/quotations/${quotation.id}/acceptance`,
    "GET",
    undefined,
    false
  )).status, 401);
});
