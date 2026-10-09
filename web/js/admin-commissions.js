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
    return `<dl class="inquiry-detail-list">${detailFields
      .filter((field) => hasContent(commission[field]))
      .map((field) => `
        <div class="inquiry-detail-field">
          <dt>${escapeHtml(labels[field])}</dt>
          <dd>${escapeHtml(formatDetailValue(field, commission[field]))}</dd>
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
      sales_tax: readNumber(form, "sales_tax", "Sales tax", { defaultValue: 0 }),
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
      createPanel: documentObject.querySelector("#commission-create"),
      createForm: documentObject.querySelector("#commission-form"),
      createStatus: documentObject.querySelector("#commission-create-status"),
      cancelCreate: documentObject.querySelector("#cancel-commission")
    };
    let commissions = [];

    function showError(element, error) {
      element.textContent = error.message || "An unexpected error occurred.";
      element.classList?.add("is-error");
    }

    function renderList() {
      elements.list.innerHTML = renderListMarkup(commissions);
      elements.count.textContent = String(commissions.length);
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
        elements.detailFields.innerHTML = renderDetailMarkup(body.commission);
        elements.detailStatus.textContent = "";
        return body.commission;
      } catch (error) {
        elements.detailFields.innerHTML = "";
        showError(elements.detailStatus, error);
        return null;
      }
    }

    function openCreate() {
      elements.detail.hidden = true;
      elements.createPanel.hidden = false;
      elements.createForm.reset();
      elements.createForm.elements.namedItem("sales_tax").value = "0";
      elements.createForm.elements.namedItem("shipping").value = "0";
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

    function bindEvents() {
      elements.list.addEventListener("click", (event) => {
        const button = event.target.closest?.("[data-commission-id]");

        if (button) {
          openDetail(button.dataset.commissionId);
        }
      });
      elements.newCommission.addEventListener("click", openCreate);
      elements.createForm.addEventListener("submit", submitCreate);
      elements.cancelCreate.addEventListener("click", closeCreate);
      elements.closeDetail.addEventListener("click", () => {
        elements.detail.hidden = true;
        elements.detailFields.innerHTML = "";
        elements.detailStatus.textContent = "";
      });
    }

    return {
      bindEvents,
      closeCreate,
      loadClients,
      loadList,
      openCreate,
      openDetail,
      submitCreate
    };
  }

  const api = {
    API_PATH,
    CLIENTS_API_PATH,
    buildCreatePayload,
    createApp,
    fetchJson,
    formatCurrency,
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
