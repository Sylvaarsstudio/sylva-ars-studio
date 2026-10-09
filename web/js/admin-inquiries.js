(function initializeAdminInquiries(globalObject) {
  const API_PATH = "/admin/api/inquiries";
  const detailFields = [
    "id",
    "form_type",
    "client_name",
    "client_email",
    "client_phone",
    "artwork_title",
    "artwork_subject",
    "artwork_size",
    "budget_range",
    "estimated_date",
    "occasion",
    "shipping_location",
    "preferred_contact_method",
    "reference_notes",
    "organization_project",
    "collaboration_type",
    "message",
    "status",
    "created_at",
    "updated_at"
  ];
  const labels = {
    id: "ID",
    form_type: "Form Type",
    client_name: "Client Name",
    client_email: "Client Email",
    client_phone: "Client Phone",
    artwork_title: "Artwork Title",
    artwork_subject: "Artwork Subject",
    artwork_size: "Artwork Size",
    budget_range: "Budget Range",
    estimated_date: "Timeline",
    occasion: "Specific Occasion",
    shipping_location: "Shipping Location",
    preferred_contact_method: "Preferred Contact Method",
    reference_notes: "Reference Notes",
    organization_project: "Organization / Project",
    collaboration_type: "Collaboration Type",
    message: "Message",
    status: "Status",
    created_at: "Created",
    updated_at: "Updated"
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

  function formatLabel(value) {
    const readableLabels = {
      artwork_inquiry: "Artwork Inquiry",
      commission_request: "Commission Request",
      within_1_month: "Within 1 month",
      within_2_months: "Within 2 months",
      within_3_months: "Within 3 months",
      valentines_day: "Valentine's Day",
      mothers_day: "Mother's Day",
      fathers_day: "Father's Day",
      wedding_anniversary: "Wedding / Anniversary",
      christmas_holiday: "Christmas / Holiday Season",
      national_holiday: "National Holiday / Patriotic Holiday"
    };

    if (readableLabels[value]) {
      return readableLabels[value];
    }

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

  function formatDetailValue(field, value) {
    if (field === "created_at" || field === "updated_at") {
      return formatDate(value);
    }

    if (["form_type", "status", "estimated_date", "occasion"].includes(field)) {
      return formatLabel(value);
    }

    return String(value);
  }

  function renderListMarkup(inquiries) {
    if (!inquiries.length) {
      return '<tr><td colspan="6" class="inquiry-empty">No inquiries match these filters.</td></tr>';
    }

    return inquiries.map((inquiry) => `
      <tr>
        <td>${escapeHtml(formatDate(inquiry.created_at))}</td>
        <td>${escapeHtml(formatLabel(inquiry.form_type))}</td>
        <td>${escapeHtml(inquiry.client_name)}</td>
        <td>${escapeHtml(inquiry.client_email)}</td>
        <td><span class="inquiry-status inquiry-status-${escapeHtml(inquiry.status)}">${escapeHtml(formatLabel(inquiry.status))}</span></td>
        <td><button type="button" class="admin-text-button inquiry-open" data-inquiry-id="${escapeHtml(inquiry.id)}">${escapeHtml(inquiry.id)}</button></td>
      </tr>
    `).join("");
  }

  function renderDetailMarkup(inquiry) {
    return `<dl class="inquiry-detail-list">${detailFields
      .filter((field) => hasContent(inquiry[field]))
      .map((field) => `
        <div class="inquiry-detail-field inquiry-detail-${escapeHtml(field)}">
          <dt>${escapeHtml(labels[field])}</dt>
          <dd>${escapeHtml(formatDetailValue(field, inquiry[field]))}</dd>
        </div>
      `).join("")}</dl>`;
  }

  function buildListUrl(status, formType) {
    const parameters = new URLSearchParams();

    if (status && status !== "all") {
      parameters.set("status", status);
    }

    if (formType && formType !== "all") {
      parameters.set("form_type", formType);
    }

    const query = parameters.toString();
    return query ? `${API_PATH}?${query}` : API_PATH;
  }

  async function fetchJson(fetchImplementation, url, options) {
    const response = await fetchImplementation(url, options);

    if (response.redirected && response.url?.includes("/admin-login.html")) {
      const error = new Error("Your admin session expired. Please sign in again.");
      error.code = "SESSION_EXPIRED";
      throw error;
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

  function createApp(documentObject, fetchImplementation, confirmImplementation = () => true) {
    const elements = {
      count: documentObject.querySelector("#inquiry-count"),
      statusFilter: documentObject.querySelector("#inquiry-status-filter"),
      formTypeFilter: documentObject.querySelector("#inquiry-form-type-filter"),
      list: documentObject.querySelector("#inquiry-list"),
      listStatus: documentObject.querySelector("#inquiry-list-status"),
      detail: documentObject.querySelector("#inquiry-detail"),
      detailFields: documentObject.querySelector("#inquiry-detail-fields"),
      detailStatus: documentObject.querySelector("#inquiry-detail-status"),
      statusForm: documentObject.querySelector("#inquiry-status-form"),
      statusSelect: documentObject.querySelector("#inquiry-status"),
      convertClient: documentObject.querySelector("#convert-inquiry-client"),
      closeDetail: documentObject.querySelector("#close-inquiry-detail")
    };
    let selectedInquiryId = "";
    let selectedInquiry = null;

    function showError(element, error) {
      element.textContent = error.message || "An unexpected error occurred.";
      element.classList?.add("is-error");
    }

    function updateConversionAction() {
      elements.convertClient.hidden = selectedInquiry?.status !== "accepted";
    }

    async function loadList() {
      elements.listStatus.textContent = "Loading inquiries…";
      elements.listStatus.classList?.remove("is-error");

      try {
        const body = await fetchJson(
          fetchImplementation,
          buildListUrl(elements.statusFilter.value, elements.formTypeFilter.value)
        );
        elements.list.innerHTML = renderListMarkup(body.inquiries);
        elements.count.textContent = String(body.total);
        elements.listStatus.textContent = "";
        return body.inquiries;
      } catch (error) {
        elements.list.innerHTML = "";
        elements.count.textContent = "0";
        showError(elements.listStatus, error);
        return [];
      }
    }

    async function openDetail(id) {
      elements.detailStatus.textContent = "Loading inquiry…";
      elements.detailStatus.classList?.remove("is-error");
      elements.detail.hidden = false;

      try {
        const body = await fetchJson(
          fetchImplementation,
          `${API_PATH}/${encodeURIComponent(id)}`
        );
        selectedInquiryId = body.inquiry.id;
        selectedInquiry = body.inquiry;
        elements.detailFields.innerHTML = renderDetailMarkup(body.inquiry);
        elements.statusSelect.value = body.inquiry.status;
        updateConversionAction();
        elements.detailStatus.textContent = "";
        return body.inquiry;
      } catch (error) {
        selectedInquiryId = "";
        selectedInquiry = null;
        elements.detailFields.innerHTML = "";
        updateConversionAction();
        showError(elements.detailStatus, error);
        return null;
      }
    }

    async function updateStatus() {
      if (!selectedInquiryId) {
        return null;
      }

      elements.detailStatus.textContent = "Updating status…";
      elements.detailStatus.classList?.remove("is-error");

      try {
        const body = await fetchJson(
          fetchImplementation,
          `${API_PATH}/${encodeURIComponent(selectedInquiryId)}`,
          {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({ status: elements.statusSelect.value })
          }
        );
        selectedInquiry = {
          ...selectedInquiry,
          ...body.inquiry
        };
        elements.detailFields.innerHTML = renderDetailMarkup(selectedInquiry);
        updateConversionAction();
        elements.detailStatus.textContent = "Status updated.";
        await loadList();
        return body.inquiry;
      } catch (error) {
        showError(elements.detailStatus, error);
        return null;
      }
    }

    async function convertToClient() {
      if (
        !selectedInquiryId
        || selectedInquiry?.status !== "accepted"
        || !confirmImplementation("Convert this accepted inquiry to a client?")
      ) {
        return null;
      }

      elements.detailStatus.textContent = "Converting inquiry…";
      elements.detailStatus.classList?.remove("is-error");

      try {
        const body = await fetchJson(
          fetchImplementation,
          `${API_PATH}/${encodeURIComponent(selectedInquiryId)}/convert-client`,
          { method: "POST" }
        );
        elements.detailStatus.textContent = body.created
          ? "Client created."
          : "Existing client linked/found.";
        return body;
      } catch (error) {
        showError(elements.detailStatus, error);
        return null;
      }
    }

    function bindEvents() {
      elements.statusFilter.addEventListener("change", loadList);
      elements.formTypeFilter.addEventListener("change", loadList);
      elements.list.addEventListener("click", (event) => {
        const button = event.target.closest?.("[data-inquiry-id]");

        if (button) {
          openDetail(button.dataset.inquiryId);
        }
      });
      elements.statusForm.addEventListener("submit", (event) => {
        event.preventDefault();
        updateStatus();
      });
      elements.convertClient.addEventListener("click", convertToClient);
      elements.closeDetail.addEventListener("click", () => {
        elements.detail.hidden = true;
        selectedInquiryId = "";
        selectedInquiry = null;
        updateConversionAction();
      });
    }

    return {
      bindEvents,
      convertToClient,
      loadList,
      openDetail,
      updateStatus
    };
  }

  const api = {
    API_PATH,
    buildListUrl,
    createApp,
    fetchJson,
    formatLabel,
    renderDetailMarkup,
    renderListMarkup
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  globalObject.AdminInquiries = api;

  if (globalObject.document) {
    const app = createApp(
      globalObject.document,
      globalObject.fetch.bind(globalObject),
      globalObject.confirm.bind(globalObject)
    );
    app.bindEvents();
    app.loadList();
  }
})(typeof window !== "undefined" ? window : globalThis);
