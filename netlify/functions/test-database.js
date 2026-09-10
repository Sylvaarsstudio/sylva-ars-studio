const { randomUUID, timingSafeEqual } = require("node:crypto");
const { getDatabase } = require("@netlify/database");

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(body)
  };
}

function testFormResponse() {
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer"
    },
    body: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Database validation</title>
    <style>
      body { font: 16px system-ui; max-width: 36rem; margin: 4rem auto; padding: 0 1rem; }
      label, input, button { display: block; width: 100%; box-sizing: border-box; }
      input, button { margin-top: .5rem; padding: .75rem; }
    </style>
  </head>
  <body>
    <h1>Database validation</h1>
    <form method="post" action="/api/test-database">
      <label for="database-test-token">Private test token</label>
      <input id="database-test-token" name="database_test_token" type="password" autocomplete="off" required>
      <button type="submit">Run CRUD validation</button>
    </form>
  </body>
</html>`
  };
}

function hasValidToken(actualToken, expectedToken) {
  if (!actualToken || !expectedToken) {
    return false;
  }

  const actual = Buffer.from(actualToken);
  const expected = Buffer.from(expectedToken);

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function getSuppliedToken(event) {
  const headerToken = event.headers?.["x-database-test-token"];

  if (headerToken) {
    return headerToken;
  }

  const contentType = event.headers?.["content-type"] || "";

  if (!contentType.includes("application/x-www-form-urlencoded") || !event.body) {
    return "";
  }

  return new URLSearchParams(event.body).get("database_test_token") || "";
}

async function runCrud(db) {
  const connection = await db.pool.connect();
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

    const checks = {
      insert: inserted.rowCount === 1,
      read: read.rowCount === 1 && read.rows[0].email === testEmail,
      update:
        updated.rowCount === 1 &&
        updated.rows[0].full_name === "Database CRUD Test Updated",
      delete: deleted.rowCount === 1 && remaining.rows[0].count === 0
    };

    if (Object.values(checks).some((passed) => !passed)) {
      throw new Error("One or more CRUD checks failed.");
    }

    await connection.query("COMMIT");

    return {
      checks,
      returned_record: {
        full_name: updated.rows[0].full_name,
        email_domain: "sylvaarsstudio.invalid"
      },
      cleanup_complete: true
    };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

function createHandler(databaseFactory = getDatabase) {
  return async function handler(event) {
    if (event.httpMethod === "GET") {
      return testFormResponse();
    }

    if (event.httpMethod !== "POST") {
      return jsonResponse(405, {
        success: false,
        message: "Method not allowed. Use POST."
      });
    }

    const suppliedToken = getSuppliedToken(event);
    const expectedToken = process.env.DATABASE_TEST_TOKEN;

    if (!hasValidToken(suppliedToken, expectedToken)) {
      return jsonResponse(401, {
        success: false,
        message: "Unauthorized."
      });
    }

    try {
      const result = await runCrud(databaseFactory());

      return jsonResponse(200, {
        success: true,
        ...result
      });
    } catch (error) {
      console.error("Database CRUD validation failed:", error);

      return jsonResponse(500, {
        success: false,
        message: "Database CRUD validation failed."
      });
    }
  };
}

exports.createHandler = createHandler;
exports.handler = createHandler();
exports.runCrud = runCrud;
