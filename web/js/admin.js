const form = document.querySelector("#document-form");
const documentSelect = form?.querySelector('select[name="document-type"]');
const artworkSelect = form?.querySelector('select[name="artworkSlug"]');
const documentFrame = document.querySelector("#document-frame");
const loadButton = document.querySelector("#load-document");
const printButton = document.querySelector("#print-document");
const exportStatus = document.querySelector("#export-status");

const documentsPath = "../documents/";
const artworksPath = "../data/artworks.json";
const artworkOverridesKey = "sylvaArsDocumentArtworkOverrides";

const fields = [
  "artworkSlug",
  "clientName",
  "clientEmail",
  "clientPhone",
  "clientAddress",
  "artworkTitle",
  "artworkDescription",
  "medium",
  "dimensions",
  "year",
  "invoiceId",
  "certificateId",
  "amount",
  "depositAmount",
  "estimatedDate",
  "notes"
];

let artworks = [];

function getArtworkOverrides() {
  try {
    return JSON.parse(localStorage.getItem(artworkOverridesKey)) || {};
  } catch {
    return {};
  }
}

function saveArtworkDescriptionOverride(slug, description) {
  if (!slug) {
    return;
  }

  try {
    const overrides = getArtworkOverrides();
    overrides[slug] = {
      ...(overrides[slug] || {}),
      artworkDescription: description
    };

    localStorage.setItem(artworkOverridesKey, JSON.stringify(overrides));
  } catch (error) {
    console.warn(error);
  }
}

function getAdminArtworkDescription(artwork = {}) {
  const overrides = getArtworkOverrides();
  const savedDescription = artwork.slug ? overrides[artwork.slug]?.artworkDescription : "";
  const mergedArtwork = {
    ...artwork,
    artworkDescription: savedDescription
  };

  return window.getArtworkDescription
    ? window.getArtworkDescription(mergedArtwork)
    : (savedDescription || artwork.longDescription || artwork.shortDescription || "").trim();
}

function formatMoney(value) {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return "";
  }

  if (trimmedValue.startsWith("$")) {
    return trimmedValue;
  }

  return `$${trimmedValue}`;
}

function setFormValue(name, value) {
  const input = form.elements[name];

  if (input) {
    input.value = value || "";
  }
}

function populateArtworkOptions() {
  if (!artworkSelect) {
    return;
  }

  artworks.forEach((artwork) => {
    const option = document.createElement("option");
    option.value = artwork.slug;
    option.textContent = artwork.title;
    artworkSelect.append(option);
  });
}

async function loadArtworks() {
  if (!artworkSelect) {
    return;
  }

  try {
    const response = await fetch(artworksPath);

    if (!response.ok) {
      throw new Error(`Unable to load ${artworksPath}`);
    }

    artworks = await response.json();
    populateArtworkOptions();
  } catch (error) {
    console.warn(error);
  }
}

function loadSelectedArtwork() {
  const slug = artworkSelect?.value;
  const artwork = artworks.find((item) => item.slug === slug);

  if (!artwork) {
    return;
  }

  setFormValue("artworkTitle", artwork.title);
  setFormValue("artworkDescription", getAdminArtworkDescription(artwork));
  setFormValue("medium", artwork.medium);
  setFormValue("dimensions", artwork.dimensions);
  setFormValue("year", artwork.year);
  setFormValue("certificateId", artwork.certificateId);

  injectValues();
}

function getFormValues() {
  const values = {};

  fields.forEach((field) => {
    const input = form.elements[field];
    values[field] = input ? input.value.trim() : "";
  });

  values.issueDate = window.formatDocumentDate
    ? window.formatDocumentDate()
    : new Date().toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric"
    });

  values.amount = formatMoney(values.amount);
  values.depositAmount = formatMoney(values.depositAmount);
  values.artworkDescription = window.getArtworkDescription
    ? window.getArtworkDescription({ artworkDescription: values.artworkDescription })
    : values.artworkDescription;

  return values;
}

function applyValuesToDocument(targetDocument, values = getFormValues()) {
  targetDocument.querySelectorAll("[data-field]").forEach((element) => {
    const field = element.dataset.field;
    const value = values[field];

    if (!element.dataset.defaultValue) {
      element.dataset.defaultValue = element.textContent;
    }

    element.textContent = value || element.dataset.defaultValue;
  });

  const applyDate = targetDocument.defaultView?.applyDocumentDate || window.applyDocumentDate;
  applyDate?.(targetDocument);

  if (!applyDate) {
    targetDocument.querySelectorAll("[data-current-date]").forEach((element) => {
      element.textContent = values.issueDate;
    });
  }
}

function injectValues() {
  const previewDocument = getPreviewDocument();

  if (!previewDocument) {
    return;
  }

  applyValuesToDocument(previewDocument);
}

function loadSelectedDocument() {
  const template = documentSelect.value;
  documentFrame.src = `${documentsPath}${template}`;
}

function getPreviewDocument() {
  return documentFrame.contentDocument || documentFrame.contentWindow?.document || null;
}

async function getPrintableDocumentHtml() {
  const previewDocument = getPreviewDocument();
  let clonedDocument = null;

  if (previewDocument?.documentElement) {
    clonedDocument = previewDocument.documentElement.cloneNode(true);
  } else {
    const response = await fetch(documentFrame.src);

    if (!response.ok) {
      throw new Error(`Unable to load printable document: ${documentFrame.src}`);
    }

    const templateHtml = await response.text();
    const parsedDocument = new DOMParser().parseFromString(templateHtml, "text/html");
    applyValuesToDocument(parsedDocument);
    clonedDocument = parsedDocument.documentElement;
  }

  if (!clonedDocument) {
    return "";
  }

  const base = clonedDocument.ownerDocument.createElement("base");
  base.href = new URL(documentsPath, window.location.href).href;

  clonedDocument.querySelectorAll("[data-default-value]").forEach((element) => {
    delete element.dataset.defaultValue;
  });

  clonedDocument.querySelector("head")?.prepend(base);

  return `<!DOCTYPE html>\n${clonedDocument.outerHTML}`;
}

function setExportStatus(message, options = {}) {
  if (!exportStatus) {
    return;
  }

  if (options.html) {
    exportStatus.innerHTML = message;
    return;
  }

  exportStatus.textContent = message;
}

async function createPdfFromCurrentDocument() {
  setExportStatus("Preparing printable document...");

  let printableHtml = "";

  try {
    injectValues();
    printableHtml = await getPrintableDocumentHtml();
  } catch (error) {
    console.error(error);
    setExportStatus("The document could not be prepared. Check the preview and try again.");
    return;
  }

  if (!printableHtml) {
    setExportStatus("The document is still loading. Try again in a moment.");
    return;
  }

  const pdfBlob = new Blob([printableHtml], { type: "text/html" });
  const pdfUrl = URL.createObjectURL(pdfBlob);
  let pdfWindow = null;

  try {
    pdfWindow = window.open(pdfUrl, "_blank");
  } catch (error) {
    console.error(error);
  }

  if (!pdfWindow) {
    setExportStatus(
      `Your browser blocked the PDF window. <a href="${pdfUrl}" target="_blank" rel="noopener">Open the printable document</a>, then choose Print and Save as PDF.`,
      { html: true }
    );
    return;
  }

  setExportStatus("Opened the printable document. In the print dialog, choose Save as PDF.");

  let printStarted = false;

  const printDocument = () => {
    if (printStarted) {
      return;
    }

    printStarted = true;
    pdfWindow.focus();
    pdfWindow.print();
  };

  pdfWindow.addEventListener?.("load", printDocument, { once: true });
  window.setTimeout(printDocument, 800);
  window.setTimeout(() => URL.revokeObjectURL(pdfUrl), 60000);
}

window.createPdfFromCurrentDocument = createPdfFromCurrentDocument;

documentFrame.addEventListener("load", injectValues);

form.addEventListener("input", injectValues);

form.elements.artworkDescription?.addEventListener("input", () => {
  saveArtworkDescriptionOverride(artworkSelect?.value, form.elements.artworkDescription.value.trim());
});

documentSelect.addEventListener("change", loadSelectedDocument);

artworkSelect?.addEventListener("change", loadSelectedArtwork);

loadButton.addEventListener("click", () => {
  loadSelectedDocument();
  injectValues();
});

printButton.addEventListener("click", () => {
  createPdfFromCurrentDocument();
});

loadArtworks();
