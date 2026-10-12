(function initializeAdminQuotation(globalObject) {
  const API_PATH = "/admin/api/quotations";
  const CONTRACT_ELIGIBILITY_API_PATH = "/admin/api/contracts/eligibility";
  const SHIPPING_ESTIMATE_API_PATH = "/admin/api/shipping/estimate";

  function escapeHtml(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }

  function toCents(value) {
    const normalized = String(value ?? "").trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return 0;
    const [whole, fraction = ""] = normalized.split(".");
    return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  }

  function formatCurrency(value) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(value));
  }

  function calculatePreview({ price, salesTaxRate, shippingCharge }) {
    const priceCents = toCents(price);
    const shippingCents = toCents(shippingCharge);
    const taxCents = Math.round(priceCents * Number(salesTaxRate || 0));
    return {
      salesTax: taxCents / 100,
      requiredDeposit: Math.round(priceCents * 0.5) / 100,
      total: (priceCents + taxCents + shippingCents) / 100
    };
  }

  function buildPayload(form, shippingEstimateSnapshot = null) {
    return {
      artwork_title: String(form.elements.namedItem("artwork_title").value || "").trim(),
      artwork_description: String(form.elements.namedItem("artwork_description").value || "").trim(),
      artwork_medium: String(form.elements.namedItem("artwork_medium").value || "").trim(),
      artwork_width: String(form.elements.namedItem("artwork_width").value || "").trim() || null,
      artwork_height: String(form.elements.namedItem("artwork_height").value || "").trim() || null,
      price: String(form.elements.namedItem("price").value || "").trim(),
      sales_tax_rate: String(form.elements.namedItem("sales_tax_rate").value || "").trim(),
      shipping_charge: String(form.elements.namedItem("shipping_charge").value || "").trim(),
      estimated_completion: String(form.elements.namedItem("estimated_completion").value || "").trim() || null,
      special_terms: String(form.elements.namedItem("special_terms").value || "").trim() || null,
      shipping_estimate_snapshot: shippingEstimateSnapshot
    };
  }

  function buildShippingEstimateRequest(form) {
    return {
      destination: {
        recipient_name: String(form.elements.namedItem("shipping_recipient_name").value || "").trim() || null,
        address_line1: String(form.elements.namedItem("shipping_address_line1").value || "").trim(),
        address_line2: String(form.elements.namedItem("shipping_address_line2").value || "").trim() || null,
        city: String(form.elements.namedItem("shipping_city").value || "").trim(),
        state_region: String(form.elements.namedItem("shipping_state_region").value || "").trim(),
        postal_code: String(form.elements.namedItem("shipping_postal_code").value || "").trim(),
        country: String(form.elements.namedItem("shipping_country").value || "").trim()
      },
      parcel: {
        length: String(form.elements.namedItem("parcel_length").value || "").trim(),
        width: String(form.elements.namedItem("parcel_width").value || "").trim(),
        height: String(form.elements.namedItem("parcel_height").value || "").trim(),
        dimension_unit: String(form.elements.namedItem("dimension_unit").value || "").trim(),
        weight: String(form.elements.namedItem("parcel_weight").value || "").trim(),
        weight_unit: String(form.elements.namedItem("weight_unit").value || "").trim()
      }
    };
  }

  function buildShippingEstimateSnapshot(rate, destination, parcel) {
    return {
      provider: rate.provider,
      carrier: rate.carrier,
      service: rate.service,
      estimated_amount: rate.amount,
      currency: rate.currency,
      estimated_days: rate.estimated_days,
      rate_id: rate.rate_id,
      generated_at: rate.generated_at,
      parcel: {
        length: parcel.length,
        width: parcel.width,
        height: parcel.height,
        dimension_unit: parcel.dimension_unit,
        weight: parcel.weight,
        weight_unit: parcel.weight_unit
      },
      destination: {
        city: destination.city,
        state_region: destination.state_region,
        postal_code: destination.postal_code,
        country: destination.country
      }
    };
  }

  function canRecordAcceptance(quotation, now = new Date()) {
    return Boolean(
      quotation
      && ["issued", "sent"].includes(quotation.quotation_status)
      && quotation.quotation_snapshot
      && quotation.snapshot_hash
      && quotation.expires_at
      && now.getTime() <= new Date(quotation.expires_at).getTime()
    );
  }

  function getQuotationActionVisibility(quotation, acceptance = null) {
    const status = quotation?.is_expired
      && ["issued", "sent"].includes(quotation.quotation_status)
      ? "expired"
      : quotation?.quotation_status;
    return {
      saveDraft: status === "draft",
      issue: status === "draft" && Boolean(quotation?.id),
      markSent: status === "issued",
      recordAcceptance: status === "sent" && !acceptance,
      newVersion: ["issued", "sent"].includes(status) && !acceptance,
      withdraw: ["issued", "sent"].includes(status) && !acceptance,
      prepareContract: status === "accepted"
    };
  }

  function buildAcceptancePayload(form, requestId) {
    return {
      request_id: requestId,
      acceptance_method: "admin_recorded",
      client_name_entered: String(form.elements.namedItem("client_name_entered").value || "").trim(),
      client_email: String(form.elements.namedItem("client_email").value || "").trim(),
      accepted_by_client_confirmation: Boolean(form.elements.namedItem("accepted_by_client_confirmation").checked)
    };
  }

  function renderSummary(quotation) {
    const expired = quotation.is_expired ? " · Expired by date" : "";
    return `<article class="commission-detail-summary"><p class="commission-number">${escapeHtml(quotation.quotation_number)} · v${escapeHtml(quotation.version)}</p><h2>${escapeHtml(quotation.artwork_title || quotation.commission_title)}</h2><p>${escapeHtml(quotation.client_name)}${quotation.commission_number ? ` · ${escapeHtml(quotation.commission_number)}` : " · Pre-Commission"}</p><p><strong>Status:</strong> ${escapeHtml(quotation.quotation_status)}${expired}</p></article>`;
  }

  function renderSnapshot(snapshot) {
    if (!snapshot) return "";
    const c = snapshot.commercial;
    const estimate = c.shipping_estimate
      ? `<h3>Selected Shipping Estimate</h3><p>${escapeHtml(c.shipping_estimate.carrier)} · ${escapeHtml(c.shipping_estimate.service)} · ${escapeHtml(formatCurrency(c.shipping_estimate.estimated_amount))}</p>`
      : "";
    return `<article class="commission-detail-summary"><h2>Issued Commercial Snapshot</h2><dl class="commission-data-grid"><div><dt>Issued At</dt><dd>${escapeHtml(new Date(snapshot.issued_at).toLocaleString())}</dd></div><div><dt>Expires At</dt><dd>${escapeHtml(new Date(snapshot.expires_at).toLocaleString())}</dd></div><div><dt>Price</dt><dd>${escapeHtml(formatCurrency(c.price))}</dd></div><div><dt>Sales Tax Rate</dt><dd>${escapeHtml((Number(c.sales_tax_rate) * 100).toFixed(0))}%</dd></div><div><dt>Sales Tax</dt><dd>${escapeHtml(formatCurrency(c.sales_tax))}</dd></div><div><dt>Shipping Charge</dt><dd>${escapeHtml(formatCurrency(c.shipping_charge))}</dd></div><div><dt>Required Deposit</dt><dd>${escapeHtml(formatCurrency(c.required_deposit))}</dd></div><div><dt>Total</dt><dd>${escapeHtml(formatCurrency(c.total))}</dd></div></dl>${estimate}${c.special_terms ? `<h3>Special Terms</h3><p>${escapeHtml(c.special_terms)}</p>` : ""}<p><small>Snapshot hash: ${escapeHtml(snapshot ? "verified persistent snapshot" : "")}</small></p></article>`;
  }

  function renderShippingRates(model) {
    if (!model?.rates?.length) return '<p class="admin-notice">No live shipping rates were returned.</p>';
    return model.rates.map((rate, index) => `<article class="commission-detail-summary" data-shipping-rate-index="${index}">
      <p><strong>${escapeHtml(rate.carrier)}</strong> · ${escapeHtml(rate.service)}</p>
      <p>Estimate: ${escapeHtml(formatCurrency(rate.amount))}</p>
      <p>Estimated transit time: ${rate.estimated_days === null ? "Unavailable" : `${escapeHtml(rate.estimated_days)} days`}</p>
      <button type="button" class="admin-text-button" data-use-shipping-rate="${index}">Use as Shipping Charge</button>
    </article>`).join("");
  }

  function renderSelectedShippingEstimate(snapshot) {
    if (!snapshot) return "";
    return `<article class="commission-detail-summary">
      <p><strong>Selected estimate:</strong> ${escapeHtml(snapshot.carrier)} · ${escapeHtml(snapshot.service)} · ${escapeHtml(formatCurrency(snapshot.estimated_amount))}</p>
      <p>The Shipping Charge remains an explicit editable commercial value until this draft is issued.</p>
    </article>`;
  }

  function renderAcceptanceRecord(acceptance) {
    if (!acceptance) return "";
    return `<article class="commission-detail-summary"><h2>Accepted <button type="button" class="admin-help-trigger" data-glossary-key="immutable_acceptance" aria-label="Learn about Immutable Acceptance">i</button></h2><dl class="commission-data-grid"><div><dt>Accepted At</dt><dd>${escapeHtml(new Date(acceptance.accepted_at).toLocaleString())}</dd></div><div><dt>Method</dt><dd>${escapeHtml(acceptance.acceptance_method)}</dd></div><div><dt>Client</dt><dd>${escapeHtml(acceptance.client_name_entered)}</dd></div><div><dt>Client Email</dt><dd>${escapeHtml(acceptance.client_email)}</dd></div><div><dt>Subject</dt><dd>${escapeHtml(acceptance.subject_number)} · v${escapeHtml(acceptance.subject_version)}</dd></div><div><dt>Snapshot Hash</dt><dd>${escapeHtml(acceptance.snapshot_hash)}</dd></div></dl></article>`;
  }

  async function fetchJson(fetchImplementation, url, options) {
    const response = await fetchImplementation(url, options);
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(body?.message || "Unable to complete quotation request.");
      error.code = body?.code || null;
      throw error;
    }
    return body;
  }

  function createApp(
    documentObject,
    fetchImplementation,
    locationObject = globalObject.location,
    uuidFactory = () => globalObject.crypto.randomUUID(),
    historyObject = globalObject.history
  ) {
    const elements = {
      status: documentObject.querySelector("#quotation-page-status"),
      panel: documentObject.querySelector("#quotation-panel"),
      summary: documentObject.querySelector("#quotation-summary"),
      form: documentObject.querySelector("#quotation-form"),
      tax: documentObject.querySelector("#quotation-tax-preview"),
      deposit: documentObject.querySelector("#quotation-deposit-preview"),
      total: documentObject.querySelector("#quotation-total-preview"),
      issue: documentObject.querySelector("#issue-quotation"),
      markSent: documentObject.querySelector("#mark-quotation-sent"),
      newVersion: documentObject.querySelector("#new-quotation-version"),
      withdraw: documentObject.querySelector("#withdraw-quotation"),
      recordAcceptance: documentObject.querySelector("#record-quotation-acceptance"),
      acceptanceSubmit: documentObject.querySelector("#confirm-quotation-acceptance"),
      acceptancePanel: documentObject.querySelector("#quotation-acceptance-panel"),
      acceptanceSummary: documentObject.querySelector("#quotation-acceptance-summary"),
      acceptanceForm: documentObject.querySelector("#quotation-acceptance-form"),
      cancelAcceptance: documentObject.querySelector("#cancel-quotation-acceptance"),
      acceptanceRecord: documentObject.querySelector("#quotation-acceptance-record"),
      contractAction: documentObject.querySelector("#quotation-contract-action"),
      contractStatus: documentObject.querySelector("#quotation-contract-status"),
      prepareContract: documentObject.querySelector("#quotation-prepare-contract"),
      getShippingEstimate: documentObject.querySelector("#get-shipping-estimate"),
      shippingEstimateStatus: documentObject.querySelector("#shipping-estimate-status"),
      shippingEstimateResults: documentObject.querySelector("#shipping-estimate-results"),
      preview: documentObject.querySelector("#quotation-preview")
    };
    let quotation = null;
    let acceptance = null;
    let shippingEstimateModel = null;
    let selectedShippingEstimate = null;
    const createRequestId = uuidFactory();
    let acceptanceRequestId = null;
    let pendingClientId = null;
    let pendingInquiryId = null;
    let actionPending = false;

    function setActionPending(pending) {
      actionPending = pending;
      for (const element of [
        elements.issue,
        elements.markSent,
        elements.newVersion,
        elements.withdraw,
        elements.recordAcceptance,
        elements.acceptanceSubmit
      ]) {
        if (element) element.disabled = pending;
      }
    }

    function updatePreview() {
      const preview = calculatePreview({
        price: elements.form.elements.namedItem("price").value,
        salesTaxRate: elements.form.elements.namedItem("sales_tax_rate").value,
        shippingCharge: elements.form.elements.namedItem("shipping_charge").value
      });
      elements.tax.textContent = formatCurrency(preview.salesTax);
      elements.deposit.textContent = formatCurrency(preview.requiredDeposit);
      elements.total.textContent = formatCurrency(preview.total);
      return preview;
    }

    function render() {
      const isDraft = quotation.quotation_status === "draft";
      const actions = getQuotationActionVisibility(quotation, acceptance);
      elements.panel.hidden = false;
      elements.summary.innerHTML = renderSummary(quotation);
      elements.form.hidden = !actions.saveDraft;
      elements.issue.hidden = !actions.issue;
      elements.markSent.hidden = !actions.markSent;
      const acceptanceEligible = actions.recordAcceptance && canRecordAcceptance(quotation);
      elements.recordAcceptance.hidden = !acceptanceEligible;
      elements.newVersion.hidden = !actions.newVersion;
      elements.withdraw.hidden = !actions.withdraw;
      if (!acceptanceEligible) elements.acceptancePanel.hidden = true;
      elements.acceptanceRecord.hidden = !acceptance;
      elements.acceptanceRecord.innerHTML = renderAcceptanceRecord(acceptance);
      if (quotation.quotation_status !== "accepted") elements.contractAction.hidden = true;
      elements.preview.hidden = isDraft;
      elements.preview.innerHTML = renderSnapshot(quotation.quotation_snapshot);
      if (isDraft) {
        elements.form.elements.namedItem("artwork_title").value = quotation.artwork_title || quotation.commission_title || "";
        elements.form.elements.namedItem("artwork_description").value = quotation.artwork_description || quotation.commission_description || "";
        elements.form.elements.namedItem("artwork_medium").value = quotation.artwork_medium || quotation.commission_medium || "Acrylic";
        elements.form.elements.namedItem("artwork_width").value = quotation.artwork_width || quotation.commission_width || "";
        elements.form.elements.namedItem("artwork_height").value = quotation.artwork_height || quotation.commission_height || "";
        elements.form.elements.namedItem("price").value = quotation.price;
        elements.form.elements.namedItem("sales_tax_rate").value = Number(quotation.sales_tax_rate).toFixed(2);
        elements.form.elements.namedItem("shipping_charge").value = quotation.shipping_charge;
        elements.form.elements.namedItem("estimated_completion").value = quotation.estimated_completion ? String(quotation.estimated_completion).slice(0, 10) : "";
        elements.form.elements.namedItem("special_terms").value = quotation.special_terms || "";
        selectedShippingEstimate = quotation.shipping_estimate_snapshot || selectedShippingEstimate;
        if (selectedShippingEstimate && !shippingEstimateModel) {
          elements.shippingEstimateResults.innerHTML =
            renderSelectedShippingEstimate(selectedShippingEstimate);
        }
        updatePreview();
      }
      setActionPending(actionPending);
    }

    async function getShippingEstimate() {
      elements.shippingEstimateStatus.textContent = "Requesting live shipping rates…";
      elements.shippingEstimateStatus.classList?.remove("is-error");
      try {
        const body = await fetchJson(fetchImplementation, SHIPPING_ESTIMATE_API_PATH, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildShippingEstimateRequest(elements.form))
        });
        shippingEstimateModel = {
          rates: body.rates || [],
          destination: body.destination,
          parcel: body.parcel
        };
        elements.shippingEstimateResults.innerHTML = renderShippingRates(shippingEstimateModel);
        elements.shippingEstimateStatus.textContent = "";
        return shippingEstimateModel;
      } catch (error) {
        shippingEstimateModel = null;
        elements.shippingEstimateResults.innerHTML = "";
        elements.shippingEstimateStatus.textContent = error.code === "rate_provider_not_configured"
          ? "Live shipping rates are not configured yet."
          : error.message;
        elements.shippingEstimateStatus.classList?.add("is-error");
        return null;
      }
    }

    function useShippingRate(index) {
      const rate = shippingEstimateModel?.rates?.[Number(index)];
      if (!rate) return null;
      selectedShippingEstimate = buildShippingEstimateSnapshot(
        rate,
        shippingEstimateModel.destination,
        shippingEstimateModel.parcel
      );
      elements.form.elements.namedItem("shipping_charge").value = rate.amount;
      elements.shippingEstimateResults.innerHTML =
        renderSelectedShippingEstimate(selectedShippingEstimate);
      elements.shippingEstimateStatus.textContent =
        "Estimate selected and explicitly applied as the Shipping Charge. Save Draft to persist it.";
      updatePreview();
      return selectedShippingEstimate;
    }

    async function loadAcceptance() {
      if (!quotation || quotation.quotation_status === "draft") return null;
      const body = await fetchJson(fetchImplementation, `${API_PATH}/${quotation.id}/acceptance`);
      acceptance = body.acceptance || null;
      render();
      return acceptance;
    }

    async function loadContractEligibility() {
      if (!quotation || quotation.quotation_status !== "accepted") return null;
      const body = await fetchJson(
        fetchImplementation,
        `${CONTRACT_ELIGIBILITY_API_PATH}?quotation_id=${encodeURIComponent(quotation.id)}`
      );
      elements.contractStatus.textContent = body.message;
      elements.contractAction.hidden = !body.eligible;
      if (body.eligible) {
        elements.prepareContract.href = `create-contract.html?quotation_id=${encodeURIComponent(quotation.id)}`;
      }
      return body;
    }

    async function load() {
      const params = new URLSearchParams(locationObject.search);
      const id = params.get("id");
      const clientId = params.get("client_id");
      const inquiryId = params.get("inquiry_id");
      pendingClientId = clientId;
      pendingInquiryId = inquiryId;
      elements.status.textContent = "Loading quotation…";
      try {
        const body = id
          ? await fetchJson(fetchImplementation, `${API_PATH}/${encodeURIComponent(id)}`)
          : await fetchJson(fetchImplementation, `/admin/api/clients/${encodeURIComponent(clientId)}`);
        quotation = id ? body.quotation : {
          quotation_status: "draft", quotation_number: "New Quotation", version: 1,
          client_id: body.client.id, client_name: body.client.full_name,
          artwork_title: "", artwork_description: "", artwork_medium: "Acrylic",
          artwork_width: null, artwork_height: null, price: "0.00",
          sales_tax_rate: "0.0600", sales_tax: "0.00", shipping_charge: "0.00",
          estimated_completion: null, special_terms: null, shipping_estimate_snapshot: null
        };
        elements.status.textContent = "";
        render();
        if (quotation.quotation_status !== "draft") await loadAcceptance();
        if (quotation.quotation_status === "accepted") await loadContractEligibility();
        return quotation;
      } catch (error) {
        elements.status.textContent = error.message;
        elements.status.classList?.add("is-error");
        return null;
      }
    }

    function openAcceptance() {
      if (!canRecordAcceptance(quotation) || acceptance) return false;
      acceptanceRequestId ||= uuidFactory();
      const snapshot = quotation.quotation_snapshot;
      elements.acceptanceSummary.innerHTML = `<p><strong>${escapeHtml(quotation.quotation_number)} · v${escapeHtml(quotation.version)}</strong></p><p>${escapeHtml(quotation.client_name)} · ${escapeHtml(formatCurrency(snapshot.commercial.total))}</p><p>Expires ${escapeHtml(new Date(quotation.expires_at).toLocaleString())}</p>`;
      elements.acceptanceForm.elements.namedItem("client_name_entered").value = quotation.client_name;
      elements.acceptanceForm.elements.namedItem("client_email").value = quotation.client_email;
      elements.acceptanceForm.elements.namedItem("accepted_by_client_confirmation").checked = false;
      elements.acceptancePanel.hidden = false;
      return true;
    }

    async function submitAcceptance(event) {
      event?.preventDefault();
      if (actionPending) return null;
      if (!acceptanceRequestId) acceptanceRequestId = uuidFactory();
      setActionPending(true);
      try {
        const body = await fetchJson(fetchImplementation, `${API_PATH}/${quotation.id}/accept`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildAcceptancePayload(elements.acceptanceForm, acceptanceRequestId))
        });
        acceptance = body.acceptance;
        quotation = { ...quotation, quotation_status: "accepted", accepted_at: acceptance.accepted_at };
        elements.acceptancePanel.hidden = true;
        elements.status.textContent = "Quotation acceptance recorded.";
        render();
        await loadContractEligibility();
        return acceptance;
      } catch (error) {
        elements.status.textContent = error.message;
        return null;
      } finally {
        setActionPending(false);
      }
    }

    async function save(event) {
      event?.preventDefault();
      try {
        const payload = buildPayload(elements.form, selectedShippingEstimate);
        const creating = !quotation.id;
        const body = await fetchJson(fetchImplementation, creating
          ? `/admin/api/clients/${encodeURIComponent(pendingClientId)}/quotations`
          : `${API_PATH}/${quotation.id}`, {
          method: creating ? "POST" : "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(creating
            ? { ...payload, inquiry_id: pendingInquiryId, request_id: createRequestId }
            : payload)
        });
        quotation = body.quotation;
        if (creating) historyObject?.replaceState?.(null, "", `quotation.html?id=${encodeURIComponent(quotation.id)}`);
        render(); elements.status.textContent = creating ? "Quotation draft created." : "Draft saved."; return quotation;
      } catch (error) { elements.status.textContent = error.message; return null; }
    }

    async function action(name) {
      if (actionPending) return null;
      setActionPending(true);
      try {
        const body = await fetchJson(fetchImplementation, `${API_PATH}/${quotation.id}/${name}`, { method: "POST" });
        quotation = body.quotation;
        render();
        elements.status.textContent = body.message
          || (name === "mark-sent" && body.created === false
            ? "Quotation is already marked as sent."
            : name === "issue" && body.created === false
              ? "Quotation is already issued."
              : "Quotation updated.");
        if (name === "new-version") locationObject.href = `quotation.html?id=${encodeURIComponent(quotation.id)}`;
        return quotation;
      } catch (error) {
        elements.status.textContent = error.message;
        return null;
      } finally {
        setActionPending(false);
      }
    }

    function bindEvents() {
      elements.form.addEventListener("submit", save);
      ["price", "shipping_charge"].forEach((name) => elements.form.elements.namedItem(name).addEventListener("input", updatePreview));
      elements.form.elements.namedItem("sales_tax_rate").addEventListener("change", updatePreview);
      elements.getShippingEstimate.addEventListener("click", getShippingEstimate);
      elements.shippingEstimateResults.addEventListener("click", (event) => {
        const button = event.target.closest?.("[data-use-shipping-rate]");
        if (button) useShippingRate(button.getAttribute("data-use-shipping-rate"));
      });
      elements.issue.addEventListener("click", () => action("issue"));
      elements.markSent.addEventListener("click", () => action("mark-sent"));
      elements.newVersion.addEventListener("click", () => action("new-version"));
      elements.withdraw.addEventListener("click", () => action("withdraw"));
      elements.recordAcceptance.addEventListener("click", openAcceptance);
      elements.cancelAcceptance.addEventListener("click", () => { elements.acceptancePanel.hidden = true; });
      elements.acceptanceForm.addEventListener("submit", submitAcceptance);
    }

    return { action, bindEvents, getShippingEstimate, load, loadAcceptance, loadContractEligibility, openAcceptance, render, save, submitAcceptance, updatePreview, useShippingRate };
  }

  const api = { API_PATH, CONTRACT_ELIGIBILITY_API_PATH, SHIPPING_ESTIMATE_API_PATH, buildAcceptancePayload, buildPayload, buildShippingEstimateRequest, buildShippingEstimateSnapshot, calculatePreview, canRecordAcceptance, createApp, getQuotationActionVisibility, renderAcceptanceRecord, renderShippingRates, renderSnapshot, renderSummary };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalObject.AdminQuotation = api;
  if (globalObject.document) { const app = createApp(globalObject.document, globalObject.fetch.bind(globalObject)); app.bindEvents(); app.load(); }
})(typeof window !== "undefined" ? window : globalThis);
