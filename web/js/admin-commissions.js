(function initializeAdminCommissions(globalObject) {
  const API_PATH = "/admin/api/commissions";
  const CLIENTS_API_PATH = "/admin/api/clients";
  const INQUIRIES_API_PATH = "/admin/api/inquiries";
  const DOCUMENTS_API_PATH = "/admin/api/documents";
  const QUOTATIONS_API_PATH = "/admin/api/quotations";
  const CONTRACT_ELIGIBILITY_API_PATH = "/admin/api/contracts/eligibility";
  const COMMUNICATIONS_API_PATH = "/admin/api/communications";
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
  const documentTypeLabels = {
    receipt: "Receipt",
    invoice: "Invoice",
    contract: "Contract",
    quotation: "Quotation",
    coa: "COA"
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
  const fieldHelpKeys = {
    required_deposit: "required_deposit",
    deposit_amount: "deposit_received",
    balance: "outstanding_balance"
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

  function getCommissionDisplayStatus(commission) {
    return commission?.lifecycle_status || commission?.status || "";
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

  function renderHelpTrigger(key, label) {
    return `<button type="button" class="admin-help-trigger" data-glossary-key="${escapeHtml(key)}" aria-label="Learn about ${escapeHtml(label)}" aria-expanded="false" aria-controls="admin-glossary-popover">i</button>`;
  }

  function renderListMarkup(commissions) {
    if (!commissions.length) {
      return '<tr><td colspan="8" class="inquiry-empty">No commissions yet.</td></tr>';
    }

    return commissions.map((commission) => `
      <tr>
        <td><a class="admin-text-link" href="commissions.html?commission_id=${encodeURIComponent(commission.id)}" data-commission-id="${escapeHtml(commission.id)}">${escapeHtml(commission.commission_number)}</a></td>
        <td>${escapeHtml(commission.client_name)}</td>
        <td>${escapeHtml(commission.title)}</td>
        <td>${escapeHtml(formatLabel(getCommissionDisplayStatus(commission)))}</td>
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
        <dt>${escapeHtml(labels[field])}${fieldHelpKeys[field] ? renderHelpTrigger(fieldHelpKeys[field], labels[field]) : ""}</dt>
        <dd>${escapeHtml(formatDetailValue(field, detail[field]))}</dd>
      </div>
    ` : "";
    const hasCanonicalLifecycle = hasContent(detail.lifecycle_status);
    const lifecycleLabel = hasCanonicalLifecycle
      ? `Lifecycle: ${formatLabel(detail.lifecycle_status)}`
      : `Status: ${formatLabel(detail.status)}`;
    const lifecycleHelpKey = hasCanonicalLifecycle
      ? detail.lifecycle_status === "active" ? "commission.active" : "commission_overview"
      : "commission.legacy_status";
    return `
      <article class="commission-detail-summary" aria-labelledby="commission-overview-title">
        <div class="commission-overview-heading">
          <h2 id="commission-overview-title">Overview ${renderHelpTrigger("commission_overview", "Commission Overview")}</h2>
        </div>
        <header class="commission-detail-header">
          <div>
            <p class="commission-number">${escapeHtml(detail.commission_number)}</p>
            <h2>${escapeHtml(detail.title)}</h2>
            <p class="commission-client">${escapeHtml(detail.client_name)} · ${escapeHtml(detail.client_email)}</p>
          </div>
          <div>
            <span class="commission-status-badge">${escapeHtml(lifecycleLabel)}</span>
            ${renderHelpTrigger(lifecycleHelpKey, hasCanonicalLifecycle ? "Canonical Commission Lifecycle" : "Legacy Commission Status")}
          </div>
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

  function renderCommercialSourceMarkup(commission) {
    const inquiries = Array.isArray(commission?.inquiries) ? commission.inquiries : [];
    const sourceLabel = commission?.source_quotation_number
      ? `${commission.source_quotation_number}${hasContent(commission.source_quotation_version) ? ` · v${commission.source_quotation_version}` : ""}`
      : "View Source Quotation";
    const contract = commission?.contract_document_id
      ? `<p><strong>Contract</strong><br><a class="admin-text-link" href="contract.html?document=${encodeURIComponent(commission.contract_document_id)}">${escapeHtml(commission.contract_document_number || "View Contract")}</a></p>`
      : "";
    const activation = commission?.lifecycle_status
      ? `<p><strong>Deposit received</strong><br>${escapeHtml(formatCurrency(commission.deposit_amount || 0))}</p>
         <p><strong>Activation date</strong> ${renderHelpTrigger("commission_activation", "Commission Activation")}<br>${escapeHtml(formatDate(commission.activated_at))}</p>`
      : "";
    const source = commission?.source_quotation_id
      ? `<p><strong>Source Accepted Quotation</strong><br><a class="admin-text-link" href="quotation.html?id=${encodeURIComponent(commission.source_quotation_id)}">${escapeHtml(sourceLabel)}</a></p>
         <p><strong>Acceptance</strong><br>Recorded with the accepted Source Quotation.</p>
         ${contract}${activation}`
      : '<p class="inquiry-empty">Legacy Commission — no canonical source quotation or Acceptance has been fabricated.</p>';

    return `${source}
      <div class="commission-commercial-inquiries">
        <h3>Source Inquiry</h3>
        ${renderProvenanceMarkup(inquiries)}
      </div>`;
  }

  function describeCommercialSection(commission, contractEligibility) {
    if (!commission?.source_quotation_id) return "Commercial — Legacy record";
    if (!contractEligibility) return "Commercial — Quote accepted · Contract status unavailable";
    const contractState = contractEligibility?.eligible ? "Contract ready" : "Contract pending";
    return `Commercial — Quote accepted · ${contractState}`;
  }

  function describeProductionSection(production) {
    return `Production — ${production?.initialized
      ? formatLabel(production.production_status)
      : "Not initialized"}`;
  }

  function describeFinancialSection(commission) {
    if (!commission) return "Financial — Unavailable";
    if (!hasContent(commission.amount_paid) || !hasContent(commission.balance)) {
      return "Financial — Details available";
    }
    return `Financial — ${formatCurrency(commission.amount_paid)} paid · ${formatCurrency(commission.balance)} outstanding`;
  }

  function describeDeliverySection(model) {
    const delivery = model?.delivery;
    if (!model?.initialized || !delivery) return "Delivery — Not configured";
    if (delivery.delivery_status === "scheduled" && delivery.scheduled_at) {
      return `Delivery — Pickup scheduled ${formatDate(delivery.scheduled_at)}`;
    }
    if (delivery.delivery_status === "shipped" && hasContent(delivery.carrier)) {
      return `Delivery — Shipped · ${delivery.carrier}`;
    }
    return `Delivery — ${formatLabel(delivery.delivery_status)}`;
  }

  function describeCommunicationsSection(communications) {
    const count = communications.length;
    if (!count) return "Communications — None";
    const ready = communications.filter((communication) =>
      communication.communication_status === "ready"
    ).length;
    return `Communications — ${count} ${count === 1 ? "record" : "records"}${ready ? ` · ${ready} Ready` : ""}`;
  }

  function describeDocumentsSection(documents) {
    return documents.length
      ? `Documents — ${documents.length} issued`
      : "Documents — None";
  }

  function describeTimelineSection(entries) {
    return `Timeline — ${entries.length} ${entries.length === 1 ? "milestone" : "milestones"}`;
  }

  function describeActivitySection(events) {
    return `Activity — ${events.length} ${events.length === 1 ? "event" : "events"}`;
  }

  function renderProvenanceMarkup(inquiries) {
    if (!inquiries.length) {
      return '<p class="inquiry-empty">No linked inquiries.</p>';
    }

    return `<ul>${inquiries.map((inquiry) => `
      <li>
        <strong>${escapeHtml(formatLabel(inquiry.relationship_type))}</strong>
        ${renderHelpTrigger(`provenance.${inquiry.relationship_type}`, `${formatLabel(inquiry.relationship_type)} provenance`)}
        — ${escapeHtml(formatLabel(inquiry.form_type))}
        — ${escapeHtml(inquiry.client_name)}
        <span>(${escapeHtml(inquiry.id)})</span>
      </li>
    `).join("")}</ul>`;
  }

  function renderClientOptions(clients) {
    return '<option value="">Select one</option>' + clients.map((client) =>
      `<option value="${escapeHtml(client.id)}">${escapeHtml(client.full_name)} — ${escapeHtml(client.email)}</option>`
    ).join("");
  }

  function renderOriginInquiryOptions(inquiries, clientEmail) {
    const normalizedClientEmail = String(clientEmail || "").trim().toLowerCase();
    const matchingInquiries = normalizedClientEmail
      ? inquiries.filter((inquiry) =>
        String(inquiry.client_email || "").trim().toLowerCase() === normalizedClientEmail
      )
      : [];

    return '<option value="">None</option>' + matchingInquiries.map((inquiry) =>
      `<option value="${escapeHtml(inquiry.id)}">${escapeHtml(formatLabel(inquiry.form_type))} — ${escapeHtml(formatLabel(inquiry.status))} — ${escapeHtml(String(inquiry.created_at).slice(0, 10))}</option>`
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
      return '<tr><td colspan="8" class="inquiry-empty">No payments recorded.</td></tr>';
    }

    return sortPayments(payments).map((payment) => {
      const document = payment.document || payment.receipt;
      const documentLabel = document?.document_type === "invoice"
        ? "View Final Invoice"
        : "View Receipt";

      return `
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
        <td data-label="Document">${document?.file_location
          ? `<a class="admin-text-link" href="${escapeHtml(document.file_location)}">${documentLabel}</a>`
          : "—"}</td>
      </tr>
    `;
    }).join("");
  }

  function describeCommissionEvent(event) {
    const payload = event?.payload && typeof event.payload === "object"
      ? event.payload
      : {};
    const quotation = payload.quotation_number
      ? `${payload.quotation_number}${payload.version ? ` v${payload.version}` : ""}`
      : "Quotation";

    return {
      inquiry_linked: `Inquiry linked as ${formatLabel(payload.relationship_type || "source")}`,
      quotation_created: `${quotation} created`,
      quotation_issued: `${quotation} issued`,
      quotation_sent: `${quotation} sent`,
      quotation_accepted: `${quotation} accepted`,
      quotation_withdrawn: `${quotation} withdrawn`,
      quotation_superseded: `${quotation} superseded`,
      contract_preview_prepared: "Contract draft preview prepared",
      payment_recorded: `${formatLabel(payload.payment_type || "Payment")} recorded${hasContent(payload.amount) ? ` — ${formatCurrency(payload.amount)}` : ""}`,
      deposit_received: `Required deposit received${hasContent(payload.amount) ? ` — ${formatCurrency(payload.amount)}` : ""}`,
      balance_paid: `Balance paid${hasContent(payload.amount) ? ` — ${formatCurrency(payload.amount)}` : ""}`,
      receipt_issued: `${payload.document_number || "Receipt"} issued`,
      final_invoice_issued: `${payload.document_number || "Final Invoice"} issued`,
      commission_status_changed: `Commission status changed from ${formatLabel(payload.previous_status || "unknown")} to ${formatLabel(payload.new_status || "unknown")}`,
      production_initialized: "Canonical Production tracking initialized — Not Started",
      production_reserved: "Production reserved",
      production_started: "Production started",
      production_awaiting_client_review: "Production awaiting Client review",
      production_revision_started: "Production revision started",
      production_final_presented: "Final artwork presented",
      production_final_accepted: "Final artwork accepted",
      production_paused: `Production paused from ${formatLabel(payload.previous_status || "unknown")}`,
      production_resumed: `Production resumed — ${formatLabel(payload.new_status || "unknown")}`,
      production_completed: "Production completed",
      delivery_created: `${formatLabel(payload.delivery_method || "Delivery")} delivery created`,
      delivery_ready: "Delivery ready",
      delivery_scheduled: "Pickup scheduled",
      delivery_shipped: "Artwork shipped",
      delivery_delivered: "Artwork delivered",
      delivery_picked_up: "Artwork picked up",
      delivery_cancelled: "Delivery cancelled",
      delivery_in_storage: "Artwork moved to Storage",
      storage_notice_recorded: "Storage Notice recorded",
      storage_fee_created: `Storage Fee created${hasContent(payload.amount) ? ` — ${formatCurrency(payload.amount)}` : ""}`,
      storage_fee_updated: `Storage Fee updated${hasContent(payload.new_amount) ? ` — ${formatCurrency(payload.new_amount)}` : ""}`,
      storage_final_notice_recorded: "Final Written Notice recorded",
      communication_draft_created: `${formatLabel(payload.communication_type || "Communication")} draft created`,
      manual_communication_recorded: `${formatLabel(payload.communication_type || "Manual communication")} recorded`,
      communication_generated_from_template: `${formatLabel(payload.communication_type || "Communication")} draft generated from ${formatLabel(payload.template_key || "template")}`,
      communication_marked_ready: `${formatLabel(payload.communication_type || "Communication")} reviewed and marked ready`,
      communication_queued: `${formatLabel(payload.communication_type || "Communication")} claimed for sending`,
      communication_sent: `${formatLabel(payload.communication_type || "Communication")} sent${payload.provider ? ` via ${formatLabel(payload.provider)}` : ""}`,
      communication_failed: `${formatLabel(payload.communication_type || "Communication")} send failed${payload.error_code ? ` — ${formatLabel(payload.error_code)}` : ""}`,
      communication_reconciliation_started: "Communication send reconciliation started",
      communication_reconciled_sent: "Communication reconciled as Sent",
      communication_reconciled_not_sent: "Communication reconciled as Not Sent",
      communication_reconciliation_inconclusive: "Communication reconciliation requires manual review",
      communication_marked_sent_manually: "Communication marked Sent after external verification",
      communication_marked_failed_manually: "Communication marked Failed after manual review",
      communication_automation_created: `${formatLabel(payload.automation_key || "Communication")} automation created`
    }[event?.event_type] || formatLabel(event?.event_type || "Commission event");
  }

  function renderCommissionEventsMarkup(events) {
    if (!events.length) {
      return '<li class="inquiry-empty">No activity recorded yet.</li>';
    }

    return [...events]
      .sort((left, right) => {
        const byTime = String(right.occurred_at).localeCompare(String(left.occurred_at));
        return byTime || Number(right.id) - Number(left.id);
      })
      .map((event) => `<li class="commission-activity-item" data-event-type="${escapeHtml(event.event_type)}">
        <strong>${escapeHtml(describeCommissionEvent(event))}</strong>
        <time datetime="${escapeHtml(event.occurred_at)}">${escapeHtml(formatDate(event.occurred_at))}</time>
      </li>`).join("");
  }

  function renderCommissionTimelineMarkup(entries) {
    if (!entries.length) {
      return '<li class="inquiry-empty">No timeline milestones available.</li>';
    }

    return [...entries]
      .sort((left, right) => String(left.starts_at).localeCompare(String(right.starts_at)))
      .map((entry) => `<li class="commission-activity-item commission-timeline-item" data-entry-type="${escapeHtml(entry.type)}">
        <strong>${escapeHtml(entry.title)}</strong>
        <span>${escapeHtml(formatLabel(entry.domain))} · ${escapeHtml(formatLabel(entry.status))}</span>
        <time datetime="${escapeHtml(entry.starts_at)}">${escapeHtml(entry.all_day
          ? formatDateOnly(String(entry.starts_at).slice(0, 10))
          : formatDate(entry.starts_at))}</time>
      </li>`).join("");
  }

  function renderCommissionCommunicationsMarkup(communications) {
    if (!communications.length) {
      return '<tr><td colspan="6" class="inquiry-empty">No communications recorded for this commission.</td></tr>';
    }

    return communications.map((communication) => `<tr>
      <td>${escapeHtml(formatDate(communication.created_at))}</td>
      <td>${escapeHtml(communication.recipient)}</td>
      <td>${escapeHtml(formatLabel(communication.communication_type))}</td>
      <td>${escapeHtml(formatLabel(communication.channel))}</td>
      <td>${escapeHtml(formatLabel(communication.communication_status))}</td>
      <td><a class="admin-text-link" href="communications.html?communication_id=${encodeURIComponent(communication.id)}">View</a></td>
    </tr>`).join("");
  }

  function renderProductionMarkup(production) {
    if (!production?.initialized) {
      return `<article class="commission-production-summary is-uninitialized">
        <p><strong>Not initialized</strong> ${renderHelpTrigger("production.not_started", "Production Not Started")}</p>
        <p>Canonical Production tracking was not initialized for this legacy Commission. No status has been inferred from Legacy Commission Status.</p>
      </article>`;
    }

    const timestampFields = [
      ["reserved_at", "Reserved"],
      ["started_at", "Started"],
      ["final_presented_at", "Final Presented"],
      ["final_accepted_at", "Final Accepted"],
      ["completed_at", "Completed"],
      ["paused_at", "Last Paused"],
      ["created_at", "Tracking Created"],
      ["updated_at", "Last Updated"]
    ];
    const timestamps = timestampFields
      .filter(([field]) => hasContent(production[field]))
      .map(([field, label]) => `<div class="commission-data-field" data-field="${field}">
        <dt>${label}</dt>
        <dd>${escapeHtml(formatDate(production[field]))}</dd>
      </div>`).join("");
    const pausedFrom = hasContent(production.paused_from_status)
      ? `<div class="commission-data-field" data-field="paused_from_status">
          <dt>Paused From</dt>
          <dd>${escapeHtml(formatLabel(production.paused_from_status))}</dd>
        </div>`
      : "";

    return `<article class="commission-production-summary">
      <p>
        <span class="commission-status-badge">${escapeHtml(formatLabel(production.production_status))}</span>
        ${renderHelpTrigger(`production.${production.production_status}`, `Production ${formatLabel(production.production_status)}`)}
      </p>
      <p>Canonical Production is tracked independently from Legacy Commission Status.</p>
      <dl class="commission-data-grid">
        ${pausedFrom}
        ${timestamps}
      </dl>
    </article>`;
  }

  function renderNextActionMarkup(nextAction) {
    if (!nextAction) {
      return '<article class="commission-production-summary"><p><strong>Unavailable</strong></p><p>The next action could not be resolved.</p></article>';
    }

    const actionLink = nextAction.state === "action" && nextAction.target?.href
      ? `<p class="commission-next-action-link"><a class="admin-text-link" href="${escapeHtml(nextAction.target.href)}">${escapeHtml(nextAction.target.label || nextAction.label)} →</a></p>`
      : "";

    return `<article class="commission-production-summary commission-next-action-summary" data-next-action-state="${escapeHtml(nextAction.state)}" data-next-action-code="${escapeHtml(nextAction.code)}">
      <div class="commission-next-action-heading">
        <span class="commission-status-badge">${escapeHtml(formatLabel(nextAction.state))}</span>
        <h3>${escapeHtml(nextAction.label)}</h3>
      </div>
      <p class="commission-next-action-reason">${escapeHtml(nextAction.reason)}</p>
      ${actionLink}
    </article>`;
  }

  function renderObligationsMarkup(model) {
    const obligations = model?.obligations || [];
    const compatibilityNote = "Legacy financial totals remain available for compatibility but are not canonical obligations.";

    if (!model?.initialized || !obligations.length) {
      return `<article class="commission-production-summary is-uninitialized">
        <p><strong>No canonical obligations yet.</strong></p>
        <p>${compatibilityNote}</p>
      </article>`;
    }

    return `<div class="inquiry-table-wrap">
      <table class="inquiry-table">
        <thead><tr><th>Type</th><th>Status</th><th>Amount</th><th>Allocated</th><th>Outstanding</th><th>Due</th><th>Source</th></tr></thead>
        <tbody>${obligations.map((obligation) => `<tr>
          <td>${escapeHtml(formatLabel(obligation.obligation_type))}</td>
          <td>${escapeHtml(formatLabel(obligation.obligation_status))}</td>
          <td>${escapeHtml(formatCurrency(obligation.amount))}</td>
          <td>${escapeHtml(formatCurrency(obligation.allocated_amount))}</td>
          <td>${escapeHtml(formatCurrency(obligation.outstanding_amount))}</td>
          <td>${obligation.due_at ? escapeHtml(formatDate(obligation.due_at)) : "—"}</td>
          <td>${obligation.source_type && obligation.source_id
            ? `${escapeHtml(formatLabel(obligation.source_type))} ${escapeHtml(obligation.source_id)}`
            : "—"}</td>
        </tr>`).join("")}</tbody>
      </table>
      <p>${compatibilityNote}</p>
    </div>`;
  }

  function renderDeliveryMarkup(model) {
    const delivery = model?.delivery;
    if (!model?.initialized || !delivery) {
      const releaseMessage = model?.release_eligibility?.message
        ? `<p>${escapeHtml(model.release_eligibility.message)}</p>`
        : "";
      return `<article class="commission-production-summary is-uninitialized">
        <p><strong>No canonical delivery record yet.</strong></p>
        <p>No fulfillment has been inferred from Shipping Charge, Client address, Payments, Production, Documents, or Legacy Commission Status.</p>
        ${releaseMessage}
      </article>`;
    }

    const destination = [
      delivery.address_line1,
      delivery.address_line2,
      delivery.city,
      delivery.state_region,
      delivery.postal_code,
      delivery.country
    ].filter(hasContent).join(", ");
    const carrierService = [delivery.carrier, delivery.service_level]
      .filter(hasContent)
      .join(" · ");
    const storageState = delivery.storage_state || {};
    const storageFields = delivery.storage_start_at ? [
      ["storage_start_at", "Storage Started", formatDate(delivery.storage_start_at), "storage_period"],
      ["free_storage_ends_at", "Free Storage Ends", storageState.free_storage_ends_at ? formatDate(storageState.free_storage_ends_at) : null, "free_storage"],
      ["billable_weeks", "Billable Weeks", String(storageState.billable_weeks ?? 0), "billable_week"],
      ["estimated_storage_fee", "Current Storage Fee", formatCurrency(storageState.estimated_storage_fee ?? 0), "storage_fee"],
      ["storage_notice_at", "Storage Notice", delivery.storage_notice_at ? formatDate(delivery.storage_notice_at) : "Not recorded", "storage_notice"],
      ["final_notice_at", "Final Written Notice", delivery.final_notice_at ? formatDate(delivery.final_notice_at) : "Not recorded", "final_written_notice"],
      ["abandonment_eligible_at", "Abandonment Review Eligible Date", storageState.abandonment_eligible_at ? formatDate(storageState.abandonment_eligible_at) : "Not established", "abandonment_eligibility"],
      ["abandonment_eligible", "Abandonment Review", storageState.abandonment_eligible ? "Eligible for legal review — not automatically abandoned" : "Not eligible", "abandonment_review"]
    ] : [];
    const fields = [
      ["delivery_method", "Method", formatLabel(delivery.delivery_method), "delivery_method"],
      ["delivery_status", "Status", formatLabel(delivery.delivery_status), "delivery_status"],
      ["recipient_name", "Recipient", delivery.recipient_name],
      ["destination", "Destination", destination],
      ["carrier_service", "Carrier / Service", carrierService],
      ["tracking_number", "Tracking Number", delivery.tracking_number, "tracking_number"],
      ["actual_shipping_cost", "Actual Shipping Cost", hasContent(delivery.actual_shipping_cost) ? formatCurrency(delivery.actual_shipping_cost) : null, "actual_shipping_cost"],
      ["protection_cost", "Protection Cost", hasContent(delivery.protection_cost) ? formatCurrency(delivery.protection_cost) : null, "protection_cost"],
      ["ready_at", "Ready", delivery.ready_at ? formatDate(delivery.ready_at) : null],
      ["scheduled_at", "Scheduled", delivery.scheduled_at ? formatDate(delivery.scheduled_at) : null],
      ["shipped_at", "Shipped", delivery.shipped_at ? formatDate(delivery.shipped_at) : null],
      ["delivered_at", "Delivered", delivery.delivered_at ? formatDate(delivery.delivered_at) : null],
      ["picked_up_at", "Picked Up", delivery.picked_up_at ? formatDate(delivery.picked_up_at) : null],
      ...storageFields
    ].filter(([, , value]) => hasContent(value));

    return `<article class="commission-production-summary">
      <p>
        <span class="commission-status-badge">${escapeHtml(formatLabel(delivery.delivery_status))}</span>
        ${renderHelpTrigger(`delivery.${delivery.delivery_status}`, `Delivery ${formatLabel(delivery.delivery_status)}`)}
      </p>
      <dl class="commission-data-grid">
        ${fields.map(([field, label, value, helpKey]) => `<div class="commission-data-field" data-field="${escapeHtml(field)}">
          <dt>${escapeHtml(label)}${helpKey ? renderHelpTrigger(helpKey, label) : ""}</dt>
          <dd>${escapeHtml(value)}</dd>
        </div>`).join("")}
      </dl>
      <p>Shipping Charge is the commercial amount billed to the Client; Actual Shipping Cost is the fulfillment cost to SAS.</p>
    </article>`;
  }

  function renderDeliveryActionsMarkup(delivery) {
    if (!delivery || ["delivered", "picked_up", "cancelled"].includes(delivery.delivery_status)) {
      return delivery
        ? '<p class="admin-notice">This Delivery is terminal and read-only.</p>'
        : "";
    }
    const transitions = {
      shipping: {
        pending: [["ready", "Mark Ready"]],
        ready: [["shipped", "Mark Shipped"], ["cancelled", "Cancel Delivery"]],
        in_storage: [["ready", "Return to Ready"], ["shipped", "Mark Shipped"]],
        shipped: [["delivered", "Mark Delivered"]]
      },
      pickup: {
        pending: [["ready", "Mark Ready"], ["cancelled", "Cancel Delivery"]],
        ready: [["scheduled", "Schedule Pickup"], ["picked_up", "Mark Picked Up"], ["cancelled", "Cancel Delivery"]],
        scheduled: [["picked_up", "Mark Picked Up"], ["cancelled", "Cancel Delivery"]],
        in_storage: [["scheduled", "Schedule Pickup"], ["picked_up", "Mark Picked Up"]]
      }
    }[delivery.delivery_method]?.[delivery.delivery_status] || [];
    const storageEligible = delivery.delivery_method === "pickup"
      ? ["ready", "scheduled"].includes(delivery.delivery_status)
      : delivery.delivery_status === "ready";
    const storageActions = delivery.delivery_status === "in_storage"
      ? `${delivery.storage_notice_at ? "" : '<button type="button" class="admin-text-button" data-delivery-storage-action="storage-notice">Record Storage Notice</button>'}
         ${delivery.final_notice_at ? "" : '<button type="button" class="admin-text-button" data-delivery-storage-action="final-notice">Record Final Written Notice</button>'}`
      : storageEligible
        ? '<button type="button" class="admin-text-button" data-delivery-storage-action="storage">Move to Storage</button>'
        : "";
    const scheduleInput = transitions.some(([status]) => status === "scheduled")
      ? '<label>Pickup Date / Time <input type="datetime-local" id="delivery-scheduled-at"></label>'
      : "";
    return `<div class="commission-form-actions" data-delivery-actions>
      ${scheduleInput}
      ${transitions.map(([status, label]) => `<button type="button" class="${status === "cancelled" ? "admin-text-button" : "admin-button"}" data-delivery-transition="${status}">${label}</button>`).join("")}
      ${storageActions}
    </div>`;
  }

  function describeDocument(document) {
    if (document.document_type === "receipt") {
      return document.payment?.payment_type === "deposit"
        ? "Deposit Receipt"
        : "Payment Receipt";
    }

    if (document.document_type === "contract") {
      return {
        commission_agreement: "Commission Agreement",
        artwork_sales_agreement: "Artwork Sales Agreement"
      }[document.contract_subtype] || "Contract";
    }

    if (document.document_type === "quotation") {
      return `Quotation — Version ${document.version}`;
    }

    return {
      invoice: "Final Invoice — Paid in full",
      coa: "Certificate of Authenticity"
    }[document.document_type] || formatLabel(document.document_type);
  }

  function renderCommissionDocumentsMarkup(documents) {
    if (!documents.length) {
      return '<tr><td colspan="7" class="inquiry-empty">No documents for this commission.</td></tr>';
    }

    return documents.map((document) => `
      <tr>
        <td>${escapeHtml(document.document_number)}</td>
        <td>${escapeHtml(documentTypeLabels[document.document_type] || formatLabel(document.document_type))}</td>
        <td>${escapeHtml(describeDocument(document))}</td>
        <td>v${escapeHtml(document.version)}</td>
        <td>${escapeHtml(formatDate(document.created_at))}</td>
        <td>${document.payment ? escapeHtml(formatLabel(document.payment.payment_type)) : "—"}</td>
        <td><a class="admin-text-link" href="${escapeHtml(document.file_location)}" target="_blank" rel="noopener">View</a></td>
      </tr>
    `).join("");
  }

  function renderQuotationsMarkup(quotations) {
    if (!quotations.length) {
      return '<tr><td colspan="9" class="inquiry-empty">No quotations for this commission.</td></tr>';
    }

    return quotations.map((quotation) => {
      const snapshotTotal = quotation.quotation_snapshot?.commercial?.total;
      const total = snapshotTotal ?? (
        (toCents(quotation.price) + toCents(quotation.sales_tax) + toCents(quotation.shipping_charge)) / 100
      );
      return `<tr>
        <td>${escapeHtml(quotation.quotation_number)}</td>
        <td>v${escapeHtml(quotation.version)}</td>
        <td>${escapeHtml(formatLabel(quotation.quotation_status))}${quotation.is_expired ? " (Expired)" : ""}</td>
        <td>${escapeHtml(formatCurrency(quotation.price))}</td>
        <td>${escapeHtml(formatCurrency(total))}</td>
        <td>${quotation.issued_at ? escapeHtml(formatDate(quotation.issued_at)) : "—"}</td>
        <td>${quotation.expires_at ? escapeHtml(formatDate(quotation.expires_at)) : "—"}</td>
        <td>${quotation.sent_at ? escapeHtml(formatDate(quotation.sent_at)) : "—"}</td>
        <td><a class="admin-text-link" href="quotation.html?id=${encodeURIComponent(quotation.id)}">View</a></td>
      </tr>`;
    }).join("");
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
        String(form.elements.namedItem("estimated_completion").value || "").trim() || null,
      origin_inquiry_id:
        String(form.elements.namedItem("origin_inquiry_id").value || "").trim() || null
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

  function buildDeliveryCreatePayload(form) {
    const method = readRequired(form, "delivery_method", "Delivery method");
    const payload = {
      delivery_method: method,
      recipient_name: readRequired(form, "recipient_name", "Recipient name"),
      notes: String(form.elements.namedItem("notes").value || "").trim() || null
    };
    for (const field of [
      "address_line1", "address_line2", "city", "state_region", "postal_code",
      "country", "carrier", "service_level", "tracking_number"
    ]) {
      payload[field] = String(form.elements.namedItem(field).value || "").trim() || null;
    }
    if (method === "shipping") {
      for (const [field, label] of [
        ["address_line1", "Address line 1"], ["city", "City"],
        ["state_region", "State / region"], ["postal_code", "Postal code"],
        ["country", "Country"]
      ]) {
        if (!payload[field]) throw new Error(`${label} is required for shipping.`);
      }
    }
    return payload;
  }

  function buildDeliveryUpdatePayload(form, method) {
    const payload = {};
    for (const field of [
      "recipient_name", "address_line1", "address_line2", "city", "state_region",
      "postal_code", "country", "carrier", "service_level", "tracking_number", "notes"
    ]) {
      payload[field] = String(form.elements.namedItem(field).value || "").trim() || null;
    }
    if (method === "shipping") {
      for (const field of ["actual_shipping_cost", "protection_cost"]) {
        const value = String(form.elements.namedItem(field).value || "").trim();
        if (value && (!/^\d+(?:\.\d{1,2})?$/.test(value) || Number(value) < 0)) {
          throw new Error(`${field === "actual_shipping_cost" ? "Actual shipping cost" : "Protection cost"} must be 0 or greater with no more than 2 decimals.`);
        }
        payload[field] = value || null;
      }
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
      commercialSourceDetail: documentObject.querySelector("#commission-commercial-source-detail"),
      commercialSummary: documentObject.querySelector("#commission-commercial-summary"),
      productionSummary: documentObject.querySelector("#commission-production-summary"),
      financialSummary: documentObject.querySelector("#commission-financial-summary"),
      deliverySummary: documentObject.querySelector("#commission-delivery-summary"),
      communicationsSummary: documentObject.querySelector("#commission-communications-summary"),
      documentsSummary: documentObject.querySelector("#commission-documents-summary"),
      timelineSummary: documentObject.querySelector("#commission-timeline-summary"),
      activitySummary: documentObject.querySelector("#commission-activity-summary"),
      payments: documentObject.querySelector("#commission-payments"),
      paymentList: documentObject.querySelector("#payment-list"),
      paymentStatus: documentObject.querySelector("#payment-status"),
      paymentReceiptAction: documentObject.querySelector("#payment-receipt-action"),
      paymentGuidance: documentObject.querySelector("#payment-guidance"),
      recordPayment: documentObject.querySelector("#record-payment"),
      paymentForm: documentObject.querySelector("#payment-form"),
      cancelPayment: documentObject.querySelector("#cancel-payment"),
      documentList: documentObject.querySelector("#commission-document-list"),
      documentStatus: documentObject.querySelector("#commission-documents-status"),
      communicationsList: documentObject.querySelector("#commission-communications-list"),
      communicationsStatus: documentObject.querySelector("#commission-communications-status"),
      createCommunication: documentObject.querySelector("#create-communication"),
      newCommunicationDraft: documentObject.querySelector("#new-communication-draft"),
      recordManualCommunication: documentObject.querySelector("#record-manual-communication"),
      quotationList: documentObject.querySelector("#quotation-list"),
      quotationStatus: documentObject.querySelector("#quotation-status"),
      prepareQuotation: documentObject.querySelector("#prepare-quotation"),
      prepareContract: documentObject.querySelector("#prepare-contract"),
      contractEligibilityStatus: documentObject.querySelector("#contract-eligibility-status"),
      activityList: documentObject.querySelector("#commission-activity-list"),
      activityStatus: documentObject.querySelector("#commission-activity-status"),
      timelineList: documentObject.querySelector("#commission-timeline-list"),
      timelineStatus: documentObject.querySelector("#commission-timeline-status"),
      productionDetail: documentObject.querySelector("#commission-production-detail"),
      productionStatus: documentObject.querySelector("#commission-production-status"),
      nextActionDetail: documentObject.querySelector("#commission-next-action-detail"),
      nextActionStatus: documentObject.querySelector("#commission-next-action-status"),
      obligationsDetail: documentObject.querySelector("#commission-obligations-detail"),
      obligationsStatus: documentObject.querySelector("#commission-obligations-status"),
      deliveryDetail: documentObject.querySelector("#commission-delivery-detail"),
      deliveryStatus: documentObject.querySelector("#commission-delivery-status"),
      deliveryActions: documentObject.querySelector("#commission-delivery-actions"),
      createDelivery: documentObject.querySelector("#create-delivery"),
      editDelivery: documentObject.querySelector("#edit-delivery"),
      deliveryCreateForm: documentObject.querySelector("#delivery-create-form"),
      cancelDeliveryCreate: documentObject.querySelector("#cancel-delivery-create"),
      deliveryShippingFields: documentObject.querySelector("#delivery-shipping-fields"),
      deliveryEditForm: documentObject.querySelector("#delivery-edit-form"),
      cancelDeliveryEdit: documentObject.querySelector("#cancel-delivery-edit"),
      deliveryActualCostField: documentObject.querySelector("#delivery-actual-cost-field"),
      deliveryProtectionCostField: documentObject.querySelector("#delivery-protection-cost-field"),
      deliveryCancelConfirmation: documentObject.querySelector("#delivery-cancel-confirmation"),
      confirmDeliveryCancel: documentObject.querySelector("#confirm-delivery-cancel"),
      keepDelivery: documentObject.querySelector("#keep-delivery"),
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
    let clients = [];
    let inquiries = [];
    let selectedCommission = null;
    let pendingStatus = null;
    let payments = [];
    let documents = [];
    let communications = [];
    let quotations = [];
    let commissionEvents = [];
    let commissionTimeline = [];
    let production = { initialized: false };
    let nextAction = null;
    let contractEligibility = null;
    let obligations = { initialized: false, obligations: [] };
    let delivery = { initialized: false, delivery: null };
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
      updateSectionSummaries();
    }

    function renderDocuments() {
      elements.documentList.innerHTML = renderCommissionDocumentsMarkup(documents);
      updateSectionSummaries();
    }

    function renderCommunications() {
      elements.communicationsList.innerHTML = renderCommissionCommunicationsMarkup(communications);
      updateSectionSummaries();
    }

    function renderQuotations() {
      elements.quotationList.innerHTML = renderQuotationsMarkup(quotations);
      updateSectionSummaries();
    }

    function renderCommissionEvents() {
      elements.activityList.innerHTML = renderCommissionEventsMarkup(commissionEvents);
      updateSectionSummaries();
    }

    function renderCommissionTimeline() {
      elements.timelineList.innerHTML = renderCommissionTimelineMarkup(commissionTimeline);
      updateSectionSummaries();
    }

    function renderObligations() {
      elements.obligationsDetail.innerHTML = renderObligationsMarkup(obligations);
      updateSectionSummaries();
    }

    function renderDelivery() {
      elements.deliveryDetail.innerHTML = renderDeliveryMarkup(delivery);
      elements.deliveryActions.innerHTML = renderDeliveryActionsMarkup(delivery.delivery);
      const terminal = ["delivered", "picked_up", "cancelled"].includes(
        delivery.delivery?.delivery_status
      );
      elements.createDelivery.hidden = Boolean(
        delivery.initialized || !delivery.release_eligibility?.eligible
      );
      elements.editDelivery.hidden = !delivery.initialized || terminal;
      updateSectionSummaries();
    }

    function renderCommercialSource() {
      if (elements.commercialSourceDetail) {
        elements.commercialSourceDetail.innerHTML = selectedCommission
          ? renderCommercialSourceMarkup(selectedCommission)
          : "";
      }
      updateSectionSummaries();
    }

    function updateSectionSummaries() {
      const summaries = [
        [elements.commercialSummary, describeCommercialSection(selectedCommission, contractEligibility)],
        [elements.productionSummary, describeProductionSection(production)],
        [elements.financialSummary, describeFinancialSection(selectedCommission)],
        [elements.deliverySummary, describeDeliverySection(delivery)],
        [elements.communicationsSummary, describeCommunicationsSection(communications)],
        [elements.documentsSummary, describeDocumentsSection(documents)],
        [elements.timelineSummary, describeTimelineSection(commissionTimeline)],
        [elements.activitySummary, describeActivitySection(commissionEvents)]
      ];
      summaries.forEach(([element, value]) => {
        if (element) element.textContent = value;
      });
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

    function resetCommissionSections() {
      documentObject.querySelectorAll?.("details.commission-section").forEach((section) => {
        section.open = false;
      });
    }

    function openTargetedSection() {
      const hash = String(globalObject.location?.hash || "").slice(1);
      if (!hash) return null;
      const target = documentObject.getElementById?.(hash);
      const section = target?.matches?.("details.commission-section")
        ? target
        : target?.closest?.("details.commission-section");
      if (section) section.open = true;
      return section || null;
    }

    function showCommissionIndex() {
      elements.detail.hidden = true;
      elements.detailFields.innerHTML = "";
      elements.detailStatus.textContent = "";
      elements.paymentStatus.textContent = "";
      elements.paymentReceiptAction.innerHTML = "";
      elements.indexToolbar.hidden = false;
      elements.listStatus.hidden = false;
      elements.listPanel.hidden = false;
      elements.workspace.classList?.remove("is-detail-mode");
      payments = [];
      renderPayments();
      documents = [];
      renderDocuments();
      communications = [];
      renderCommunications();
      quotations = [];
      renderQuotations();
      commissionEvents = [];
      renderCommissionEvents();
      commissionTimeline = [];
      renderCommissionTimeline();
      elements.activityStatus.textContent = "";
      elements.timelineStatus.textContent = "";
      production = { initialized: false };
      elements.productionDetail.innerHTML = renderProductionMarkup(production);
      elements.productionStatus.textContent = "";
      nextAction = null;
      elements.nextActionDetail.innerHTML = renderNextActionMarkup(nextAction);
      elements.nextActionStatus.textContent = "";
      contractEligibility = null;
      obligations = { initialized: false, obligations: [] };
      renderObligations();
      elements.obligationsStatus.textContent = "";
      delivery = { initialized: false, delivery: null };
      renderDelivery();
      elements.deliveryStatus.textContent = "";
      elements.deliveryCreateForm.hidden = true;
      elements.deliveryEditForm.hidden = true;
      elements.deliveryCancelConfirmation.hidden = true;
      elements.documentStatus.textContent = "";
      elements.communicationsStatus.textContent = "";
      elements.prepareContract.hidden = true;
      elements.contractEligibilityStatus.textContent = "Contract unavailable — Accepted Quotation required.";
      cancelPayment();
      selectedCommission = null;
      renderCommercialSource();
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
      renderCommercialSource();
      updateSectionSummaries();
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
        clients = body.clients || [];
        elements.createForm.elements.namedItem("client_id").innerHTML =
          renderClientOptions(clients);
        updateOriginInquiryOptions();
        return clients;
      } catch (error) {
        clients = [];
        showError(elements.createStatus, error);
        return [];
      }
    }

    function updateOriginInquiryOptions() {
      const selectedClientId = String(
        elements.createForm.elements.namedItem("client_id").value || ""
      );
      const selectedClient = clients.find(
        (client) => String(client.id) === selectedClientId
      );
      elements.createForm.elements.namedItem("origin_inquiry_id").innerHTML =
        renderOriginInquiryOptions(inquiries, selectedClient?.email);
    }

    async function loadInquiries() {
      try {
        const body = await fetchJson(fetchImplementation, INQUIRIES_API_PATH);
        inquiries = body.inquiries || [];
        updateOriginInquiryOptions();
        return inquiries;
      } catch (error) {
        inquiries = [];
        updateOriginInquiryOptions();
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
      elements.paymentReceiptAction.innerHTML = "";
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

    async function loadDocuments() {
      if (!selectedCommission) {
        documents = [];
        renderDocuments();
        return [];
      }

      elements.documentStatus.textContent = "Loading documents…";
      elements.documentStatus.classList?.remove("is-error");
      if (elements.documentsSummary) elements.documentsSummary.textContent = "Documents — Loading…";

      try {
        const body = await fetchJson(
          fetchImplementation,
          `${DOCUMENTS_API_PATH}?commission_id=${encodeURIComponent(selectedCommission.id)}`
        );
        documents = body.documents || [];
        renderDocuments();
        elements.documentStatus.textContent = "";
        return documents;
      } catch {
        documents = [];
        renderDocuments();
        elements.documentStatus.textContent = "Unable to load documents.";
        elements.documentStatus.classList?.add("is-error");
        if (elements.documentsSummary) elements.documentsSummary.textContent = "Documents — Unavailable";
        return [];
      }
    }

    async function loadCommunications() {
      if (!selectedCommission) {
        communications = [];
        renderCommunications();
        return [];
      }

      elements.communicationsStatus.textContent = "Loading communications…";
      elements.communicationsStatus.classList?.remove("is-error");
      if (elements.communicationsSummary) elements.communicationsSummary.textContent = "Communications — Loading…";
      elements.createCommunication.href = `communications.html?commission_id=${encodeURIComponent(selectedCommission.id)}&action=template`;
      elements.newCommunicationDraft.href = `communications.html?commission_id=${encodeURIComponent(selectedCommission.id)}&action=draft`;
      elements.recordManualCommunication.href = `communications.html?commission_id=${encodeURIComponent(selectedCommission.id)}&action=manual`;

      try {
        const body = await fetchJson(
          fetchImplementation,
          `${COMMUNICATIONS_API_PATH}?commission_id=${encodeURIComponent(selectedCommission.id)}`
        );
        communications = body.communications || [];
        renderCommunications();
        elements.communicationsStatus.textContent = "";
        return communications;
      } catch (error) {
        communications = [];
        renderCommunications();
        showError(elements.communicationsStatus, error);
        if (elements.communicationsSummary) elements.communicationsSummary.textContent = "Communications — Unavailable";
        return [];
      }
    }

    async function loadQuotations() {
      if (!selectedCommission) return [];
      elements.quotationStatus.textContent = "Loading quotations…";
      try {
        const body = await fetchJson(
          fetchImplementation,
          `${API_PATH}/${encodeURIComponent(selectedCommission.id)}/quotations`
        );
        quotations = body.quotations || [];
        renderQuotations();
        elements.quotationStatus.textContent = "";
        return quotations;
      } catch (error) {
        quotations = [];
        renderQuotations();
        showError(elements.quotationStatus, error);
        return [];
      }
    }

    async function loadContractEligibility() {
      if (!selectedCommission) return null;
      elements.prepareContract.hidden = true;
      elements.contractEligibilityStatus.textContent = "Checking Contract eligibility…";
      if (elements.commercialSummary && selectedCommission.source_quotation_id) {
        elements.commercialSummary.textContent = "Commercial — Quote accepted · Checking Contract…";
      }
      try {
        const body = await fetchJson(
          fetchImplementation,
          `${CONTRACT_ELIGIBILITY_API_PATH}?commission_id=${encodeURIComponent(selectedCommission.id)}`
        );
        contractEligibility = body;
        elements.contractEligibilityStatus.textContent = body.message;
        elements.prepareContract.hidden = !body.eligible;
        if (body.eligible) {
          elements.prepareContract.href = `create-contract.html?commission_id=${encodeURIComponent(selectedCommission.id)}`;
        }
        updateSectionSummaries();
        return body;
      } catch (error) {
        contractEligibility = null;
        elements.prepareContract.hidden = true;
        showError(elements.contractEligibilityStatus, error);
        updateSectionSummaries();
        return null;
      }
    }

    async function loadCommissionEvents() {
      if (!selectedCommission) return [];
      elements.activityStatus.textContent = "Loading activity…";
      elements.activityStatus.classList?.remove("is-error");
      if (elements.activitySummary) elements.activitySummary.textContent = "Activity — Loading…";
      try {
        const body = await fetchJson(
          fetchImplementation,
          `${API_PATH}/${encodeURIComponent(selectedCommission.id)}/events`
        );
        commissionEvents = body.events || [];
        renderCommissionEvents();
        elements.activityStatus.textContent = "";
        return commissionEvents;
      } catch (error) {
        commissionEvents = [];
        renderCommissionEvents();
        showError(elements.activityStatus, error);
        if (elements.activitySummary) elements.activitySummary.textContent = "Activity — Unavailable";
        return [];
      }
    }

    async function loadCommissionTimeline() {
      if (!selectedCommission) return [];
      elements.timelineStatus.textContent = "Loading timeline…";
      elements.timelineStatus.classList?.remove("is-error");
      if (elements.timelineSummary) elements.timelineSummary.textContent = "Timeline — Loading…";
      try {
        const body = await fetchJson(
          fetchImplementation,
          `${API_PATH}/${encodeURIComponent(selectedCommission.id)}/timeline`
        );
        commissionTimeline = body.entries || [];
        renderCommissionTimeline();
        elements.timelineStatus.textContent = "";
        return commissionTimeline;
      } catch (error) {
        commissionTimeline = [];
        renderCommissionTimeline();
        showError(elements.timelineStatus, error);
        if (elements.timelineSummary) elements.timelineSummary.textContent = "Timeline — Unavailable";
        return [];
      }
    }

    async function loadProduction() {
      if (!selectedCommission) return null;
      elements.productionStatus.textContent = "Loading production status…";
      elements.productionStatus.classList?.remove("is-error");
      if (elements.productionSummary) elements.productionSummary.textContent = "Production — Loading…";
      try {
        const body = await fetchJson(
          fetchImplementation,
          `${API_PATH}/${encodeURIComponent(selectedCommission.id)}/production`
        );
        production = body.production || { initialized: false };
        elements.productionDetail.innerHTML = renderProductionMarkup(production);
        elements.productionStatus.textContent = "";
        updateSectionSummaries();
        return production;
      } catch (error) {
        production = { initialized: false };
        elements.productionDetail.innerHTML = renderProductionMarkup(production);
        showError(elements.productionStatus, error);
        if (elements.productionSummary) elements.productionSummary.textContent = "Production — Unavailable";
        return null;
      }
    }

    async function loadNextAction() {
      if (!selectedCommission) return null;
      elements.nextActionStatus.textContent = "Resolving next action…";
      elements.nextActionStatus.classList?.remove("is-error");
      try {
        const body = await fetchJson(
          fetchImplementation,
          `${API_PATH}/${encodeURIComponent(selectedCommission.id)}/next-action`
        );
        nextAction = body.next_action || null;
        elements.nextActionDetail.innerHTML = renderNextActionMarkup(nextAction);
        elements.nextActionStatus.textContent = "";
        return nextAction;
      } catch (error) {
        nextAction = null;
        elements.nextActionDetail.innerHTML = renderNextActionMarkup(nextAction);
        showError(elements.nextActionStatus, error);
        return null;
      }
    }

    async function loadObligations() {
      if (!selectedCommission) return null;
      elements.obligationsStatus.textContent = "Loading financial obligations…";
      elements.obligationsStatus.classList?.remove("is-error");
      try {
        const body = await fetchJson(
          fetchImplementation,
          `${API_PATH}/${encodeURIComponent(selectedCommission.id)}/obligations`
        );
        obligations = {
          initialized: Boolean(body.initialized),
          obligations: body.obligations || []
        };
        renderObligations();
        elements.obligationsStatus.textContent = "";
        return obligations;
      } catch (error) {
        obligations = { initialized: false, obligations: [] };
        renderObligations();
        showError(elements.obligationsStatus, error);
        return null;
      }
    }

    async function loadDelivery() {
      if (!selectedCommission) return null;
      elements.deliveryStatus.textContent = "Loading delivery…";
      elements.deliveryStatus.classList?.remove("is-error");
      if (elements.deliverySummary) elements.deliverySummary.textContent = "Delivery — Loading…";
      try {
        const body = await fetchJson(
          fetchImplementation,
          `${API_PATH}/${encodeURIComponent(selectedCommission.id)}/delivery`
        );
        delivery = {
          initialized: Boolean(body.initialized),
          delivery: body.delivery || null,
          release_eligibility: body.release_eligibility || null
        };
        renderDelivery();
        elements.deliveryStatus.textContent = "";
        return delivery;
      } catch (error) {
        delivery = { initialized: false, delivery: null };
        renderDelivery();
        showError(elements.deliveryStatus, error);
        if (elements.deliverySummary) elements.deliverySummary.textContent = "Delivery — Unavailable";
        return null;
      }
    }

    function toggleDeliveryShippingFields() {
      const isShipping = elements.deliveryCreateForm.elements.namedItem("delivery_method").value === "shipping";
      elements.deliveryShippingFields.hidden = !isShipping;
      return isShipping;
    }

    function openDeliveryCreate() {
      elements.deliveryCreateForm.hidden = false;
      elements.deliveryEditForm.hidden = true;
      elements.deliveryCancelConfirmation.hidden = true;
      toggleDeliveryShippingFields();
    }

    function cancelDeliveryCreate() {
      elements.deliveryCreateForm.hidden = true;
    }

    async function submitDeliveryCreate(event) {
      event?.preventDefault();
      if (!selectedCommission) return null;
      let payload;
      try {
        payload = buildDeliveryCreatePayload(elements.deliveryCreateForm);
      } catch (error) {
        showError(elements.deliveryStatus, error);
        return null;
      }
      try {
        const body = await fetchJson(
          fetchImplementation,
          `${API_PATH}/${encodeURIComponent(selectedCommission.id)}/delivery`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }
        );
        delivery = { initialized: true, delivery: body.delivery, release_eligibility: delivery.release_eligibility };
        elements.deliveryCreateForm.hidden = true;
        renderDelivery();
        elements.deliveryStatus.textContent = "Delivery created.";
        await loadCommissionEvents();
        return body.delivery;
      } catch (error) {
        showError(elements.deliveryStatus, error);
        return null;
      }
    }

    function openDeliveryEdit() {
      if (!delivery.delivery) return;
      const form = elements.deliveryEditForm;
      for (const field of [
        "recipient_name", "address_line1", "address_line2", "city", "state_region",
        "postal_code", "country", "carrier", "service_level", "tracking_number",
        "actual_shipping_cost", "protection_cost", "notes"
      ]) {
        form.elements.namedItem(field).value = delivery.delivery[field] ?? "";
      }
      const isShipping = delivery.delivery.delivery_method === "shipping";
      elements.deliveryActualCostField.hidden = !isShipping;
      elements.deliveryProtectionCostField.hidden = !isShipping;
      form.hidden = false;
      elements.deliveryCreateForm.hidden = true;
    }

    function cancelDeliveryEdit() {
      elements.deliveryEditForm.hidden = true;
    }

    async function submitDeliveryEdit(event) {
      event?.preventDefault();
      if (!selectedCommission || !delivery.delivery) return null;
      let payload;
      try {
        payload = buildDeliveryUpdatePayload(
          elements.deliveryEditForm,
          delivery.delivery.delivery_method
        );
      } catch (error) {
        showError(elements.deliveryStatus, error);
        return null;
      }
      try {
        const body = await fetchJson(
          fetchImplementation,
          `${API_PATH}/${encodeURIComponent(selectedCommission.id)}/delivery`,
          { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }
        );
        delivery.delivery = body.delivery;
        elements.deliveryEditForm.hidden = true;
        renderDelivery();
        elements.deliveryStatus.textContent = "Delivery updated.";
        return body.delivery;
      } catch (error) {
        showError(elements.deliveryStatus, error);
        return null;
      }
    }

    async function transitionDelivery(nextStatus) {
      if (!selectedCommission || !delivery.delivery) return null;
      if (nextStatus === "cancelled") {
        elements.deliveryCancelConfirmation.hidden = false;
        return null;
      }
      const payload = { next_status: nextStatus };
      if (nextStatus === "scheduled") {
        const scheduledInput = documentObject.querySelector("#delivery-scheduled-at");
        payload.scheduled_at = scheduledInput?.value || null;
      }
      try {
        const body = await fetchJson(
          fetchImplementation,
          `${API_PATH}/${encodeURIComponent(selectedCommission.id)}/delivery/transition`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }
        );
        delivery.delivery = body.delivery;
        renderDelivery();
        elements.deliveryStatus.textContent = `Delivery marked ${formatLabel(nextStatus)}.`;
        await loadCommissionEvents();
        return body.delivery;
      } catch (error) {
        showError(elements.deliveryStatus, error);
        return null;
      }
    }

    async function performDeliveryStorageAction(action) {
      if (!selectedCommission || !delivery.delivery) return null;
      const messages = {
        storage: "Artwork moved to Storage.",
        "storage-notice": "Storage Notice recorded.",
        "final-notice": "Final Written Notice recorded. Abandonment remains subject to legal review."
      };
      try {
        const body = await fetchJson(
          fetchImplementation,
          `${API_PATH}/${encodeURIComponent(selectedCommission.id)}/delivery/${action}`,
          { method: "POST" }
        );
        delivery.delivery = body.delivery;
        renderDelivery();
        elements.deliveryStatus.textContent = body.created === false
          ? "This Storage record already exists."
          : messages[action];
        await loadObligations();
        await loadCommissionEvents();
        return body.delivery;
      } catch (error) {
        showError(elements.deliveryStatus, error);
        return null;
      }
    }

    async function confirmDeliveryCancellation() {
      elements.deliveryCancelConfirmation.hidden = true;
      if (!selectedCommission || !delivery.delivery) return null;
      try {
        const body = await fetchJson(
          fetchImplementation,
          `${API_PATH}/${encodeURIComponent(selectedCommission.id)}/delivery/transition`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ next_status: "cancelled" }) }
        );
        delivery.delivery = body.delivery;
        renderDelivery();
        elements.deliveryStatus.textContent = "Delivery cancelled. The Commission was not cancelled.";
        await loadCommissionEvents();
        return body.delivery;
      } catch (error) {
        showError(elements.deliveryStatus, error);
        return null;
      }
    }

    async function openDetail(id) {
      if (elements.createPanel) elements.createPanel.hidden = true;
      elements.detail.hidden = false;
      resetCommissionSections();
      enterDetailMode();
      elements.detailStatus.textContent = "Loading commission…";
      elements.detailStatus.classList?.remove("is-error");

      try {
        const body = await fetchJson(
          fetchImplementation,
          `${API_PATH}/${encodeURIComponent(id)}`
        );
        selectedCommission = body.commission;
        payments = [];
        documents = [];
        communications = [];
        quotations = [];
        commissionEvents = [];
        commissionTimeline = [];
        production = { initialized: false };
        obligations = { initialized: false, obligations: [] };
        delivery = { initialized: false, delivery: null };
        contractEligibility = null;
        elements.detailFields.innerHTML = renderDetailMarkup(selectedCommission);
        renderCommercialSource();
        renderPayments();
        renderDocuments();
        renderCommunications();
        renderQuotations();
        renderCommissionEvents();
        renderCommissionTimeline();
        renderObligations();
        renderDelivery();
        updatePaymentAvailability();
        showReadOnlyDetail();
        elements.detailStatus.textContent = "";
        await loadNextAction();
        await loadProduction();
        await loadCommissionTimeline();
        await loadCommissionEvents();
        await loadPayments();
        await loadQuotations();
        await loadContractEligibility();
        await loadObligations();
        await loadDelivery();
        await loadDocuments();
        await loadCommunications();
        openTargetedSection();
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
      updateOriginInquiryOptions();
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
        await loadCommissionEvents();
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
      elements.paymentReceiptAction.innerHTML = "";
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
          {
            ...body.payment,
            document: body.document || body.receipt || null,
            receipt: body.receipt || null
          },
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
        const paymentDocument = body.document || body.receipt;
        const actionLabel = paymentDocument?.document_type === "invoice"
          ? "View Final Invoice"
          : "View Receipt";
        elements.paymentReceiptAction.innerHTML = paymentDocument?.file_location
          ? `<a class="admin-text-link" href="${escapeHtml(paymentDocument.file_location)}">${actionLabel}</a>`
          : "";
        await loadDocuments();
        await loadCommissionEvents();
        return body.payment;
      } catch (error) {
        showError(elements.paymentStatus, error);
        return null;
      }
    }

    function bindEvents() {
      elements.list.addEventListener("click", async (event) => {
        const button = event.target.closest?.("[data-commission-id]");

        if (button) {
          event.preventDefault?.();
          const commissionId = button.dataset.commissionId
            || button.getAttribute?.("data-commission-id");
          globalObject.history?.pushState?.(
            null,
            "",
            `commissions.html?commission_id=${encodeURIComponent(commissionId)}`
          );
          return openDetail(commissionId);
        }
      });
      elements.newCommission?.addEventListener("click", openCreate);
      elements.editCommission.addEventListener("click", openEdit);
      elements.changeStatus.addEventListener("click", openStatus);
      elements.recordPayment.addEventListener("click", openPayment);
      elements.createDelivery.addEventListener("click", openDeliveryCreate);
      elements.editDelivery.addEventListener("click", openDeliveryEdit);
      elements.deliveryCreateForm.elements.namedItem("delivery_method").addEventListener("change", toggleDeliveryShippingFields);
      elements.deliveryCreateForm.addEventListener("submit", submitDeliveryCreate);
      elements.cancelDeliveryCreate.addEventListener("click", cancelDeliveryCreate);
      elements.deliveryEditForm.addEventListener("submit", submitDeliveryEdit);
      elements.cancelDeliveryEdit.addEventListener("click", cancelDeliveryEdit);
      elements.deliveryActions.addEventListener("click", (event) => {
        const button = event.target.closest?.("[data-delivery-transition]");
        if (button) transitionDelivery(button.getAttribute("data-delivery-transition"));
        const storageButton = event.target.closest?.("[data-delivery-storage-action]");
        if (storageButton) {
          performDeliveryStorageAction(
            storageButton.getAttribute("data-delivery-storage-action")
          );
        }
      });
      elements.confirmDeliveryCancel.addEventListener("click", confirmDeliveryCancellation);
      elements.keepDelivery.addEventListener("click", () => {
        elements.deliveryCancelConfirmation.hidden = true;
      });
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
      elements.createForm?.addEventListener("submit", submitCreate);
      elements.createForm?.elements.namedItem("client_id")?.addEventListener(
        "change",
        updateOriginInquiryOptions
      );
      elements.createForm?.elements.namedItem("price")?.addEventListener(
        "input",
        updateFinancialPreview
      );
      elements.createForm?.elements.namedItem("sales_tax_rate")?.addEventListener(
        "change",
        updateFinancialPreview
      );
      elements.createForm?.elements.namedItem("shipping")?.addEventListener(
        "input",
        updateFinancialPreview
      );
      elements.cancelCreate?.addEventListener("click", closeCreate);
      elements.closeDetail.addEventListener("click", () => {
        globalObject.history?.pushState?.(null, "", "commissions.html");
        showCommissionIndex();
      });
    }

    return {
      bindEvents,
      cancelEdit,
      cancelPayment,
      cancelStatus,
      cancelStatusConfirmation,
      cancelDeliveryCreate,
      cancelDeliveryEdit,
      closeCreate,
      loadClients,
      loadInquiries,
      loadList,
      loadDocuments,
      loadCommunications,
      loadContractEligibility,
      loadCommissionEvents,
      loadCommissionTimeline,
      loadNextAction,
      loadObligations,
      loadDelivery,
      loadProduction,
      loadQuotations,
      loadPayments,
      openCreate,
      openDeliveryCreate,
      openDeliveryEdit,
      openDetail,
      openEdit,
      openPayment,
      openStatus,
      performDeliveryStorageAction,
      prepareStatusConfirmation,
      showCommissionIndex,
      submitCreate,
      submitDeliveryCreate,
      submitDeliveryEdit,
      transitionDelivery,
      confirmDeliveryCancellation,
      submitEdit,
      submitPayment,
      submitStatus,
      updateEditFinancialPreview,
      updateFinancialPreview,
      updateOriginInquiryOptions,
      updatePaymentSuggestions
    };
  }

  const api = {
    API_PATH,
    CLIENTS_API_PATH,
    INQUIRIES_API_PATH,
    DOCUMENTS_API_PATH,
    QUOTATIONS_API_PATH,
    CONTRACT_ELIGIBILITY_API_PATH,
    COMMUNICATIONS_API_PATH,
    buildCreatePayload,
    buildEditPayload,
    buildPaymentPayload,
    buildDeliveryCreatePayload,
    buildDeliveryUpdatePayload,
    calculateFinancialPreview,
    createApp,
    describeActivitySection,
    describeCommercialSection,
    describeCommunicationsSection,
    describeDocument,
    describeDeliverySection,
    describeDocumentsSection,
    describeFinancialSection,
    describeProductionSection,
    describeTimelineSection,
    fetchJson,
    formatCurrency,
    getCommissionDisplayStatus,
    inferSalesTaxRate,
    paymentMethodLabels,
    renderCommissionDocumentsMarkup,
    renderCommissionCommunicationsMarkup,
    renderCommercialSourceMarkup,
    renderCommissionEventsMarkup,
    renderCommissionTimelineMarkup,
    renderNextActionMarkup,
    renderObligationsMarkup,
    renderDeliveryMarkup,
    renderDeliveryActionsMarkup,
    renderProductionMarkup,
    describeCommissionEvent,
    renderClientOptions,
    renderDetailMarkup,
    renderListMarkup,
    renderPaymentsMarkup,
    renderQuotationsMarkup,
    renderProvenanceMarkup,
    renderOriginInquiryOptions,
    renderHelpTrigger,
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
    app.loadList().then(() => {
      const commissionId = new URLSearchParams(globalObject.location?.search || "")
        .get("commission_id");
      if (/^[1-9][0-9]*$/.test(commissionId || "")) app.openDetail(commissionId);
    });
  }
})(typeof window !== "undefined" ? window : globalThis);
