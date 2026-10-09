(function initializeAdminClients(globalObject) {
  const API_PATH = "/admin/api/clients";
  const detailFields = [
    "id",
    "full_name",
    "email",
    "phone",
    "address_line_1",
    "address_line_2",
    "city",
    "state",
    "postal_code",
    "country",
    "created_at"
  ];
  const labels = {
    id: "ID",
    full_name: "Full Name",
    email: "Email",
    phone: "Phone",
    address_line_1: "Address Line 1",
    address_line_2: "Address Line 2",
    city: "City",
    state: "State",
    postal_code: "Postal Code",
    country: "Country",
    created_at: "Created"
  };
  const editableFields = [
    "full_name",
    "email",
    "phone",
    "address_line_1",
    "address_line_2",
    "city",
    "state",
    "postal_code",
    "country"
  ];

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

  function formatDate(value) {
    if (!value) {
      return "";
    }

    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(new Date(value));
  }

  function renderListMarkup(clients) {
    if (!clients.length) {
      return '<tr><td colspan="5" class="inquiry-empty">No clients yet.</td></tr>';
    }

    return clients.map((client) => `
      <tr>
        <td><button type="button" class="admin-text-button" data-client-id="${escapeHtml(client.id)}">${escapeHtml(client.full_name)}</button></td>
        <td>${escapeHtml(client.email)}</td>
        <td>${escapeHtml(client.phone || "")}</td>
        <td>${escapeHtml(formatDate(client.created_at))}</td>
        <td>${escapeHtml(client.id)}</td>
      </tr>
    `).join("");
  }

  function renderDetailMarkup(client) {
    return `<dl class="inquiry-detail-list">${detailFields
      .filter((field) => hasContent(client[field]))
      .map((field) => `
        <div class="inquiry-detail-field">
          <dt>${escapeHtml(labels[field])}</dt>
          <dd>${escapeHtml(field === "created_at" ? formatDate(client[field]) : client[field])}</dd>
        </div>
      `).join("")}</dl>`;
  }

  function buildUpdatePayload(form) {
    const payload = {};

    for (const field of editableFields) {
      const value = String(form.elements.namedItem(field).value || "").trim();
      payload[field] = field === "full_name" || field === "email"
        ? value
        : value || null;
    }

    if (!payload.full_name || !payload.email) {
      throw new Error("Full Name and Email are required.");
    }

    return payload;
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
      const error = new Error(body?.message || "The admin request could not be completed.");
      error.status = response.status;
      throw error;
    }

    return body;
  }

  function createApp(documentObject, fetchImplementation) {
    const elements = {
      count: documentObject.querySelector("#client-count"),
      list: documentObject.querySelector("#client-list"),
      listStatus: documentObject.querySelector("#client-list-status"),
      detail: documentObject.querySelector("#client-detail"),
      detailFields: documentObject.querySelector("#client-detail-fields"),
      detailActions: documentObject.querySelector("#client-detail-actions"),
      detailStatus: documentObject.querySelector("#client-detail-status"),
      editClient: documentObject.querySelector("#edit-client"),
      editForm: documentObject.querySelector("#client-edit-form"),
      cancelEdit: documentObject.querySelector("#cancel-client-edit"),
      closeDetail: documentObject.querySelector("#close-client-detail")
    };
    let clients = [];
    let selectedClient = null;

    function showError(element, error) {
      element.textContent = error.message || "An unexpected error occurred.";
      element.classList?.add("is-error");
    }

    function populateEditForm(client) {
      for (const field of editableFields) {
        elements.editForm.elements.namedItem(field).value = client[field] || "";
      }
    }

    function showReadOnlyDetail() {
      elements.detailFields.hidden = false;
      elements.detailActions.hidden = false;
      elements.editForm.hidden = true;
    }

    function beginEdit() {
      if (!selectedClient) {
        return;
      }

      populateEditForm(selectedClient);
      elements.detailFields.hidden = true;
      elements.detailActions.hidden = true;
      elements.editForm.hidden = false;
      elements.detailStatus.textContent = "";
      elements.detailStatus.classList?.remove("is-error");
    }

    function cancelEdit() {
      if (selectedClient) {
        populateEditForm(selectedClient);
      }

      showReadOnlyDetail();
      elements.detailStatus.textContent = "";
      elements.detailStatus.classList?.remove("is-error");
    }

    async function loadList() {
      elements.listStatus.textContent = "Loading clients…";
      elements.listStatus.classList?.remove("is-error");

      try {
        const body = await fetchJson(fetchImplementation, API_PATH);
        clients = body.clients;
        elements.list.innerHTML = renderListMarkup(body.clients);
        elements.count.textContent = String(body.total);
        elements.listStatus.textContent = "";
        return body.clients;
      } catch (error) {
        clients = [];
        elements.list.innerHTML = "";
        elements.count.textContent = "0";
        showError(elements.listStatus, error);
        return [];
      }
    }

    async function openDetail(id) {
      elements.detailStatus.textContent = "Loading client…";
      elements.detailStatus.classList?.remove("is-error");
      elements.detail.hidden = false;
      elements.detailActions.hidden = true;
      elements.editForm.hidden = true;

      try {
        const body = await fetchJson(
          fetchImplementation,
          `${API_PATH}/${encodeURIComponent(id)}`
        );
        selectedClient = body.client;
        elements.detailFields.innerHTML = renderDetailMarkup(body.client);
        showReadOnlyDetail();
        elements.detailStatus.textContent = "";
        return body.client;
      } catch (error) {
        selectedClient = null;
        elements.detailFields.innerHTML = "";
        elements.detailActions.hidden = true;
        elements.editForm.hidden = true;
        showError(elements.detailStatus, error);
        return null;
      }
    }

    async function saveChanges(event) {
      event?.preventDefault();

      if (!selectedClient) {
        return null;
      }

      let payload;

      try {
        payload = buildUpdatePayload(elements.editForm);
      } catch (error) {
        showError(elements.detailStatus, error);
        return null;
      }

      elements.detailStatus.textContent = "Saving changes…";
      elements.detailStatus.classList?.remove("is-error");

      try {
        const body = await fetchJson(
          fetchImplementation,
          `${API_PATH}/${encodeURIComponent(selectedClient.id)}`,
          {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
          }
        );
        selectedClient = body.client;
        clients = clients.map((client) => String(client.id) === String(body.client.id)
          ? body.client
          : client);
        elements.detailFields.innerHTML = renderDetailMarkup(body.client);
        elements.list.innerHTML = renderListMarkup(clients);
        showReadOnlyDetail();
        elements.detailStatus.textContent = "Client updated.";
        return body.client;
      } catch (error) {
        const message = error.status === 409
          ? "Email already belongs to another client."
          : "Unable to update client.";
        showError(elements.detailStatus, new Error(message));
        return null;
      }
    }

    function bindEvents() {
      elements.list.addEventListener("click", (event) => {
        const button = event.target.closest?.("[data-client-id]");

        if (button) {
          openDetail(button.dataset.clientId);
        }
      });
      elements.editClient.addEventListener("click", beginEdit);
      elements.editForm.addEventListener("submit", saveChanges);
      elements.cancelEdit.addEventListener("click", cancelEdit);
      elements.closeDetail.addEventListener("click", () => {
        elements.detail.hidden = true;
        elements.detailFields.innerHTML = "";
        elements.detailActions.hidden = true;
        elements.editForm.hidden = true;
        elements.detailStatus.textContent = "";
        selectedClient = null;
      });
    }

    return {
      beginEdit,
      bindEvents,
      cancelEdit,
      loadList,
      openDetail,
      saveChanges
    };
  }

  const api = {
    API_PATH,
    buildUpdatePayload,
    createApp,
    fetchJson,
    renderDetailMarkup,
    renderListMarkup
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  globalObject.AdminClients = api;

  if (globalObject.document) {
    const app = createApp(globalObject.document, globalObject.fetch.bind(globalObject));
    app.bindEvents();
    app.loadList();
  }
})(typeof window !== "undefined" ? window : globalThis);
