const automationModes = Object.freeze(["auto_send", "review_required"]);

function rule(definition) {
  return Object.freeze({ enabled: true, ...definition });
}

const communicationAutomationPolicy = Object.freeze([
  rule({ key: "inquiry_received_confirmation", trigger: "inquiry_created", template_key: "inquiry_received_confirmation", mode: "auto_send" }),
  rule({ key: "quotation_acceptance_confirmation", trigger: "quotation_accepted", template_key: "quotation_acceptance_confirmation", mode: "auto_send" }),
  rule({ key: "receipt_delivery", trigger: "receipt_issued", template_key: "receipt", mode: "auto_send" }),
  rule({ key: "final_invoice_delivery", trigger: "final_invoice_issued", template_key: "final_invoice", mode: "auto_send" }),
  rule({ key: "inquiry_reply", trigger: "admin_review", template_key: "inquiry_reply", mode: "review_required" }),
  rule({ key: "quotation", trigger: "admin_review", template_key: "quotation", mode: "review_required" }),
  rule({ key: "contract", trigger: "admin_review", template_key: "contract", mode: "review_required" }),
  rule({ key: "payment_request", trigger: "admin_review", template_key: "payment_request", mode: "review_required" }),
  rule({ key: "final_presentation", trigger: "admin_review", template_key: "final_presentation", mode: "review_required" }),
  rule({ key: "delivery_ready", trigger: "admin_review", template_key: "delivery_ready", mode: "review_required" }),
  rule({ key: "pickup_scheduled", trigger: "admin_review", template_key: "pickup_scheduled", mode: "review_required" }),
  rule({ key: "shipping_notice", trigger: "admin_review", template_key: "shipping_notice", mode: "review_required" }),
  rule({ key: "storage_notice", trigger: "admin_review", template_key: "storage_notice", mode: "review_required" }),
  rule({ key: "final_storage_notice", trigger: "admin_review", template_key: "final_storage_notice", mode: "review_required" }),
  rule({ key: "thank_you", trigger: "admin_review", template_key: "thank_you", mode: "review_required" })
]);

const automationPolicyRegistry = new Map(communicationAutomationPolicy.map((item) => [item.key, item]));

function getCommunicationAutomationRule(key) {
  return automationPolicyRegistry.get(key) || null;
}

function listCommunicationAutomationPolicy() {
  return communicationAutomationPolicy.map((item) => ({ ...item }));
}

export {
  automationModes,
  communicationAutomationPolicy,
  getCommunicationAutomationRule,
  listCommunicationAutomationPolicy
};
