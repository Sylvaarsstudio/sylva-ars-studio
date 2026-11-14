import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { test } from "node:test";

const LEGACY_FUNCTION = "netlify/functions/test-database.js";
const DEPLOYED_SOURCE_ROOTS = ["netlify", "web"];
const TEXT_SOURCE_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".sql",
  ".toml"
]);
const FORBIDDEN_DIAGNOSTIC_SURFACE =
  /\/api\/test-database|\/\.netlify\/functions\/test-database|DATABASE_TEST_TOKEN|database_test_token|x-database-test-token/i;

async function sourceFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = `${root}/${entry.name}`;

    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(path)));
      continue;
    }

    const extension = entry.name.slice(entry.name.lastIndexOf("."));
    if (TEXT_SOURCE_EXTENSIONS.has(extension)) {
      files.push(path);
    }
  }

  return files;
}

test("SAS-005 removes the legacy serverless function", async () => {
  await assert.rejects(access(LEGACY_FUNCTION), { code: "ENOENT" });
});

test("SAS-005 leaves no production route or token reference", async () => {
  const files = ["netlify.toml"];

  for (const root of DEPLOYED_SOURCE_ROOTS) {
    files.push(...(await sourceFiles(root)));
  }

  for (const file of files) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, FORBIDDEN_DIAGNOSTIC_SURFACE, file);
  }
});
