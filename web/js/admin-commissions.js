(function initializeAdminCommissions(globalObject) {
  const API_PATH = "/admin/api/commissions";
  const CLIENTS_API_PATH = "/admin/api/clients";
  const statusTransitions = {
    draft: ["quoted", "cancelled"],
    quoted: ["draft", "approved", "cancelled"],
    approved: ["quoted", "in_progress", "cancelled"],
    in_progress: ["approved", "completed", "cancelled"],
    completed: ["in_progress"],
    cancelled: ["draft"]
  };
  const paymentMethodLabels = {
    cash: "Cash",
    card: "Credit / Debit Card",
    bank_transfer: "Bank Transfer",
    check: "Check",
    zelle: "Zelle",
    paypal: "PayPal"
  };
  const labels = {
    commission_number: "Commission Number",
    client_name: "Client",
    client_email: "Client Email",
    title: "Title",
    description: "Description",
    medium: "Medium",
    width: "Width (in)",
    height: "Height (in)",
    price: "Price",
    sales_tax: "Sales Tax",
    shipping: "Shipping",
    total: "Total",
    required_deposit: "Required Deposit (50%)",
    deposit_amount: "Deposit Amount",
    amount_paid: "Amount Paid",
    balance: "Balance",
    status: "Status",
    estimated_completion: "Estimated Completion",
    created_at: "Created",
    id: "ID"
  };
  const moneyFields = new Set([
    "price",
    "sales_tax",
    "shipping",
    "total",
    "required_deposit",
    "deposit_amount",
    "amount_paid",
    "balance"
  ]);

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
    }).format(Number(value));
  }

  function toCents(value) {
    const normalized = String(value ?? "").trim();

    if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
      return 0;
    }

    const [whole, fraction = ""] = normalized.split(".");
    const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
    return Number.isSafeInteger(cents) ? cents : 0;
  }

  function calculateFinancialPreview({ price, salesTaxRate, shipping }) {
    const priceCents = toCents(price);
    const shippingCents = toCents(shipping);
    const rate = Number(salesTaxRate);
    const salesTaxCents = Number.isFinite(rate)
      ? Math.round(priceCents * rate)
      : 0;
    const requiredDepositCents = Math.round(priceCents / 2);

    return {
      salesTaxCents,
      requiredDepositCents,
      estimatedRemainingCents:
        priceCents - requiredDepositCents + salesTaxCents + shippingCents
    };
  }

  function inferSalesTaxRate(price, salesTax) {
    const priceCents = toCents(price);
    const salesTaxCents = toCents(salesTax);

    if (priceCents === 0) {
      return "0.06";
    }

    return ["0.00", "0.06", "0.07", "0.08"].find(
      (rate) => Math.round(priceCents * Number(rate)) === salesTaxCents
    ) || "0.06";
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

  function formatDateOnly(value) {
    if (!value) {
      return "";
    }

    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeZone: "UTC"
    }).format(new Date(`${String(value).slice(0, 10)}T00:00:00Z`));
  }

  function formatLabel(value) {
    return String(value)
      .replace(/_/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function formatDetailValue(field, value) {
    if (moneyFields.has(field)) {
      return formatCurrency(value);
    }

    if (field === "created_at") {
      return formatDate(value);
    }

    if (field === "estimated_completion") {
      return formatDateOnly(value);
    }

    if (field === "status") {
      return formatLabel(value);
    }

    return String(value);
  }

  function renderListMarkup(commissions) {
    if (!commissions.length) {
      return '<tr><td colspan="8" class="inquiry-empty">No commissions yet.</td></tr>';
    }

    return commissions.map((commission) => `
      <tr>
        <td><button type="button" class="admin-text-button" data-commission-id="${escapeHtml(commission.id)}">${escapeHtml(commission.commission_number)}</button></td>
        <td>${escapeHtml(commission.client_name)}</td>
        <td>${escapeHtml(commission.title)}</td>
        <td>${escapeHtml(formatLabel(commission.status))}</td>
        <td>${escapeHtml(formatCurrency(commission.price))}</td>
        <td>${escapeHtml(formatCurrency(commission.balance))}</td>
        <td>${escapeHtml(formatDate(commission.created_at))}</td>
        <td>${escapeHtml(commission.id)}</td>
      </tr>
    `).join("");
  }

  function renderDetailMarkup(commission) {
    const detail = {
      ...commission,
      total: (
        toCents(commission.price)
        + toCents(commission.sales_tax)
        + toCents(commission.shipping)
      ) / 100,
      required_deposit: Math.round(toCents(commission.price) / 2) / 100
    };
    const renderField = (field) => hasContent(detail[field]) ? `
      <div class="commission-data-field" data-field="${escapeHtml(field)}">
        <dt>${escapeHtml(labels[field])}</dt>
        <dd>${escapeHtml(formatDetailValue(field, detail[field]))}</dd>
      </div>
    ` : "";

    return `
      <article class="commission-detail-summary">
        <header class="commission-detail-header">
          <div>
            <p class="commission-number">${escapeHtml(detail.commission_number)}</p>
            <h2>${escapeHtml(detail.title)}</h2>
            <p class="commission-client">${escapeHtml(detail.client_name)} · ${escapeHtml(detail.client_email)}</p>
          </div>
          <span class="commission-status-badge">${escapeHtml(formatLabel(detail.status))}</span>
        </header>

        <section class="commission-description">
          <h3>Description</h3>
          <p>${escapeHtml(detail.description)}</p>
        </section>

        <div class="commission-summary-grid">
          <section class="commission-summary-section">
            <h3>Artwork</h3>
            <dl class="commission-data-grid commission-artwork-grid">
              ${renderField("medium")}
              ${renderField("width")}
              ${renderField("height")}
              ${renderField("estimated_completion")}
            </dl>
          </section>

          <section class="commission-summary-section commission-financial-section">
            <h3>Financial</h3>
            <dl class="commission-data-grid commission-financial-grid">
              ${renderField("price")}
              ${renderField("sales_tax")}
              ${renderField("shipping")}
              ${renderField("total")}
              ${renderField("required_deposit")}
              ${renderField("deposit_amount")}
              ${renderField("amount_paid")}
              ${renderField("balance")}
            </dl>
          </section>
        </div>

        <section class="commission-record-information">
          <h3>Record Information</h3>
          <dl class="commission-data-grid commission-record-grid">
            ${renderField("created_at")}
            ${renderField("id")}
          </dl>
        </section>
      </article>`;
  }

  function renderClientOptions(clients) {
    return '<option value="">Select one</option>' + clients.map((client) =>
      `<option value="${escapeHtml(client.id)}">${escapeHtml(client.full_name)} — ${escapeHtml(client.email)}</option>`
    ).join("");
  }

  function renderStatusOptions(status) {
    return (statusTransitions[status] || []).map((nextStatus) =>
      `<option value="${escapeHtml(nextStatus)}">${escapeHtml(formatLabel(nextStatus))}</option>`
    ).join("");
  }

  function sortPayments(payments) {
    return [...payments].sort((left, right) => {
      const leftDate = left.payment_date ? String(left.payment_date).slice(0, 10) : "";
      const rightDate = right.payment_date ? String(right.payment_date).slice(0, 10) : "";

      if (leftDate !== rightDate) {
        if (!leftDate) return 1;
        if (!rightDate) return -1;
        return rightDate.localeCompare(leftDate);
      }

      const createdDifference = String(right.created_at).localeCompare(String(left.created_at));
      return createdDifference || Number(right.id) - Number(left.id);
    });
  }

  function renderPaymentsMarkup(payments) {
    if (!payments.length) {
      return '<tr><td colspan="7" class="inquiry-empty">No payments recorded.</td></tr>';
    }

    return sortPayments(payments).map((payment) => `
      <tr>
        <td data-label="Date">${payment.payment_date ? escapeHtml(formatDateOnly(payment.payment_date)) : "—"}</td>
        <td data-label="Type">${escapeHtml(formatLabel(payment.payment_type))}</td>
        <td data-label="Amount">${escapeHtml(formatCurrency(payment.amount))}</td>
        <td data-label="Tax Portion">${escapeHtml(formatCurrency(payment.sales_tax))}</td>
        <td data-label="Method">${hasContent(payment.payment_method) ? escapeHtml(paymentMethodLabels[payment.payment_method] || payment.payment_method) : "—"}</td>
        <td data-label="Status">${escapeHtml(formatLabel(payment.status))}</td>
        <td data-label="Reference">
          ${hasContent(payment.external_reference) ? escapeHtml(payment.external_reference) : "—"}
          ${hasContent(payment.notes) ? `<span class="commission-payment-notes"><strong>Notes:</strong> ${escapeHtml(payment.notes)}</span>` : ""}
        </td>
      </tr>
    `).join("");
  }

  function readRequired(form, field, label) {
    const value = String(form.elements.namedItem(field).value || "").trim();

    if (!value) {
      throw new Error(`${label} is required.`);
    }

    return value;
  }

  function readNumber(form, field, label, options = {}) {
    const rawValue = String(form.elements.namedItem(field).value || "").trim();

    if (!rawValue) {
      if (options.required) {
        throw new Error(`${label} is required.`);
      }

      return options.defaultValue ?? null;
    }

    const value = Number(rawValue);

    if (!Number.isFinite(value)) {
      throw new Error(`${label} must be a valid number.`);
    }

    if (options.positive ? value <= 0 : value < 0) {
      throw new Error(
        options.positive
          ? `${label} must be greater than 0.`
          : `${label} must be 0 or greater.`
      );
    }

    return value;
  }

  function buildCreatePayload(form) {
    return {
      client_id: readRequired(form, "client_id", "Client"),
      title: readRequired(form, "title", "Title"),
      description: readRequired(form, "description", "Description"),
      medium: readRequired(form, "medium", "Medium"),
      width: readNumber(form, "width", "Width", { positive: true }),
      height: readNumber(form, "height", "Height", { positive: true }),
      price: readNumber(form, "price", "Price", { required: true }),
      sales_tax_rate: readRequired(form, "sales_tax_rate", "Sales tax rate"),
      shipping: readNumber(form, "shipping", "Shipping", { defaultValue: 0 }),
      estimated_completion:
        String(form.elements.namedItem("estimated_completion").value || "").trim() || null
    };
  }

  function buildEditPayload(form) {
    return {
      title: readRequired(form, "title", "Title"),
      description: readRequired(form, "description", "Description"),
      medium: readRequired(form, "medium", "Medium"),
      width: readNumber(form, "width", "Width", { positive: true }),
      height: readNumber(form, "height", "Height", { positive: true }),
      price: readNumber(form, "price", "Price", { required: true }),
      sales_tax_rate: readRequired(form, "sales_tax_rate", "Sales tax rate"),
      shipping: readNumber(form, "shipping", "Shipping", { defaultValue: 0 }),
      estimated_completion:
        String(form.elements.namedItem("estimated_completion").value || "").trim() || null
    };
  }

  function buildPaymentPayload(form, requestId) {
    const amount = String(form.elements.namedItem("amount").value || "").trim();
    const salesTax = String(form.elements.namedItem("sales_tax").value || "").trim() || "0";

    if (!/^\d+(?:\.\d{1,2})?$/.test(amount) || toCents(amount) <= 0) {
      throw new Error("Amount must be greater than 0 with no more than 2 decimals.");
    }

    if (!/^\d+(?:\.\d{1,2})?$/.test(salesTax)) {
      throw new Error("Sales tax must be 0 or greater with no more than 2 decimals.");
    }

    if (toCents(salesTax) > toCents(amount)) {
      throw new Error("Sales tax cannot exceed amount.");
    }

    return {
      request_id: requestId,
      payment_type: readRequired(form, "payment_type", "Payment type"),
      amount,
      sales_tax: salesTax,
      payment_method:
        String(form.elements.namedItem("payment_method").value || "").trim() || null,
      payment_date:
        String(form.elements.namedItem("payment_date").value || "").trim() || null,
      external_reference:
        String(form.elements.namedItem("external_reference").value || "").trim() || null,
      notes: String(form.elements.namedItem("notes").value || "").trim() || null
    };
  }

  async function fetchJson(fetchImplementation, url, options) {
    const response = await fetchImplementation(url, options);

    if (response.redirected && response.url?.includes("/admin-login.html")) {
      throw new Error("Your admin session expired. Please sign in again.");
    }

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
    uuidFactory = () => globalObject.crypto.randomUUID()
  ) {
    const elements = {
      count: documentObject.querySelector("#commission-count"),
      indexToolbar: documentObject.querySelector("#commission-index-toolbar"),
      workspace: documentObject.querySelector("#commission-workspace"),
      listPanel: documentObject.querySelector("#commission-list-panel"),
      list: documentObject.querySelector("#commission-list"),
      listStatus: documentObject.querySelector("#commission-list-status"),
      newCommission: documentObject.querySelector("#new-commission"),
      detail: documentObject.querySelector("#commission-detail"),
      detailFields: documentObject.querySelector("#commission-detail-fields"),
      detailStatus: documentObject.querySelector("#commission-detail-status"),
      closeDetail: documentObject.querySelector("#close-commission-detail"),
      editCommission: documentObject.querySelector("#edit-commission"),
      changeStatus: documentObject.querySelector("#change-commission-status"),
      payments: documentObject.querySelector("#commission-payments"),
      paymentList: documentObject.querySelector("#payment-list"),
      paymentStatus: documentObject.querySelector("#payment-status"),
      paymentGuidance: documentObject.querySelector("#payment-guidance"),
      recordPayment: documentObject.querySelector("#record-payment"),
      paymentForm: documentObject.querySelector("#payment-form"),
      cancelPayment: documentObject.querySelector("#cancel-payment"),
      statusForm: documentObject.querySelector("#commission-status-form"),
      cancelStatus: documentObject.querySelector("#cancel-commission-status"),
      statusConfirmation:
        documentObject.querySelector("#commission-status-confirmation"),
      statusConfirmationText:
        documentObject.querySelector("#commission-status-confirmation-text"),
      confirmStatus: documentObject.querySelector("#confirm-commission-status"),
      cancelStatusConfirmation:
        documentObject.querySelector("#cancel-commission-status-confirmation"),
      editForm: documentObject.querySelector("#commission-edit-form"),
      editSalesTaxPreview: documentObject.querySelector("#edit-sales-tax-preview"),
      editRequiredDepositPreview:
        documentObject.querySelector("#edit-required-deposit-preview"),
      editRemainingAfterDepositPreview:
        documentObject.querySelector("#edit-remaining-after-deposit-preview"),
      cancelEdit: documentObject.querySelector("#cancel-commission-edit"),
      createPanel: documentObject.querySelector("#commission-create"),
      createForm: documentObject.querySelector("#commission-form"),
      createStatus: documentObject.querySelector("#commission-create-status"),
      salesTaxPreview: documentObject.querySelector("#sales-tax-preview"),
      requiredDepositPreview: documentObject.querySelector("#required-deposit-preview"),
      remainingAfterDepositPreview:
        documentObject.querySelector("#remaining-after-deposit-preview"),
      cancelCreate: documentObject.querySelector("#cancel-commission")
    };
    let commissions = [];
    let selectedCommission = null;
    let pendingStatus = null;
    let payments = [];
    let paymentRequestId = null;

    function showError(element, error) {
      element.textContent = error.message || "An unexpected error occurred.";
      element.classList?.add("is-error");
    }

    function renderList() {
      elements.list.innerHTML = renderListMarkup(commissions);
      elements.count.textContent = String(commissions.length);
    }

    function renderPayments() {
      elements.paymentList.innerHTML = renderPaymentsMarkup(payments);
    }

    function formatPaymentInput(cents) {
      return (cents / 100).toFixed(2);
    }

    function isPaidInFull() {
      return selectedCommission && toCents(selectedCommission.balance) === 0;
    }

    function updatePaymentAvailability() {
      const paidInFull = isPaidInFull();

      elements.recordPayment.hidden = Boolean(paidInFull);
      elements.paymentStatus.classList?.remove("is-error");

      if (paidInFull) {
        elements.paymentStatus.textContent = "Paid in full";
        elements.paymentStatus.classList?.add("is-paid-in-full");
      } else {
        elements.paymentStatus.classList?.remove("is-paid-in-full");
      }

      return paidInFull;
    }

    function enterDetailMode() {
      elements.indexToolbar.hidden = true;
      elements.listStatus.hidden = true;
      elements.listPanel.hidden = true;
      elements.workspace.classList?.add("is-detail-mode");
    }

    function showCommissionIndex() {
      elements.detail.hidden = true;
      elements.detailFields.innerHTML = "";
      elements.detailStatus.textContent = "";
      elements.paymentStatus.textContent = "";
      elements.indexToolbar.hidden = false;
      elements.listStatus.hidden = false;
      elements.listPanel.hidden = false;
      elements.workspace.classList?.remove("is-detail-mode");
      payments = [];
      renderPayments();
      cancelPayment();
      selectedCommission = null;
      showReadOnlyDetail();
    }

    function mergeCommissionFinancials(financials) {
      selectedCommission = {
        ...selectedCommission,
        ...financials
      };
      commissions = commissions.map((commission) =>
        String(commission.id) === String(selectedCommission.id)
          ? { ...commission, ...financials }
          : commission
      );
      renderList();
      elements.detailFields.innerHTML = renderDetailMarkup(selectedCommission);
    }

    function updateFinancialPreview() {
      const preview = calculateFinancialPreview({
        price: elements.createForm.elements.namedItem("price").value,
        salesTaxRate: elements.createForm.elements.namedItem("sales_tax_rate").value,
        shipping: elements.createForm.elements.namedItem("shipping").value
      });

      elements.salesTaxPreview.textContent = formatCurrency(preview.salesTaxCents / 100);
      elements.requiredDepositPreview.textContent =
        formatCurrency(preview.requiredDepositCents / 100);
      elements.remainingAfterDepositPreview.textContent =
        formatCurrency(preview.estimatedRemainingCents / 100);
      return preview;
    }

    function updateEditFinancialPreview() {
      const preview = calculateFinancialPreview({
        price: elements.editForm.elements.namedItem("price").value,
        salesTaxRate: elements.editForm.elements.namedItem("sales_tax_rate").value,
        shipping: elements.editForm.elements.namedItem("shipping").value
      });

      elements.editSalesTaxPreview.textContent = formatCurrency(preview.salesTaxCents / 100);
      elements.editRequiredDepositPreview.textContent =
        formatCurrency(preview.requiredDepositCents / 100);
      elements.editRemainingAfterDepositPreview.textContent =
        formatCurrency(preview.estimatedRemainingCents / 100);
      return preview;
    }

    function showReadOnlyDetail() {
      elements.editForm.hidden = true;
      elements.statusForm.hidden = true;
      elements.statusConfirmation.hidden = true;
      elements.detailFields.hidden = false;
      elements.editCommission.hidden = false;
      elements.changeStatus.hidden = false;
      pendingStatus = null;
    }

    async function loadList() {
      elements.listStatus.textContent = "Loading commissions…";
      elements.listStatus.classList?.remove("is-error");

      try {
        const body = await fetchJson(fetchImplementation, API_PATH);
        commissions = body.commissions;
        renderList();
        elements.listStatus.textContent = "";
        return commissions;
      } catch (error) {
        commissions = [];
        renderList();
        showError(elements.listStatus, error);
        return [];
      }
    }

    async function loadClients() {
      try {
        const body = await fetchJson(fetchImplementation, CLIENTS_API_PATH);
        elements.createForm.elements.namedItem("client_id").innerHTML =
          renderClientOptions(body.clients);
        return body.clients;
      } catch (error) {
        showError(elements.createStatus, error);
        return [];
      }
    }

    async function loadPayments() {
      if (!selectedCommission) {
        payments = [];
        renderPayments();
        return [];
      }

      elements.paymentStatus.textContent = "Loading payments…";
      elements.paymentStatus.classList?.remove("is-error");

      try {
        const body = await fetchJson(
          fetchImplementation,
          `${API_PATH}/${encodeURIComponent(selectedCommission.id)}/payments`
        );
        payments = body.payments || [];

        if (body.commission) {
          mergeCommissionFinancials(body.commission);
        }

        renderPayments();
        elements.paymentStatus.textContent = "";
        updatePaymentAvailability();
        return payments;
      } catch (error) {
        payments = [];
        renderPayments();
        showError(elements.paymentStatus, error);
        return [];
      }
    }

    async function openDetail(id) {
      elements.createPanel.hidden = true;
      elements.detail.hidden = false;
      enterDetailMode();
      elements.detailStatus.textContent = "Loading commission…";
      elements.detailStatus.classList?.remove("is-error");

      try {
        const body = await fetchJson(
          fetchImplementation,
          `${API_PATH}/${encodeURIComponent(id)}`
        );
        selectedCommission = body.commission;
        elements.detailFields.innerHTML = renderDetailMarkup(selectedCommission);
        updatePaymentAvailability();
        showReadOnlyDetail();
        elements.detailStatus.textContent = "";
        await loadPayments();
        return selectedCommission;
      } catch (error) {
        selectedCommission = null;
        elements.detailFields.innerHTML = "";
        showError(elements.detailStatus, error);
        return null;
      }
    }

    function openEdit() {
      if (!selectedCommission) {
        return;
      }

      const form = elements.editForm;
      cancelPayment();
      form.elements.namedItem("title").value = selectedCommission.title;
      form.elements.namedItem("description").value = selectedCommission.description;
      form.elements.namedItem("medium").value = selectedCommission.medium;
      form.elements.namedItem("width").value = selectedCommission.width ?? "";
      form.elements.namedItem("height").value = selectedCommission.height ?? "";
      form.elements.namedItem("price").value = selectedCommission.price;
      form.elements.namedItem("sales_tax_rate").value = inferSalesTaxRate(
        selectedCommission.price,
        selectedCommission.sales_tax
      );
      form.elements.namedItem("shipping").value = selectedCommission.shipping;
      form.elements.namedItem("estimated_completion").value =
        selectedCommission.estimated_completion
          ? String(selectedCommission.estimated_completion).slice(0, 10)
          : "";
      elements.detailFields.hidden = true;
      elements.editCommission.hidden = true;
      elements.changeStatus.hidden = true;
      elements.editForm.hidden = false;
      elements.detailStatus.textContent = "";
      elements.detailStatus.classList?.remove("is-error");
      updateEditFinancialPreview();
    }

    function cancelEdit() {
      showReadOnlyDetail();
      elements.detailStatus.textContent = "";
      elements.detailStatus.classList?.remove("is-error");
    }

    function openStatus() {
      if (!selectedCommission) {
        return;
      }

      const transitions = statusTransitions[selectedCommission.status] || [];
      cancelPayment();
      const select = elements.statusForm.elements.namedItem("status");
      select.innerHTML = renderStatusOptions(selectedCommission.status);
      select.value = transitions[0] || "";
      elements.editForm.hidden = true;
      elements.statusConfirmation.hidden = true;
      elements.statusForm.hidden = false;
      elements.editCommission.hidden = true;
      elements.changeStatus.hidden = true;
      elements.detailStatus.textContent = "";
      elements.detailStatus.classList?.remove("is-error");
    }

    function cancelStatus() {
      showReadOnlyDetail();
      elements.detailStatus.textContent = "";
      elements.detailStatus.classList?.remove("is-error");
    }

    function prepareStatusConfirmation(event) {
      event?.preventDefault();

      if (!selectedCommission) {
        return null;
      }

      const nextStatus = elements.statusForm.elements.namedItem("status").value;

      if (!(statusTransitions[selectedCommission.status] || []).includes(nextStatus)) {
        showError(elements.detailStatus, new Error("Invalid commission status transition."));
        return null;
      }

      pendingStatus = nextStatus;
      elements.statusForm.hidden = true;
      elements.statusConfirmation.hidden = false;
      elements.statusConfirmationText.textContent =
        `Change commission status from ${formatLabel(selectedCommission.status).toUpperCase()} to ${formatLabel(nextStatus).toUpperCase()}?`;
      return nextStatus;
    }

    function cancelStatusConfirmation() {
      pendingStatus = null;
      elements.statusConfirmation.hidden = true;
      elements.statusForm.hidden = false;
    }

    function openCreate() {
      elements.detail.hidden = true;
      cancelPayment();
      elements.createPanel.hidden = false;
      elements.createForm.reset();
      elements.createForm.elements.namedItem("sales_tax_rate").value = "0.06";
      elements.createForm.elements.namedItem("shipping").value = "0";
      updateFinancialPreview();
      elements.createStatus.textContent = "";
      elements.createStatus.classList?.remove("is-error");
    }

    function closeCreate() {
      elements.createPanel.hidden = true;
      elements.createStatus.textContent = "";
    }

    async function submitCreate(event) {
      event?.preventDefault();
      let payload;

      try {
        payload = buildCreatePayload(elements.createForm);
      } catch (error) {
        showError(elements.createStatus, error);
        return null;
      }

      elements.createStatus.textContent = "Creating commission…";
      elements.createStatus.classList?.remove("is-error");

      try {
        const body = await fetchJson(fetchImplementation, API_PATH, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify(payload)
        });
        selectedCommission = body.commission;
        commissions = [selectedCommission, ...commissions];
        renderList();
        elements.createPanel.hidden = true;
        elements.detail.hidden = false;
        elements.detailFields.innerHTML = renderDetailMarkup(selectedCommission);
        payments = [];
        renderPayments();
        updatePaymentAvailability();
        enterDetailMode();
        showReadOnlyDetail();
        elements.detailStatus.textContent = "Commission created.";
        return selectedCommission;
      } catch (error) {
        showError(elements.createStatus, error);
        return null;
      }
    }

    async function submitEdit(event) {
      event?.preventDefault();

      if (!selectedCommission) {
        return null;
      }

      let payload;

      try {
        payload = buildEditPayload(elements.editForm);
      } catch (error) {
        showError(elements.detailStatus, error);
        return null;
      }

      elements.detailStatus.textContent = "Saving changes…";
      elements.detailStatus.classList?.remove("is-error");

      try {
        const body = await fetchJson(
          fetchImplementation,
          `${API_PATH}/${encodeURIComponent(selectedCommission.id)}`,
          {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
          }
        );
        const updatedCommission = {
          ...selectedCommission,
          ...body.commission
        };
        selectedCommission = updatedCommission;
        commissions = commissions.map((commission) =>
          String(commission.id) === String(updatedCommission.id)
            ? { ...commission, ...updatedCommission }
            : commission
        );
        renderList();
        elements.detailFields.innerHTML = renderDetailMarkup(updatedCommission);
        showReadOnlyDetail();
        elements.detailStatus.textContent = "Commission updated.";
        return updatedCommission;
      } catch {
        showError(elements.detailStatus, new Error("Unable to update commission."));
        return null;
      }
    }

    async function submitStatus() {
      if (!selectedCommission || !pendingStatus) {
        return null;
      }

      elements.detailStatus.textContent = "Updating commission status…";
      elements.detailStatus.classList?.remove("is-error");

      try {
        const body = await fetchJson(
          fetchImplementation,
          `${API_PATH}/${encodeURIComponent(selectedCommission.id)}/status`,
          {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({ status: pendingStatus })
          }
        );
        const updatedCommission = {
          ...selectedCommission,
          ...body.commission
        };
        selectedCommission = updatedCommission;
        commissions = commissions.map((commission) =>
          String(commission.id) === String(updatedCommission.id)
            ? { ...commission, ...updatedCommission }
            : commission
        );
        renderList();
        elements.detailFields.innerHTML = renderDetailMarkup(updatedCommission);
        showReadOnlyDetail();
        elements.detailStatus.textContent = "Commission status updated.";
        return updatedCommission;
      } catch {
        showError(
          elements.detailStatus,
          new Error("Unable to update commission status.")
        );
        return null;
      }
    }

    function openPayment() {
      if (!selectedCommission) {
        return null;
      }

      if (updatePaymentAvailability()) {
        elements.paymentForm.hidden = true;
        return null;
      }

      if (!paymentRequestId) {
        paymentRequestId = uuidFactory();
      }

      elements.paymentForm.reset();
      elements.paymentForm.elements.namedItem("payment_type").value =
        toCents(selectedCommission.deposit_amount) > 0 ? "balance" : "deposit";
      updatePaymentSuggestions();
      elements.paymentForm.elements.namedItem("payment_method").value = "";
      elements.paymentForm.hidden = false;
      elements.paymentStatus.textContent = "";
      elements.paymentStatus.classList?.remove("is-error");
      return paymentRequestId;
    }

    function updatePaymentSuggestions() {
      if (!selectedCommission) {
        return null;
      }

      const paymentType = elements.paymentForm.elements.namedItem("payment_type").value;
      const isBalance = paymentType === "balance";
      const amountCents = isBalance
        ? toCents(selectedCommission.balance)
        : Math.round(toCents(selectedCommission.price) / 2);
      const salesTaxCents = isBalance ? toCents(selectedCommission.sales_tax) : 0;

      elements.paymentForm.elements.namedItem("amount").value =
        formatPaymentInput(amountCents);
      elements.paymentForm.elements.namedItem("sales_tax").value =
        formatPaymentInput(salesTaxCents);

      if (!isBalance && toCents(selectedCommission.deposit_amount) > 0) {
        elements.paymentGuidance.textContent =
          "An initial deposit has already been recorded for this commission.";
      } else if (isBalance && toCents(selectedCommission.deposit_amount) === 0) {
        elements.paymentGuidance.textContent =
          "No deposit has been recorded for this commission.";
      } else {
        elements.paymentGuidance.textContent = "";
      }

      return {
        amount: elements.paymentForm.elements.namedItem("amount").value,
        salesTax: elements.paymentForm.elements.namedItem("sales_tax").value
      };
    }

    function cancelPayment() {
      elements.paymentForm.hidden = true;
      paymentRequestId = null;
    }

    async function submitPayment(event) {
      event?.preventDefault();

      if (!selectedCommission || !paymentRequestId) {
        return null;
      }

      let payload;

      try {
        payload = buildPaymentPayload(elements.paymentForm, paymentRequestId);
      } catch (error) {
        showError(elements.paymentStatus, error);
        return null;
      }

      elements.paymentStatus.textContent = "Recording payment…";
      elements.paymentStatus.classList?.remove("is-error");

      try {
        const body = await fetchJson(
          fetchImplementation,
          `${API_PATH}/${encodeURIComponent(selectedCommission.id)}/payments`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
          }
        );
        payments = sortPayments([
          body.payment,
          ...payments.filter((payment) => String(payment.id) !== String(body.payment.id))
        ]);
        mergeCommissionFinancials(body.commission);
        renderPayments();
        elements.paymentForm.reset();
        elements.paymentForm.elements.namedItem("payment_type").value =
          toCents(selectedCommission.deposit_amount) > 0 ? "balance" : "deposit";
        updatePaymentSuggestions();
        elements.paymentForm.hidden = true;
        paymentRequestId = uuidFactory();
        if (updatePaymentAvailability()) {
          elements.paymentStatus.textContent = "Paid in full";
        } else {
          elements.paymentStatus.textContent = "Payment recorded.";
        }
        return body.payment;
      } catch (error) {
        showError(elements.paymentStatus, error);
        return null;
      }
    }

    function bindEvents() {
      elements.list.addEventListener("click", (event) => {
        const button = event.target.closest?.("[data-commission-id]");

        if (button) {
          openDetail(button.dataset.commissionId);
        }
      });
      elements.newCommission.addEventListener("click", openCreate);
      elements.editCommission.addEventListener("click", openEdit);
      elements.changeStatus.addEventListener("click", openStatus);
      elements.recordPayment.addEventListener("click", openPayment);
      elements.paymentForm.elements.namedItem("payment_type").addEventListener(
        "change",
        updatePaymentSuggestions
      );
      elements.paymentForm.addEventListener("submit", submitPayment);
      elements.cancelPayment.addEventListener("click", cancelPayment);
      elements.statusForm.addEventListener("submit", prepareStatusConfirmation);
      elements.cancelStatus.addEventListener("click", cancelStatus);
      elements.confirmStatus.addEventListener("click", submitStatus);
      elements.cancelStatusConfirmation.addEventListener(
        "click",
        cancelStatusConfirmation
      );
      elements.editForm.addEventListener("submit", submitEdit);
      elements.editForm.elements.namedItem("price").addEventListener(
        "input",
        updateEditFinancialPreview
      );
      elements.editForm.elements.namedItem("sales_tax_rate").addEventListener(
        "change",
        updateEditFinancialPreview
      );
      elements.editForm.elements.namedItem("shipping").addEventListener(
        "input",
        updateEditFinancialPreview
      );
      elements.cancelEdit.addEventListener("click", cancelEdit);
      elements.createForm.addEventListener("submit", submitCreate);
      elements.createForm.elements.namedItem("price").addEventListener(
        "input",
        updateFinancialPreview
      );
      elements.createForm.elements.namedItem("sales_tax_rate").addEventListener(
        "change",
        updateFinancialPreview
      );
      elements.createForm.elements.namedItem("shipping").addEventListener(
        "input",
        updateFinancialPreview
      );
      elements.cancelCreate.addEventListener("click", closeCreate);
      elements.closeDetail.addEventListener("click", () => {
        showCommissionIndex();
      });
    }

    return {
      bindEvents,
      cancelEdit,
      cancelPayment,
      cancelStatus,
      cancelStatusConfirmation,
      closeCreate,
      loadClients,
      loadList,
      loadPayments,
      openCreate,
      openDetail,
      openEdit,
      openPayment,
      openStatus,
      prepareStatusConfirmation,
      showCommissionIndex,
      submitCreate,
      submitEdit,
      submitPayment,
      submitStatus,
      updateEditFinancialPreview,
      updateFinancialPreview,
      updatePaymentSuggestions
    };
  }

  const api = {
    API_PATH,
    CLIENTS_API_PATH,
    buildCreatePayload,
    buildEditPayload,
    buildPaymentPayload,
    calculateFinancialPreview,
    createApp,
    fetchJson,
    formatCurrency,
    inferSalesTaxRate,
    paymentMethodLabels,
    renderClientOptions,
    renderDetailMarkup,
    renderListMarkup,
    renderPaymentsMarkup,
    renderStatusOptions,
    statusTransitions
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  globalObject.AdminCommissions = api;

  if (globalObject.document) {
    const app = createApp(globalObject.document, globalObject.fetch.bind(globalObject));
    app.bindEvents();
    app.loadList();
    app.loadClients();
  }
})(typeof window !== "undefined" ? window : globalThis);
