(function initializePaymentReceipt(globalObject) {
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

  function renderRow(label, value, { money = false } = {}) {
    if (!hasContent(value)) {
      return "";
    }

    const displayValue = money ? formatCurrency(value) : value;
    return `
      <div class="receipt-row">
        <dt>${escapeHtml(label)}</dt>
        <dd>${escapeHtml(displayValue)}</dd>
      </div>`;
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
      ? `<address>${lines.map((line) => escapeHtml(line)).join("<br>")}</address>`
      : "";
  }

  function renderReceiptMarkup(snapshot) {
    const receipt = snapshot.receipt || {};
    const payment = snapshot.payment || {};
    const commission = snapshot.commission || {};
    const client = snapshot.client || {};
    const studio = snapshot.studio || {};
    const method = hasContent(payment.method)
      ? paymentMethodLabels[payment.method] || formatLabel(payment.method)
      : null;

    return `
      <header class="receipt-header">
        <div>
          <p class="receipt-studio-name">${escapeHtml(studio.name || "Sylva Ars Studio")}</p>
          <h1>Payment Receipt</h1>
        </div>
        <dl class="receipt-meta">
          ${renderRow("Receipt Number", receipt.number)}
          ${renderRow("Date", formatDate(receipt.issued_at))}
        </dl>
      </header>

      <section class="receipt-section">
        <h2>Client</h2>
        <p class="receipt-primary-value">${escapeHtml(client.name || "")}</p>
        ${hasContent(client.email) ? `<p>${escapeHtml(client.email)}</p>` : ""}
        ${renderAddress(client)}
      </section>

      <section class="receipt-section">
        <h2>Commission</h2>
        <dl>
          ${renderRow("Commission Number", commission.number)}
          ${renderRow("Title", commission.title)}
        </dl>
      </section>

      <section class="receipt-section">
        <h2>Payment</h2>
        <dl>
          ${renderRow("Type", hasContent(payment.type) ? formatLabel(payment.type) : null)}
          ${renderRow("Amount Received", payment.amount, { money: true })}
          ${renderRow("Sales Tax Portion", payment.sales_tax, { money: true })}
          ${renderRow("Payment Method", method)}
          ${renderRow("Payment Date", formatDate(payment.payment_date))}
          ${renderRow("External Reference", payment.external_reference)}
          ${renderRow("Notes", payment.notes)}
        </dl>
      </section>

      <section class="receipt-section receipt-financial">
        <h2>Financial</h2>
        <dl>
          ${renderRow("Commission Total", commission.total, { money: true })}
          ${renderRow("Balance After Payment", payment.balance_after_payment, { money: true })}
        </dl>
      </section>

      <footer class="receipt-footer">
        <p>Thank you for your payment.</p>
        <p>${[studio.email, studio.phone, studio.website].filter(hasContent).map(escapeHtml).join(" · ")}</p>
      </footer>`;
  }

  async function fetchReceipt(fetchImplementation, receiptId) {
    const response = await fetchImplementation(
      `/admin/api/receipts/${encodeURIComponent(receiptId)}`
    );

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
      throw new Error(body?.message || "Unable to load receipt.");
    }

    return body.receipt;
  }

  function createApp(documentObject, fetchImplementation, locationObject, printFunction) {
    const elements = {
      status: documentObject.querySelector("#receipt-status"),
      receipt: documentObject.querySelector("#payment-receipt"),
      print: documentObject.querySelector("#print-receipt"),
      back: documentObject.querySelector("#back-to-commission")
    };

    async function load() {
      const receiptId = new URLSearchParams(locationObject.search).get("receipt");

      if (!receiptId || !/^[1-9][0-9]*$/.test(receiptId)) {
        elements.status.textContent = "Invalid receipt reference.";
        elements.status.classList?.add("is-error");
        return null;
      }

      try {
        const receipt = await fetchReceipt(fetchImplementation, receiptId);
        elements.receipt.innerHTML = renderReceiptMarkup(receipt.snapshot);
        elements.receipt.hidden = false;
        elements.status.textContent = "";
        return receipt;
      } catch (error) {
        elements.receipt.hidden = true;
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
    fetchReceipt,
    formatCurrency,
    paymentMethodLabels,
    renderReceiptMarkup
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  globalObject.AdminPaymentReceipt = api;

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
