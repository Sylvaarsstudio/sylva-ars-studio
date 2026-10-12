(function initializeAdminCommunications(globalObject) {
  const API_PATH = "/admin/api/communications";
  const communicationTypes = [
    "general", "inquiry_reply", "quotation", "contract", "payment_request",
    "receipt", "final_invoice", "final_presentation", "delivery",
    "storage_notice", "final_storage_notice", "thank_you", "manual_note"
  ];

  function escapeHtml(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }

  function formatLabel(value) {
    return String(value || "").replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function formatStatus(value, item = {}) {
    if (value === "ready" && item.automation_mode === "auto_send") {
      return "Ready — Automatic send pending provider configuration";
    }
    if (value === "ready") return "Reviewed / Ready";
    if (value === "queued" && item.reconciliation_status === "inconclusive") return "Manual Review Required";
    if (value === "queued" && item.reconciliation_required) return "Reconciliation Required";
    if (value === "queued") return "Sending / Processing";
    return formatLabel(value);
  }

  function describeAutomation(item) {
    if (!item.automation_key) return null;
    const labels = {
      inquiry_received_confirmation: "Inquiry Confirmation",
      quotation_acceptance_confirmation: "Quotation Acceptance Confirmation",
      receipt_delivery: "Receipt Delivery",
      final_invoice_delivery: "Final Invoice Delivery"
    };
    return `Automated · ${labels[item.automation_key] || formatLabel(item.automation_key)}`;
  }

  function formatDate(value) {
    return value
      ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
      : "—";
  }

  function renderTypeOptions(selected = "general") {
    return communicationTypes.map((type) => `<option value="${type}"${type === selected ? " selected" : ""}>${escapeHtml(formatLabel(type))}</option>`).join("");
  }

  function renderTemplateOptions(templates, selected = "") {
    return `<option value="">Select one</option>${templates.map((item) =>
      `<option value="${escapeHtml(item.key)}"${item.key === selected ? " selected" : ""}>${escapeHtml(item.name)} · v${escapeHtml(item.version)}</option>`
    ).join("")}`;
  }

  function describeRelationship(item) {
    const relationships = [];
    if (item.commission_id) relationships.push(item.commission_number || `Commission #${item.commission_id}`);
    if (item.inquiry_id) relationships.push(`Inquiry ${item.inquiry_id}`);
    if (!relationships.length && item.client_id) relationships.push(`Client #${item.client_id}`);
    if (!relationships.length && item.quotation_id) relationships.push(item.quotation_number || `Quotation #${item.quotation_id}`);
    if (!relationships.length && item.document_id) relationships.push(item.document_number || `Document #${item.document_id}`);
    return relationships.join(" · ") || "—";
  }

  function renderListMarkup(items) {
    if (!items.length) return '<tr><td colspan="7" class="inquiry-empty">No communications found.</td></tr>';
    return items.map((item) => `<tr>
      <td>${escapeHtml(formatDate(item.created_at))}</td>
      <td>${escapeHtml(item.recipient)}</td>
      <td>${escapeHtml(describeAutomation(item) || formatLabel(item.communication_type))}</td>
      <td>${escapeHtml(formatLabel(item.channel))}</td>
      <td><span class="inquiry-status" data-communication-status="${escapeHtml(item.communication_status)}">${escapeHtml(formatStatus(item.communication_status, item))}</span></td>
      <td>${escapeHtml(describeRelationship(item))}</td>
      <td><button type="button" class="admin-text-button" data-communication-id="${escapeHtml(item.id)}">View</button></td>
    </tr>`).join("");
  }

  function renderDetailMarkup(item) {
    const fields = [
      ["Status", formatStatus(item.communication_status, item)], ["Channel", formatLabel(item.channel)],
      ["Type", formatLabel(item.communication_type)], ["Recipient Snapshot", item.recipient],
      ["Automation", describeAutomation(item)],
      ["Subject", item.subject], ["Template", item.template_key ? `${formatLabel(item.template_key)} · v${item.template_version}` : null],
      ["Related", describeRelationship(item)], ["Created", formatDate(item.created_at)],
      ["Ready", item.ready_at ? formatDate(item.ready_at) : null],
      ["Queued", item.queued_at ? formatDate(item.queued_at) : null],
      ["Sent", item.sent_at ? formatDate(item.sent_at) : null],
      ["Failed", item.failed_at ? formatDate(item.failed_at) : null],
      ["Error Code", item.error_code || null],
      ["Reconciliation Result", item.reconciliation_status ? formatLabel(item.reconciliation_status) : null],
      ["Reconciled", item.reconciled_at ? formatDate(item.reconciled_at) : null],
      ["Reconciliation Note", item.reconciliation_note ? formatLabel(item.reconciliation_note) : null]
    ].filter(([, value]) => value !== null && value !== undefined && value !== "");
    return `<dl class="inquiry-detail-list">${fields.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>
      <section><h3>Body Snapshot</h3><p class="communication-body-snapshot">${escapeHtml(item.body_snapshot).replace(/\n/g, "<br>")}</p></section>`;
  }

  function renderTemplatePreview(preview) {
    if (!preview.complete) {
      return `<p><strong>Context incomplete.</strong></p><p>Missing: ${escapeHtml((preview.missing_context || []).join(", "))}</p>`;
    }
    return `<dl class="inquiry-detail-list">
      <div><dt>Template</dt><dd>${escapeHtml(formatLabel(preview.template))} · v${escapeHtml(preview.version)}</dd></div>
      <div><dt>Recipient</dt><dd>${escapeHtml(preview.recipient)}</dd></div>
      <div><dt>Subject</dt><dd>${escapeHtml(preview.subject)}</dd></div>
    </dl><h3>Plain-text Preview</h3><p class="communication-body-snapshot">${escapeHtml(preview.body).replace(/\n/g, "<br>")}</p>`;
  }

  function formValue(form, name) {
    return form.elements.namedItem(name)?.value?.trim() || null;
  }

  function buildPayload(form, requestId, manual) {
    return {
      channel: manual ? "manual" : formValue(form, "channel"),
      communication_type: formValue(form, "communication_type"),
      recipient: formValue(form, "recipient"), subject: formValue(form, "subject"),
      body_snapshot: formValue(form, "body_snapshot"),
      commission_id: formValue(form, "commission_id"), client_id: formValue(form, "client_id"),
      inquiry_id: formValue(form, "inquiry_id"), quotation_id: formValue(form, "quotation_id"),
      document_id: formValue(form, "document_id"), request_id: requestId
    };
  }

  function buildTemplatePayload(form, requestId) {
    const payload = {
      template_key: formValue(form, "template_key"),
      commission_id: formValue(form, "commission_id"),
      inquiry_id: formValue(form, "inquiry_id"),
      quotation_id: formValue(form, "quotation_id"),
      document_id: formValue(form, "document_id")
    };
    if (requestId !== undefined) payload.request_id = requestId;
    return payload;
  }

  async function fetchJson(fetchImplementation, url, options) {
    const response = await fetchImplementation(url, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.message || body.code || "Request failed.");
      error.body = body;
      throw error;
    }
    return body;
  }

  function createApp(
    documentObject,
    fetchImplementation,
    uuidFactory = () => globalObject.crypto.randomUUID(),
    locationObject = globalObject.location,
    confirmImplementation = globalObject.confirm?.bind(globalObject) || (() => false)
  ) {
    const elements = {
      count: documentObject.querySelector("#communication-count"), list: documentObject.querySelector("#communications-list"),
      listPanel: documentObject.querySelector("#communications-list-panel"), status: documentObject.querySelector("#communications-status"),
      statusFilter: documentObject.querySelector("#communication-status-filter"), typeFilter: documentObject.querySelector("#communication-type-filter"),
      channelFilter: documentObject.querySelector("#communication-channel-filter"), newDraft: documentObject.querySelector("#new-draft"),
      newFromTemplate: documentObject.querySelector("#new-from-template"), recordManual: documentObject.querySelector("#record-manual"),
      detail: documentObject.querySelector("#communication-detail"), detailFields: documentObject.querySelector("#communication-detail-fields"),
      closeDetail: documentObject.querySelector("#close-communication-detail"), markReady: documentObject.querySelector("#mark-communication-ready"),
      send: documentObject.querySelector("#send-communication"), sendConfirmation: documentObject.querySelector("#send-communication-confirmation"),
      sendRecipient: documentObject.querySelector("#send-communication-recipient"), sendSubject: documentObject.querySelector("#send-communication-subject"),
      cancelSend: documentObject.querySelector("#cancel-send-communication"), confirmSend: documentObject.querySelector("#confirm-send-communication"),
      reconcile: documentObject.querySelector("#check-send-status"),
      markReconciledSent: documentObject.querySelector("#mark-reconciled-sent"),
      markReconciledFailed: documentObject.querySelector("#mark-reconciled-failed"),
      editForm: documentObject.querySelector("#draft-edit-form"), create: documentObject.querySelector("#communication-create"),
      createForm: documentObject.querySelector("#communication-create-form"), createTitle: documentObject.querySelector("#communication-create-title"),
      createHelp: documentObject.querySelector("#communication-create-help"), createSubmit: documentObject.querySelector("#communication-create-submit"),
      channelField: documentObject.querySelector("#communication-channel-field"), cancelCreate: documentObject.querySelector("#cancel-communication-create"),
      templateCreate: documentObject.querySelector("#communication-template-create"), templateForm: documentObject.querySelector("#communication-template-form"),
      cancelTemplate: documentObject.querySelector("#cancel-template-create"), previewTemplate: documentObject.querySelector("#preview-template"),
      generateTemplate: documentObject.querySelector("#generate-template-draft"), previewStatus: documentObject.querySelector("#template-preview-status"),
      preview: documentObject.querySelector("#template-preview")
    };
    let items = [];
    let templates = [];
    let selected = null;
    let manualMode = false;
    let requestId = null;
    let templateRequestId = null;
    let templatePreviewComplete = false;

    function updateActionVisibility() {
      const isDraft = selected?.communication_status === "draft";
      elements.editForm.hidden = !isDraft;
      elements.markReady.hidden = !isDraft;
      elements.send.hidden = !(selected?.communication_status === "ready" && selected.channel === "email");
      elements.reconcile.hidden = !(selected?.communication_status === "queued"
        && selected.reconciliation_required
        && selected.reconciliation_status !== "inconclusive");
      const manualResolutionAllowed = selected?.communication_status === "queued"
        && selected.queued_stale
        && selected.reconciliation_status === "inconclusive";
      elements.markReconciledSent.hidden = !manualResolutionAllowed;
      elements.markReconciledFailed.hidden = !manualResolutionAllowed;
    }

    function showIndex() {
      elements.listPanel.hidden = false;
      elements.detail.hidden = true;
      elements.create.hidden = true;
      elements.templateCreate.hidden = true;
      elements.sendConfirmation.hidden = true;
      elements.status.textContent = "";
      selected = null;
    }

    async function loadTemplates() {
      const body = await fetchJson(fetchImplementation, `${API_PATH}/templates`);
      templates = body.templates || [];
      elements.templateForm.elements.namedItem("template_key").innerHTML = renderTemplateOptions(templates);
      return templates;
    }

    async function loadList() {
      const params = new URLSearchParams();
      if (elements.statusFilter.value) params.set("status", elements.statusFilter.value);
      if (elements.typeFilter.value) params.set("type", elements.typeFilter.value);
      if (elements.channelFilter.value) params.set("channel", elements.channelFilter.value);
      const body = await fetchJson(fetchImplementation, `${API_PATH}${params.size ? `?${params}` : ""}`);
      items = body.communications || [];
      elements.list.innerHTML = renderListMarkup(items);
      elements.count.textContent = String(items.length);
      return items;
    }

    async function openDetail(id) {
      const body = await fetchJson(fetchImplementation, `${API_PATH}/${encodeURIComponent(id)}`);
      selected = body.communication;
      elements.detailFields.innerHTML = renderDetailMarkup(selected);
      elements.listPanel.hidden = true;
      elements.create.hidden = true;
      elements.templateCreate.hidden = true;
      elements.detail.hidden = false;
      const isDraft = selected.communication_status === "draft";
      updateActionVisibility();
      elements.sendConfirmation.hidden = true;
      if (isDraft) {
        elements.editForm.elements.namedItem("communication_type").innerHTML = renderTypeOptions(selected.communication_type);
        for (const name of ["recipient", "subject", "body_snapshot"]) elements.editForm.elements.namedItem(name).value = selected[name] || "";
      }
      return selected;
    }

    function prefillContext(form) {
      const query = new URLSearchParams(locationObject?.search || "");
      for (const field of ["commission_id", "client_id", "inquiry_id", "quotation_id", "document_id"]) {
        if (form.elements.namedItem(field) && query.get(field)) form.elements.namedItem(field).value = query.get(field);
      }
    }

    function openCreate(manual = false) {
      manualMode = manual;
      requestId = uuidFactory();
      elements.createForm.reset();
      elements.createForm.elements.namedItem("communication_type").innerHTML = renderTypeOptions(manual ? "manual_note" : "general");
      elements.createForm.elements.namedItem("channel").value = manual ? "manual" : "email";
      prefillContext(elements.createForm);
      elements.createTitle.textContent = manual ? "Record Manual Communication" : "New Draft";
      elements.createHelp.textContent = manual
        ? "Records a communication already completed outside this system. Nothing will be sent."
        : "Creates an editable draft. Saving does not send or queue a message.";
      elements.createSubmit.textContent = manual ? "Record Communication" : "Save Draft";
      elements.channelField.hidden = manual;
      elements.listPanel.hidden = true;
      elements.detail.hidden = true;
      elements.templateCreate.hidden = true;
      elements.create.hidden = false;
    }

    function invalidateTemplatePreview() {
      templatePreviewComplete = false;
      elements.generateTemplate.disabled = true;
      elements.preview.hidden = true;
      elements.previewStatus.textContent = "Preview required before generating a Draft.";
    }

    function openTemplateCreate() {
      templateRequestId = uuidFactory();
      elements.templateForm.reset();
      elements.templateForm.elements.namedItem("template_key").innerHTML = renderTemplateOptions(templates);
      prefillContext(elements.templateForm);
      invalidateTemplatePreview();
      elements.listPanel.hidden = true;
      elements.detail.hidden = true;
      elements.create.hidden = true;
      elements.templateCreate.hidden = false;
    }

    async function previewSelectedTemplate() {
      const body = await fetchJson(fetchImplementation, `${API_PATH}/template-preview`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildTemplatePayload(elements.templateForm))
      });
      templatePreviewComplete = Boolean(body.complete);
      elements.generateTemplate.disabled = !templatePreviewComplete;
      elements.preview.hidden = false;
      elements.preview.innerHTML = renderTemplatePreview(body);
      elements.previewStatus.textContent = body.complete
        ? "Preview complete. Review the exact recipient, subject, and body before generating."
        : `Context incomplete: ${(body.missing_context || []).join(", ")}`;
      return body;
    }

    async function generateTemplateDraft(event) {
      event?.preventDefault?.();
      if (!templatePreviewComplete) throw new Error("Preview is required before generating a Draft.");
      const body = await fetchJson(fetchImplementation, `${API_PATH}/from-template`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildTemplatePayload(elements.templateForm, templateRequestId))
      });
      templateRequestId = uuidFactory();
      await loadList();
      await openDetail(body.communication.id);
      return body.communication;
    }

    async function submitCreate(event) {
      event?.preventDefault?.();
      const body = await fetchJson(fetchImplementation, manualMode ? `${API_PATH}/manual` : API_PATH, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload(elements.createForm, requestId, manualMode))
      });
      requestId = uuidFactory();
      await loadList();
      await openDetail(body.communication.id);
      return body.communication;
    }

    async function submitEdit(event) {
      event?.preventDefault?.();
      const value = (name) => elements.editForm.elements.namedItem(name).value.trim();
      const body = await fetchJson(fetchImplementation, `${API_PATH}/${encodeURIComponent(selected.id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          communication_type: value("communication_type"), recipient: value("recipient"),
          subject: value("subject") || null, body_snapshot: value("body_snapshot")
        })
      });
      selected = body.communication;
      elements.detailFields.innerHTML = renderDetailMarkup(selected);
      return selected;
    }

    async function markReady() {
      if (!selected) return null;
      const body = await fetchJson(fetchImplementation, `${API_PATH}/${encodeURIComponent(selected.id)}/ready`, { method: "POST" });
      selected = body.communication;
      elements.detailFields.innerHTML = renderDetailMarkup(selected);
      elements.editForm.hidden = true;
      elements.markReady.hidden = true;
      elements.send.hidden = !(selected.communication_status === "ready" && selected.channel === "email");
      await loadList();
      return selected;
    }

    function openSendConfirmation() {
      if (!selected || selected.communication_status !== "ready" || selected.channel !== "email") return false;
      elements.sendRecipient.textContent = selected.recipient;
      elements.sendSubject.textContent = selected.subject || "";
      elements.sendConfirmation.hidden = false;
      return true;
    }

    function cancelSend() {
      elements.sendConfirmation.hidden = true;
    }

    async function sendSelected() {
      if (!selected || selected.communication_status !== "ready" || selected.channel !== "email") return null;
      const id = selected.id;
      elements.sendConfirmation.hidden = true;
      elements.send.hidden = true;
      elements.status.textContent = "Sending / Processing…";
      elements.detailFields.innerHTML = renderDetailMarkup({ ...selected, communication_status: "queued" });
      try {
        const body = await fetchJson(fetchImplementation, `${API_PATH}/${encodeURIComponent(id)}/send`, { method: "POST" });
        selected = body.communication;
        elements.detailFields.innerHTML = renderDetailMarkup(selected);
        elements.status.textContent = selected.communication_status === "sent" ? "Email sent." : "";
        await loadList();
        return selected;
      } catch (error) {
        await loadList();
        await openDetail(id);
        elements.status.textContent = error.message;
        return null;
      }
    }

    async function reconcileSelected() {
      if (!selected || selected.communication_status !== "queued" || !selected.reconciliation_required) return null;
      const id = selected.id;
      elements.reconcile.hidden = true;
      elements.status.textContent = "Checking send status…";
      try {
        const body = await fetchJson(fetchImplementation, `${API_PATH}/${encodeURIComponent(id)}/reconcile`, { method: "POST" });
        await loadList();
        await openDetail(id);
        elements.status.textContent = body.result === "confirmed_sent"
          ? "Send confirmed."
          : body.result === "confirmed_not_sent"
            ? "Provider confirmed the message was not sent."
            : "Send status is inconclusive. Manual review required.";
        return selected;
      } catch (error) {
        await openDetail(id);
        elements.status.textContent = error.message;
        return null;
      }
    }

    async function resolveManually(resolution) {
      if (!selected || selected.communication_status !== "queued"
        || selected.reconciliation_status !== "inconclusive" || !selected.queued_stale) return null;
      const isSent = resolution === "sent";
      const confirmed = confirmImplementation(isSent
        ? "Mark this Communication as Sent only after verifying it externally. This action does not send an email."
        : "Mark this Communication as Failed. This action does not retry or send an email.");
      if (!confirmed) return null;
      const id = selected.id;
      const suffix = isSent ? "manual-sent" : "manual-failed";
      const confirmation = isSent ? "MARK_AS_SENT_VERIFIED_EXTERNALLY" : "MARK_AS_FAILED_NO_RETRY";
      const body = await fetchJson(fetchImplementation, `${API_PATH}/${encodeURIComponent(id)}/reconcile/${suffix}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmation })
      });
      await loadList();
      await openDetail(id);
      elements.status.textContent = isSent
        ? "Marked as Sent after external verification. No email was sent by this action."
        : "Marked as Failed. No retry or email send occurred.";
      return body.communication;
    }

    function bindEvents() {
      elements.typeFilter.innerHTML = `<option value="">All</option>${renderTypeOptions("")}`;
      for (const filter of [elements.statusFilter, elements.typeFilter, elements.channelFilter]) filter.addEventListener("change", loadList);
      elements.newDraft.addEventListener("click", () => openCreate(false));
      elements.newFromTemplate.addEventListener("click", openTemplateCreate);
      elements.recordManual.addEventListener("click", () => openCreate(true));
      elements.cancelCreate.addEventListener("click", showIndex);
      elements.cancelTemplate.addEventListener("click", showIndex);
      elements.closeDetail.addEventListener("click", showIndex);
      elements.previewTemplate.addEventListener("click", previewSelectedTemplate);
      elements.templateForm.addEventListener("change", invalidateTemplatePreview);
      elements.templateForm.addEventListener("submit", generateTemplateDraft);
      elements.createForm.addEventListener("submit", submitCreate);
      elements.editForm.addEventListener("submit", submitEdit);
      elements.markReady.addEventListener("click", markReady);
      elements.send.addEventListener("click", openSendConfirmation);
      elements.cancelSend.addEventListener("click", cancelSend);
      elements.confirmSend.addEventListener("click", sendSelected);
      elements.reconcile.addEventListener("click", reconcileSelected);
      elements.markReconciledSent.addEventListener("click", () => resolveManually("sent"));
      elements.markReconciledFailed.addEventListener("click", () => resolveManually("failed"));
      elements.list.addEventListener("click", (event) => {
        const button = event.target.closest?.("[data-communication-id]");
        if (button) openDetail(button.getAttribute("data-communication-id"));
      });
    }

    return {
      bindEvents, generateTemplateDraft, invalidateTemplatePreview, loadList,
      loadTemplates, markReady, openCreate, openDetail, openSendConfirmation,
      openTemplateCreate, previewSelectedTemplate, reconcileSelected, resolveManually, sendSelected, showIndex,
      submitCreate, submitEdit
    };
  }

  const api = {
    API_PATH, buildPayload, buildTemplatePayload, communicationTypes, createApp,
    describeAutomation, describeRelationship, fetchJson, formatLabel, formatStatus, renderDetailMarkup,
    renderListMarkup, renderTemplateOptions, renderTemplatePreview, renderTypeOptions
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (globalObject?.document) {
    globalObject.addEventListener("DOMContentLoaded", async () => {
      const app = createApp(globalObject.document, globalObject.fetch.bind(globalObject));
      app.bindEvents();
      const query = new URLSearchParams(globalObject.location.search);
      try {
        await app.loadTemplates();
        await app.loadList();
        if (query.get("communication_id")) await app.openDetail(query.get("communication_id"));
        else if (query.get("action") === "draft") app.openCreate(false);
        else if (query.get("action") === "manual") app.openCreate(true);
        else if (query.get("action") === "template") app.openTemplateCreate();
      } catch (error) {
        globalObject.document.querySelector("#communications-status").textContent = error.message;
      }
    });
  }
})(typeof window !== "undefined" ? window : globalThis);
