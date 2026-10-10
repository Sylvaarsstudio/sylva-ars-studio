(function initializeAdminDocuments(globalObject) {
  const API_PATH = "/admin/api/documents";
  const COMMISSIONS_API_PATH = "/admin/api/commissions";
  const documentTypeLabels = {
    receipt: "Receipt",
    invoice: "Invoice",
    contract: "Contract",
    coa: "COA"
  };

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function formatLabel(value) {
    return String(value)
      .replace(/_/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function formatDate(value) {
    if (!value) {
      return "";
    }

    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(new Date(value));
  }

  function describeDocument(document) {
    if (document.document_type === "receipt") {
      return document.payment?.payment_type === "deposit"
        ? "Deposit Receipt"
        : "Payment Receipt";
    }

    return {
      invoice: "Final Invoice — Paid in full",
      contract: "Contract",
      coa: "Certificate of Authenticity"
    }[document.document_type] || formatLabel(document.document_type);
  }

  function renderDocumentsMarkup(documents, emptyMessage = "No documents found.") {
    if (!documents.length) {
      return `<tr><td colspan="9" class="inquiry-empty">${escapeHtml(emptyMessage)}</td></tr>`;
    }

    return documents.map((document) => `
      <tr>
        <td>${escapeHtml(document.document_number)}</td>
        <td>${escapeHtml(documentTypeLabels[document.document_type] || formatLabel(document.document_type))}</td>
        <td>${escapeHtml(describeDocument(document))}</td>
        <td>v${escapeHtml(document.version)}</td>
        <td>${escapeHtml(document.commission.commission_number)} — ${escapeHtml(document.commission.title)}</td>
        <td>${escapeHtml(document.client.full_name)}</td>
        <td>${escapeHtml(formatDate(document.created_at))}</td>
        <td>${document.payment ? escapeHtml(formatLabel(document.payment.payment_type)) : "—"}</td>
        <td><a class="admin-text-link" href="${escapeHtml(document.file_location)}" target="_blank" rel="noopener">View</a></td>
      </tr>
    `).join("");
  }

  function renderCommissionOptions(commissions) {
    return '<option value="">All Commissions</option>' + commissions.map((commission) =>
      `<option value="${escapeHtml(commission.id)}">${escapeHtml(commission.commission_number)} — ${escapeHtml(commission.title)}</option>`
    ).join("");
  }

  function buildDocumentsUrl(commissionId, documentType) {
    const params = new URLSearchParams();

    if (commissionId) {
      params.set("commission_id", commissionId);
    }

    if (documentType) {
      params.set("document_type", documentType);
    }

    const query = params.toString();
    return query ? `${API_PATH}?${query}` : API_PATH;
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

  function createApp(documentObject, fetchImplementation) {
    const elements = {
      count: documentObject.querySelector("#document-count"),
      list: documentObject.querySelector("#document-list"),
      status: documentObject.querySelector("#document-list-status"),
      commissionFilter: documentObject.querySelector("#document-commission-filter"),
      typeFilter: documentObject.querySelector("#document-type-filter")
    };

    function renderDocuments(documents) {
      elements.list.innerHTML = renderDocumentsMarkup(documents);
      elements.count.textContent = String(documents.length);
    }

    async function loadCommissions() {
      try {
        const body = await fetchJson(fetchImplementation, COMMISSIONS_API_PATH);
        elements.commissionFilter.innerHTML = renderCommissionOptions(body.commissions || []);
        return body.commissions || [];
      } catch {
        elements.status.textContent = "Unable to load commissions.";
        elements.status.classList?.add("is-error");
        return [];
      }
    }

    async function loadDocuments() {
      elements.status.textContent = "Loading documents…";
      elements.status.classList?.remove("is-error");

      try {
        const body = await fetchJson(
          fetchImplementation,
          buildDocumentsUrl(elements.commissionFilter.value, elements.typeFilter.value)
        );
        renderDocuments(body.documents || []);
        elements.status.textContent = "";
        return body.documents || [];
      } catch {
        renderDocuments([]);
        elements.status.textContent = "Unable to load documents.";
        elements.status.classList?.add("is-error");
        return [];
      }
    }

    function bindEvents() {
      elements.commissionFilter.addEventListener("change", loadDocuments);
      elements.typeFilter.addEventListener("change", loadDocuments);
    }

    return {
      bindEvents,
      loadCommissions,
      loadDocuments
    };
  }

  const api = {
    API_PATH,
    COMMISSIONS_API_PATH,
    buildDocumentsUrl,
    createApp,
    describeDocument,
    documentTypeLabels,
    fetchJson,
    formatDate,
    renderCommissionOptions,
    renderDocumentsMarkup
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  globalObject.AdminDocuments = api;

  if (globalObject.document) {
    const app = createApp(globalObject.document, globalObject.fetch.bind(globalObject));
    app.bindEvents();
    app.loadCommissions();
    app.loadDocuments();
  }
})(typeof window !== "undefined" ? window : globalThis);
