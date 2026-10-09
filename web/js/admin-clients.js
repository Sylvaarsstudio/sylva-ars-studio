(function initializeAdminClients(globalObject) {
  const API_PATH = "/admin/api/clients";
  const detailFields = ["id", "full_name", "email", "phone", "created_at"];
  const labels = {
    id: "ID",
    full_name: "Full Name",
    email: "Email",
    phone: "Phone",
    created_at: "Created"
  };

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

  async function fetchJson(fetchImplementation, url) {
    const response = await fetchImplementation(url);

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
      count: documentObject.querySelector("#client-count"),
      list: documentObject.querySelector("#client-list"),
      listStatus: documentObject.querySelector("#client-list-status"),
      detail: documentObject.querySelector("#client-detail"),
      detailFields: documentObject.querySelector("#client-detail-fields"),
      detailStatus: documentObject.querySelector("#client-detail-status"),
      closeDetail: documentObject.querySelector("#close-client-detail")
    };

    function showError(element, error) {
      element.textContent = error.message || "An unexpected error occurred.";
      element.classList?.add("is-error");
    }

    async function loadList() {
      elements.listStatus.textContent = "Loading clients…";
      elements.listStatus.classList?.remove("is-error");

      try {
        const body = await fetchJson(fetchImplementation, API_PATH);
        elements.list.innerHTML = renderListMarkup(body.clients);
        elements.count.textContent = String(body.total);
        elements.listStatus.textContent = "";
        return body.clients;
      } catch (error) {
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

      try {
        const body = await fetchJson(
          fetchImplementation,
          `${API_PATH}/${encodeURIComponent(id)}`
        );
        elements.detailFields.innerHTML = renderDetailMarkup(body.client);
        elements.detailStatus.textContent = "";
        return body.client;
      } catch (error) {
        elements.detailFields.innerHTML = "";
        showError(elements.detailStatus, error);
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
      elements.closeDetail.addEventListener("click", () => {
        elements.detail.hidden = true;
        elements.detailFields.innerHTML = "";
        elements.detailStatus.textContent = "";
      });
    }

    return {
      bindEvents,
      loadList,
      openDetail
    };
  }

  const api = {
    API_PATH,
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
