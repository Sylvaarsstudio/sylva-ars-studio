const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const WEB_DIR = path.join(ROOT_DIR, 'web');
const NOTES_DIR = path.join(WEB_DIR, 'data', 'studio-notes-md');
const ARTWORKS_PATH = path.join(WEB_DIR, 'data', 'artworks.json');
const TEMPLATE_PATH = path.join(WEB_DIR, 'templates', 'studio-note-page-template.html');
const INDEX_TEMPLATE_PATH = path.join(WEB_DIR, 'templates', 'studio-notes-index-template.html');
const OUTPUT_DIR = path.join(WEB_DIR, 'studio-notes');
const GENERATED_MARKER = '<!-- AUTO-GENERATED STUDIO NOTE PAGE - DO NOT EDIT MANUALLY -->';
const INDEX_GENERATED_MARKER = '<!-- AUTO-GENERATED STUDIO NOTES INDEX - DO NOT EDIT MANUALLY -->';
const REQUIRED_FIELDS = ['slug', 'title', 'date', 'status'];
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SECTION_POSITIONS = new Set(['text-only', 'media-left', 'media-right', 'media-center']);
const MEDIA_SIZES = new Set(['small', 'medium', 'large', 'wide']);
const VIDEO_MODES = new Set(['ambient', 'controls']);
const IMAGE_EXTENSIONS = new Set(['.avif', '.jpeg', '.jpg', '.png', '.webp']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm']);

/*
 * Studio Notes editorial grammar (one directive per line):
 *
 *   ::section position="text-only|media-left|media-right|media-center"
 *   ::image src="images/..." alt="Required" size="small|medium|large|wide" caption="Optional"
 *   ::video src="videos/..." size="small|medium|large|wide" mode="ambient|controls" caption="Optional" poster="images/..."
 *   Narrative Markdown using paragraphs, #, ##, *emphasis*, and **strong**.
 *   ::end
 *
 *   ::artwork slug="artwork-slug"
 *
 * Attribute values must use double quotes. A section accepts at most one media
 * directive. Free Markdown outside directives remains supported and is rendered
 * as an implicit text-only section. Arbitrary HTML, attributes, classes, styles,
 * URLs, nested sections, and unknown directives are rejected or escaped.
 */

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseFrontmatterScalar(rawValue, fileName, key) {
  const value = rawValue.trim();
  if (!value) return '';

  const first = value[0];
  const last = value[value.length - 1];
  if (first === '"' || first === "'") {
    if (last !== first) {
      throw new Error(`${fileName}: unclosed quoted value for "${key}".`);
    }
    return value.slice(1, -1);
  }

  return value;
}

function parseMarkdownNote(source, fileName) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) {
    throw new Error(`${fileName}: missing or invalid frontmatter block.`);
  }

  const metadata = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue;

    const fieldMatch = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!fieldMatch) {
      throw new Error(`${fileName}: invalid frontmatter line: ${line}`);
    }

    const [, key, rawValue] = fieldMatch;
    if (Object.prototype.hasOwnProperty.call(metadata, key)) {
      throw new Error(`${fileName}: duplicate frontmatter field "${key}".`);
    }
    metadata[key] = parseFrontmatterScalar(rawValue, fileName, key);
  }

  return { metadata, body: match[2] };
}

function renderInlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
}

function renderMarkdown(markdown) {
  const normalized = markdown.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return '';

  return normalized
    .split(/\n[\t ]*\n+/)
    .map((block) => {
      const lines = block.split('\n');
      if (lines.length === 1) {
        const heading = lines[0].match(/^(#{1,2})[\t ]+(.+)$/);
        if (heading) {
          const level = heading[1].length + 1;
          return `<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`;
        }
      }

      const paragraph = lines.map((line) => line.trim()).join(' ');
      return `<p>${renderInlineMarkdown(paragraph)}</p>`;
    })
    .join('\n');
}

function directiveError(fileName, lineNumber, message) {
  return new Error(`${fileName}:${lineNumber}: ${message}`);
}

function parseAttributes(source, fileName, lineNumber) {
  const attributes = {};
  let cursor = 0;

  while (cursor < source.length) {
    while (source[cursor] === ' ' || source[cursor] === '\t') cursor += 1;
    if (cursor >= source.length) break;

    const match = source.slice(cursor).match(/^([a-z][a-z0-9-]*)="([^"]*)"/);
    if (!match) {
      throw directiveError(fileName, lineNumber, 'attributes must use key="value" syntax.');
    }

    const [, key, value] = match;
    if (Object.prototype.hasOwnProperty.call(attributes, key)) {
      throw directiveError(fileName, lineNumber, `duplicate attribute "${key}".`);
    }
    attributes[key] = value;
    cursor += match[0].length;

    if (cursor < source.length && source[cursor] !== ' ' && source[cursor] !== '\t') {
      throw directiveError(fileName, lineNumber, 'attributes must be separated by whitespace.');
    }
  }

  return attributes;
}

function parseDirective(line, fileName, lineNumber) {
  const match = line.match(/^::([a-z]+)(?:[\t ]+(.*))?$/);
  if (!match) {
    throw directiveError(fileName, lineNumber, `invalid directive syntax: ${line}`);
  }

  return {
    name: match[1],
    attributes: parseAttributes(match[2] || '', fileName, lineNumber),
    lineNumber
  };
}

function validateAttributes(directive, allowed, required, fileName) {
  for (const key of Object.keys(directive.attributes)) {
    if (!allowed.includes(key)) {
      throw directiveError(fileName, directive.lineNumber, `attribute "${key}" is not allowed on ::${directive.name}.`);
    }
  }
  for (const key of required) {
    if (!directive.attributes[key]) {
      throw directiveError(fileName, directive.lineNumber, `::${directive.name} requires "${key}".`);
    }
  }
}

function validateAssetPath(assetPath, kind, fileName, lineNumber) {
  const prefix = kind === 'video' ? 'videos/' : 'images/';
  const extensions = kind === 'video' ? VIDEO_EXTENSIONS : IMAGE_EXTENSIONS;
  const segments = assetPath.split('/');

  if (
    !assetPath.startsWith(prefix) ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(assetPath) ||
    segments.some((segment) => !segment || segment === '.' || segment === '..') ||
    !extensions.has(path.extname(assetPath).toLowerCase())
  ) {
    throw directiveError(
      fileName,
      lineNumber,
      `unsafe or unsupported ${kind} path "${assetPath}"; use a relative ${prefix} path.`
    );
  }

  return assetPath;
}

function validateMediaDirective(directive, fileName, validateAsset) {
  const attributes = directive.attributes;
  if (directive.name === 'image') {
    validateAttributes(directive, ['src', 'alt', 'size', 'caption'], ['src', 'alt', 'size'], fileName);
    validateAssetPath(attributes.src, 'image', fileName, directive.lineNumber);
  } else {
    validateAttributes(
      directive,
      ['src', 'size', 'mode', 'caption', 'poster'],
      ['src', 'size', 'mode'],
      fileName
    );
    validateAssetPath(attributes.src, 'video', fileName, directive.lineNumber);
    if (!VIDEO_MODES.has(attributes.mode)) {
      throw directiveError(fileName, directive.lineNumber, `invalid video mode "${attributes.mode}".`);
    }
    if (attributes.poster) {
      validateAssetPath(attributes.poster, 'image', fileName, directive.lineNumber);
    }
  }

  if (!MEDIA_SIZES.has(attributes.size)) {
    throw directiveError(fileName, directive.lineNumber, `invalid media size "${attributes.size}".`);
  }

  if (validateAsset) {
    validateAsset(attributes.src, fileName, directive.lineNumber);
    if (attributes.poster) validateAsset(attributes.poster, fileName, directive.lineNumber);
  }
}

function renderFigure(directive) {
  const attributes = directive.attributes;
  const className = `studio-note-media studio-note-media--${attributes.size}`;
  const caption = attributes.caption
    ? `\n    <figcaption>${escapeHtml(attributes.caption)}</figcaption>`
    : '';

  if (directive.name === 'image') {
    return `<figure class="${className}">
    <img src="../${escapeHtml(attributes.src)}" alt="${escapeHtml(attributes.alt)}" loading="lazy" decoding="async">${caption}
  </figure>`;
  }

  const poster = attributes.poster ? ` poster="../${escapeHtml(attributes.poster)}"` : '';
  const label = attributes.caption || 'Studio Note video';
  const playback = attributes.mode === 'ambient'
    ? ' muted autoplay loop playsinline data-ambient-video'
    : ' controls playsinline';
  return `<figure class="${className}">
    <video src="../${escapeHtml(attributes.src)}"${poster}${playback} preload="metadata" aria-label="${escapeHtml(label)}"></video>${caption}
  </figure>`;
}

function renderSection(section, fileName) {
  const textHtml = renderMarkdown(section.textLines.join('\n'));
  const mediaHtml = section.media ? renderFigure(section.media) : '';

  if (section.position === 'text-only' && mediaHtml) {
    throw directiveError(fileName, section.lineNumber, 'text-only sections cannot contain media.');
  }
  if (section.position !== 'text-only' && !mediaHtml) {
    throw directiveError(fileName, section.lineNumber, `${section.position} sections require an image or video.`);
  }
  if (!textHtml && !mediaHtml) {
    throw directiveError(fileName, section.lineNumber, 'section cannot be empty.');
  }

  const modifiers = [`studio-note-section--${section.position}`];
  if (!textHtml) modifiers.push('studio-note-section--media-only');
  const parts = [mediaHtml, textHtml ? `  <div class="studio-note-copy">\n${textHtml}\n  </div>` : '']
    .filter(Boolean)
    .join('\n');

  return `<section class="studio-note-section ${modifiers.join(' ')}">
${parts}
</section>`;
}

function renderRelatedArtwork(directive, artworkIndex, fileName, validateAsset) {
  validateAttributes(directive, ['slug'], ['slug'], fileName);
  const slug = directive.attributes.slug;
  if (!SLUG_PATTERN.test(slug)) {
    throw directiveError(fileName, directive.lineNumber, `invalid artwork slug "${slug}".`);
  }
  if (!artworkIndex || !artworkIndex.has(slug)) {
    throw directiveError(fileName, directive.lineNumber, `related artwork "${slug}" was not found in artworks.json.`);
  }

  const artwork = artworkIndex.get(slug);
  for (const field of ['title', 'image', 'altText']) {
    if (typeof artwork[field] !== 'string' || !artwork[field].trim()) {
      throw directiveError(fileName, directive.lineNumber, `related artwork "${slug}" is missing "${field}".`);
    }
  }

  const imagePath = validateAssetPath(`images/${artwork.image}`, 'image', fileName, directive.lineNumber);
  if (validateAsset) validateAsset(imagePath, fileName, directive.lineNumber);

  return `<aside class="studio-note-related-artwork" aria-labelledby="related-${slug}">
  <figure>
    <a href="../artworks/${slug}.html">
      <img src="../${escapeHtml(imagePath)}" alt="${escapeHtml(artwork.altText)}" loading="lazy" decoding="async">
    </a>
    <figcaption>
      <h2 id="related-${slug}">${escapeHtml(artwork.title)}</h2>
      <a href="../artworks/${slug}.html">View artwork <span aria-hidden="true">→</span></a>
    </figcaption>
  </figure>
</aside>`;
}

function renderEditorialContent(markdown, options = {}) {
  const fileName = options.fileName || 'Studio Note';
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const renderedBlocks = [];
  const outsideText = [];
  let currentSection = null;
  let relatedArtworkSeen = false;

  function flushOutsideText() {
    if (!outsideText.join('\n').trim()) {
      outsideText.length = 0;
      return;
    }
    renderedBlocks.push(renderSection({
      position: 'text-only',
      textLines: outsideText.splice(0),
      media: null,
      lineNumber: 1
    }, fileName));
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    if (!line.startsWith('::')) {
      (currentSection ? currentSection.textLines : outsideText).push(line);
      continue;
    }

    const directive = parseDirective(line, fileName, lineNumber);
    if (currentSection) {
      if (directive.name === 'end') {
        validateAttributes(directive, [], [], fileName);
        renderedBlocks.push(renderSection(currentSection, fileName));
        currentSection = null;
      } else if (directive.name === 'image' || directive.name === 'video') {
        if (currentSection.media) {
          throw directiveError(fileName, lineNumber, 'a section may contain only one image or video.');
        }
        validateMediaDirective(directive, fileName, options.validateAsset);
        currentSection.media = directive;
      } else {
        throw directiveError(fileName, lineNumber, `::${directive.name} is not allowed inside a section.`);
      }
      continue;
    }

    if (directive.name === 'section') {
      flushOutsideText();
      validateAttributes(directive, ['position'], ['position'], fileName);
      if (!SECTION_POSITIONS.has(directive.attributes.position)) {
        throw directiveError(fileName, lineNumber, `invalid section position "${directive.attributes.position}".`);
      }
      currentSection = {
        position: directive.attributes.position,
        textLines: [],
        media: null,
        lineNumber
      };
    } else if (directive.name === 'artwork') {
      flushOutsideText();
      if (relatedArtworkSeen) {
        throw directiveError(fileName, lineNumber, 'only one ::artwork directive is allowed per Studio Note.');
      }
      renderedBlocks.push(
        renderRelatedArtwork(directive, options.artworkIndex, fileName, options.validateAsset)
      );
      relatedArtworkSeen = true;
    } else if (directive.name === 'end') {
      throw directiveError(fileName, lineNumber, 'unexpected ::end without an open section.');
    } else {
      throw directiveError(fileName, lineNumber, `::${directive.name} must be inside a section.`);
    }
  }

  if (currentSection) {
    throw directiveError(fileName, currentSection.lineNumber, 'section is missing its closing ::end.');
  }
  flushOutsideText();

  if (renderedBlocks.length === 0) {
    throw new Error(`${fileName}: Studio Note body is empty.`);
  }
  return renderedBlocks.join('\n');
}

function extractRelatedArtworkSlug(markdown, fileName) {
  let relatedArtworkSlug = '';

  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith('::')) continue;

    const directive = parseDirective(lines[index], fileName, index + 1);
    if (directive.name === 'artwork') {
      relatedArtworkSlug = directive.attributes.slug || '';
    }
  }

  return relatedArtworkSlug;
}

function loadArtworkIndex(artworksPath = ARTWORKS_PATH) {
  let artworks;
  try {
    artworks = JSON.parse(fs.readFileSync(artworksPath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read artworks.json: ${error.message}`);
  }
  if (!Array.isArray(artworks)) {
    throw new Error('artworks.json must contain an array.');
  }

  const index = new Map();
  for (const artwork of artworks) {
    if (!artwork || typeof artwork.slug !== 'string' || !SLUG_PATTERN.test(artwork.slug)) {
      throw new Error('artworks.json contains an artwork with an invalid or missing slug.');
    }
    if (index.has(artwork.slug)) {
      throw new Error(`artworks.json contains duplicate slug "${artwork.slug}".`);
    }
    index.set(artwork.slug, artwork);
  }
  return index;
}

function renderTemplateWithRawField(template, data, rawField) {
  const rawToken = `{{{${rawField}}}}`;
  const rawSentinel = `__STUDIO_NOTES_RAW_${rawField.toUpperCase()}__`;
  const tokenCount = template.split(rawToken).length - 1;
  if (tokenCount !== 1) {
    throw new Error(`Template must contain exactly one ${rawToken} token.`);
  }

  let output = template.replace(rawToken, rawSentinel);
  output = output.replace(
    /\{\{#([A-Za-z][A-Za-z0-9_]*)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (fullMatch, key, content) => (data[key] ? content : '')
  );
  output = output.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (fullMatch, key) => {
    if (!Object.prototype.hasOwnProperty.call(data, key)) {
      throw new Error(`Template references unknown field "${key}".`);
    }
    return escapeHtml(data[key]);
  });

  if (/\{\{[^}]+\}\}/.test(output)) {
    throw new Error('Template contains an unresolved placeholder.');
  }

  return output.replace(rawSentinel, data[rawField]);
}

function renderTemplate(template, note) {
  return renderTemplateWithRawField(template, note, 'bodyHtml');
}

function getPublishedNotes(notes) {
  return notes.filter((note) => note.status === 'published');
}

function buildPublishedNoteByArtworkSlug(notes) {
  const notesByArtworkSlug = new Map();

  for (const note of getPublishedNotes(notes)) {
    if (!note.relatedArtworkSlug) continue;
    if (notesByArtworkSlug.has(note.relatedArtworkSlug)) {
      throw new Error(
        `Multiple published Studio Notes reference artwork "${note.relatedArtworkSlug}".`
      );
    }
    notesByArtworkSlug.set(note.relatedArtworkSlug, note);
  }

  return notesByArtworkSlug;
}

function renderIndexEntries(notes) {
  return getPublishedNotes(notes).map((note) => {
    return `<article class="studio-notes-index-entry">
  <div class="studio-notes-index-visual" aria-hidden="true"></div>
  <div class="studio-notes-index-copy">
    <p class="studio-notes-index-date">${escapeHtml(note.date)}</p>
    <h2><a href="${escapeHtml(note.slug)}.html">${escapeHtml(note.title)}</a></h2>
    <a class="studio-notes-index-link" href="${escapeHtml(note.slug)}.html">Read note <span aria-hidden="true">→</span></a>
  </div>
</article>`;
  }).join('\n');
}

function renderIndexTemplate(template, notes) {
  return renderTemplateWithRawField(template, {
    entriesHtml: renderIndexEntries(notes)
  }, 'entriesHtml');
}

function validatePublishedAsset(assetPath, fileName, lineNumber) {
  const absolutePath = path.join(WEB_DIR, assetPath);
  if (!fs.existsSync(absolutePath) || !fs.lstatSync(absolutePath).isFile()) {
    throw directiveError(fileName, lineNumber, `referenced asset does not exist: ${assetPath}`);
  }
}

function readAndValidateNotes() {
  const artworkIndex = loadArtworkIndex();
  const fileNames = fs.readdirSync(NOTES_DIR)
    .filter((fileName) => path.extname(fileName).toLowerCase() === '.md')
    .sort();

  if (fileNames.length === 0) {
    throw new Error(`No Markdown Studio Notes found in ${NOTES_DIR}.`);
  }

  const notes = fileNames.map((fileName) => {
    const source = fs.readFileSync(path.join(NOTES_DIR, fileName), 'utf8');
    const { metadata, body } = parseMarkdownNote(source, fileName);

    for (const field of REQUIRED_FIELDS) {
      if (typeof metadata[field] !== 'string' || !metadata[field].trim()) {
        throw new Error(`${fileName}: required frontmatter field "${field}" is missing or empty.`);
      }
    }
    if (!body.trim()) {
      throw new Error(`${fileName}: Markdown body is empty.`);
    }
    if (!SLUG_PATTERN.test(metadata.slug)) {
      throw new Error(
        `${fileName}: invalid slug "${metadata.slug}"; use lowercase letters, numbers, and single hyphens.`
      );
    }

    return {
      slug: metadata.slug,
      title: metadata.title,
      artwork: typeof metadata.artwork === 'string' ? metadata.artwork : '',
      date: metadata.date,
      status: metadata.status,
      relatedArtworkSlug: extractRelatedArtworkSlug(body, fileName),
      bodyHtml: renderEditorialContent(body, {
        fileName,
        artworkIndex,
        validateAsset: validatePublishedAsset
      })
    };
  });

  const seenSlugs = new Set();
  for (const note of notes) {
    if (seenSlugs.has(note.slug)) {
      throw new Error(`Duplicate Studio Note slug detected: "${note.slug}".`);
    }
    seenSlugs.add(note.slug);
  }

  return notes;
}

function validateExistingTargets(notes) {
  for (const note of notes) {
    const targetPath = path.join(OUTPUT_DIR, `${note.slug}.html`);
    if (!fs.existsSync(targetPath)) continue;

    const stats = fs.lstatSync(targetPath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Refusing to overwrite non-regular output target: ${targetPath}`);
    }

    const existing = fs.readFileSync(targetPath, 'utf8');
    if (!existing.includes(GENERATED_MARKER)) {
      throw new Error(`Refusing to overwrite manual Studio Note page: ${targetPath}`);
    }
  }

  const indexPath = path.join(OUTPUT_DIR, 'index.html');
  if (!fs.existsSync(indexPath)) return;

  const stats = fs.lstatSync(indexPath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Refusing to overwrite non-regular Studio Notes index: ${indexPath}`);
  }

  const existing = fs.readFileSync(indexPath, 'utf8');
  if (!existing.includes(INDEX_GENERATED_MARKER)) {
    throw new Error(`Refusing to overwrite manual Studio Notes index: ${indexPath}`);
  }
}

function findGeneratedPages() {
  if (!fs.existsSync(OUTPUT_DIR)) return [];

  const generatedPages = [];
  for (const fileName of fs.readdirSync(OUTPUT_DIR)) {
    if (path.extname(fileName).toLowerCase() !== '.html') continue;

    const filePath = path.join(OUTPUT_DIR, fileName);
    const stats = fs.lstatSync(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) continue;

    const contents = fs.readFileSync(filePath, 'utf8');
    if (contents.includes(GENERATED_MARKER)) generatedPages.push(filePath);
  }
  return generatedPages;
}

function main(options = {}) {
  const log = options.log || console.log;
  const notes = readAndValidateNotes();
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const indexTemplate = fs.readFileSync(INDEX_TEMPLATE_PATH, 'utf8');
  if (!template.includes(GENERATED_MARKER)) {
    throw new Error('Studio Note template is missing the generated-page marker.');
  }
  if (!indexTemplate.includes(INDEX_GENERATED_MARKER)) {
    throw new Error('Studio Notes index template is missing the generated-page marker.');
  }

  const pages = notes.map((note) => ({
    fileName: `${note.slug}.html`,
    html: renderTemplate(template, note)
  }));
  const indexHtml = renderIndexTemplate(indexTemplate, notes);
  validateExistingTargets(notes);
  const generatedPages = findGeneratedPages();

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  for (const filePath of generatedPages) fs.unlinkSync(filePath);
  for (const page of pages) {
    fs.writeFileSync(path.join(OUTPUT_DIR, page.fileName), `${page.html.trimEnd()}\n`, 'utf8');
    log(`Generated web/studio-notes/${page.fileName}`);
  }
  fs.writeFileSync(path.join(OUTPUT_DIR, 'index.html'), `${indexHtml.trimEnd()}\n`, 'utf8');
  log('Generated web/studio-notes/index.html');
  log(`Generated ${pages.length} Studio Note page(s).`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Studio Notes generation failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  buildPublishedNoteByArtworkSlug,
  escapeHtml,
  extractRelatedArtworkSlug,
  getPublishedNotes,
  loadArtworkIndex,
  main,
  parseAttributes,
  parseMarkdownNote,
  readAndValidateNotes,
  renderEditorialContent,
  renderIndexEntries,
  renderIndexTemplate,
  renderMarkdown,
  renderTemplate
};
