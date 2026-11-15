import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  CANONICAL_FRAGMENT_PATH,
  PUBLIC_FOOTER_END,
  PUBLIC_FOOTER_START,
  PUBLIC_FOOTER_TARGETS,
  replaceFooterBlock,
  syncPublicFooter
} = require("../../scripts/sync-public-footer.js");
const { main: generateArtworks } = require("../../scripts/generate-artworks.js");
const { main: generateStudioNotes } = require("../../scripts/generate-studio-notes.js");

const expectedTargets = Object.freeze([
  "web/index.html",
  "web/collection.html",
  "web/about.html",
  "web/contact.html",
  "web/collaboration.html",
  "web/artwork-inquiry.html",
  "web/commission-request.html",
  "web/legal/index.html",
  "web/legal/privacy.html",
  "web/legal/cookies.html",
  "web/legal/terms-of-use.html",
  "web/legal/copyright.html",
  "web/legal/accessibility.html",
  "web/legal/email-communications.html",
  "web/templates/artwork-page-template.html",
  "web/templates/studio-note-page-template.html",
  "web/templates/studio-notes-index-template.html",
  "web/artworks/a-shared-legacy.html",
  "web/artworks/autumn-glow.html",
  "web/artworks/before-the-crossing.html",
  "web/artworks/between-flight-and-fall.html",
  "web/artworks/found-family.html",
  "web/artworks/harvest-road.html",
  "web/artworks/shared-horizon.html",
  "web/artworks/still-here.html",
  "web/artworks/who-am-i.html",
  "web/studio-notes/index.html",
  "web/studio-notes/still-here.html"
]);

const expectedSocialLinks = Object.freeze([
  ["https://instagram.com/sylvaarsstudio", "instagram.svg"],
  ["https://pinterest.com/sylvaarsstudio", "pinterest.svg"],
  ["https://www.youtube.com/@sylvaarsstudio", "youtube.svg"],
  ["https://www.facebook.com/Sylvaarsstudio/", "facebook.svg"],
  ["https://x.com/sylvaarsstudio", "x-twitter.svg"]
]);

const expectedAssetHashes = Object.freeze({
  "whatsapp.svg": "0aab59ebdc2a5f8dbcf4e6194acc702a9b122098afd6ef6d4c0f88a5a15c249a",
  "instagram.svg": "d0355c6af0b4b85d934b6a0a32b4734998872c5e74306d9576a1f5ed7bbefcfd",
  "pinterest.svg": "1ee537ea19b7ba4253e3f84d2ea66212823d029b5acc8733ef95283e71887e98",
  "youtube.svg": "33fd65593fdad1cfdfc4332f324a6fb82d0bc6296ea646bacb63cba3d2cc75b4",
  "facebook.svg": "606867f61493149594b136408af34b10a452a27dfca58566449a08f13df0082a",
  "x-twitter.svg": "e597edffd652238aa5bd19a3608ca6bbd7956e9ee58b4a021afd000a79d45b83",
  "LICENSE.txt": "0aa8f86525273b2efa4f40f4272a188e187704252170e979dc06879adf68d43c"
});

function read(filePath) {
  return readFileSync(filePath, "utf8");
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function count(source, value) {
  return (source.match(new RegExp(escapeRegExp(value), "g")) || []).length;
}

function extractSynchronizedFooter(source) {
  const start = source.indexOf(PUBLIC_FOOTER_START);
  const end = source.indexOf(PUBLIC_FOOTER_END);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return source.slice(start + PUBLIC_FOOTER_START.length, end).trim();
}

function visibleText(source) {
  return source.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function openingTags(source, tagName) {
  return Array.from(source.matchAll(new RegExp(`<${tagName}\\b[^>]*>`, "gi")), (match) => match[0]);
}

function attribute(tag, name) {
  return tag.match(new RegExp(`\\b${name}=["']([^"']*)["']`, "i"))?.[1] ?? null;
}

function listFilesRecursively(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFilesRecursively(entryPath));
    if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

function writeFixture(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
}

test("the canonical fragment contains one unmarked footer", () => {
  const fragment = read(CANONICAL_FRAGMENT_PATH);
  assert.equal((fragment.match(/<footer\b/g) || []).length, 1);
  assert.equal((fragment.match(/<\/footer>/g) || []).length, 1);
  assert.doesNotMatch(fragment, /PUBLIC_FOOTER_(?:START|END)/);
});

test("the synchronizer has the exact explicit target list", () => {
  assert.deepEqual(PUBLIC_FOOTER_TARGETS, expectedTargets);
  assert.equal(new Set(PUBLIC_FOOTER_TARGETS).size, PUBLIC_FOOTER_TARGETS.length);
});

test("every target has one marker pair and a byte-identical canonical footer", () => {
  const canonical = read(CANONICAL_FRAGMENT_PATH).trim();
  for (const target of PUBLIC_FOOTER_TARGETS) {
    const source = read(target);
    assert.equal(count(source, PUBLIC_FOOTER_START), 1, target);
    assert.equal(count(source, PUBLIC_FOOTER_END), 1, target);
    assert.ok(source.indexOf(PUBLIC_FOOTER_START) < source.indexOf(PUBLIC_FOOTER_END), target);
    assert.equal((source.match(/<footer class="site-footer"/g) || []).length, 1, target);
    assert.equal(extractSynchronizedFooter(source), canonical, target);
  }
});

test("replacement is deterministic and preserves all content outside the markers", () => {
  const source = `before\n${PUBLIC_FOOTER_START}\nold\n${PUBLIC_FOOTER_END}\nafter\n`;
  const first = replaceFooterBlock(source, "<footer>canonical</footer>", "fixture.html");
  const second = replaceFooterBlock(first, "<footer>canonical</footer>", "fixture.html");
  assert.equal(first, second);
  assert.ok(first.startsWith(`before\n${PUBLIC_FOOTER_START}`));
  assert.ok(first.endsWith(`${PUBLIC_FOOTER_END}\nafter\n`));
});

test("synchronization is idempotent on the checked-in targets", () => {
  const result = syncPublicFooter({ log: () => {} });
  assert.deepEqual(result, { changed: 0, checked: expectedTargets.length });
});

test("missing, duplicated, inverted, or absent targets fail before any write", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sas-footer-sync-"));
  const targets = ["web/one.html", "web/two.html"];
  const valid = `one-before\n${PUBLIC_FOOTER_START}\nold\n${PUBLIC_FOOTER_END}\none-after`;
  const malformed = [
    "missing markers",
    `${PUBLIC_FOOTER_START}\n${PUBLIC_FOOTER_START}\n${PUBLIC_FOOTER_END}`,
    `${PUBLIC_FOOTER_END}\n${PUBLIC_FOOTER_START}`
  ];

  try {
    writeFixture(root, CANONICAL_FRAGMENT_PATH, "<footer>fixture</footer>");
    for (const invalid of malformed) {
      writeFixture(root, targets[0], valid);
      writeFixture(root, targets[1], invalid);
      assert.throws(
        () => syncPublicFooter({ rootDir: root, targets, log: () => {} }),
        /exactly one|inverted/
      );
      assert.equal(read(path.join(root, targets[0])), valid);
      assert.equal(read(path.join(root, targets[1])), invalid);
    }

    rmSync(path.join(root, targets[1]));
    assert.throws(
      () => syncPublicFooter({ rootDir: root, targets, log: () => {} }),
      /target does not exist/
    );
    assert.equal(read(path.join(root, targets[0])), valid);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing or empty canonical fragment fails before target writes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sas-footer-fragment-"));
  const target = "web/page.html";
  const original = `${PUBLIC_FOOTER_START}\nold\n${PUBLIC_FOOTER_END}`;

  try {
    writeFixture(root, target, original);
    assert.throws(
      () => syncPublicFooter({ rootDir: root, targets: [target], log: () => {} }),
      /fragment is missing/
    );
    assert.equal(read(path.join(root, target)), original);

    writeFixture(root, CANONICAL_FRAGMENT_PATH, "   \n");
    assert.throws(
      () => syncPublicFooter({ rootDir: root, targets: [target], log: () => {} }),
      /missing or empty/
    );
    assert.equal(read(path.join(root, target)), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("footer brand, directory links, address, contact, and copyright are exact", () => {
  const fragment = read(CANONICAL_FRAGMENT_PATH);
  for (const text of [
    "SYLVA ARS STUDIO",
    "Original works and thoughtful commissions.",
    "Shipping &amp; correspondence",
    "Sylva Ars Studio LLC",
    "204 St Charles Way, Unit E #362",
    "York, PA 17402",
    "+1 (717) 220-5592",
    "Preferred contact",
    "© 2026 Sylva Ars Studio LLC. All rights reserved."
  ]) assert.match(fragment, new RegExp(escapeRegExp(text)));

  for (const href of [
    "/collection.html",
    "/studio-notes/",
    "/about.html",
    "/contact.html",
    "/legal/",
    "/legal/privacy.html",
    "/legal/cookies.html",
    "/legal/accessibility.html"
  ]) assert.match(fragment, new RegExp(`href="${escapeRegExp(href)}"`));

  assert.doesNotMatch(fragment, /href="\/legal\/(?:terms-of-use|copyright|email-communications)\.html"/);
  assert.match(fragment, /href="\/admin\/dashboard\.html" class="studio-access"/);
});

test("the six external contact links are exact, labeled, and safely opened", () => {
  const fragment = read(CANONICAL_FRAGMENT_PATH);
  const externalAnchors = openingTags(fragment, "a").filter((tag) => attribute(tag, "target") === "_blank");
  assert.equal(externalAnchors.length, 6);
  for (const tag of externalAnchors) {
    assert.equal(attribute(tag, "rel"), "noopener noreferrer");
    assert.ok(attribute(tag, "aria-label"));
  }
  assert.equal(attribute(externalAnchors[0], "href"), "https://wa.me/17172205592");
  assert.deepEqual(
    externalAnchors.slice(1).map((tag) => attribute(tag, "href")),
    expectedSocialLinks.map(([href]) => href)
  );
});

test("social links expose only local icons with no visible network names", () => {
  const fragment = read(CANONICAL_FRAGMENT_PATH);
  const social = fragment.match(/<div class="site-footer-social"[^>]*>([\s\S]*?)<\/div>/)?.[1];
  assert.ok(social);
  assert.equal(visibleText(social), "");
  assert.doesNotMatch(visibleText(fragment), /WhatsApp|Instagram|Pinterest|YouTube|Facebook|\bX\b/);
  for (const [href, icon] of expectedSocialLinks) {
    assert.match(social, new RegExp(`href="${escapeRegExp(href)}"[\\s\\S]*?src="/images/social/${icon}"`));
  }
});

test("official Font Awesome Free 6.5.1 assets and license retain pinned hashes", () => {
  for (const [filename, expectedHash] of Object.entries(expectedAssetHashes)) {
    const filePath = path.join("web/images/social", filename);
    assert.equal(sha256(filePath), expectedHash, filename);
    if (filename.endsWith(".svg")) {
      const svg = read(filePath);
      assert.match(svg, /Font Awesome Free 6\.5\.1/);
      assert.equal((svg.match(/<path\b/g) || []).length, 1);
    }
  }
  const license = read("web/images/social/LICENSE.txt");
  assert.match(license, /Font Awesome Free License/);
  assert.match(license, /Icons: CC BY 4\.0 License/);
  assert.match(license, /# Attribution/);
});

test("Contact uses five safe local icon links and no remote icon library", () => {
  const contact = read("web/contact.html");
  const social = contact.match(/<div class="social-links">([\s\S]*?)<\/div>/)?.[1];
  assert.ok(social);
  assert.equal(openingTags(social, "a").length, 5);
  assert.equal(visibleText(social), "");
  assert.doesNotMatch(social, /whatsapp/i);
  for (const [href, icon] of expectedSocialLinks) {
    assert.match(social, new RegExp(`href="${escapeRegExp(href)}"[\\s\\S]*?src="/images/social/${icon}"`));
  }
  for (const tag of openingTags(social, "a")) {
    assert.equal(attribute(tag, "target"), "_blank");
    assert.equal(attribute(tag, "rel"), "noopener noreferrer");
    assert.ok(attribute(tag, "aria-label"));
  }
  assert.doesNotMatch(contact, /font-awesome|cdnjs/i);
});

test("the public tree contains no remote Font Awesome or cdnjs dependency", () => {
  const publicFiles = listFilesRecursively("web").filter((filePath) => /\.(?:css|html|js)$/i.test(filePath));
  for (const filePath of publicFiles) {
    assert.doesNotMatch(
      read(filePath),
      /cdnjs\.cloudflare\.com\/ajax\/libs\/font-awesome|use\.fontawesome\.com|fontawesome\.com\/releases/i,
      filePath
    );
  }
});

test("documents, Admin, login, backup, and non-page fragments remain excluded", () => {
  const excluded = [
    ...listFilesRecursively("web/documents"),
    ...listFilesRecursively("web/admin"),
    ...listFilesRecursively("web-backup-before-css-cleanup"),
    "web/admin-login.html",
    "web/templates/collection-item-template.html",
    "web/templates/home-artwork-template.html"
  ].filter((filePath) => existsSync(filePath) && /\.html$/i.test(filePath));

  for (const filePath of excluded) {
    const source = read(filePath);
    assert.doesNotMatch(source, /PUBLIC_FOOTER_(?:START|END)|class="site-footer"/, filePath);
  }
});

test("internal footer routes and local assets use absolute paths", () => {
  const fragment = read(CANONICAL_FRAGMENT_PATH);
  for (const tag of [...openingTags(fragment, "a"), ...openingTags(fragment, "img")]) {
    const value = attribute(tag, tag.startsWith("<a") ? "href" : "src");
    if (/^https:\/\//.test(value)) continue;
    assert.ok(value.startsWith("/"), value);
  }
});

test("footer layout has desktop columns, mobile reflow, touch targets, and visible focus", () => {
  const css = read("web/css/main.css");
  const footerCssStart = css.indexOf(".site-footer {");
  const footerCssEnd = css.indexOf("/* =========================\n   About", footerCssStart);
  assert.notEqual(footerCssStart, -1);
  assert.notEqual(footerCssEnd, -1);
  const footerCss = css.slice(footerCssStart, footerCssEnd);
  assert.match(css, /\.site-footer\s*{[\s\S]*?background:\s*#eeeeec/);
  assert.match(css, /\.site-footer-directory\s*{[\s\S]*?grid-template-columns:[\s\S]*?minmax\(280px, 1\.25fr\)/);
  assert.match(css, /@media\s*\(max-width:\s*600px\)[\s\S]*?\.site-footer-directory\s*{[\s\S]*?grid-template-columns:\s*1fr/);
  assert.match(css, /\.site-footer-social a,[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px/);
  assert.match(css, /\.site-footer-social a:focus-visible[\s\S]*?outline:\s*2px solid #252525/);
  assert.doesNotMatch(footerCss, /linear-gradient|box-shadow/);
});

test("artwork and Studio Notes regeneration preserve one canonical footer", { concurrency: false }, () => {
  generateArtworks();
  generateStudioNotes({ log: () => {} });
  const canonical = read(CANONICAL_FRAGMENT_PATH).trim();
  for (const target of expectedTargets.filter((target) =>
    target.startsWith("web/artworks/") || target.startsWith("web/studio-notes/")
  )) {
    const source = read(target);
    assert.equal(count(source, PUBLIC_FOOTER_START), 1, target);
    assert.equal(count(source, PUBLIC_FOOTER_END), 1, target);
    assert.equal(extractSynchronizedFooter(source), canonical, target);
  }
});
