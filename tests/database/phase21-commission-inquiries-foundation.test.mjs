import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { getDatabase } from "@netlify/database";
import { NetlifyDB } from "@netlify/database-dev";

let database;
let db;
let commissions;
let inquiries;

before(async () => {
  database = new NetlifyDB({ logger: () => {} });
  const connectionString = await database.start();
  await database.applyMigrations("./netlify/database/migrations");
  db = getDatabase({ connectionString });

  const clients = (await db.pool.query(`
    INSERT INTO clients (full_name, email)
    VALUES
      ('First Provenance Client', 'first-provenance@example.invalid'),
      ('Second Provenance Client', 'second-provenance@example.invalid')
    RETURNING id
  `)).rows;
  commissions = (await db.pool.query(`
    INSERT INTO commissions (
      commission_number, client_id, title, description, medium, price
    ) VALUES
      ('SAS-COM-2026-2101', $1, 'First Provenance Commission', 'Test', 'Oil', 100),
      ('SAS-COM-2026-2102', $2, 'Second Provenance Commission', 'Test', 'Acrylic', 200)
    RETURNING id
  `, [clients[0].id, clients[1].id])).rows;
  inquiries = (await db.pool.query(`
    INSERT INTO inquiries (form_type, client_name, client_email, message)
    VALUES
      ('commission_request', 'First Provenance Client', 'first-provenance@example.invalid', 'First'),
      ('contact', 'Second Provenance Client', 'second-provenance@example.invalid', 'Second')
    RETURNING id
  `)).rows;
});

afterEach(async () => {
  await db?.pool.query("DELETE FROM commission_inquiries");
});

after(async () => {
  await db?.pool.end();
  await database?.stop();
});

test("phase 21 creates commission_inquiries with the approved columns", async () => {
  const result = await db.pool.query(`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'commission_inquiries'
    ORDER BY ordinal_position
  `);

  assert.deepEqual(result.rows.map((column) => ({
    name: column.column_name,
    type: column.data_type,
    nullable: column.is_nullable,
    has_default: column.column_default !== null
  })), [
    { name: "commission_id", type: "bigint", nullable: "NO", has_default: false },
    { name: "inquiry_id", type: "uuid", nullable: "NO", has_default: false },
    { name: "relationship_type", type: "text", nullable: "NO", has_default: true },
    { name: "created_at", type: "timestamp with time zone", nullable: "NO", has_default: true }
  ]);
});

test("phase 21 foreign keys use ON DELETE RESTRICT", async () => {
  const result = await db.pool.query(`
    SELECT kcu.column_name, ccu.table_name AS foreign_table, rc.delete_rule
    FROM information_schema.table_constraints AS tc
    JOIN information_schema.key_column_usage AS kcu
      ON kcu.constraint_name = tc.constraint_name
     AND kcu.constraint_schema = tc.constraint_schema
    JOIN information_schema.referential_constraints AS rc
      ON rc.constraint_name = tc.constraint_name
     AND rc.constraint_schema = tc.constraint_schema
    JOIN information_schema.constraint_column_usage AS ccu
      ON ccu.constraint_name = tc.constraint_name
     AND ccu.constraint_schema = tc.constraint_schema
    WHERE tc.table_schema = 'public'
      AND tc.table_name = 'commission_inquiries'
      AND tc.constraint_type = 'FOREIGN KEY'
    ORDER BY kcu.column_name
  `);

  assert.deepEqual(result.rows, [
    { column_name: "commission_id", foreign_table: "commissions", delete_rule: "RESTRICT" },
    { column_name: "inquiry_id", foreign_table: "inquiries", delete_rule: "RESTRICT" }
  ]);
});

test("phase 21 defaults relationship_type to origin", async () => {
  const result = await db.pool.query(
    `INSERT INTO commission_inquiries (commission_id, inquiry_id)
     VALUES ($1, $2)
     RETURNING relationship_type, created_at`,
    [commissions[0].id, inquiries[0].id]
  );

  assert.equal(result.rows[0].relationship_type, "origin");
  assert.ok(result.rows[0].created_at);
});

for (const relationshipType of ["origin", "supporting"]) {
  test(`phase 21 accepts relationship type ${relationshipType}`, async () => {
    const result = await db.pool.query(
      `INSERT INTO commission_inquiries (
         commission_id, inquiry_id, relationship_type
       ) VALUES ($1, $2, $3)
       RETURNING relationship_type`,
      [commissions[0].id, inquiries[0].id, relationshipType]
    );

    assert.equal(result.rows[0].relationship_type, relationshipType);
  });
}

test("phase 21 rejects unsupported relationship types", async () => {
  await assert.rejects(
    db.pool.query(
      `INSERT INTO commission_inquiries (
         commission_id, inquiry_id, relationship_type
       ) VALUES ($1, $2, 'accepted')`,
      [commissions[0].id, inquiries[0].id]
    ),
    (error) => error.code === "23514"
  );
});

test("phase 21 rejects a duplicate commission and inquiry pair", async () => {
  await db.pool.query(
    `INSERT INTO commission_inquiries (commission_id, inquiry_id)
     VALUES ($1, $2)`,
    [commissions[0].id, inquiries[0].id]
  );

  await assert.rejects(
    db.pool.query(
      `INSERT INTO commission_inquiries (
         commission_id, inquiry_id, relationship_type
       ) VALUES ($1, $2, 'supporting')`,
      [commissions[0].id, inquiries[0].id]
    ),
    (error) => error.code === "23505"
  );
});

test("phase 21 supports many inquiries per commission and many commissions per inquiry", async () => {
  await db.pool.query(
    `INSERT INTO commission_inquiries (
       commission_id, inquiry_id, relationship_type
     ) VALUES
       ($1, $3, 'origin'),
       ($1, $4, 'supporting'),
       ($2, $3, 'supporting')`,
    [commissions[0].id, commissions[1].id, inquiries[0].id, inquiries[1].id]
  );
  const result = await db.pool.query(
    "SELECT count(*)::integer AS count FROM commission_inquiries"
  );

  assert.equal(result.rows[0].count, 3);
});

test("phase 21 permits commissions and inquiries without provenance", async () => {
  const counts = await db.pool.query(`
    SELECT
      (SELECT count(*)::integer FROM commissions) AS commissions,
      (SELECT count(*)::integer FROM inquiries) AS inquiries,
      (SELECT count(*)::integer FROM commission_inquiries) AS links
  `);

  assert.equal(counts.rows[0].commissions >= 2, true);
  assert.equal(counts.rows[0].inquiries >= 2, true);
  assert.equal(counts.rows[0].links, 0);
});

test("phase 21 prevents deleting linked commission provenance", async () => {
  await db.pool.query(
    `INSERT INTO commission_inquiries (commission_id, inquiry_id)
     VALUES ($1, $2)`,
    [commissions[0].id, inquiries[0].id]
  );

  await assert.rejects(
    db.pool.query("DELETE FROM commissions WHERE id = $1", [commissions[0].id]),
    (error) => error.code === "23503"
  );
});

test("phase 21 prevents deleting linked inquiry provenance", async () => {
  await db.pool.query(
    `INSERT INTO commission_inquiries (commission_id, inquiry_id)
     VALUES ($1, $2)`,
    [commissions[0].id, inquiries[0].id]
  );

  await assert.rejects(
    db.pool.query("DELETE FROM inquiries WHERE id = $1", [inquiries[0].id]),
    (error) => error.code === "23503"
  );
});

test("phase 21 avoids a redundant standalone commission_id index", async () => {
  const result = await db.pool.query(`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'commission_inquiries'
    ORDER BY indexname
  `);
  const definitions = result.rows.map((index) => index.indexdef);

  assert.equal(definitions.some((definition) => /UNIQUE.*commission_id.*inquiry_id/.test(definition)), true);
  assert.equal(definitions.some((definition) => /\(inquiry_id\)/.test(definition)), true);
  assert.equal(
    result.rows.some((index) => index.indexname === "commission_inquiries_commission_id_index"),
    false
  );
});
