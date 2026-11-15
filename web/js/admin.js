const documentObject = typeof document === "undefined" ? null : document;
const form = documentObject?.querySelector("#document-form");
const documentSelect = form?.querySelector('select[name="document-type"]');
const artworkSelect = form?.querySelector('select[name="artworkSlug"]');
const documentFrame = documentObject?.querySelector("#document-frame");
const loadButton = documentObject?.querySelector("#load-document");
const printButton = documentObject?.querySelector("#print-document");
const exportStatus = documentObject?.querySelector("#export-status");
const invoiceFields = documentObject?.querySelector("#invoice-fields");
const paymentList = documentObject?.querySelector("#payment-list");
const addPaymentButton = documentObject?.querySelector("#add-payment");

const documentsPath = "/admin/document-templates/";
const artworksPath = "../data/artworks.json";
const artworkOverridesKey = "sylvaArsDocumentArtworkOverrides";
const sessionExpiredMessage =
  "Your Admin session expired. Sign in again before loading or creating this document.";
const templateDefinitions = Object.freeze({
  "invoice-template.html": Object.freeze({
    title: "Invoice | Sylva Ars Studio",
    mainSelector: "main.invoice"
  }),
  "coa-template.html": Object.freeze({
    title: "Certificate of Authenticity",
    mainSelector: "main.coa"
  }),
  "artwork-sales-agreement.html": Object.freeze({
    title: "Artwork Sales Agreement | Sylva Ars Studio",
    mainSelector: "main.document"
  }),
  "commission-agreement.html": Object.freeze({
    title: "Commission Agreement | Sylva Ars Studio",
    mainSelector: "main.document"
  })
});

class AdminSessionExpiredError extends Error {
  constructor() {
    super(sessionExpiredMessage);
    this.name = "AdminSessionExpiredError";
  }
}

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
  "artworkPrice",
  "salesTaxRate",
  "certificateId",
  "amount",
  "depositAmount",
  "estimatedDate",
  "notes"
];

let artworks = [];

function createPaymentEntry(payment = {}) {
  const entry = document.createElement("section");
  entry.className = "payment-entry";

  entry.innerHTML = `
    <p class="payment-entry-title"></p>
    <div class="payment-entry-grid">
      <label>
        Payment Date
        <input type="date" data-payment-field="date">
      </label>
      <label>
        Payment Amount
        <input type="number" min="0" step="0.01" placeholder="0.00" data-payment-field="amount">
      </label>
      <label>
        Payment Method
        <input type="text" placeholder="Cash, card, check, transfer…" data-payment-field="method">
      </label>
      <label>
        Optional Note
        <input type="text" data-payment-field="note">
      </label>
    </div>
    <button type="button" class="admin-button remove-payment">Remove Payment</button>
  `;

  Object.entries(payment).forEach(([field, value]) => {
    const input = entry.querySelector(`[data-payment-field="${field}"]`);

    if (input) {
      input.value = value;
    }
  });

  entry.querySelector(".remove-payment")?.addEventListener("click", () => {
    entry.remove();
    renumberPaymentEntries();
    injectValues();
  });

  paymentList?.append(entry);
  renumberPaymentEntries();
}

function renumberPaymentEntries() {
  paymentList?.querySelectorAll(".payment-entry").forEach((entry, index) => {
    const title = entry.querySelector(".payment-entry-title");

    if (title) {
      title.textContent = `Payment ${index + 1}`;
    }
  });
}

function getPayments() {
  if (!paymentList || !window.InvoiceUtils) {
    return [];
  }

  return Array.from(paymentList.querySelectorAll(".payment-entry"))
    .map((entry) => ({
      date: entry.querySelector('[data-payment-field="date"]')?.value || "",
      amount: entry.querySelector('[data-payment-field="amount"]')?.value || "",
      method: entry.querySelector('[data-payment-field="method"]')?.value.trim() || "",
      note: entry.querySelector('[data-payment-field="note"]')?.value.trim() || ""
    }))
    .filter((payment) => window.InvoiceUtils.toCents(payment.amount) > 0);
}

function applyAutomaticPaymentNotes(totals) {
  if (!paymentList || !window.InvoiceUtils) {
    return;
  }

  let cumulativePaymentsCents = 0;

  paymentList.querySelectorAll(".payment-entry").forEach((entry, index) => {
    const amountInput = entry.querySelector('[data-payment-field="amount"]');
    const noteInput = entry.querySelector('[data-payment-field="note"]');
    const paymentAmountCents = window.InvoiceUtils.toCents(amountInput?.value);
    const previousCumulativeCents = cumulativePaymentsCents;
    cumulativePaymentsCents += paymentAmountCents;

    let automaticNote = "";

    if (
      index === 0 &&
      totals.artworkPriceCents > 0 &&
      paymentAmountCents * 2 === totals.artworkPriceCents
    ) {
      automaticNote = "50% Deposit";
    } else if (
      paymentAmountCents > 0 &&
      totals.amountDueCents > 0 &&
      previousCumulativeCents < totals.amountDueCents &&
      cumulativePaymentsCents >= totals.amountDueCents
    ) {
      automaticNote = "Final Payment";
    }

    if (!noteInput) {
      return;
    }

    const previousAutomaticNote = noteInput.dataset.automaticPaymentNote || "";
    const currentNote = noteInput.value.trim();
    const canUpdateAutomatically = !currentNote || currentNote === previousAutomaticNote;

    if (canUpdateAutomatically) {
      noteInput.value = automaticNote;
      noteInput.dataset.automaticPaymentNote = automaticNote;
    }
  });
}

function updateInvoiceFieldsVisibility() {
  const isInvoice = documentSelect?.value === "invoice-template.html";

  if (invoiceFields) {
    invoiceFields.hidden = !isInvoice;
  }

  document.querySelectorAll(".legacy-financial-field").forEach((field) => {
    field.hidden = isInvoice;
  });
}

function updateAdminCalculationSummary(values, totals) {
  const outputValues = {
    salesTaxAmount: values.salesTaxAmount,
    amountDue: values.amountDue,
    totalReceived: values.totalReceived,
    voluntaryAdditionalPayment: values.voluntaryAdditionalPayment,
    balanceDue: values.balanceDue,
    status: values.status
  };

  Object.entries(outputValues).forEach(([field, value]) => {
    const output = form.querySelector(`[data-calculated-output="${field}"]`);

    if (output) {
      output.textContent = value;
    }
  });

  const voluntaryRow = form.querySelector("[data-admin-voluntary-row]");

  if (voluntaryRow) {
    voluntaryRow.hidden = totals.voluntaryAdditionalPaymentCents <= 0;
  }
}

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

function getSelectedArtwork(slug = artworkSelect?.value) {
  return artworks.find((artwork) => artwork.slug === slug);
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
  const artwork = getSelectedArtwork(slug);
  const yearInput = form.elements.year;

  if (!artwork) {
    if (yearInput) {
      if (yearInput.readOnly) {
        yearInput.value = "";
      }

      yearInput.readOnly = false;
    }

    injectValues();
    return;
  }

  if (yearInput) {
    yearInput.readOnly = true;
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
  const selectedArtwork = getSelectedArtwork(values.artworkSlug);

  if (selectedArtwork) {
    values.year = String(selectedArtwork.year ?? "").trim();
  }

  values.invoiceDescription = selectedArtwork?.shortDescription?.trim() || values.artworkDescription;

  if (window.InvoiceUtils) {
    values.payments = getPayments();
    const totals = window.InvoiceUtils.calculateInvoiceTotals({
      artworkPrice: values.artworkPrice,
      salesTaxRate: values.salesTaxRate,
      payments: values.payments
    });

    applyAutomaticPaymentNotes(totals);
    values.payments = getPayments();

    values.artworkPrice = window.InvoiceUtils.formatCents(totals.artworkPriceCents);
    values.salesTaxLabel = `PA Sales Tax (${window.InvoiceUtils.formatTaxRate(totals.salesTaxRate)}%)`;
    values.salesTaxAmount = window.InvoiceUtils.formatCents(totals.salesTaxCents);
    values.amountDue = window.InvoiceUtils.formatCents(totals.amountDueCents);
    values.totalReceived = window.InvoiceUtils.formatCents(totals.totalReceivedCents);
    values.voluntaryAdditionalPayment = window.InvoiceUtils.formatCents(
      totals.voluntaryAdditionalPaymentCents
    );
    values.hasVoluntaryAdditionalPayment = totals.voluntaryAdditionalPaymentCents > 0;
    values.balanceDue = window.InvoiceUtils.formatCents(totals.balanceDueCents);
    values.status = totals.status;
    updateAdminCalculationSummary(values, totals);
  }

  return values;
}

function renderPaymentHistory(targetDocument, payments = []) {
  const paymentBody = targetDocument.querySelector("#payment-history-body");

  if (!paymentBody) {
    return;
  }

  paymentBody.replaceChildren();

  if (!payments.length) {
    const row = paymentBody.insertRow();
    const cell = row.insertCell();
    cell.colSpan = 5;
    cell.className = "empty-payment-history";
    cell.textContent = "No payments received.";
    return;
  }

  payments.forEach((payment, index) => {
    const row = paymentBody.insertRow();
    const values = [
      `Payment ${index + 1}`,
      payment.date || "—",
      window.InvoiceUtils.formatCents(window.InvoiceUtils.toCents(payment.amount)),
      payment.method || "—",
      payment.note || "—"
    ];

    values.forEach((value) => {
      const cell = row.insertCell();
      cell.textContent = value;
    });
  });
}

function getProtectedTemplateUrl(template, baseUrl = window.location.href) {
  if (!templateDefinitions[template]) {
    throw new AdminSessionExpiredError();
  }

  return new URL(`${documentsPath}${template}`, baseUrl);
}

function isExpectedTemplateUrl(urlValue, template, baseUrl = window.location.href) {
  try {
    const expectedUrl = getProtectedTemplateUrl(template, baseUrl);
    const actualUrl = new URL(urlValue, baseUrl);
    return actualUrl.origin === expectedUrl.origin
      && actualUrl.pathname === expectedUrl.pathname
      && actualUrl.search === "";
  } catch {
    return false;
  }
}

function isExpectedTemplateDocument(targetDocument, template) {
  const definition = templateDefinitions[template];
  if (!definition || !targetDocument?.documentElement || !targetDocument.head || !targetDocument.body) {
    return false;
  }

  if (targetDocument.title.trim() !== definition.title) {
    return false;
  }

  if (targetDocument.querySelectorAll(definition.mainSelector).length !== 1) {
    return false;
  }

  if (
    targetDocument.querySelector('.public-document-status, [aria-label="Document status"]')
    || targetDocument.querySelector('form[action*="admin-login"], input[name="password"]')
    || /admin login|sign in/i.test(targetDocument.title)
  ) {
    return false;
  }

  return true;
}

async function fetchProtectedTemplateDocument(template) {
  const templateUrl = getProtectedTemplateUrl(template);
  let response;

  try {
    response = await fetch(templateUrl.href, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "follow",
      headers: { Accept: "text/html" }
    });
  } catch {
    throw new AdminSessionExpiredError();
  }

  const contentType = response.headers.get("content-type") || "";
  if (
    !response.ok
    || response.redirected
    || !isExpectedTemplateUrl(response.url, template)
    || !contentType.toLowerCase().includes("text/html")
  ) {
    throw new AdminSessionExpiredError();
  }

  const templateHtml = await response.text();
  const parsedDocument = new DOMParser().parseFromString(templateHtml, "text/html");
  if (!isExpectedTemplateDocument(parsedDocument, template)) {
    throw new AdminSessionExpiredError();
  }

  return parsedDocument;
}

function applyValuesToDocument(targetDocument, values = getFormValues()) {
  targetDocument.querySelectorAll("[data-field]").forEach((element) => {
    const field = element.dataset.field;
    const value = values[field];

    if (!("defaultValue" in element.dataset)) {
      element.dataset.defaultValue = element.textContent;
    }

    element.textContent = value || element.dataset.defaultValue;
  });

  renderPaymentHistory(targetDocument, values.payments);

  const clientFields = ["clientName", "clientEmail", "clientPhone", "clientAddress"];
  const hasClientInformation = clientFields.some((field) => Boolean(values[field]));

  clientFields.forEach((field) => {
    const row = targetDocument.querySelector(`[data-client-row="${field}"]`);

    if (row) {
      row.hidden = !values[field];
    }
  });

  const clientSection = targetDocument.querySelector("[data-client-section]");
  const partiesSection = targetDocument.querySelector("[data-parties-section]");

  if (clientSection) {
    clientSection.hidden = !hasClientInformation;
  }

  partiesSection?.classList.toggle("client-hidden", !hasClientInformation);

  const applyBusinessInformation =
    targetDocument.defaultView?.SylvaArsBusiness?.apply || window.SylvaArsBusiness?.apply;
  applyBusinessInformation?.(targetDocument);

  const voluntaryRow = targetDocument.querySelector("[data-voluntary-row]");

  if (voluntaryRow) {
    voluntaryRow.hidden = !values.hasVoluntaryAdditionalPayment;
  }

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
  const template = documentSelect?.value;

  if (!previewDocument || !isExpectedTemplateDocument(previewDocument, template)) {
    return;
  }

  applyValuesToDocument(previewDocument);
}

function loadSelectedDocument() {
  const template = documentSelect?.value;
  if (!template || !documentFrame) return;

  updateInvoiceFieldsVisibility();
  documentFrame.dataset.templateReady = "false";
  documentFrame.src = getProtectedTemplateUrl(template).href;
}

function getPreviewDocument() {
  return documentFrame?.contentDocument || documentFrame?.contentWindow?.document || null;
}

function validateAndPopulatePreview() {
  const template = documentSelect?.value;
  const previewDocument = getPreviewDocument();
  let frameUrl = "";

  try {
    frameUrl = documentFrame?.contentWindow?.location?.href || documentFrame?.src || "";
  } catch {
    frameUrl = "";
  }

  if (
    !template
    || !isExpectedTemplateUrl(frameUrl, template)
    || !isExpectedTemplateDocument(previewDocument, template)
  ) {
    if (documentFrame) documentFrame.dataset.templateReady = "false";
    setExportStatus(sessionExpiredMessage);
    return false;
  }

  documentFrame.dataset.templateReady = "true";
  setExportStatus("");
  injectValues();
  return true;
}

async function getPrintableDocumentHtml() {
  const template = documentSelect?.value;
  if (!template) throw new AdminSessionExpiredError();

  const parsedDocument = await fetchProtectedTemplateDocument(template);
  applyValuesToDocument(parsedDocument);

  if (!isExpectedTemplateDocument(parsedDocument, template)) {
    throw new AdminSessionExpiredError();
  }

  parsedDocument.querySelectorAll("[data-default-value]").forEach((element) => {
    delete element.dataset.defaultValue;
  });

  parsedDocument.querySelectorAll("base").forEach((element) => element.remove());
  const base = parsedDocument.createElement("base");
  base.href = new URL("/", window.location.origin).href;
  parsedDocument.head.prepend(base);

  return `<!DOCTYPE html>\n${parsedDocument.documentElement.outerHTML}`;
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
    printableHtml = await getPrintableDocumentHtml();
  } catch (error) {
    console.error(error);
    setExportStatus(
      error instanceof AdminSessionExpiredError
        ? sessionExpiredMessage
        : "The document could not be prepared. Check the preview and try again."
    );
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

  const printDocument = async () => {
    if (printStarted) {
      return;
    }

    printStarted = true;

    try {
      if (pdfWindow.document.fonts?.ready) {
        await pdfWindow.document.fonts.ready;
      }

      await Promise.all(
        Array.from(pdfWindow.document.images).map((image) => {
          if (image.complete) {
            return image.decode
              ? image.decode().catch(() => {})
              : Promise.resolve();
          }

          return new Promise((resolve) => {
            image.addEventListener("load", resolve, { once: true });
            image.addEventListener("error", resolve, { once: true });
          });
        })
      );

      await new Promise((resolve) => {
        pdfWindow.requestAnimationFrame(() => {
          pdfWindow.requestAnimationFrame(resolve);
        });
      });
    } catch (error) {
      console.warn(error);
    }

    pdfWindow.focus();
    pdfWindow.print();
  };

  pdfWindow.addEventListener?.("load", printDocument, { once: true });
  window.setTimeout(printDocument, 800);
  window.setTimeout(() => URL.revokeObjectURL(pdfUrl), 60000);
}

if (typeof window !== "undefined") {
  window.createPdfFromCurrentDocument = createPdfFromCurrentDocument;
}

if (form && documentSelect && documentFrame && loadButton && printButton) {
  addPaymentButton?.addEventListener("click", () => {
    createPaymentEntry();
  });

  documentFrame.addEventListener("load", validateAndPopulatePreview);

  form.addEventListener("input", injectValues);

  form.elements.artworkDescription?.addEventListener("input", () => {
    saveArtworkDescriptionOverride(artworkSelect?.value, form.elements.artworkDescription.value.trim());
  });

  documentSelect.addEventListener("change", loadSelectedDocument);

  artworkSelect?.addEventListener("change", loadSelectedArtwork);

  loadButton.addEventListener("click", () => {
    loadSelectedDocument();
  });

  printButton.addEventListener("click", () => {
    createPdfFromCurrentDocument();
  });

  loadArtworks();
  createPaymentEntry();
  updateInvoiceFieldsVisibility();
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    AdminSessionExpiredError,
    documentsPath,
    getProtectedTemplateUrl,
    isExpectedTemplateDocument,
    isExpectedTemplateUrl,
    sessionExpiredMessage,
    templateDefinitions
  };
}
