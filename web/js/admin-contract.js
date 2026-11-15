(function initializeAdminContract(globalObject) {
  const PREPARE_API_PATH = "/admin/api/contracts/prepare";
  const numericIdPattern = /^[1-9][0-9]*$/;
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  const previewReferencePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

  function normalizeDocumentFields(fields = {}) {
    return {
      optional_message: String(fields.optional_message || "").trim(),
      delivery_notes: String(fields.delivery_notes || "").trim()
    };
  }

  function applyDocumentFields(snapshot, fields = {}) {
    const prepared = typeof structuredClone === "function"
      ? structuredClone(snapshot)
      : JSON.parse(JSON.stringify(snapshot));
    prepared.document_fields = normalizeDocumentFields(fields);
    return prepared;
  }

  function isValidDate(value) {
    if (!datePattern.test(value || "")) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }

  function parsePreviewRequest(search = "") {
    const params = new URLSearchParams(search);
    const allowedParams = new Set([
      "preview", "commission_id", "quotation_id", "contract_date", "draft_ref"
    ]);
    if ([...params.keys()].some((key) => !allowedParams.has(key))) return null;
    if (params.get("preview") !== "1") return null;
    for (const key of allowedParams) {
      if (params.getAll(key).length > 1) return null;
    }
    const commissionId = params.get("commission_id") || "";
    const quotationId = params.get("quotation_id") || "";
    const contractDate = params.get("contract_date") || "";
    const previewReference = params.get("draft_ref") || null;

    if (Boolean(commissionId) === Boolean(quotationId)) return null;
    if (commissionId && !numericIdPattern.test(commissionId)) return null;
    if (quotationId && !numericIdPattern.test(quotationId)) return null;
    if (!isValidDate(contractDate)) return null;
    if (previewReference && !previewReferencePattern.test(previewReference)) return null;

    const sourceQuery = quotationId
      ? `quotation_id=${encodeURIComponent(quotationId)}`
      : `commission_id=${encodeURIComponent(commissionId)}`;
    return {
      apiUrl: `${PREPARE_API_PATH}?${sourceQuery}&contract_date=${encodeURIComponent(contractDate)}`,
      commissionId: commissionId || null,
      quotationId: quotationId || null,
      contractDate,
      previewReference
    };
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

  async function fetchJson(fetchImplementation, url) {
    const response = await fetchImplementation(url);
    let body;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      throw new Error(body?.message || "The draft preview could not be prepared.");
    }
    return body;
  }

  function getPreviewReference(search = "") {
    const reference = new URLSearchParams(search).get("draft_ref") || null;
    return previewReferencePattern.test(reference || "") ? reference : null;
  }

  function consumeTransientFields(openerObject, reference) {
    if (!reference) return normalizeDocumentFields();
    try {
      return normalizeDocumentFields(
        openerObject?.AdminCreateContract?.consumePreviewFields?.(reference) || {}
      );
    } catch {
      return normalizeDocumentFields();
    }
  }

  function discardTransientFields(openerObject, reference) {
    if (!reference) return;
    try {
      openerObject?.AdminCreateContract?.discardPreviewFields?.(reference);
    } catch {
      // The opener may have navigated away or become inaccessible.
    }
  }

  function removePreviewReference(historyObject, locationObject) {
    const params = new URLSearchParams(locationObject?.search || "");
    if (!params.has("draft_ref")) return;
    params.delete("draft_ref");
    const query = params.toString();
    const path = locationObject?.pathname || "/admin/contract.html";
    historyObject?.replaceState?.(null, "", `${path}${query ? `?${query}` : ""}`);
  }

  function createApp(
    documentObject,
    fetchImplementation,
    locationObject = globalObject.location,
    historyObject = globalObject.history,
    openerObject = globalObject.opener,
    printFunction = globalObject.print?.bind(globalObject)
  ) {
    const elements = {
      status: documentObject.querySelector("#contract-preview-status"),
      preview: documentObject.querySelector("#contract-preview"),
      print: documentObject.querySelector("#print-contract")
    };

    async function load() {
      const previewReference = getPreviewReference(locationObject?.search);
      const request = parsePreviewRequest(locationObject?.search);
      if (!request) {
        discardTransientFields(openerObject, previewReference);
        removePreviewReference(historyObject, locationObject);
        elements.status.textContent = "No valid draft preview request is available.";
        elements.status.classList?.add("is-error");
        return null;
      }

      try {
        const body = await fetchJson(fetchImplementation, request.apiUrl);
        if (body.snapshot?.contract?.status !== "draft") {
          throw new Error("The server did not return a draft contract preview.");
        }
        const fields = consumeTransientFields(openerObject, request.previewReference);
        const snapshot = applyDocumentFields(body.snapshot, fields);
        elements.preview.innerHTML = renderContractMarkup(snapshot);
        elements.preview.hidden = false;
        elements.status.textContent = "";
        removePreviewReference(historyObject, locationObject);
        return snapshot;
      } catch (error) {
        discardTransientFields(openerObject, request.previewReference);
        removePreviewReference(historyObject, locationObject);
        elements.preview.innerHTML = "";
        elements.preview.hidden = true;
        elements.status.textContent = error.message;
        elements.status.classList?.add("is-error");
        return null;
      }
    }

    function bindEvents() {
      elements.print.addEventListener("click", () => printFunction());
    }

    return { bindEvents, load };
  }

  const api = {
    PREPARE_API_PATH,
    applyDocumentFields,
    consumeTransientFields,
    createApp,
    parsePreviewRequest,
    removePreviewReference,
    renderContractMarkup,
    renderTerms
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalObject.AdminContract = api;
  if (globalObject.document) {
    const app = createApp(
      globalObject.document,
      globalObject.fetch.bind(globalObject)
    );
    app.bindEvents();
    app.load();
  }
})(typeof window !== "undefined" ? window : globalThis);
