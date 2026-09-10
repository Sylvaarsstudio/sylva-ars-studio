import assert from "node:assert/strict";
import { after, before, test } from "node:test";

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

after(async () => {
  await client?.end();
  await database?.stop();
});

test("phase 4 creates the four studio tables", async () => {
  const { rows } = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('clients', 'commissions', 'payments', 'documents')
    ORDER BY table_name
  `);

  assert.deepEqual(
    rows.map(({ table_name }) => table_name),
    ["clients", "commissions", "documents", "payments"]
  );
});

test("phase 4 links Test Client to the sample commission and calculates its balance", async () => {
  const insertedClient = await client.query(
    `INSERT INTO clients (full_name, email, phone)
     VALUES ($1, $2, $3)
     RETURNING id, full_name`,
    ["Test Client", "test-client@sylvaarsstudio.invalid", null]
  );

  const clientId = insertedClient.rows[0].id;

  const insertedCommission = await client.query(
    `INSERT INTO commissions (
       commission_number,
       client_id,
       title,
       description,
       medium,
       price,
       deposit_amount,
       status
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      "SAS-COM-2026-0001",
      clientId,
      "Test Commission",
      "Temporary record used to validate the relational model.",
      "Oil on canvas",
      "150.00",
      "75.00",
      "draft"
    ]
  );

  const commissionId = insertedCommission.rows[0].id;
  const joined = await client.query(
    `SELECT
       c.commission_number,
       c.price,
       c.deposit_amount,
       c.balance,
       c.status,
       cl.full_name
     FROM commissions AS c
     JOIN clients AS cl ON cl.id = c.client_id
     WHERE c.id = $1`,
    [commissionId]
  );

  assert.deepEqual(joined.rows[0], {
    commission_number: "SAS-COM-2026-0001",
    price: "150.00",
    deposit_amount: "75.00",
    balance: "75.00",
    status: "draft",
    full_name: "Test Client"
  });

  await assert.rejects(
    client.query(
      `INSERT INTO commissions (
         commission_number,
         client_id,
         title,
         description,
         medium,
         price
       )
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        "SAS-COM-2026-9999",
        "999999999",
        "Invalid relation",
        "This insert must fail.",
        "Oil on canvas",
        "1.00"
      ]
    ),
    (error) => error.code === "23503"
  );

  await client.query("DELETE FROM commissions WHERE id = $1", [commissionId]);
  await client.query("DELETE FROM clients WHERE id = $1", [clientId]);

  const remaining = await client.query(
    `SELECT
       (SELECT count(*)::integer FROM clients) AS clients,
       (SELECT count(*)::integer FROM commissions) AS commissions`
  );

  assert.deepEqual(remaining.rows[0], { clients: 0, commissions: 0 });
});
