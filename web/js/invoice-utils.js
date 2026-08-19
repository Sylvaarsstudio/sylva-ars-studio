(function attachInvoiceUtils(global) {
  function toCents(value) {
    const normalized = String(value ?? "")
      .replace(/[$,\s]/g, "")
      .trim();
    const amount = Number.parseFloat(normalized);

    return Number.isFinite(amount) ? Math.max(0, Math.round(amount * 100)) : 0;
  }

  function formatCents(cents) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD"
    }).format((Number(cents) || 0) / 100);
  }

  function formatTaxRate(rate) {
    const numericRate = Number.parseFloat(rate);

    if (!Number.isFinite(numericRate)) {
      return "0";
    }

    return String(Number(numericRate.toFixed(4)));
  }

  function calculateInvoiceTotals({ artworkPrice, salesTaxRate, payments = [] } = {}) {
    const artworkPriceCents = toCents(artworkPrice);
    const normalizedTaxRate = Math.max(0, Number.parseFloat(salesTaxRate) || 0);
    const salesTaxCents = Math.round(artworkPriceCents * normalizedTaxRate / 100);
    const amountDueCents = artworkPriceCents + salesTaxCents;
    const totalReceivedCents = payments.reduce(
      (total, payment) => total + toCents(payment.amount),
      0
    );
    const voluntaryAdditionalPaymentCents = Math.max(0, totalReceivedCents - amountDueCents);
    const balanceDueCents = Math.max(0, amountDueCents - totalReceivedCents);

    let status = "UNPAID";

    if (totalReceivedCents >= amountDueCents && amountDueCents > 0) {
      status = "PAID";
    } else if (totalReceivedCents > 0) {
      status = "PARTIALLY PAID";
    }

    return {
      artworkPriceCents,
      salesTaxRate: normalizedTaxRate,
      salesTaxCents,
      amountDueCents,
      totalReceivedCents,
      voluntaryAdditionalPaymentCents,
      balanceDueCents,
      status
    };
  }

  global.InvoiceUtils = Object.freeze({
    calculateInvoiceTotals,
    formatCents,
    formatTaxRate,
    toCents
  });
})(globalThis);
