import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { NetlifyDB } from "@netlify/database-dev";
import { getDatabase } from "@netlify/database";

let database;
let db;

async function runCrud(databaseConnection) {
  const connection = await databaseConnection.pool.connect();
  const testKey = randomUUID();
  const testEmail = `database-crud-${testKey}@sylvaarsstudio.invalid`;

  try {
    await connection.query("BEGIN");

    const inserted = await connection.query(
      `INSERT INTO clients (full_name, email)
       VALUES ($1, $2)
       RETURNING id, full_name, email`,
      ["Database CRUD Test", testEmail]
    );
    const clientId = inserted.rows[0].id;
    const read = await connection.query(
      `SELECT id, full_name, email
       FROM clients
       WHERE id = $1`,
      [clientId]
    );
    const updated = await connection.query(
      `UPDATE clients
       SET full_name = $1
       WHERE id = $2
       RETURNING id, full_name, email`,
      ["Database CRUD Test Updated", clientId]
    );
    const deleted = await connection.query(
      `DELETE FROM clients
       WHERE id = $1
       RETURNING id`,
      [clientId]
    );
    const remaining = await connection.query(
      "SELECT count(*)::integer AS count FROM clients WHERE id = $1",
      [clientId]
    );

    await connection.query("COMMIT");

    return {
      insert: inserted.rowCount === 1,
      read: read.rowCount === 1 && read.rows[0].email === testEmail,
      update:
        updated.rowCount === 1 &&
        updated.rows[0].full_name === "Database CRUD Test Updated",
      delete: deleted.rowCount === 1 && remaining.rows[0].count === 0
    };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

before(async () => {
  database = new NetlifyDB({ logger: () => {} });
  const connectionString = await database.start();
  await database.applyMigrations("./netlify/database/migrations");

  db = getDatabase({ connectionString });
});

after(async () => {
  await db?.pool.end();
  await database?.stop();
});

test("phase 5 local database harness completes CRUD and cleans up", async () => {
  assert.deepEqual(await runCrud(db), {
    insert: true,
    read: true,
    update: true,
    delete: true
  });

  const remaining = await db.pool.query(
    "SELECT count(*)::integer AS count FROM clients"
  );
  assert.equal(remaining.rows[0].count, 0);
});
