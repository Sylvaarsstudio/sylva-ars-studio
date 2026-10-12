(function initializeAdminCreateContract(globalObject) {
  const COMMISSIONS_API_PATH = "/admin/api/commissions";
  const PREPARE_API_PATH = "/admin/api/contracts/prepare";
  const ELIGIBILITY_API_PATH = "/admin/api/contracts/eligibility";
  const PREVIEW_STORAGE_KEY = "sylvaArsDraftContractPreview";

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
    prepared.document_fields = {
      optional_message: String(fields.optional_message || "").trim(),
      delivery_notes: String(fields.delivery_notes || "").trim()
    };
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

  function createApp(documentObject, fetchImplementation, storage, locationObject = globalObject.location) {
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
        const snapshot = applyDocumentFields(body.snapshot, {
          optional_message: inputs.namedItem("optional_message").value,
          delivery_notes: inputs.namedItem("delivery_notes").value
        });
        storage.setItem(PREVIEW_STORAGE_KEY, JSON.stringify(snapshot));
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

    function bindEvents() {
      elements.form.addEventListener("submit", prepare);
      inputs.namedItem("commission_id").addEventListener("change", () => {
        const eligibility = eligibilityById.get(String(inputs.namedItem("commission_id").value || ""));
        elements.eligibilityStatus.textContent = eligibility?.message || "An accepted Quotation is required.";
      });
    }

    inputs.namedItem("contract_date").value = getNewYorkDate();
    return { bindEvents, loadCommissions, prepare };
  }

  const api = {
    COMMISSIONS_API_PATH,
    ELIGIBILITY_API_PATH,
    PREPARE_API_PATH,
    PREVIEW_STORAGE_KEY,
    applyDocumentFields,
    createApp,
    getNewYorkDate,
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
      globalObject.fetch.bind(globalObject),
      globalObject.sessionStorage
    );
    app.bindEvents();
    app.loadCommissions();
  }
})(typeof window !== "undefined" ? window : globalThis);
