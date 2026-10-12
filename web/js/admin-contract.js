(function initializeAdminContract(globalObject) {
  const PREVIEW_STORAGE_KEY = "sylvaArsDraftContractPreview";

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function hasContent(value) {
    return value !== null && value !== undefined && String(value).trim() !== "";
  }

  function formatCurrency(value) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD"
    }).format(Number(value || 0));
  }

  function formatDate(value) {
    if (!hasContent(value)) return "";
    const normalized = String(value);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(normalized)
      ? new Date(`${normalized}T00:00:00Z`)
      : new Date(normalized);
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "long",
      timeZone: "UTC"
    }).format(date);
  }

  function renderAddress(party) {
    const locality = [party.city, party.state, party.postal_code]
      .filter(hasContent)
      .join(", ")
      .replace(/, ([^,]+)$/, " $1");
    const lines = [party.address_line_1, party.address_line_2, locality, party.country]
      .filter(hasContent);
    return lines.length ? `<p>${lines.map(escapeHtml).join("<br>")}</p>` : "";
  }

  function renderTerms(terms) {
    return Object.values(terms.sections || {}).map((section) => `
      <section class="section contract-draft-terms">
        <h2>${escapeHtml(section.title)}</h2>
        ${(section.paragraphs || []).map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("")}
      </section>`).join("");
  }

  function renderContractMarkup(snapshot) {
    const contract = snapshot.contract || {};
    const studio = snapshot.studio || {};
    const client = snapshot.client || {};
    const commission = snapshot.commission || {};
    const quotation = snapshot.quotation || {};
    const artwork = snapshot.artwork || commission;
    const financial = snapshot.commercial || snapshot.commercial_terms || snapshot.financial || {};
    const fields = snapshot.document_fields || {};
    const width = artwork.dimensions?.width ?? artwork.width;
    const height = artwork.dimensions?.height ?? artwork.height;
    const unit = artwork.dimensions?.unit || "in";
    const dimensions = [width, height].every(hasContent)
      ? `${width} × ${height} ${unit}`
      : "—";

    return `
      <div class="contract-draft-banner">DRAFT — NOT ISSUED — TERMS UNDER REVIEW <button type="button" class="admin-help-trigger" data-glossary-key="contract_issuance" aria-label="Learn about Contract Issuance">i</button></div>
      <header class="document-header">
        <div>
          <p>${escapeHtml(studio.name || "Sylva Ars Studio LLC")}</p>
          <h1>Commission Agreement</h1>
        </div>
        <dl class="contract-meta">
          <dt>Contract Number</dt><dd>${escapeHtml(contract.document_number || contract.number || "Not issued")}</dd>
          <dt>Version</dt><dd>${contract.version ? `v${escapeHtml(contract.version)}` : "Draft"}</dd>
          <dt>Draft Contract Date</dt><dd>${escapeHtml(formatDate(contract.contract_date))}</dd>
        </dl>
      </header>

      <section class="section contract-source-quotation">
        <h2>Based on Accepted Quotation <button type="button" class="admin-help-trigger" data-glossary-key="contract_source_quotation" aria-label="Learn about Contract Source Quotation">i</button></h2>
        <table><tbody>
          <tr><th>Quotation</th><td>${escapeHtml(quotation.quotation_number || "")} · v${escapeHtml(quotation.quotation_version || "")}</td></tr>
          <tr><th>Accepted At</th><td>${hasContent(quotation.quotation_accepted_at) ? escapeHtml(formatDate(quotation.quotation_accepted_at)) : "—"}</td></tr>
          <tr><th>Snapshot Hash</th><td>${escapeHtml(quotation.quotation_snapshot_hash || "")}</td></tr>
        </tbody></table>
      </section>

      <section class="section two-columns">
        <div><h2>Studio</h2><p><strong>${escapeHtml(studio.name || "")}</strong></p><p>${escapeHtml(studio.address_line_1 || "")}<br>${escapeHtml(studio.address_line_2 || "")}</p><p>${escapeHtml(studio.email || "")}</p></div>
        <div><h2>Client</h2><p><strong>${escapeHtml(client.full_name || client.name || "")}</strong></p><p>${escapeHtml(client.email || "")}</p>${hasContent(client.phone) ? `<p>${escapeHtml(client.phone)}</p>` : ""}${renderAddress(client)}</div>
      </section>

      <section class="section"><h2>Artwork</h2><table><tbody>
        ${hasContent(commission.commission_number || commission.number) ? `<tr><th>Commission Number</th><td>${escapeHtml(commission.commission_number || commission.number)}</td></tr>` : ""}
        <tr><th>Title</th><td>${escapeHtml(artwork.title || "")}</td></tr>
        <tr><th>Description</th><td>${escapeHtml(artwork.description || "")}</td></tr>
        <tr><th>Medium</th><td>${escapeHtml(artwork.medium || "")}</td></tr>
        <tr><th>Dimensions</th><td>${escapeHtml(dimensions)}</td></tr>
        <tr><th>Estimated Completion</th><td>${hasContent(financial.estimated_completion) ? escapeHtml(formatDate(String(financial.estimated_completion).slice(0, 10))) : "—"}</td></tr>
      </tbody></table></section>

      <section class="section"><h2>Financial Summary</h2><table><tbody>
        <tr><th>Artwork Price</th><td>${escapeHtml(formatCurrency(financial.price))}</td></tr>
        <tr><th>Sales Tax</th><td>${escapeHtml(formatCurrency(financial.sales_tax))}</td></tr>
        <tr><th>Shipping</th><td>${escapeHtml(formatCurrency(financial.shipping_charge ?? financial.shipping))}</td></tr>
        <tr><th>Total</th><td>${escapeHtml(formatCurrency(financial.total))}</td></tr>
        <tr><th>Required Deposit (50%)</th><td>${escapeHtml(formatCurrency(financial.required_deposit))}</td></tr>
        <tr><th>Estimated Remaining After Required Deposit</th><td>${escapeHtml(formatCurrency(financial.estimated_remaining_after_required_deposit))}</td></tr>
      </tbody></table></section>

      ${hasContent(financial.special_terms) ? `<section class="section"><h2>Accepted Special Terms</h2><p>${escapeHtml(financial.special_terms)}</p></section>` : ""}

      ${renderTerms(snapshot.terms || {})}
      ${hasContent(fields.optional_message) ? `<section class="section"><h2>Optional Message</h2><p>${escapeHtml(fields.optional_message)}</p></section>` : ""}
      ${hasContent(fields.delivery_notes) ? `<section class="section"><h2>Delivery / Pickup Notes</h2><p>${escapeHtml(fields.delivery_notes)}</p></section>` : ""}

      <section class="signature-area contract-signatures">
        <div><div class="signature-line"></div><p>Artist Signature</p><div class="signature-line"></div><p>Date</p></div>
        <div><div class="signature-line"></div><p>Client Signature</p><div class="signature-line"></div><p>Date</p></div>
      </section>
      <footer><p>DRAFT — NOT ISSUED — Contract terms are under review.</p></footer>`;
  }

  function readPreview(storage) {
    const serialized = storage.getItem(PREVIEW_STORAGE_KEY);
    if (!serialized) return null;
    try {
      const snapshot = JSON.parse(serialized);
      return snapshot.contract?.status === "draft" ? snapshot : null;
    } catch {
      return null;
    }
  }

  function createApp(documentObject, storage, printFunction) {
    const elements = {
      status: documentObject.querySelector("#contract-preview-status"),
      preview: documentObject.querySelector("#contract-preview"),
      print: documentObject.querySelector("#print-contract")
    };

    function load() {
      const snapshot = readPreview(storage);
      if (!snapshot) {
        elements.status.textContent = "No prepared draft contract is available.";
        elements.status.classList?.add("is-error");
        return null;
      }
      elements.preview.innerHTML = renderContractMarkup(snapshot);
      elements.preview.hidden = false;
      elements.status.textContent = "";
      return snapshot;
    }

    function bindEvents() {
      elements.print.addEventListener("click", () => printFunction());
    }

    return { bindEvents, load };
  }

  const api = {
    PREVIEW_STORAGE_KEY,
    createApp,
    readPreview,
    renderContractMarkup,
    renderTerms
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalObject.AdminContract = api;
  if (globalObject.document) {
    const app = createApp(globalObject.document, globalObject.sessionStorage, globalObject.print.bind(globalObject));
    app.bindEvents();
    app.load();
  }
})(typeof window !== "undefined" ? window : globalThis);
