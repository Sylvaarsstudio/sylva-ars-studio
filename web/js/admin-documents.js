(function initializeAdminDocuments(globalObject) {
  const API_PATH = "/admin/api/documents";
  const COMMISSIONS_API_PATH = "/admin/api/commissions";
  const LEGAL_TEMPLATES_API_PATH = "/admin/api/legal-templates";
  const LEGACY_INVENTORY_API_PATH = `${LEGAL_TEMPLATES_API_PATH}/inventory`;
  const documentTypeLabels = {
    receipt: "Receipt",
    invoice: "Invoice",
    contract: "Contract",
    quotation: "Quotation",
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

    if (document.document_type === "contract") {
      return {
        commission_agreement: "Commission Agreement",
        artwork_sales_agreement: "Artwork Sales Agreement"
      }[document.contract_subtype] || "Contract";
    }

    if (document.document_type === "quotation") {
      return `Quotation — Version ${document.version}`;
    }

    return {
      invoice: "Final Invoice — Paid in full",
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

  function renderStatusBadges(values) {
    if (!values?.length) return '<span class="legal-status-badge">Inventory Ready</span>';
    return `<span class="legal-template-badges">${values.map((value) =>
      `<span class="legal-status-badge${value === "Source Conflict" ? " is-warning" : ""}">${escapeHtml(value)}</span>`
    ).join("")}</span>`;
  }

  function renderLegalTemplatesMarkup(templates, emptyMessage = "No Legal Templates imported.") {
    if (!templates.length) {
      return `<tr><td colspan="8" class="inquiry-empty">${escapeHtml(emptyMessage)}</td></tr>`;
    }

    return templates.map((template) => `
      <tr>
        <td><strong>${escapeHtml(template.name)}</strong><br><span class="legal-template-key">${escapeHtml(template.template_key)}</span></td>
        <td>${escapeHtml(formatLabel(template.template_kind))}</td>
        <td>${template.effective_version ? `v${escapeHtml(template.effective_version.version_number)}` : "None"}</td>
        <td>${template.latest_draft
          ? `v${escapeHtml(template.latest_draft.version_number)} — ${escapeHtml(template.latest_draft.version_label || "Draft")}<br>${renderStatusBadges(["Draft", formatLabel(template.latest_draft.source_role || "legacy_source")])}`
          : "None"}</td>
        <td>${escapeHtml(template.version_count)}</td>
        <td>${escapeHtml(formatLabel(template.publication_state))}</td>
        <td>${renderStatusBadges(template.warnings)}</td>
        <td><button type="button" class="admin-text-button" data-template-id="${escapeHtml(template.id)}">Inspect</button></td>
      </tr>
    `).join("");
  }

  function structuralSummaryText(summary) {
    if (!summary) return "Not recorded";
    const parts = [];
    if (summary.section_count !== undefined) parts.push(`${summary.section_count} sections`);
    if (summary.heading_count !== undefined) parts.push(`${summary.heading_count} headings`);
    if (summary.data_field_count !== undefined) parts.push(`${summary.data_field_count} data fields`);
    if (summary.declared_status) parts.push(`declared ${summary.declared_status}`);
    if (summary.declared_version) parts.push(summary.declared_version);
    return parts.join(" · ") || "Recorded";
  }

  function renderVersionHistoryMarkup(versions) {
    if (!versions.length) {
      return '<tr><td colspan="11" class="inquiry-empty">No versions imported.</td></tr>';
    }
    return versions.map((version) => `
      <tr>
        <td>v${escapeHtml(version.version_number)}<br>${escapeHtml(version.version_label || "")}</td>
        <td>${renderStatusBadges([formatLabel(version.state)])}</td>
        <td>${renderStatusBadges([formatLabel(version.source_role || "legacy_source")])}</td>
        <td>${escapeHtml(version.source_label || "")}</td>
        <td>${escapeHtml(version.source_type || "")}</td>
        <td>${escapeHtml(version.source_path || "")}</td>
        <td>${escapeHtml(formatLabel(version.current_usage || "not_recorded"))}</td>
        <td class="legal-hash"><code>${escapeHtml(version.content_hash || "")}</code></td>
        <td>${escapeHtml(structuralSummaryText(version.structural_summary))}</td>
        <td>${escapeHtml(version.legal_review_notes || "No review note recorded.")}</td>
        <td>${escapeHtml(formatDate(version.created_at))}</td>
      </tr>
    `).join("");
  }

  function renderAuditHistoryMarkup(events) {
    if (!events.length) {
      return '<tr><td colspan="4" class="inquiry-empty">No audit events recorded.</td></tr>';
    }
    return events.map((event) => `
      <tr>
        <td>${escapeHtml(formatLabel(event.event_type))}</td>
        <td>${event.template_version_id ? escapeHtml(event.event_context?.source_identity || `Version ${event.template_version_id}`) : "Template"}</td>
        <td>${escapeHtml(event.content_hash || "—")}</td>
        <td>${escapeHtml(formatDate(event.occurred_at))}</td>
      </tr>
    `).join("");
  }

  function renderDocumentProvenanceMarkup(documents, emptyMessage) {
    if (!documents.length) return `<p class="legal-empty">${escapeHtml(emptyMessage)}</p>`;
    return `<ul class="legal-source-list">${documents.map((document) =>
      `<li><a class="admin-text-link" href="${escapeHtml(document.file_location)}" target="_blank" rel="noopener">${escapeHtml(document.document_number)}</a> — ${escapeHtml(formatLabel(document.provenance_status))}</li>`
    ).join("")}</ul>`;
  }

  function renderLegalTemplateDetailMarkup(template) {
    const comparison = template.versions.find((version) => version.comparison)?.comparison;
    const comparisonWarning = comparison?.warning || "No source comparison warning recorded.";
    return `
      <header class="legal-template-detail-header">
        <div>
          <p class="legal-template-key">${escapeHtml(template.template_key)}</p>
          <h3>${escapeHtml(template.name)}</h3>
          <p>${escapeHtml(template.description || "")}</p>
        </div>
        ${renderStatusBadges(template.warnings)}
      </header>

      <dl class="legal-template-summary-grid">
        <div><dt>Kind</dt><dd>${escapeHtml(formatLabel(template.template_kind))}</dd></div>
        <div><dt>Lifecycle</dt><dd>${escapeHtml(formatLabel(template.lifecycle_status))}</dd></div>
        <div><dt>Approved versions</dt><dd>${escapeHtml(template.approved_version_count)}</dd></div>
        <div><dt>Effective version</dt><dd>${template.effective_version ? `v${escapeHtml(template.effective_version.version_number)}` : "None"}</dd></div>
        <div><dt>Publication</dt><dd>${escapeHtml(formatLabel(template.publication_state))}</dd></div>
        <div><dt>Contract issuance</dt><dd>${template.template_key === "commission-agreement" ? (template.contract_issuance_locked ? "Locked" : "Not locked by draft terms") : "Not applicable"}</dd></div>
      </dl>

      <p class="legal-warning"><strong>Comparison status:</strong> ${escapeHtml(formatLabel(comparison?.equivalence_status || "not_recorded"))}. ${escapeHtml(comparisonWarning)}</p>

      <h4>Version history</h4>
      <div class="inquiry-table-wrap">
        <table class="inquiry-table">
          <thead><tr><th>Version</th><th>State</th><th>Role</th><th>Source</th><th>Source Type</th><th>Source Path</th><th>Current Usage</th><th>SHA-256</th><th>Structure</th><th>Review Notes</th><th>Imported</th></tr></thead>
          <tbody>${renderVersionHistoryMarkup(template.versions)}</tbody>
        </table>
      </div>

      <div class="legal-provenance-grid">
        <section>
          <h4>Proven related documents</h4>
          ${renderDocumentProvenanceMarkup(template.related_documents, "No issued Document has proven governed-template provenance.")}
        </section>
        <section>
          <h4>Legacy unmapped Documents</h4>
          ${renderDocumentProvenanceMarkup(template.legacy_unmapped_documents, "No matching legacy Contract snapshots were found.")}
        </section>
      </div>

      <h4>Import audit history</h4>
      <div class="inquiry-table-wrap">
        <table class="inquiry-table">
          <thead><tr><th>Event</th><th>Source / Version</th><th>Hash</th><th>Occurred</th></tr></thead>
          <tbody>${renderAuditHistoryMarkup(template.audit_events)}</tbody>
        </table>
      </div>
    `;
  }

  function renderLegacyInventoryMarkup(sources) {
    if (!sources.length) {
      return '<tr><td colspan="5" class="inquiry-empty">No operational sources inventoried.</td></tr>';
    }
    return sources.map((source) => `
      <tr>
        <td>${escapeHtml(source.name)}</td>
        <td>${escapeHtml(formatLabel(source.source_type))}<br>${renderStatusBadges([formatLabel(source.governance_status)])}</td>
        <td>${escapeHtml(source.source_path)}</td>
        <td class="legal-hash"><code>${escapeHtml(source.source_hash)}</code></td>
        <td>${escapeHtml(source.treatment)}</td>
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
      typeFilter: documentObject.querySelector("#document-type-filter"),
      issuedTab: documentObject.querySelector("#issued-documents-tab"),
      legalTab: documentObject.querySelector("#legal-templates-tab"),
      issuedView: documentObject.querySelector("#issued-documents-view"),
      legalView: documentObject.querySelector("#legal-templates-view"),
      legalCount: documentObject.querySelector("#legal-template-count"),
      legalList: documentObject.querySelector("#legal-template-list"),
      legalStatus: documentObject.querySelector("#legal-template-list-status"),
      legalDetail: documentObject.querySelector("#legal-template-detail"),
      legalDetailStatus: documentObject.querySelector("#legal-template-detail-status"),
      legalDetailContent: documentObject.querySelector("#legal-template-detail-content"),
      inventoryList: documentObject.querySelector("#legacy-inventory-list"),
      inventoryStatus: documentObject.querySelector("#legacy-inventory-status")
    };
    let legalRegistryLoaded = false;

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

    async function loadLegalTemplates() {
      elements.legalStatus.textContent = "Loading Legal Templates…";
      elements.legalStatus.classList?.remove("is-error");
      try {
        const body = await fetchJson(fetchImplementation, LEGAL_TEMPLATES_API_PATH);
        const templates = body.templates || [];
        elements.legalList.innerHTML = renderLegalTemplatesMarkup(templates);
        elements.legalCount.textContent = String(templates.length);
        elements.legalStatus.textContent = "Read-only registry. No approval, effectivity, publication, or editing actions are available.";
        return templates;
      } catch {
        elements.legalList.innerHTML = renderLegalTemplatesMarkup([]);
        elements.legalCount.textContent = "0";
        elements.legalStatus.textContent = "Unable to load Legal Templates.";
        elements.legalStatus.classList?.add("is-error");
        return [];
      }
    }

    async function loadLegacyInventory() {
      elements.inventoryStatus.textContent = "Loading operational inventory…";
      elements.inventoryStatus.classList?.remove("is-error");
      try {
        const body = await fetchJson(fetchImplementation, LEGACY_INVENTORY_API_PATH);
        elements.inventoryList.innerHTML = renderLegacyInventoryMarkup(body.sources || []);
        elements.inventoryStatus.textContent = "";
        return body.sources || [];
      } catch {
        elements.inventoryList.innerHTML = renderLegacyInventoryMarkup([]);
        elements.inventoryStatus.textContent = "Unable to load operational source inventory.";
        elements.inventoryStatus.classList?.add("is-error");
        return [];
      }
    }

    async function loadTemplateDetail(templateId) {
      elements.legalDetail.hidden = false;
      elements.legalDetailStatus.textContent = "Loading template history…";
      elements.legalDetailStatus.classList?.remove("is-error");
      elements.legalDetailContent.innerHTML = "";
      try {
        const body = await fetchJson(fetchImplementation, `${LEGAL_TEMPLATES_API_PATH}/${templateId}`);
        elements.legalDetailContent.innerHTML = renderLegalTemplateDetailMarkup(body.template);
        elements.legalDetailStatus.textContent = "";
        return body.template;
      } catch {
        elements.legalDetailStatus.textContent = "Unable to load this Legal Template.";
        elements.legalDetailStatus.classList?.add("is-error");
        return null;
      }
    }

    function showIssuedDocuments() {
      elements.issuedView.hidden = false;
      elements.legalView.hidden = true;
      elements.issuedTab.setAttribute("aria-selected", "true");
      elements.legalTab.setAttribute("aria-selected", "false");
    }

    async function showLegalTemplates() {
      elements.issuedView.hidden = true;
      elements.legalView.hidden = false;
      elements.issuedTab.setAttribute("aria-selected", "false");
      elements.legalTab.setAttribute("aria-selected", "true");
      if (!legalRegistryLoaded) {
        legalRegistryLoaded = true;
        await Promise.all([loadLegalTemplates(), loadLegacyInventory()]);
      }
    }

    function bindEvents() {
      elements.commissionFilter.addEventListener("change", loadDocuments);
      elements.typeFilter.addEventListener("change", loadDocuments);
      elements.issuedTab.addEventListener("click", showIssuedDocuments);
      elements.legalTab.addEventListener("click", showLegalTemplates);
      elements.legalList.addEventListener("click", (event) => {
        const trigger = event.target.closest?.("[data-template-id]");
        if (trigger) loadTemplateDetail(trigger.dataset.templateId);
      });
    }

    return {
      bindEvents,
      loadCommissions,
      loadDocuments,
      loadLegacyInventory,
      loadLegalTemplates,
      loadTemplateDetail,
      showIssuedDocuments,
      showLegalTemplates
    };
  }

  const api = {
    API_PATH,
    COMMISSIONS_API_PATH,
    LEGACY_INVENTORY_API_PATH,
    LEGAL_TEMPLATES_API_PATH,
    buildDocumentsUrl,
    createApp,
    describeDocument,
    documentTypeLabels,
    fetchJson,
    formatDate,
    renderAuditHistoryMarkup,
    renderCommissionOptions,
    renderDocumentsMarkup,
    renderLegacyInventoryMarkup,
    renderLegalTemplateDetailMarkup,
    renderLegalTemplatesMarkup,
    renderStatusBadges,
    renderVersionHistoryMarkup
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
