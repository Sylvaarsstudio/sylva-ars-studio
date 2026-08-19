const form = document.querySelector("#document-form");
const documentSelect = form?.querySelector('select[name="document-type"]');
const artworkSelect = form?.querySelector('select[name="artworkSlug"]');
const documentFrame = document.querySelector("#document-frame");
const loadButton = document.querySelector("#load-document");
const printButton = document.querySelector("#print-document");
const exportStatus = document.querySelector("#export-status");
const invoiceFields = document.querySelector("#invoice-fields");
const paymentList = document.querySelector("#payment-list");
const addPaymentButton = document.querySelector("#add-payment");

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

  if (window.InvoiceUtils) {
    values.payments = getPayments();
    const totals = window.InvoiceUtils.calculateInvoiceTotals({
      artworkPrice: values.artworkPrice,
      salesTaxRate: values.salesTaxRate,
      payments: values.payments
    });

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

function applyValuesToDocument(targetDocument, values = getFormValues()) {
  targetDocument.querySelectorAll("[data-field]").forEach((element) => {
    const field = element.dataset.field;
    const value = values[field];

    if (!element.dataset.defaultValue) {
      element.dataset.defaultValue = element.textContent;
    }

    element.textContent = value || element.dataset.defaultValue;
  });

  renderPaymentHistory(targetDocument, values.payments);

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

  if (!previewDocument) {
    return;
  }

  applyValuesToDocument(previewDocument);
}

function loadSelectedDocument() {
  const template = documentSelect.value;
  updateInvoiceFieldsVisibility();
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

addPaymentButton?.addEventListener("click", () => {
  createPaymentEntry();
});

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
createPaymentEntry();
updateInvoiceFieldsVisibility();
