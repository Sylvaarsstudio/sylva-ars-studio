const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const CANONICAL_FRAGMENT_PATH = "web/templates/public-footer.html";
const PUBLIC_FOOTER_START = "<!-- PUBLIC_FOOTER_START -->";
const PUBLIC_FOOTER_END = "<!-- PUBLIC_FOOTER_END -->";

const PUBLIC_FOOTER_TARGETS = Object.freeze([
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

function countOccurrences(source, marker) {
  let count = 0;
  let cursor = 0;

  while (cursor < source.length) {
    const index = source.indexOf(marker, cursor);
    if (index === -1) break;
    count += 1;
    cursor = index + marker.length;
  }

  return count;
}

function validateCanonicalFragment(source) {
  const fragment = String(source ?? "").trim();

  if (!fragment) {
    throw new Error(`Canonical footer fragment is missing or empty: ${CANONICAL_FRAGMENT_PATH}`);
  }
  if (fragment.includes(PUBLIC_FOOTER_START) || fragment.includes(PUBLIC_FOOTER_END)) {
    throw new Error("Canonical footer fragment must not contain synchronization markers.");
  }
  if ((fragment.match(/<footer\b/gi) || []).length !== 1 || (fragment.match(/<\/footer>/gi) || []).length !== 1) {
    throw new Error("Canonical footer fragment must contain exactly one footer element.");
  }

  return fragment;
}

function replaceFooterBlock(source, fragment, targetPath) {
  const startCount = countOccurrences(source, PUBLIC_FOOTER_START);
  const endCount = countOccurrences(source, PUBLIC_FOOTER_END);

  if (startCount !== 1 || endCount !== 1) {
    throw new Error(
      `${targetPath} must contain exactly one ${PUBLIC_FOOTER_START} and one ${PUBLIC_FOOTER_END}.`
    );
  }

  const startIndex = source.indexOf(PUBLIC_FOOTER_START);
  const endIndex = source.indexOf(PUBLIC_FOOTER_END);
  if (endIndex < startIndex) {
    throw new Error(`${targetPath} has inverted public footer markers.`);
  }

  return [
    source.slice(0, startIndex + PUBLIC_FOOTER_START.length),
    "\n",
    fragment,
    "\n",
    source.slice(endIndex)
  ].join("");
}

function assertSafeRelativePath(relativePath) {
  if (
    path.isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/).some((segment) => segment === "..")
  ) {
    throw new Error(`Unsafe public footer target path: ${relativePath}`);
  }
}

function buildSyncPlan(options = {}) {
  const rootDir = options.rootDir || ROOT_DIR;
  const targets = options.targets || PUBLIC_FOOTER_TARGETS;
  const fileSystem = options.fileSystem || fs;
  const fragmentPath = path.join(rootDir, CANONICAL_FRAGMENT_PATH);

  if (!fileSystem.existsSync(fragmentPath)) {
    throw new Error(`Canonical footer fragment is missing: ${CANONICAL_FRAGMENT_PATH}`);
  }
  const fragment = validateCanonicalFragment(fileSystem.readFileSync(fragmentPath, "utf8"));

  const sources = targets.map((relativePath) => {
    assertSafeRelativePath(relativePath);
    const absolutePath = path.join(rootDir, relativePath);
    if (!fileSystem.existsSync(absolutePath)) {
      throw new Error(`Public footer target does not exist: ${relativePath}`);
    }
    return {
      relativePath,
      absolutePath,
      source: fileSystem.readFileSync(absolutePath, "utf8")
    };
  });

  const updates = sources.map(({ relativePath, absolutePath, source }) => ({
    relativePath,
    absolutePath,
    source,
    output: replaceFooterBlock(source, fragment, relativePath)
  }));

  return { fragment, updates };
}

function syncPublicFooter(options = {}) {
  const fileSystem = options.fileSystem || fs;
  const log = options.log || console.log;
  const plan = buildSyncPlan(options);
  let changed = 0;

  for (const update of plan.updates) {
    if (update.output === update.source) continue;
    fileSystem.writeFileSync(update.absolutePath, update.output, "utf8");
    changed += 1;
    log(`Synchronized public footer: ${update.relativePath}`);
  }

  log(`Public footer synchronization complete: ${changed} changed, ${plan.updates.length} checked.`);
  return { changed, checked: plan.updates.length };
}

if (require.main === module) {
  try {
    syncPublicFooter();
  } catch (error) {
    console.error(`Public footer synchronization failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  CANONICAL_FRAGMENT_PATH,
  PUBLIC_FOOTER_END,
  PUBLIC_FOOTER_START,
  PUBLIC_FOOTER_TARGETS,
  buildSyncPlan,
  replaceFooterBlock,
  syncPublicFooter,
  validateCanonicalFragment
};
