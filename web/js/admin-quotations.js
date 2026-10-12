(function initializeAdminQuotations(globalObject) {
  const API_PATH = "/admin/api/quotations";
  const escapeHtml = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  const formatCurrency = (value) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(value || 0));
  const formatDate = (value) => value ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(value)) : "—";
  function renderListMarkup(quotations) {
    if (!quotations.length) return '<tr><td colspan="8" class="inquiry-empty">No quotations match this filter.</td></tr>';
    return quotations.map((quotation) => `<tr><td>${escapeHtml(quotation.client_name)}</td><td>${escapeHtml(quotation.quotation_number)}</td><td>v${escapeHtml(quotation.version)}</td><td>${escapeHtml(quotation.quotation_status)}</td><td>${escapeHtml(formatCurrency(quotation.quotation_snapshot?.commercial?.total ?? (Number(quotation.price) + Number(quotation.sales_tax) + Number(quotation.shipping_charge))))}</td><td>${escapeHtml(formatDate(quotation.issued_at))}</td><td>${escapeHtml(formatDate(quotation.expires_at))}</td><td><a class="admin-text-link" href="quotation.html?id=${encodeURIComponent(quotation.id)}">View</a></td></tr>`).join("");
  }
  async function fetchJson(fetchImplementation, url) {
    const response = await fetchImplementation(url);
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.message || "Unable to load quotations.");
    return body;
  }
  function createApp(documentObject, fetchImplementation) {
    const list = documentObject.querySelector("#quotation-list");
    const status = documentObject.querySelector("#quotation-status-filter");
    const notice = documentObject.querySelector("#quotation-list-status");
    async function load() {
      const url = status.value ? `${API_PATH}?status=${encodeURIComponent(status.value)}` : API_PATH;
      try {
        const body = await fetchJson(fetchImplementation, url);
        list.innerHTML = renderListMarkup(body.quotations);
        notice.textContent = "";
        return body.quotations;
      } catch (error) {
        notice.textContent = error.message;
        return [];
      }
    }
    function bindEvents() { status.addEventListener("change", load); }
    return { bindEvents, load };
  }
  const api = { API_PATH, createApp, fetchJson, renderListMarkup };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalObject.AdminQuotations = api;
  if (globalObject.document) { const app = createApp(globalObject.document, globalObject.fetch.bind(globalObject)); app.bindEvents(); app.load(); }
})(typeof window !== "undefined" ? window : globalThis);
