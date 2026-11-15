import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const directoryPath = "web/legal/index.html";
const stylesheetPath = "web/css/legal.css";
const reviewHeading = "Under legal review";
const reviewMessage =
  "This policy is currently under legal review and approval. It is not yet effective. Please return for the approved version.";
const directoryNotice =
  "Pages remain available while legal review is in progress. Draft policies are not currently effective.";

const policies = Object.freeze([
  { filename: "privacy.html", title: "Privacy Policy" },
  { filename: "cookies.html", title: "Cookie Notice" },
  { filename: "terms-of-use.html", title: "Terms of Use" },
  { filename: "copyright.html", title: "Copyright & Content Use" },
  { filename: "accessibility.html", title: "Accessibility" },
  { filename: "email-communications.html", title: "Email Communications" }
]);

const directoryPolicyLinks = Object.freeze([
  ["/legal/privacy.html", "Privacy Policy"],
  ["/legal/cookies.html", "Cookie Notice"],
  ["/legal/accessibility.html", "Accessibility"],
  ["/legal/terms-of-use.html", "Terms of Use"],
  ["/legal/copyright.html", "Copyright & Content Use"],
  ["/legal/email-communications.html", "Email Communications"]
]);

const directoryDocumentLinks = Object.freeze([
  ["/documents/artwork-sales-agreement.html", "Artwork Sales Agreement", "Draft"],
  ["/documents/commission-agreement.html", "Commission Agreement", "Draft"],
  ["/documents/invoice-template.html", "Invoice", "Sample"],
  ["/documents/coa-template.html", "Certificate of Authenticity", "Sample"]
]);

function read(path) {
  return readFileSync(path, "utf8");
}

function policyPath(filename) {
  return `web/legal/${filename}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeText(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&mdash;/g, "—")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

function visibleMainText(html) {
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  assert.ok(main, "expected one main element");
  return decodeText(main[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function attributeValues(html, attribute) {
  return Array.from(
    html.matchAll(new RegExp(`\\b${attribute}=["']([^"']+)["']`, "gi")),
    (match) => match[1]
  );
}

test("all seven approved legal routes and the legal stylesheet exist", () => {
  assert.ok(read(directoryPath));
  assert.ok(read(stylesheetPath));
  for (const { filename } of policies) assert.ok(read(policyPath(filename)));
});

test("the directory has its exact title, introduction, and review notice", () => {
  const html = read(directoryPath);
  assert.match(html, /<h1>Legal &amp; Policies<\/h1>/);
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.match(html, /A directory of policy pages and public studio document references\./);
  assert.match(html, new RegExp(escapeRegExp(directoryNotice)));
});

test("the directory contains the three exact category headings", () => {
  const html = read(directoryPath);
  for (const heading of ["Privacy &amp; access", "Use &amp; rights", "Studio documents"]) {
    assert.match(html, new RegExp(`<h2[^>]*>${escapeRegExp(heading)}<\\/h2>`));
  }
  assert.equal((html.match(/<h2\b/g) || []).length, 3);
});

test("the directory contains each approved policy link exactly once", () => {
  const html = read(directoryPath);
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  assert.ok(main, "expected one main element");
  for (const [href, label] of directoryPolicyLinks) {
    const encodedLabel = label.replace(/&/g, "&amp;");
    const link = new RegExp(
      `<a href="${escapeRegExp(href)}">${escapeRegExp(encodedLabel)}<\\/a>`,
      "g"
    );
    assert.equal((main[1].match(link) || []).length, 1, href);
  }
});

test("the four public document links have exact visible Draft and Sample states", () => {
  const html = read(directoryPath);
  for (const [href, label, status] of directoryDocumentLinks) {
    const link = new RegExp(
      `<a href="${escapeRegExp(href)}">[\\s\\S]*?<span>${escapeRegExp(label)}<\\/span>[\\s\\S]*?` +
      `aria-label="Document status: ${status}">${status}<\\/span>[\\s\\S]*?<\\/a>`
    );
    assert.match(html, link, href);
  }
  assert.equal((html.match(/>Draft<\/span>/g) || []).length, 2);
  assert.equal((html.match(/>Sample<\/span>/g) || []).length, 2);
});

test("the six provisional pages use their exact titles", () => {
  for (const { filename, title } of policies) {
    const html = read(policyPath(filename));
    const encodedTitle = title.replace(/&/g, "&amp;");
    assert.match(html, new RegExp(`<title>${escapeRegExp(encodedTitle)} \\| Sylva Ars Studio<\\/title>`));
    assert.match(html, new RegExp(`<h1>${escapeRegExp(encodedTitle)}<\\/h1>`));
    assert.equal((html.match(/<h1\b/g) || []).length, 1);
  }
});

test("each provisional page has the exact review notification once", () => {
  for (const { filename } of policies) {
    const html = read(policyPath(filename));
    assert.equal((html.match(new RegExp(escapeRegExp(reviewHeading), "g")) || []).length, 1);
    assert.equal((html.match(new RegExp(escapeRegExp(reviewMessage), "g")) || []).length, 1);
    assert.match(html, /<aside class="legal-review-notice" aria-labelledby="legal-review-title">/);
  }
});

test("only provisional pages contain the exact noindex directive", () => {
  assert.doesNotMatch(read(directoryPath), /<meta\s+name="robots"/i);
  for (const { filename } of policies) {
    const html = read(policyPath(filename));
    assert.equal(
      (html.match(/<meta name="robots" content="noindex, follow">/g) || []).length,
      1,
      filename
    );
  }
});

test("each provisional page links back to the legal directory", () => {
  for (const { filename } of policies) {
    const html = read(policyPath(filename));
    assert.equal(
      (html.match(/<a class="legal-back-link" href="\/legal\/">Back to Legal &amp; Policies<\/a>/g) || []).length,
      1,
      filename
    );
  }
});

test("provisional pages contain no policy content beyond the approved notice", () => {
  for (const { filename, title } of policies) {
    assert.equal(
      visibleMainText(read(policyPath(filename))),
      `${title} ${reviewHeading} ${reviewMessage} Back to Legal & Policies`,
      filename
    );
  }
});

test("all legal pages use only approved local stylesheets and local images", () => {
  const pages = [directoryPath, ...policies.map(({ filename }) => policyPath(filename))];
  const expectedImages = [
    "/images/logo.png",
    "/images/social/whatsapp.svg",
    "/images/social/instagram.svg",
    "/images/social/pinterest.svg",
    "/images/social/youtube.svg",
    "/images/social/facebook.svg",
    "/images/social/x-twitter.svg"
  ];
  for (const page of pages) {
    const html = read(page);
    assert.deepEqual(attributeValues(html, "src"), expectedImages, page);
    assert.deepEqual(
      attributeValues(html, "href").filter((value) => value.endsWith(".css")),
      ["/css/main.css", "/css/legal.css"],
      page
    );
  }
});

test("legal pages contain no JavaScript, inline handlers, or external resources", () => {
  const pages = [directoryPath, ...policies.map(({ filename }) => policyPath(filename))];
  for (const page of pages) {
    const html = read(page);
    assert.doesNotMatch(html, /<script\b|\son[a-z]+\s*=|<iframe\b/i, page);
    assert.doesNotMatch(html, /\bsrc=["'](?:https?:)?\/\//i, page);
    assert.doesNotMatch(html, /<link\b[^>]*\bhref=["'](?:https?:)?\/\//i, page);
  }
});

test("all internal links and resources use absolute site paths", () => {
  const pages = [directoryPath, ...policies.map(({ filename }) => policyPath(filename))];
  for (const page of pages) {
    const html = read(page);
    for (const value of [...attributeValues(html, "href"), ...attributeValues(html, "src")]) {
      if (/^https:\/\//.test(value)) continue;
      assert.ok(value.startsWith("/"), `${page}: ${value}`);
    }
  }
});

test("legal pages expose a labeled navigation, one main, and logical headings", () => {
  const pages = [directoryPath, ...policies.map(({ filename }) => policyPath(filename))];
  for (const page of pages) {
    const html = read(page);
    assert.equal((html.match(/<main\b/g) || []).length, 1, page);
    assert.equal((html.match(/<nav class="navbar" aria-label="Primary navigation">/g) || []).length, 1, page);
    assert.equal((html.match(/<h1\b/g) || []).length, 1, page);
    assert.match(html, /<html lang="en">/, page);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1\.0">/, page);
  }
});

test("legal styling provides visible focus, responsive layout, and neutral status treatment", () => {
  const css = read(stylesheetPath);
  assert.match(css, /:focus-visible\s*{/);
  assert.match(css, /outline:\s*2px solid #111/);
  assert.match(css, /@media\s*\(max-width:\s*700px\)/);
  assert.match(css, /grid-template-columns:\s*1fr/);
  assert.match(css, /\.legal-status\s*{[\s\S]*?border:/);
  assert.match(css, /width:\s*calc\(100% - 36px\)/);
});
