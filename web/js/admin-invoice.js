(function initializeAdminInvoice(globalObject) {
  const paymentMethodLabels = {
    cash: "Cash",
    card: "Credit / Debit Card",
    bank_transfer: "Bank Transfer",
    check: "Check",
    zelle: "Zelle",
    paypal: "PayPal"
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

  function formatCurrency(value) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD"
    }).format(Number(value));
  }

  function formatDate(value) {
    if (!hasContent(value)) {
      return "";
    }

    const normalized = String(value);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(normalized)
      ? new Date(`${normalized}T00:00:00Z`)
      : new Date(normalized);

    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "long",
      timeZone: "UTC"
    }).format(date);
  }

  function formatLabel(value) {
    return String(value)
      .replace(/_/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function renderAddress(client) {
    const locality = [client.city, client.state, client.postal_code]
      .filter(hasContent)
      .join(", ")
      .replace(/, ([^,]+)$/, " $1");
    const lines = [
      client.address_line_1,
      client.address_line_2,
      locality,
      client.country
    ].filter(hasContent);

    return lines.length
      ? `<p>${lines.map((line) => escapeHtml(line)).join("<br>")}</p>`
      : "";
  }

  function renderFinancialRow(label, value, className = "") {
    return `
      <tr class="${escapeHtml(className)}">
        <th scope="row">${escapeHtml(label)}</th>
        <td>${escapeHtml(formatCurrency(value))}</td>
      </tr>`;
  }

  function renderPaymentHistory(payments) {
    if (!payments.length) {
      return '<tr><td colspan="6" class="empty-payment-history">No completed payments.</td></tr>';
    }

    return payments.map((payment) => {
      const method = hasContent(payment.payment_method)
        ? paymentMethodLabels[payment.payment_method] || formatLabel(payment.payment_method)
        : "—";

      return `
        <tr>
          <td>${hasContent(payment.payment_date) ? escapeHtml(formatDate(payment.payment_date)) : "—"}</td>
          <td>${escapeHtml(formatLabel(payment.payment_type))}</td>
          <td>${escapeHtml(formatCurrency(payment.amount))}</td>
          <td>${escapeHtml(method)}</td>
          <td>${hasContent(payment.receipt_number) ? escapeHtml(payment.receipt_number) : "—"}</td>
          <td>${hasContent(payment.external_reference) ? escapeHtml(payment.external_reference) : "—"}</td>
        </tr>`;
    }).join("");
  }

  function renderInvoiceMarkup(snapshot) {
    const invoice = snapshot.invoice || {};
    const studio = snapshot.studio || {};
    const client = snapshot.client || {};
    const commission = snapshot.commission || {};
    const financial = snapshot.financial || {};
    const dimensions = [commission.width, commission.height].every(hasContent)
      ? `${commission.width} × ${commission.height} in`
      : null;

    return `
      <header class="invoice-header">
        <div>
          <p>${escapeHtml(studio.name || "Sylva Ars Studio LLC")}</p>
          <h1>FINAL INVOICE</h1>
          <p class="invoice-paid-status">${escapeHtml(invoice.financial_status || "PAID")}</p>
        </div>
        <dl class="invoice-meta">
          <dt>Invoice Number</dt>
          <dd>${escapeHtml(invoice.number || "")}</dd>
          <dt>Invoice Date</dt>
          <dd>${escapeHtml(formatDate(invoice.invoice_date))}</dd>
        </dl>
      </header>

      <section class="section two-columns">
        <div>
          <h2>Client</h2>
          <p><strong>${escapeHtml(client.name || "")}</strong></p>
          ${hasContent(client.email) ? `<p>${escapeHtml(client.email)}</p>` : ""}
          ${hasContent(client.phone) ? `<p>${escapeHtml(client.phone)}</p>` : ""}
          ${renderAddress(client)}
        </div>
        <div>
          <h2>Studio</h2>
          <p><strong>${escapeHtml(studio.name || "")}</strong></p>
          ${hasContent(studio.address_line_1) ? `<p>${escapeHtml(studio.address_line_1)}</p>` : ""}
          ${hasContent(studio.address_line_2) ? `<p>${escapeHtml(studio.address_line_2)}</p>` : ""}
          ${hasContent(studio.email) ? `<p>${escapeHtml(studio.email)}</p>` : ""}
          ${hasContent(studio.phone) ? `<p>${escapeHtml(studio.phone)}</p>` : ""}
          ${hasContent(studio.website) ? `<p>${escapeHtml(studio.website)}</p>` : ""}
        </div>
      </section>

      <section class="section">
        <h2>Commission</h2>
        <table>
          <tbody>
            <tr><th scope="row">Commission Number</th><td>${escapeHtml(commission.number || "")}</td></tr>
            <tr><th scope="row">Title</th><td>${escapeHtml(commission.title || "")}</td></tr>
            ${hasContent(commission.description) ? `<tr><th scope="row">Description</th><td>${escapeHtml(commission.description)}</td></tr>` : ""}
            ${hasContent(commission.medium) ? `<tr><th scope="row">Medium</th><td>${escapeHtml(commission.medium)}</td></tr>` : ""}
            ${dimensions ? `<tr><th scope="row">Dimensions</th><td>${escapeHtml(dimensions)}</td></tr>` : ""}
          </tbody>
        </table>
      </section>

      <section class="section financial-summary">
        <h2>Financial Summary</h2>
        <table class="summary-table">
          <tbody>
            ${renderFinancialRow("Subtotal", financial.price)}
            ${renderFinancialRow("Sales Tax", financial.sales_tax)}
            ${renderFinancialRow("Shipping", financial.shipping)}
            ${renderFinancialRow("Total", financial.total)}
            ${renderFinancialRow("Amount Paid", financial.amount_paid)}
            ${renderFinancialRow("Balance Due", financial.balance, "amount-due-row")}
          </tbody>
        </table>
      </section>

      <section class="section payment-history">
        <h2>Payment History</h2>
        <table class="payment-history-table">
          <thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Method</th><th>Receipt</th><th>Reference</th></tr></thead>
          <tbody>${renderPaymentHistory(snapshot.payments || [])}</tbody>
        </table>
      </section>

      <footer>
        <p>Paid in full · Balance due ${escapeHtml(formatCurrency(financial.balance || "0.00"))}</p>
      </footer>`;
  }

  async function fetchInvoice(fetchImplementation, invoiceId) {
    const response = await fetchImplementation(
      `/admin/api/documents/invoices/${encodeURIComponent(invoiceId)}`
    );
    let body;

    try {
      body = await response.json();
    } catch {
      body = null;
    }

    if (!response.ok) {
      throw new Error(body?.message || "Unable to load invoice.");
    }

    return body.invoice;
  }

  function createApp(documentObject, fetchImplementation, locationObject, printFunction) {
    const elements = {
      status: documentObject.querySelector("#invoice-status"),
      invoice: documentObject.querySelector("#final-invoice"),
      print: documentObject.querySelector("#print-invoice"),
      back: documentObject.querySelector("#back-to-commission")
    };

    async function load() {
      const invoiceId = new URLSearchParams(locationObject.search).get("document");

      if (!invoiceId || !/^[1-9][0-9]*$/.test(invoiceId)) {
        elements.status.textContent = "Invalid invoice reference.";
        elements.status.classList?.add("is-error");
        return null;
      }

      try {
        const invoice = await fetchInvoice(fetchImplementation, invoiceId);
        elements.invoice.innerHTML = renderInvoiceMarkup(invoice.snapshot);
        elements.invoice.hidden = false;
        elements.status.textContent = "";
        return invoice;
      } catch (error) {
        elements.invoice.hidden = true;
        elements.status.textContent = error.message;
        elements.status.classList?.add("is-error");
        return null;
      }
    }

    function bindEvents() {
      elements.print.addEventListener("click", () => printFunction());
    }

    return { bindEvents, load };
  }

  const api = {
    createApp,
    fetchInvoice,
    formatCurrency,
    paymentMethodLabels,
    renderInvoiceMarkup,
    renderPaymentHistory
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  globalObject.AdminInvoice = api;

  if (globalObject.document) {
    const app = createApp(
      globalObject.document,
      globalObject.fetch.bind(globalObject),
      globalObject.location,
      globalObject.print.bind(globalObject)
    );
    app.bindEvents();
    app.load();
  }
})(typeof window !== "undefined" ? window : globalThis);
