const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  loadArtworkIndex,
  main,
  parseMarkdownNote,
  renderEditorialContent,
  renderMarkdown
} = require('../../scripts/generate-studio-notes');

const ROOT_DIR = path.join(__dirname, '..', '..');
const STILL_HERE_SOURCE = path.join(ROOT_DIR, 'web', 'data', 'studio-notes-md', 'still-here.md');
const STILL_HERE_OUTPUT = path.join(ROOT_DIR, 'web', 'studio-notes', 'still-here.html');
const ARTWORKS_PATH = path.join(ROOT_DIR, 'web', 'data', 'artworks.json');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

test('renders explicit media-left and media-right sections', () => {
  const left = renderEditorialContent(`::section position="media-left"
::image src="images/process-one.jpg" alt="Brushwork in progress" size="large"
The first passage.
::end`);
  assert.match(left, /studio-note-section--media-left/);
  assert.match(left, /studio-note-media--large/);
  assert.match(left, /<div class="studio-note-copy">/);

  const right = renderEditorialContent(`::section position="media-right"
::image src="images/process-two.webp" alt="A second process view" size="medium"
The second passage.
::end`);
  assert.match(right, /studio-note-section--media-right/);
  assert.match(right, /studio-note-media--medium/);
});

test('renders an explicit text-only section', () => {
  const html = renderEditorialContent(`::section position="text-only"
Text with *emphasis* and **weight**.
::end`);
  assert.match(html, /studio-note-section--text-only/);
  assert.match(html, /<em>emphasis<\/em>/);
  assert.match(html, /<strong>weight<\/strong>/);
  assert.doesNotMatch(html, /<figure/);
});

test('renders images with and without captions and accepts every size token', () => {
  for (const size of ['small', 'medium', 'large', 'wide']) {
    const html = renderEditorialContent(`::section position="media-center"
::image src="images/process-${size}.jpg" alt="Process ${size}" size="${size}"
::end`);
    assert.match(html, new RegExp(`studio-note-media--${size}`));
    assert.match(html, /loading="lazy"/);
    assert.doesNotMatch(html, /<figcaption>/);
  }

  const captioned = renderEditorialContent(`::section position="media-center"
::image src="images/detail.jpg" alt="Paint detail" size="small" caption="A quiet detail."
::end`);
  assert.match(captioned, /<figcaption>A quiet detail\.<\/figcaption>/);
});

test('rejects invalid sizes, attributes, and unsafe paths', () => {
  assert.throws(
    () => renderEditorialContent(`::section position="media-left"
::image src="images/detail.jpg" alt="Detail" size="giant"
Text.
::end`),
    /invalid media size/
  );
  assert.throws(
    () => renderEditorialContent(`::section position="media-left"
::image src="images/detail.jpg" alt="Detail" size="large" style="width:100%"
Text.
::end`),
    /attribute "style" is not allowed/
  );
  assert.throws(
    () => renderEditorialContent(`::section position="media-left"
::image src="javascript:alert(1)" alt="Detail" size="large"
Text.
::end`),
    /unsafe or unsupported image path/
  );
});

test('renders ambient and controlled videos with explicit playback behavior', () => {
  const ambient = renderEditorialContent(`::section position="media-center"
::video src="videos/dandelion.mp4" size="wide" mode="ambient" poster="images/dandelion.jpg" caption="Seeds moving in the air."
::end`);
  assert.match(ambient, /muted autoplay loop playsinline data-ambient-video/);
  assert.match(ambient, /poster="..\/images\/dandelion.jpg"/);
  assert.doesNotMatch(ambient, / controls/);

  const controlled = renderEditorialContent(`::section position="media-center"
::video src="videos/interview.webm" size="medium" mode="controls"
::end`);
  assert.match(controlled, / controls playsinline/);
  assert.doesNotMatch(controlled, /autoplay/);
  assert.throws(
    () => renderEditorialContent(`::section position="media-center"
::video src="videos/test.mp4" size="medium" mode="cinema"
::end`),
    /invalid video mode/
  );
});

test('escapes malicious Markdown and media metadata', () => {
  const html = renderEditorialContent(`::section position="media-left"
::image src="images/detail.jpg" alt="<img onerror='bad'>" size="small" caption="<script>bad()</script>"
<script>alert('bad')</script> and **safe**.
::end`);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img onerror=&#39;bad&#39;&gt;/);
  assert.match(html, /<strong>safe<\/strong>/);
});

test('resolves related artwork from artworks.json and rejects a missing slug', () => {
  const artworkIndex = loadArtworkIndex(ARTWORKS_PATH);
  const html = renderEditorialContent('::artwork slug="a-shared-legacy"', { artworkIndex });
  assert.match(html, /A Shared Legacy/);
  assert.match(html, /..\/images\/a-shared-legacy.jpg/);
  assert.match(html, /..\/artworks\/a-shared-legacy.html/);
  assert.match(html, /View artwork/);
  assert.doesNotMatch(html, /20 × 24|Private Commission|price/i);

  assert.throws(
    () => renderEditorialContent('::artwork slug="not-in-catalog"', { artworkIndex }),
    /related artwork "not-in-catalog" was not found in artworks.json/
  );
});

test('rejects duplicate media, duplicate artwork, and malformed closures', () => {
  assert.throws(
    () => renderEditorialContent(`::section position="media-left"
::image src="images/one.jpg" alt="One" size="small"
::image src="images/two.jpg" alt="Two" size="small"
::end`),
    /only one image or video/
  );
  const artworkIndex = loadArtworkIndex(ARTWORKS_PATH);
  assert.throws(
    () => renderEditorialContent(`::artwork slug="a-shared-legacy"
::artwork slug="who-am-i"`, { artworkIndex }),
    /only one ::artwork directive/
  );
  assert.throws(
    () => renderEditorialContent('::end'),
    /unexpected ::end/
  );
  assert.throws(
    () => renderEditorialContent(`::section position="text-only"
Unclosed text.`),
    /missing its closing ::end/
  );
});

test('keeps legacy Markdown compatible and preserves heading hierarchy', () => {
  const html = renderEditorialContent('First paragraph.\n\nSecond paragraph.');
  assert.match(html, /studio-note-section--text-only/);
  assert.equal((html.match(/<p>/g) || []).length, 2);
  assert.equal(renderMarkdown('# Section\n\n## Subsection'), '<h2>Section</h2>\n<h3>Subsection</h3>');

  const source = fs.readFileSync(STILL_HERE_SOURCE, 'utf8');
  const { body } = parseMarkdownNote(source, 'still-here.md');
  const rendered = renderEditorialContent(body, { artworkIndex: loadArtworkIndex(ARTWORKS_PATH) });
  assert.equal((rendered.match(/studio-note-section studio-note-section--/g) || []).length, 7);
  assert.equal((rendered.match(/<p>/g) || []).length, 7);
  assert.match(rendered, /studio-note-related-artwork/);
  assert.match(rendered, /In my grandmother&#39;s garden in Cuba/);
  assert.match(rendered, /It was still here\./);
});

test('generation is idempotent and does not alter the Still Here source', { concurrency: false }, () => {
  const sourceBefore = fs.readFileSync(STILL_HERE_SOURCE);
  main({ log: () => {} });
  const firstOutput = fs.readFileSync(STILL_HERE_OUTPUT);
  main({ log: () => {} });
  const secondOutput = fs.readFileSync(STILL_HERE_OUTPUT);
  const sourceAfter = fs.readFileSync(STILL_HERE_SOURCE);

  assert.equal(sha256(firstOutput), sha256(secondOutput));
  assert.equal(sha256(sourceBefore), sha256(sourceAfter));
});
