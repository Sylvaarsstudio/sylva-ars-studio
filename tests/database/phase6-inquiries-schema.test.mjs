import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { NetlifyDB } from "@netlify/database-dev";
import pg from "pg";

const { Client } = pg;

let database;
let client;

before(async () => {
  database = new NetlifyDB({ logger: () => {} });
  const connectionString = await database.start();
  await database.applyMigrations("./netlify/database/migrations");

  client = new Client({ connectionString });
  await client.connect();
});

afterEach(async () => {
  await client?.query("DELETE FROM inquiries");
});

after(async () => {
  await client?.end();
  await database?.stop();
});

test("phase 6 creates the inquiries table", async () => {
  const { rows } = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'inquiries'
  `);

  assert.deepEqual(rows, [{ table_name: "inquiries" }]);
});

test("phase 6 inserts a minimal inquiry with generated defaults", async () => {
  const { rows } = await client.query(
    `INSERT INTO inquiries (form_type, client_name, client_email, message)
     VALUES ($1, $2, $3, $4)
     RETURNING id, source_submission_id, status, created_at, updated_at`,
    [
      "contact",
      "Test Client",
      "minimal-inquiry@sylvaarsstudio.invalid",
      "A valid minimal inquiry."
    ]
  );

  assert.match(
    rows[0].id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  );
  assert.equal(rows[0].source_submission_id, null);
  assert.equal(rows[0].status, "new");
  assert.ok(rows[0].created_at);
  assert.ok(rows[0].updated_at);
});

test("phase 6 rejects duplicate non-null source submission IDs", async () => {
  const sourceSubmissionId = "netlify-submission-duplicate-test";

  await client.query(
    `INSERT INTO inquiries (
       source_submission_id,
       form_type,
       client_name,
       client_email,
       message
     )
     VALUES ($1, $2, $3, $4, $5)`,
    [
      sourceSubmissionId,
      "contact",
      "First Client",
      "first-duplicate-test@sylvaarsstudio.invalid",
      "First inquiry."
    ]
  );

  await assert.rejects(
    client.query(
      `INSERT INTO inquiries (
         source_submission_id,
         form_type,
         client_name,
         client_email,
         message
       )
       VALUES ($1, $2, $3, $4, $5)`,
      [
        sourceSubmissionId,
        "contact",
        "Second Client",
        "second-duplicate-test@sylvaarsstudio.invalid",
        "Second inquiry."
      ]
    ),
    (error) => error.code === "23505"
  );
});

test("phase 6 accepts every approved form type", async () => {
  const formTypes = [
    "contact",
    "artwork_inquiry",
    "commission_request",
    "collaboration"
  ];

  for (const [index, formType] of formTypes.entries()) {
    await client.query(
      `INSERT INTO inquiries (form_type, client_name, client_email, message)
       VALUES ($1, $2, $3, $4)`,
      [
        formType,
        `Form Type Client ${index}`,
        `form-type-${index}@sylvaarsstudio.invalid`,
        "Valid form type inquiry."
      ]
    );
  }

  const { rows } = await client.query(
    "SELECT form_type FROM inquiries ORDER BY form_type"
  );
  assert.deepEqual(
    rows.map(({ form_type }) => form_type),
    [...formTypes].sort()
  );
});

test("phase 6 rejects an invalid form type", async () => {
  await assert.rejects(
    client.query(
      `INSERT INTO inquiries (form_type, client_name, client_email, message)
       VALUES ($1, $2, $3, $4)`,
      [
        "invalid_form",
        "Invalid Form Client",
        "invalid-form@sylvaarsstudio.invalid",
        "This insert must fail."
      ]
    ),
    (error) => error.code === "23514"
  );
});

test("phase 6 accepts approved estimated dates and NULL", async () => {
  const estimatedDates = [
    "flexible",
    "within_1_month",
    "within_2_months",
    "within_3_months",
    null
  ];

  for (const [index, estimatedDate] of estimatedDates.entries()) {
    await client.query(
      `INSERT INTO inquiries (
         form_type,
         client_name,
         client_email,
         estimated_date,
         message
       )
       VALUES ($1, $2, $3, $4, $5)`,
      [
        "commission_request",
        `Estimated Date Client ${index}`,
        `estimated-date-${index}@sylvaarsstudio.invalid`,
        estimatedDate,
        "Valid estimated date inquiry."
      ]
    );
  }

  const { rows } = await client.query(
    "SELECT estimated_date FROM inquiries ORDER BY client_email"
  );
  assert.deepEqual(
    rows.map(({ estimated_date }) => estimated_date),
    estimatedDates
  );
});

test("phase 6 rejects an invalid estimated date", async () => {
  await assert.rejects(
    client.query(
      `INSERT INTO inquiries (
         form_type,
         client_name,
         client_email,
         estimated_date,
         message
       )
       VALUES ($1, $2, $3, $4, $5)`,
      [
        "commission_request",
        "Invalid Estimated Date Client",
        "invalid-estimated-date@sylvaarsstudio.invalid",
        "next_week",
        "This insert must fail."
      ]
    ),
    (error) => error.code === "23514"
  );
});

test("phase 6 accepts approved occasions and NULL", async () => {
  const occasions = [
    "birthday",
    "valentines_day",
    "mothers_day",
    "fathers_day",
    "graduation",
    "wedding_anniversary",
    "halloween",
    "thanksgiving",
    "christmas_holiday",
    "national_holiday",
    "other",
    null
  ];

  for (const [index, occasion] of occasions.entries()) {
    await client.query(
      `INSERT INTO inquiries (
         form_type,
         client_name,
         client_email,
         occasion,
         message
       )
       VALUES ($1, $2, $3, $4, $5)`,
      [
        "commission_request",
        `Occasion Client ${index}`,
        `occasion-${index.toString().padStart(2, "0")}@sylvaarsstudio.invalid`,
        occasion,
        "Valid occasion inquiry."
      ]
    );
  }

  const { rows } = await client.query(
    "SELECT occasion FROM inquiries ORDER BY client_email"
  );
  assert.deepEqual(
    rows.map(({ occasion }) => occasion),
    occasions
  );
});

test("phase 6 rejects none as an occasion", async () => {
  await assert.rejects(
    client.query(
      `INSERT INTO inquiries (
         form_type,
         client_name,
         client_email,
         occasion,
         message
       )
       VALUES ($1, $2, $3, $4, $5)`,
      [
        "commission_request",
        "Invalid Occasion Client",
        "invalid-occasion@sylvaarsstudio.invalid",
        "none",
        "This insert must fail."
      ]
    ),
    (error) => error.code === "23514"
  );
});

test("phase 6 accepts every approved status", async () => {
  const statuses = [
    "new",
    "reviewing",
    "replied",
    "accepted",
    "declined",
    "closed"
  ];

  for (const [index, status] of statuses.entries()) {
    await client.query(
      `INSERT INTO inquiries (
         form_type,
         client_name,
         client_email,
         message,
         status
       )
       VALUES ($1, $2, $3, $4, $5)`,
      [
        "contact",
        `Status Client ${index}`,
        `status-${index}@sylvaarsstudio.invalid`,
        "Valid status inquiry.",
        status
      ]
    );
  }

  const { rows } = await client.query(
    "SELECT status FROM inquiries ORDER BY client_email"
  );
  assert.deepEqual(
    rows.map(({ status }) => status),
    statuses
  );
});

test("phase 6 rejects an invalid status", async () => {
  await assert.rejects(
    client.query(
      `INSERT INTO inquiries (
         form_type,
         client_name,
         client_email,
         message,
         status
       )
       VALUES ($1, $2, $3, $4, $5)`,
      [
        "contact",
        "Invalid Status Client",
        "invalid-status@sylvaarsstudio.invalid",
        "This insert must fail.",
        "pending"
      ]
    ),
    (error) => error.code === "23514"
  );
});

test("phase 6 allows every optional field to be NULL", async () => {
  const { rows } = await client.query(
    `INSERT INTO inquiries (form_type, client_name, client_email, message)
     VALUES ($1, $2, $3, $4)
     RETURNING
       source_submission_id,
       client_phone,
       artwork_title,
       artwork_subject,
       artwork_size,
       budget_range,
       estimated_date,
       occasion,
       shipping_location,
       preferred_contact_method,
       reference_notes,
       organization_project,
       collaboration_type`,
    [
      "contact",
      "Optional Fields Client",
      "optional-fields@sylvaarsstudio.invalid",
      "An inquiry with all optional fields omitted."
    ]
  );

  assert.deepEqual(rows[0], {
    source_submission_id: null,
    client_phone: null,
    artwork_title: null,
    artwork_subject: null,
    artwork_size: null,
    budget_range: null,
    estimated_date: null,
    occasion: null,
    shipping_location: null,
    preferred_contact_method: null,
    reference_notes: null,
    organization_project: null,
    collaboration_type: null
  });
});
