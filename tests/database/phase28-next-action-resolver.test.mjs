import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";

import { getDatabase } from "@netlify/database";
import { NetlifyDB } from "@netlify/database-dev";

import { createHandler } from "../../netlify/functions/admin-commissions.mjs";
import {
  readCommissionNextAction,
  resolveCommissionNextAction
} from "../../netlify/shared/commission-next-action.mjs";
import { hashQuotationSnapshot } from "../../netlify/shared/quotation-snapshot.mjs";
import {
  COOKIE_NAME,
  createSessionToken
} from "../../netlify/shared/admin-session.mjs";

const fixedNow = new Date("2026-10-11T16:00:00.000Z");
let database;
let db;
let clientId;
let commissionId;
let handler;
let cookie;
let sequence = 0;

before(async () => {
  database = new NetlifyDB({ logger: () => {} });
  const connectionString = await database.start();
  await database.applyMigrations("./netlify/database/migrations");
  db = getDatabase({ connectionString });
  const password = "phase-28-password";
  const secret = "phase-28-secret";
  cookie = `${COOKIE_NAME}=${await createSessionToken(password, secret)}`;
  handler = createHandler({
    databaseFactory: () => db,
    environmentReader: (name) => ({
      ADMIN_PASSWORD: password,
      ADMIN_SESSION_SECRET: secret
    })[name],
    now: () => new Date(fixedNow)
  });
});

beforeEach(async () => {
  sequence += 1;
  clientId = (await db.pool.query(
    "INSERT INTO clients (full_name, email) VALUES ('Next Action Client', 'next-action@example.invalid') RETURNING id"
  )).rows[0].id;
  commissionId = (await db.pool.query(
    `INSERT INTO commissions (
       commission_number, client_id, title, description, medium, price, status
     ) VALUES ($1, $2, 'Next Action Work', 'Resolver test', 'Oil', 400, 'draft')
     RETURNING id`,
    [`SAS-COM-2026-${String(9800 + sequence).padStart(4, "0")}`, clientId]
  )).rows[0].id;
});

afterEach(async () => {
  await db.pool.query("TRUNCATE acceptances RESTART IDENTITY");
  await db.pool.query("DELETE FROM documents");
  await db.pool.query("DELETE FROM quotations");
  await db.pool.query("DELETE FROM commission_events");
  await db.pool.query("DELETE FROM commission_production");
  await db.pool.query("DELETE FROM commissions");
  await db.pool.query("DELETE FROM clients");
});

after(async () => {
  await db?.pool.end();
  await database?.stop();
});

function snapshot(number, version = 1) {
  return {
    quotation_number: number,
    version,
    issued_at: "2026-10-01T16:00:00.000Z",
    expires_at: "2026-11-10T16:00:00.000Z",
    client: {
      client_id: String(clientId),
      full_name: "Next Action Client",
      email: "next-action@example.invalid",
      phone: null
    },
    commission: {
      commission_id: String(commissionId),
      commission_number: `SAS-COM-2026-${String(9800 + sequence).padStart(4, "0")}`,
      title: "Next Action Work",
      description: "Resolver test",
      medium: "Oil",
      dimensions: { width: null, height: null, unit: "in" }
    },
    commercial: {
      price: "400.00",
      sales_tax_rate: "0.0600",
      sales_tax: "24.00",
      shipping_charge: "0.00",
      required_deposit_rate: "0.5000",
      required_deposit: "200.00",
      total: "424.00",
      estimated_completion: null,
      special_terms: null
    }
  };
}

async function insertQuotation({
  number = `SAS-QUO-2026-${String(9800 + sequence).padStart(4, "0")}`,
  version = 1,
  status = "draft",
  expiresAt = "2026-11-10T16:00:00.000Z",
  acceptance = false
} = {}) {
  const quotationSnapshot = snapshot(number, version);
  quotationSnapshot.expires_at = expiresAt;
  const hash = hashQuotationSnapshot(quotationSnapshot);
  const issued = status !== "draft";
  const quotation = (await db.pool.query(
    `INSERT INTO quotations (
       commission_id, quotation_number, version, quotation_status,
       issued_at, sent_at, accepted_at, expires_at,
       price, sales_tax_rate, sales_tax, shipping_charge,
       required_deposit_rate, required_deposit,
       quotation_snapshot, snapshot_hash
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8,
       400, .06, 24, 0, .50, 200, $9::jsonb, $10
     ) RETURNING id`,
    [
      commissionId,
      number,
      version,
      status,
      issued ? "2026-10-01T16:00:00.000Z" : null,
      ["sent", "accepted"].includes(status) ? "2026-10-02T16:00:00.000Z" : null,
      status === "accepted" ? "2026-10-03T16:00:00.000Z" : null,
      issued ? expiresAt : null,
      issued ? JSON.stringify(quotationSnapshot) : null,
      issued ? hash : null
    ]
  )).rows[0];

  if (acceptance) {
    await db.pool.query(
      `INSERT INTO acceptances (
         acceptance_type, quotation_id, commission_id, client_id,
         client_name_entered, client_email, accepted_at, acceptance_method,
         subject_number, subject_version, snapshot_hash, request_id
       ) VALUES (
         'quotation', $1, $2, $3, 'Next Action Client',
         'next-action@example.invalid', '2026-10-03T16:00:00.000Z',
         'admin_recorded', $4, $5, $6, $7
       )`,
      [quotation.id, commissionId, clientId, number, version, hash, randomUUID()]
    );
  }

  return quotation;
}

function resolve() {
  return readCommissionNextAction(db, commissionId, { now: fixedNow });
}

test("no quotation resolves to prepare_quotation", async () => {
  const action = await resolve();
  assert.equal(action.code, "prepare_quotation");
  assert.equal(action.state, "action");
  assert.match(action.target.href, /quotation\.html\?commission_id=/);
});

test("draft resolves to continue_quotation", async () => {
  await insertQuotation();
  const action = await resolve();
  assert.equal(action.code, "continue_quotation");
  assert.equal(action.state, "action");
});

test("issued resolves to mark_quotation_sent", async () => {
  await insertQuotation({ status: "issued" });
  assert.equal((await resolve()).code, "mark_quotation_sent");
});

test("valid sent quotation waits for Acceptance", async () => {
  await insertQuotation({ status: "sent" });
  const action = await resolve();
  assert.equal(action.code, "await_quotation_acceptance");
  assert.equal(action.state, "waiting");
  assert.equal(action.target, null);
});

for (const status of ["issued", "sent"]) {
  test(`expired ${status} quotation resolves to a new version`, async () => {
    await insertQuotation({ status, expiresAt: "2026-10-10T16:00:00.000Z" });
    assert.equal((await resolve()).code, "prepare_new_quotation_version");
  });
}

test("accepted Quotation with valid Acceptance resolves to prepare_contract", async () => {
  await insertQuotation({ status: "accepted", acceptance: true });
  const action = await resolve();
  assert.equal(action.code, "prepare_contract");
  assert.equal(action.state, "action");
  assert.equal(action.blocking_reason, "contract_terms_under_review");
  assert.match(action.target.href, /create-contract\.html\?commission_id=/);
  assert.doesNotMatch(action.label, /issue/i);
});

test("accepted status without valid Acceptance requires data integrity review", async () => {
  await insertQuotation({ status: "accepted", acceptance: false });
  const action = await resolve();
  assert.equal(action.code, "data_integrity_review");
  assert.equal(action.state, "blocked");
  assert.equal(action.blocking_reason, "missing_acceptance");
});

test("multiple active quotation families require data integrity review", async () => {
  await insertQuotation({ number: "SAS-QUO-2026-9901" });
  await insertQuotation({ number: "SAS-QUO-2026-9902" });
  const action = await resolve();
  assert.equal(action.code, "data_integrity_review");
  assert.equal(action.state, "blocked");
});

test("accepted quotation plus another active family is not selected silently", async () => {
  await insertQuotation({
    number: "SAS-QUO-2026-9911",
    status: "accepted",
    acceptance: true
  });
  await insertQuotation({ number: "SAS-QUO-2026-9912" });
  const action = await resolve();
  assert.equal(action.code, "data_integrity_review");
  assert.equal(action.blocking_reason, "ambiguous_active_families");
});

test("legacy Commission status does not govern Next Action", async () => {
  const before = await resolve();
  await db.pool.query("UPDATE commissions SET status = 'completed' WHERE id = $1", [commissionId]);
  const afterResult = await resolve();
  assert.equal(before.code, "prepare_quotation");
  assert.equal(afterResult.code, before.code);
});

test("not_started Production does not invent reserve, start, deposit, or payment actions", async () => {
  await db.pool.query(
    "INSERT INTO commission_production (commission_id, production_status) VALUES ($1, 'not_started')",
    [commissionId]
  );
  const action = await resolve();
  assert.equal(action.code, "prepare_quotation");
  assert.doesNotMatch(JSON.stringify(action), /reserve_production|start_production|await_deposit|await_final_payment/);
});

test("later Production state is described safely without exposing a mutation", async () => {
  await db.pool.query(
    "INSERT INTO commission_production (commission_id, production_status) VALUES ($1, 'in_progress')",
    [commissionId]
  );
  const action = await resolve();
  assert.equal(action.code, "production_workflow_unavailable");
  assert.equal(action.state, "blocked");
  assert.equal(action.target, null);
});

test("terms gate never exposes Contract issuance", () => {
  const action = resolveCommissionNextAction({
    commission: { id: "1" },
    quotations: [],
    contractEligibility: { outcome: "eligible" },
    production: { initialized: false },
    termsApproved: false,
    now: fixedNow
  });
  assert.equal(action.code, "prepare_contract");
  assert.equal(action.blocking_reason, "contract_terms_under_review");
  assert.doesNotMatch(JSON.stringify(action), /issue_contract/);
});

test("protected endpoint is read-only and resolving creates no event", async () => {
  const path = `/admin/api/commissions/${commissionId}/next-action`;
  const unauthenticated = await handler(new Request(`http://localhost${path}`));
  assert.equal(unauthenticated.status, 401);

  const response = await handler(new Request(`http://localhost${path}`, {
    headers: { Cookie: cookie }
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.commission_id, String(commissionId));
  assert.equal(body.next_action.code, "prepare_quotation");

  for (const method of ["POST", "PATCH", "DELETE"]) {
    const blocked = await handler(new Request(`http://localhost${path}`, {
      method,
      headers: { Cookie: cookie }
    }));
    assert.equal(blocked.status, 405);
  }

  const eventCount = (await db.pool.query(
    "SELECT count(*)::integer AS count FROM commission_events WHERE commission_id = $1",
    [commissionId]
  )).rows[0].count;
  assert.equal(eventCount, 0);
});
