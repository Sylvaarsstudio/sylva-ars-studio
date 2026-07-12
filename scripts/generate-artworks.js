const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const webDir = path.join(rootDir, "web");
const dataDir = path.join(webDir, "data");
const markdownDir = path.join(dataDir, "artworks-md");
const templatesDir = path.join(webDir, "templates");
const artworksDir = path.join(webDir, "artworks");
const imagesDir = path.join(webDir, "images");
const generatedArtworkMarker = "<!-- AUTO-GENERATED ARTWORK PAGE - DO NOT EDIT MANUALLY -->";

const requiredFields = [
  "slug",
  "title",
  "year",
  "medium",
  "dimensions",
  "status",
  "collection",
  "image",
  "altText",
  "priceStatus",
  "seoTitle",
  "seoDescription"
];

function readFile(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function writeFile(filePath, content) {
  fs.writeFileSync(filePath, `${content.trimEnd()}\n`);
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isPresent(value) {
  return String(value ?? "").trim() !== "";
}

function firstPresent(...values) {
  return values.find(isPresent) ?? "";
}

function withTemplateFields(artwork) {
  return {
    ...artwork,
    collectionDescription: firstPresent(artwork.shortDescription, artwork.longDescription),
    artworkDescription: firstPresent(artwork.longDescription, artwork.shortDescription)
  };
}

function renderTemplate(template, artwork) {
  const withConditionals = template.replace(
    /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (_, key, content) => (isPresent(artwork[key]) ? content : "")
  );

  return withConditionals.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    return escapeHtml(artwork[key] ?? "");
  });
}

function escapeScriptJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function parseMarkdownArtwork(filePath) {
  const file = readFile(filePath);
  const frontmatterMatch = file.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);

  if (!frontmatterMatch) {
    throw new Error(`${filePath} is missing frontmatter.`);
  }

  const [, frontmatter, body] = frontmatterMatch;
  const artwork = {};

  frontmatter.split("\n").forEach((line) => {
    const separatorIndex = line.indexOf(":");

    if (separatorIndex === -1) {
      return;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    artwork[key] = value.replace(/^["']|["']$/g, "");
  });

  if (!artwork.longDescription && body.trim()) {
    artwork.longDescription = body.trim();
  }

  return artwork;
}

function loadJsonArtworks() {
  const jsonPath = path.join(dataDir, "artworks.json");

  if (!fs.existsSync(jsonPath)) {
    return [];
  }

  const data = JSON.parse(readFile(jsonPath));

  if (!Array.isArray(data)) {
    throw new Error("web/data/artworks.json must contain an array.");
  }

  return data;
}

function loadMarkdownArtworks() {
  if (!fs.existsSync(markdownDir)) {
    return [];
  }

  return fs
    .readdirSync(markdownDir)
    .filter((fileName) => fileName.endsWith(".md"))
    .map((fileName) => parseMarkdownArtwork(path.join(markdownDir, fileName)));
}

function loadArtworks() {
  const artworksBySlug = new Map();
  const artworks = [...loadJsonArtworks(), ...loadMarkdownArtworks()];

  artworks.forEach((artwork) => {
    artworksBySlug.set(artwork.slug, artwork);
  });

  return Array.from(artworksBySlug.values());
}

function validateArtworks(artworks) {
  const slugs = new Set();
  const errors = [];

  artworks.forEach((artwork, index) => {
    requiredFields.forEach((field) => {
      if (!artwork[field]) {
        errors.push(`${artwork.slug || `artwork #${index + 1}`} is missing "${field}".`);
      }
    });

    if (artwork.slug && !/^[a-z0-9-]+$/.test(artwork.slug)) {
      errors.push(`${artwork.slug} has an invalid slug. Use lowercase letters, numbers, and hyphens.`);
    }

    if (artwork.slug && slugs.has(artwork.slug)) {
      errors.push(`${artwork.slug} is duplicated.`);
    }

    if (artwork.slug) {
      slugs.add(artwork.slug);
    }

    if (artwork.image && !fs.existsSync(path.join(imagesDir, artwork.image))) {
      errors.push(`${artwork.slug} references a missing image: web/images/${artwork.image}.`);
    }
  });

  if (errors.length) {
    throw new Error(`Artwork validation failed:\n- ${errors.join("\n- ")}`);
  }
}

function replaceGeneratedSection(content, markerName, generatedHtml) {
  const startMarker = `<!-- ${markerName}:START -->`;
  const endMarker = `<!-- ${markerName}:END -->`;
  const startIndex = content.indexOf(startMarker);
  const endIndex = content.indexOf(endMarker);

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error(`Missing markers: ${startMarker} and ${endMarker}.`);
  }

  return [
    content.slice(0, startIndex + startMarker.length),
    "\n",
    generatedHtml.trimEnd(),
    "\n",
    content.slice(endIndex)
  ].join("");
}

function generateArtworkPages(artworks) {
  const template = readFile(path.join(templatesDir, "artwork-page-template.html"));

  ensureDirectory(artworksDir);

  artworks.forEach((artwork) => {
    const outputPath = path.join(artworksDir, `${artwork.slug}.html`);
    writeFile(outputPath, renderTemplate(template, withTemplateFields(artwork)));
    console.log(`Generated artwork page: web/artworks/${artwork.slug}.html`);
  });
}

function removeOldGeneratedArtworkPages() {
  ensureDirectory(artworksDir);

  const htmlFiles = fs
    .readdirSync(artworksDir)
    .filter((fileName) => fileName.endsWith(".html"));

  htmlFiles.forEach((fileName) => {
    const filePath = path.join(artworksDir, fileName);
    const content = readFile(filePath);

    if (!content.includes(generatedArtworkMarker)) {
      return;
    }

    fs.unlinkSync(filePath);
    console.log(`Removed old generated artwork page: web/artworks/${fileName}`);
  });
}

function updateCollectionPage(artworks) {
  const collectionPath = path.join(webDir, "collection.html");
  const template = readFile(path.join(templatesDir, "collection-item-template.html"));
  const itemsHtml = artworks.map((artwork) => renderTemplate(template, withTemplateFields(artwork))).join("\n\n");
  const currentHtml = readFile(collectionPath);
  const updatedHtml = replaceGeneratedSection(currentHtml, "ARTWORKS", itemsHtml);

  writeFile(collectionPath, updatedHtml);
  console.log("Updated collection page: web/collection.html");
}

function updateHomePage(artworks) {
  const indexPath = path.join(webDir, "index.html");
  const featuredArtworks = artworks.filter((artwork) => artwork.featuredOnHome !== false);
  const showcaseArtworks = featuredArtworks.map((artwork) => ({
    slug: artwork.slug,
    title: artwork.title,
    image: artwork.image,
    altText: artwork.altText
  }));
  const itemsHtml = `    <script type="application/json" id="home-artworks-data">${escapeScriptJson(showcaseArtworks)}</script>`;
  const currentHtml = readFile(indexPath);
  const updatedHtml = replaceGeneratedSection(currentHtml, "HOME_ARTWORKS", itemsHtml);

  writeFile(indexPath, updatedHtml);
  console.log("Updated home artwork section: web/index.html");
}

function main() {
  const artworks = loadArtworks();

  if (!artworks.length) {
    throw new Error("No artworks found in web/data/artworks.json or web/data/artworks-md/.");
  }

  validateArtworks(artworks);
  removeOldGeneratedArtworkPages();
  generateArtworkPages(artworks);
  updateCollectionPage(artworks);
  updateHomePage(artworks);

  console.log(`Done. Generated ${artworks.length} artworks.`);
}

main();
