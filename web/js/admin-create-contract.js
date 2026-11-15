(function initializeAdminCreateContract(globalObject) {
  const COMMISSIONS_API_PATH = "/admin/api/commissions";
  const PREPARE_API_PATH = "/admin/api/contracts/prepare";
  const ELIGIBILITY_API_PATH = "/admin/api/contracts/eligibility";
  const PREVIEW_PATH = "/admin/contract.html";
  const previewReferencePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const transientPreviewFields = new Map();

  function normalizeDocumentFields(fields = {}) {
    return {
      optional_message: String(fields.optional_message || "").trim(),
      delivery_notes: String(fields.delivery_notes || "").trim()
    };
  }

  function createPreviewReference(cryptoObject = globalObject.crypto) {
    const reference = cryptoObject?.randomUUID?.();
    if (!previewReferencePattern.test(reference || "")) {
      throw new Error("A secure preview reference could not be created.");
    }
    return reference.toLowerCase();
  }

  function buildPreviewUrl({ commissionId, quotationId, contractDate, previewReference } = {}) {
    const params = new URLSearchParams({ preview: "1" });
    if (quotationId) params.set("quotation_id", String(quotationId));
    else if (commissionId) params.set("commission_id", String(commissionId));
    if (contractDate) params.set("contract_date", String(contractDate));
    if (previewReference) params.set("draft_ref", String(previewReference));
    return `${PREVIEW_PATH}?${params}`;
  }

  function consumePreviewFields(reference) {
    if (!previewReferencePattern.test(reference || "")) return null;
    const context = transientPreviewFields.get(reference);
    if (!context) return null;
    transientPreviewFields.delete(reference);
    const fields = normalizeDocumentFields(context.fields);
    context.cleanup?.();
    return fields;
  }

  function discardPreviewFields(reference) {
    if (!previewReferencePattern.test(reference || "")) return false;
    const context = transientPreviewFields.get(reference);
    if (!context) return false;
    transientPreviewFields.delete(reference);
    context.cleanup?.();
    return true;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function formatCurrency(value) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD"
    }).format(Number(value || 0));
  }

  function getNewYorkDate(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
    const values = Object.fromEntries(
      parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value])
    );
    return `${values.year}-${values.month}-${values.day}`;
  }

  function renderCommissionOptions(commissions, eligibilityById = new Map()) {
    return '<option value="">Select an eligible commission</option>'
      + commissions.map((commission) => {
        const eligibility = eligibilityById.get(String(commission.id));
        const suffix = eligibility?.eligible ? "" : " — Accepted Quotation required";
        return `<option value="${escapeHtml(commission.id)}"${eligibility?.eligible ? "" : " disabled"}>${escapeHtml(commission.commission_number)} — ${escapeHtml(commission.title)}${escapeHtml(suffix)}</option>`;
      }
      ).join("");
  }

  function applyDocumentFields(snapshot, fields) {
    const prepared = typeof structuredClone === "function"
      ? structuredClone(snapshot)
      : JSON.parse(JSON.stringify(snapshot));
    prepared.document_fields = normalizeDocumentFields(fields);
    return prepared;
  }

  function renderPreparationSummary(snapshot) {
    const commission = snapshot.commission || {};
    const quotation = snapshot.quotation || {};
    const artwork = snapshot.artwork || commission;
    const client = snapshot.client || {};
    const financial = snapshot.commercial || snapshot.commercial_terms || snapshot.financial || {};
    const sections = Object.values(snapshot.terms?.sections || {});

    return `
      <div class="admin-detail-card">
        <p><strong>DRAFT — NOT ISSUED</strong></p>
        <h2>${escapeHtml(artwork.title || "")}</h2>
        ${commission.commission_number || commission.number ? `<p><strong>Commission:</strong> ${escapeHtml(commission.commission_number || commission.number)}</p>` : ""}
        <p><strong>Based on Accepted Quotation:</strong> ${escapeHtml(quotation.quotation_number || "")} · v${escapeHtml(quotation.quotation_version || "")}</p>
        <p><strong>Accepted At:</strong> ${escapeHtml(quotation.quotation_accepted_at ? new Date(quotation.quotation_accepted_at).toLocaleString() : "")}</p>
        <p><strong>Client:</strong> ${escapeHtml(client.full_name || client.name || "")}</p>
        <p><strong>Artwork Price:</strong> ${escapeHtml(formatCurrency(financial.price))}</p>
        <p><strong>Sales Tax:</strong> ${escapeHtml(formatCurrency(financial.sales_tax))}</p>
        <p><strong>Shipping:</strong> ${escapeHtml(formatCurrency(financial.shipping_charge ?? financial.shipping))}</p>
        <p><strong>Total:</strong> ${escapeHtml(formatCurrency(financial.total))}</p>
        <p><strong>Required Deposit (50%):</strong> ${escapeHtml(formatCurrency(financial.required_deposit))}</p>
        <p><strong>Estimated Remaining After Required Deposit:</strong> ${escapeHtml(formatCurrency(financial.estimated_remaining_after_required_deposit))}</p>
        ${financial.special_terms ? `<p><strong>Accepted Special Terms:</strong> ${escapeHtml(financial.special_terms)}</p>` : ""}
        <h3>Draft contractual sections</h3>
        <ul>${sections.map((section) => `<li>${escapeHtml(section.title)}</li>`).join("")}</ul>
        <p><strong>Contract terms are still under review. Contract issuance is not yet enabled.</strong></p>
      </div>`;
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
      throw new Error(body?.message || "The admin request could not be completed.");
    }
    return body;
  }

  function createApp(
    documentObject,
    fetchImplementation,
    locationObject = globalObject.location,
    openWindow = globalObject.open?.bind(globalObject),
    lifecycleObject = globalObject
  ) {
    const elements = {
      form: documentObject.querySelector("#prepare-contract-form"),
      status: documentObject.querySelector("#contract-preparation-status"),
      summary: documentObject.querySelector("#contract-preparation-summary"),
      preview: documentObject.querySelector("#open-contract-preview"),
      eligibilityStatus: documentObject.querySelector("#contract-eligibility-status"),
      quotationField: documentObject.querySelector("#contract-source-quotation-field"),
      legacyField: documentObject.querySelector("#legacy-contract-commission-field")
    };
    const inputs = elements.form.elements;
    const eligibilityById = new Map();
    const activeReferences = new Set();
    let preparedContext = null;

    function clearPreparedContext({ clearFields = false } = {}) {
      for (const reference of activeReferences) transientPreviewFields.delete(reference);
      activeReferences.clear();
      preparedContext = null;
      elements.preview.hidden = true;
      elements.preview.removeAttribute?.("href");
      if (clearFields) {
        inputs.namedItem("optional_message").value = "";
        inputs.namedItem("delivery_notes").value = "";
      }
    }

    function markPreparedContextConsumed() {
      clearPreparedContext({ clearFields: true });
    }

    async function loadCommissions() {
      const params = new URLSearchParams(locationObject?.search || "");
      const requestedQuotationId = params.get("quotation_id");
      if (requestedQuotationId) {
        try {
          const eligibility = await fetchJson(
            fetchImplementation,
            `${ELIGIBILITY_API_PATH}?quotation_id=${encodeURIComponent(requestedQuotationId)}`
          );
          inputs.namedItem("quotation_id").value = requestedQuotationId;
          inputs.namedItem("quotation_reference").value = `${eligibility.quotation.quotation_number} · v${eligibility.quotation.version}`;
          inputs.namedItem("commission_id").value = "";
          elements.eligibilityStatus.textContent = eligibility.message;
          elements.quotationField.hidden = false;
          elements.legacyField.hidden = true;
          return [eligibility.quotation];
        } catch (error) {
          elements.status.textContent = error.message;
          elements.status.classList?.add("is-error");
          return [];
        }
      }

      try {
        const body = await fetchJson(fetchImplementation, COMMISSIONS_API_PATH);
        const commissions = body.commissions || [];
        await Promise.all(commissions.map(async (commission) => {
          try {
            const eligibility = await fetchJson(
              fetchImplementation,
              `${ELIGIBILITY_API_PATH}?commission_id=${encodeURIComponent(commission.id)}`
            );
            eligibilityById.set(String(commission.id), eligibility);
          } catch (error) {
            eligibilityById.set(String(commission.id), { eligible: false, message: error.message });
          }
        }));
        inputs.namedItem("commission_id").innerHTML = renderCommissionOptions(commissions, eligibilityById);
        elements.quotationField.hidden = true;
        elements.legacyField.hidden = false;
        const requestedCommissionId = new URLSearchParams(locationObject?.search || "").get("commission_id");
        if (requestedCommissionId && eligibilityById.get(requestedCommissionId)?.eligible) {
          inputs.namedItem("commission_id").value = requestedCommissionId;
          elements.eligibilityStatus.textContent = eligibilityById.get(requestedCommissionId).message;
        }
        return commissions;
      } catch (error) {
        elements.status.textContent = error.message;
        elements.status.classList?.add("is-error");
        return [];
      }
    }

    async function prepare(event) {
      event?.preventDefault?.();
      clearPreparedContext();
      elements.status.textContent = "Preparing draft preview…";
      elements.status.classList?.remove("is-error");
      elements.preview.hidden = true;
      const commissionId = inputs.namedItem("commission_id").value;
      const quotationId = inputs.namedItem("quotation_id").value;
      const contractDate = inputs.namedItem("contract_date").value;
      const sourceQuery = quotationId
        ? `quotation_id=${encodeURIComponent(quotationId)}`
        : `commission_id=${encodeURIComponent(commissionId)}`;
      const url = `${PREPARE_API_PATH}?${sourceQuery}&contract_date=${encodeURIComponent(contractDate)}`;

      try {
        const body = await fetchJson(fetchImplementation, url);
        const documentFields = normalizeDocumentFields({
          optional_message: inputs.namedItem("optional_message").value,
          delivery_notes: inputs.namedItem("delivery_notes").value
        });
        const snapshot = applyDocumentFields(body.snapshot, documentFields);
        preparedContext = {
          commissionId: commissionId || null,
          quotationId: quotationId || null,
          contractDate,
          documentFields
        };
        elements.preview.href = buildPreviewUrl(preparedContext);
        elements.summary.innerHTML = renderPreparationSummary(snapshot);
        elements.status.textContent = body.message;
        elements.preview.hidden = false;
        return snapshot;
      } catch (error) {
        elements.summary.innerHTML = "";
        elements.status.textContent = error.message;
        elements.status.classList?.add("is-error");
        return null;
      }
    }

    function openPreview(event) {
      event?.preventDefault?.();
      if (!preparedContext) return null;

      let reference;
      try {
        reference = createPreviewReference();
      } catch (error) {
        elements.status.textContent = error.message;
        elements.status.classList?.add("is-error");
        return null;
      }

      activeReferences.add(reference);
      transientPreviewFields.set(reference, {
        fields: preparedContext.documentFields,
        cleanup: markPreparedContextConsumed
      });
      const previewUrl = buildPreviewUrl({
        ...preparedContext,
        previewReference: reference
      });
      const openedWindow = openWindow?.(previewUrl, "_blank");
      if (!openedWindow) {
        transientPreviewFields.delete(reference);
        activeReferences.delete(reference);
        elements.status.textContent = "The draft preview window was blocked. Allow pop-ups and try again.";
        elements.status.classList?.add("is-error");
        return null;
      }
      return { previewUrl, reference };
    }

    function bindEvents() {
      elements.form.addEventListener("submit", prepare);
      elements.form.addEventListener("input", () => {
        if (preparedContext) clearPreparedContext();
      });
      elements.preview.addEventListener("click", openPreview);
      inputs.namedItem("commission_id").addEventListener("change", () => {
        const eligibility = eligibilityById.get(String(inputs.namedItem("commission_id").value || ""));
        elements.eligibilityStatus.textContent = eligibility?.message || "An accepted Quotation is required.";
      });
      lifecycleObject?.addEventListener?.("pagehide", () => {
        clearPreparedContext({ clearFields: true });
      });
      for (const logoutLink of documentObject.querySelectorAll?.(
        'a[href="/admin-logout"], a[href="/admin/logout"]'
      ) || []) {
        logoutLink.addEventListener("click", () => {
          clearPreparedContext({ clearFields: true });
        });
      }
    }

    inputs.namedItem("contract_date").value = getNewYorkDate();
    return { bindEvents, clearPreparedContext, loadCommissions, openPreview, prepare };
  }

  const api = {
    COMMISSIONS_API_PATH,
    ELIGIBILITY_API_PATH,
    PREPARE_API_PATH,
    applyDocumentFields,
    buildPreviewUrl,
    consumePreviewFields,
    createApp,
    createPreviewReference,
    discardPreviewFields,
    getNewYorkDate,
    normalizeDocumentFields,
    renderCommissionOptions,
    renderPreparationSummary
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  globalObject.AdminCreateContract = api;

  if (globalObject.document) {
    const app = createApp(
      globalObject.document,
      globalObject.fetch.bind(globalObject)
    );
    app.bindEvents();
    app.loadCommissions();
  }
})(typeof window !== "undefined" ? window : globalThis);
