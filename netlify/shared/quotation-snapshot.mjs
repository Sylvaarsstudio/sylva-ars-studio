import { createHash } from "node:crypto";

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
    );
  }

  return value;
}

function canonicalSerialize(value) {
  return JSON.stringify(canonicalize(value));
}

function hashQuotationSnapshot(snapshot) {
  return createHash("sha256").update(canonicalSerialize(snapshot)).digest("hex");
}

export { canonicalSerialize, hashQuotationSnapshot };
