(function initializeAdminCommissions(globalObject) {
  const API_PATH = "/admin/api/commissions";
  const CLIENTS_API_PATH = "/admin/api/clients";
  const detailFields = [
    "commission_number",
    "client_name",
    "client_email",
    "title",
    "description",
    "medium",
    "width",
    "height",
    "price",
    "required_deposit",
    "deposit_amount",
    "sales_tax",
    "shipping",
    "balance",
    "status",
    "estimated_completion",
    "created_at",
    "id"
  ];
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
    required_deposit: "Required Deposit (50%)",
    deposit_amount: "Deposit Amount",
    sales_tax: "Sales Tax",
    shipping: "Shipping",
    balance: "Balance",
    status: "Status",
    estimated_completion: "Estimated Completion",
    created_at: "Created",
    id: "ID"
  };
  const moneyFields = new Set([
    "price",
    "required_deposit",
    "deposit_amount",
    "sales_tax",
    "shipping",
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
      required_deposit: Math.round(toCents(commission.price) / 2) / 100
    };

    return `<dl class="inquiry-detail-list">${detailFields
      .filter((field) => hasContent(detail[field]))
      .map((field) => `
        <div class="inquiry-detail-field">
          <dt>${escapeHtml(labels[field])}</dt>
          <dd>${escapeHtml(formatDetailValue(field, detail[field]))}</dd>
        </div>
      `).join("")}</dl>`;
  }

  function renderClientOptions(clients) {
    return '<option value="">Select one</option>' + clients.map((client) =>
      `<option value="${escapeHtml(client.id)}">${escapeHtml(client.full_name)} — ${escapeHtml(client.email)}</option>`
    ).join("");
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

  function createApp(documentObject, fetchImplementation) {
    const elements = {
      count: documentObject.querySelector("#commission-count"),
      list: documentObject.querySelector("#commission-list"),
      listStatus: documentObject.querySelector("#commission-list-status"),
      newCommission: documentObject.querySelector("#new-commission"),
      detail: documentObject.querySelector("#commission-detail"),
      detailFields: documentObject.querySelector("#commission-detail-fields"),
      detailStatus: documentObject.querySelector("#commission-detail-status"),
      closeDetail: documentObject.querySelector("#close-commission-detail"),
      editCommission: documentObject.querySelector("#edit-commission"),
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

    function showError(element, error) {
      element.textContent = error.message || "An unexpected error occurred.";
      element.classList?.add("is-error");
    }

    function renderList() {
      elements.list.innerHTML = renderListMarkup(commissions);
      elements.count.textContent = String(commissions.length);
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
      elements.detailFields.hidden = false;
      elements.editCommission.hidden = false;
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

    async function openDetail(id) {
      elements.createPanel.hidden = true;
      elements.detail.hidden = false;
      elements.detailStatus.textContent = "Loading commission…";
      elements.detailStatus.classList?.remove("is-error");

      try {
        const body = await fetchJson(
          fetchImplementation,
          `${API_PATH}/${encodeURIComponent(id)}`
        );
        selectedCommission = body.commission;
        elements.detailFields.innerHTML = renderDetailMarkup(selectedCommission);
        showReadOnlyDetail();
        elements.detailStatus.textContent = "";
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

    function openCreate() {
      elements.detail.hidden = true;
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
        commissions = [body.commission, ...commissions];
        renderList();
        elements.createPanel.hidden = true;
        elements.detail.hidden = false;
        elements.detailFields.innerHTML = renderDetailMarkup(body.commission);
        elements.detailStatus.textContent = "Commission created.";
        return body.commission;
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

    function bindEvents() {
      elements.list.addEventListener("click", (event) => {
        const button = event.target.closest?.("[data-commission-id]");

        if (button) {
          openDetail(button.dataset.commissionId);
        }
      });
      elements.newCommission.addEventListener("click", openCreate);
      elements.editCommission.addEventListener("click", openEdit);
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
        elements.detail.hidden = true;
        elements.detailFields.innerHTML = "";
        elements.detailStatus.textContent = "";
        selectedCommission = null;
        showReadOnlyDetail();
      });
    }

    return {
      bindEvents,
      cancelEdit,
      closeCreate,
      loadClients,
      loadList,
      openCreate,
      openDetail,
      openEdit,
      submitCreate,
      submitEdit,
      updateEditFinancialPreview,
      updateFinancialPreview
    };
  }

  const api = {
    API_PATH,
    CLIENTS_API_PATH,
    buildCreatePayload,
    buildEditPayload,
    calculateFinancialPreview,
    createApp,
    fetchJson,
    formatCurrency,
    inferSalesTaxRate,
    renderClientOptions,
    renderDetailMarkup,
    renderListMarkup
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
