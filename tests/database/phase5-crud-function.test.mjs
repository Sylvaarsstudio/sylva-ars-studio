import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createRequire } from "node:module";

import { NetlifyDB } from "@netlify/database-dev";
import { getDatabase } from "@netlify/database";

const require = createRequire(import.meta.url);
const { createHandler } = require("../../netlify/functions/test-database.js");

const testToken = "local-database-test-token";
let database;
let db;
let handler;

before(async () => {
  database = new NetlifyDB({ logger: () => {} });
  const connectionString = await database.start();
  await database.applyMigrations("./netlify/database/migrations");

  db = getDatabase({ connectionString });
  handler = createHandler(() => db);
  process.env.DATABASE_TEST_TOKEN = testToken;
});

after(async () => {
  delete process.env.DATABASE_TEST_TOKEN;
  await db?.pool.end();
  await database?.stop();
});

test("phase 5 rejects a CRUD request without the private token", async () => {
  const response = await handler({ httpMethod: "POST", headers: {} });

  assert.equal(response.statusCode, 401);
  assert.equal(JSON.parse(response.body).success, false);
});

test("phase 5 serves a no-cache validation form without exposing a token", async () => {
  const response = await handler({ httpMethod: "GET", headers: {} });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["Cache-Control"], "no-store");
  assert.match(response.body, /name="database_test_token"/);
  assert.doesNotMatch(response.body, new RegExp(testToken));
});

test("phase 5 completes INSERT, READ, UPDATE, DELETE and cleans up", async () => {
  const response = await handler({
    httpMethod: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ database_test_token: testToken }).toString()
  });
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(body.checks, {
    insert: true,
    read: true,
    update: true,
    delete: true
  });
  assert.equal(body.cleanup_complete, true);

  const remaining = await db.pool.query(
    "SELECT count(*)::integer AS count FROM clients"
  );
  assert.equal(remaining.rows[0].count, 0);
});
