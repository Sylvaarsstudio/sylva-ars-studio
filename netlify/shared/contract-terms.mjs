const draftSection = (title) => Object.freeze({
  title,
  paragraphs: Object.freeze([
    "DRAFT PLACEHOLDER — This section is under review and is not an approved contractual term."
  ])
});

export const COMMISSION_AGREEMENT_TERMS = Object.freeze({
  status: "draft",
  version: "draft-1",
  approved: false,
  sections: Object.freeze({
    payment: draftSection("Payment"),
    creative_process: draftSection("Creative Process / Revisions"),
    cancellation: draftSection("Cancellation / Refunds"),
    copyright: draftSection("Copyright"),
    delivery: draftSection("Delivery / Shipping")
  })
});

export function cloneContractTerms(terms = COMMISSION_AGREEMENT_TERMS) {
  return structuredClone(terms);
}
