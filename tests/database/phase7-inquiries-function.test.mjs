import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { NetlifyDB } from "@netlify/database-dev";
import { getDatabase } from "@netlify/database";
import createRequestHandler, {
  createHandler
} from "../../netlify/functions/create-request.mjs";

const functionUrl = "http://localhost/.netlify/functions/create-request";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let database;
let db;
let handler;

before(async () => {
  database = new NetlifyDB({ logger: () => {} });
  const connectionString = await database.start();
  await database.applyMigrations("./netlify/database/migrations");

  db = getDatabase({ connectionString });
  handler = createHandler(() => db);
});

afterEach(async () => {
  await db?.pool.query("DELETE FROM inquiries");
});

after(async () => {
  await db?.pool.end();
  await database?.stop();
});

function submit(payload) {
  return handler(new Request(functionUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  }));
}

function validPayload(overrides = {}) {
  return {
    form_type: "contact",
    client_name: "Test Client",
    client_email: "inquiry-function@sylvaarsstudio.invalid",
    message: "A valid inquiry message.",
    ...overrides
  };
}

async function getInquiry(id) {
  const { rows } = await db.pool.query(
    "SELECT * FROM inquiries WHERE id = $1",
    [id]
  );
  return rows[0];
}

test("phase 7 creates and returns a real contact inquiry", async () => {
  const response = await submit(validPayload());
  const body = await response.json();

  assert.equal(typeof createRequestHandler, "function");
  assert.equal(response instanceof Response, true);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(body.success, true);
  assert.match(body.id, uuidPattern);
  assert.equal(body.request_id, body.id);
  assert.equal(body.status, "new");

  const inquiry = await getInquiry(body.id);
  assert.equal(inquiry.form_type, "contact");
  assert.equal(inquiry.client_name, "Test Client");
  assert.equal(inquiry.client_email, "inquiry-function@sylvaarsstudio.invalid");
  assert.equal(inquiry.message, "A valid inquiry message.");
  assert.equal(inquiry.source_submission_id, null);

  const relatedCounts = await db.pool.query(`
    SELECT
      (SELECT count(*)::integer FROM clients) AS clients,
      (SELECT count(*)::integer FROM commissions) AS commissions
  `);
  assert.deepEqual(relatedCounts.rows[0], { clients: 0, commissions: 0 });
});

test("phase 7 creates an artwork inquiry", async () => {
  const response = await submit(validPayload({
    form_type: "artwork_inquiry",
    artwork_title: "Still Here",
    client_phone: "  555-0100  ",
    shipping_location: "  New York, NY  ",
    preferred_contact_method: "  Email  "
  }));
  const body = await response.json();

  assert.equal(response.status, 200);
  const inquiry = await getInquiry(body.id);
  assert.equal(inquiry.form_type, "artwork_inquiry");
  assert.equal(inquiry.artwork_title, "Still Here");
  assert.equal(inquiry.client_phone, "555-0100");
  assert.equal(inquiry.shipping_location, "New York, NY");
  assert.equal(inquiry.preferred_contact_method, "Email");
});

test("phase 7 stores commission request fields", async () => {
  const response = await submit(validPayload({
    form_type: "commission_request",
    artwork_subject: "Family portrait",
    artwork_size: "24 x 36 in",
    budget_range: "$1,000 - $2,500",
    estimated_date: "within_3_months",
    occasion: "wedding_anniversary",
    shipping_location: "Miami, FL",
    reference_notes: "Use the supplied photographs."
  }));
  const body = await response.json();

  assert.equal(response.status, 200);
  const inquiry = await getInquiry(body.id);
  assert.equal(inquiry.artwork_subject, "Family portrait");
  assert.equal(inquiry.artwork_size, "24 x 36 in");
  assert.equal(inquiry.budget_range, "$1,000 - $2,500");
  assert.equal(inquiry.estimated_date, "within_3_months");
  assert.equal(inquiry.occasion, "wedding_anniversary");
  assert.equal(inquiry.shipping_location, "Miami, FL");
  assert.equal(inquiry.reference_notes, "Use the supplied photographs.");
});

test("phase 7 stores collaboration fields", async () => {
  const response = await submit(validPayload({
    form_type: "collaboration",
    organization_project: "Museum exhibition",
    collaboration_type: "Exhibition",
    estimated_date: "flexible",
    occasion: "national_holiday"
  }));
  const body = await response.json();

  assert.equal(response.status, 200);
  const inquiry = await getInquiry(body.id);
  assert.equal(inquiry.organization_project, "Museum exhibition");
  assert.equal(inquiry.collaboration_type, "Exhibition");
  assert.equal(inquiry.estimated_date, "flexible");
  assert.equal(inquiry.occasion, "national_holiday");
});

test("phase 7 converts none and empty optional fields to NULL", async () => {
  const response = await submit(validPayload({
    client_phone: "",
    artwork_title: "  ",
    artwork_subject: "",
    artwork_size: "",
    budget_range: "",
    estimated_date: "",
    occasion: "none",
    shipping_location: "",
    preferred_contact_method: "",
    reference_notes: "",
    organization_project: "",
    collaboration_type: ""
  }));
  const body = await response.json();

  assert.equal(response.status, 200);
  const inquiry = await getInquiry(body.id);
  assert.equal(inquiry.client_phone, null);
  assert.equal(inquiry.artwork_title, null);
  assert.equal(inquiry.artwork_subject, null);
  assert.equal(inquiry.artwork_size, null);
  assert.equal(inquiry.budget_range, null);
  assert.equal(inquiry.estimated_date, null);
  assert.equal(inquiry.occasion, null);
  assert.equal(inquiry.shipping_location, null);
  assert.equal(inquiry.preferred_contact_method, null);
  assert.equal(inquiry.reference_notes, null);
  assert.equal(inquiry.organization_project, null);
  assert.equal(inquiry.collaboration_type, null);
});

for (const [field, value] of [
  ["message", "  "],
  ["client_name", ""],
  ["client_email", "  "]
]) {
  test(`phase 7 rejects an empty ${field}`, async () => {
    const response = await submit(validPayload({ [field]: value }));
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.success, false);
    assert.match(body.message, new RegExp(field));

    const count = await db.pool.query(
      "SELECT count(*)::integer AS count FROM inquiries"
    );
    assert.equal(count.rows[0].count, 0);
  });
}

test("phase 7 rejects an invalid form type", async () => {
  const response = await submit(validPayload({ form_type: "newsletter" }));
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.success, false);
  assert.equal(body.message, "Unsupported form_type.");
});

test("phase 7 rejects an invalid estimated date", async () => {
  const response = await submit(validPayload({ estimated_date: "next_week" }));
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.success, false);
  assert.equal(body.message, "Unsupported estimated_date.");
});

test("phase 7 rejects an invalid occasion", async () => {
  const response = await submit(validPayload({ occasion: "anniversary" }));
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.success, false);
  assert.equal(body.message, "Unsupported occasion.");
});

test("phase 7 modern function rejects GET with a JSON Response", async () => {
  const response = await handler(new Request(functionUrl));
  const body = await response.json();

  assert.equal(response instanceof Response, true);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.deepEqual(body, {
    success: false,
    message: "Method not allowed. Use POST."
  });
});
