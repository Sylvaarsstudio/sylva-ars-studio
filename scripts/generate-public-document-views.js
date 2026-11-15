const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const protectedTemplatesDirectory = path.join(projectRoot, "web", "admin", "document-templates");
const publicViewsDirectory = path.join(projectRoot, "web", "documents");

const documentDefinitions = Object.freeze([
  Object.freeze({
    filename: "artwork-sales-agreement.html",
    mainClass: "document",
    notice: "Draft — Under legal review and approval — Not currently effective."
  }),
  Object.freeze({
    filename: "commission-agreement.html",
    mainClass: "document",
    notice: "Draft — Under legal review and approval — Not currently effective."
  })
]);

function requireSingleTag(source, tagName, filename) {
  const matches = source.match(new RegExp(`<${tagName}\\b`, "gi")) || [];
  if (matches.length !== 1) {
    throw new Error(`${filename} must contain exactly one <${tagName}> element.`);
  }
}

function findExpectedMain(source, definition) {
  const mainPattern = new RegExp(
    `<main\\b[^>]*\\bclass=["'][^"']*\\b${definition.mainClass}\\b[^"']*["'][^>]*>`,
    "i"
  );
  const matches = source.match(new RegExp(mainPattern.source, "gi")) || [];
  if (matches.length !== 1) {
    throw new Error(
      `${definition.filename} must contain exactly one expected <main class="${definition.mainClass}">.`
    );
  }
  return source.search(mainPattern);
}

function renderPublicDocument(source, definition) {
  if (typeof source !== "string" || !source.trim()) {
    throw new Error(`${definition.filename} is missing or empty.`);
  }

  requireSingleTag(source, "html", definition.filename);
  requireSingleTag(source, "head", definition.filename);
  requireSingleTag(source, "body", definition.filename);

  if (/public-document-status|aria-label=["']Document status["']/i.test(source)) {
    throw new Error(`${definition.filename} must remain a clean protected template.`);
  }

  const mainIndex = findExpectedMain(source, definition);
  const mainLineIndex = source.lastIndexOf("\n", mainIndex) + 1;
  if (source.slice(mainLineIndex, mainIndex).trim()) {
    throw new Error(`${definition.filename} expected <main> to begin on its own line.`);
  }
  const headCloseIndex = source.search(/<\/head\s*>/i);
  if (headCloseIndex < 0) {
    throw new Error(`${definition.filename} is missing </head>.`);
  }

  const stylesheet = "  <link rel=\"stylesheet\" href=\"/css/public-document-status.css\">\n";
  const withStylesheet = `${source.slice(0, headCloseIndex)}${stylesheet}${source.slice(headCloseIndex)}`;
  const adjustedMainIndex = mainLineIndex + stylesheet.length;
  const notice = [
    "  <aside class=\"public-document-status\" aria-label=\"Document status\">",
    `    <p>${definition.notice}</p>`,
    "  </aside>",
    "",
    ""
  ].join("\n");

  return `${withStylesheet.slice(0, adjustedMainIndex)}${notice}${withStylesheet.slice(adjustedMainIndex)}`;
}

function generatePublicDocumentViews({
  sourceDirectory = protectedTemplatesDirectory,
  outputDirectory = publicViewsDirectory
} = {}) {
  const renderedViews = documentDefinitions.map((definition) => {
    const sourcePath = path.join(sourceDirectory, definition.filename);
    let source;
    try {
      source = fs.readFileSync(sourcePath, "utf8");
    } catch (error) {
      throw new Error(`Unable to read protected template ${definition.filename}: ${error.message}`);
    }

    return {
      definition,
      output: renderPublicDocument(source, definition)
    };
  });

  fs.mkdirSync(outputDirectory, { recursive: true });
  const temporaryFiles = [];

  try {
    for (const { definition, output } of renderedViews) {
      const temporaryPath = path.join(
        outputDirectory,
        `.${definition.filename}.${process.pid}.tmp`
      );
      fs.writeFileSync(temporaryPath, output, "utf8");
      temporaryFiles.push({
        temporaryPath,
        outputPath: path.join(outputDirectory, definition.filename)
      });
    }

    for (const { temporaryPath, outputPath } of temporaryFiles) {
      fs.renameSync(temporaryPath, outputPath);
    }
  } catch (error) {
    for (const { temporaryPath } of temporaryFiles) {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
    throw error;
  }

  return renderedViews.map(({ definition }) => definition.filename);
}

if (require.main === module) {
  try {
    const filenames = generatePublicDocumentViews();
    console.log(`Generated ${filenames.length} public document views.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  documentDefinitions,
  generatePublicDocumentViews,
  renderPublicDocument
};
