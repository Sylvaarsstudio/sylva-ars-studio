(function initializeAdminAccess(globalObject) {
  "use strict";

  const writeSelectors = [
    "#new-client", "#client-create", "#client-create-form", "#edit-client",
    "main.admin-page > form.admin-form",
    "#new-client-quotation", "#client-edit-form", "#commission-create",
    "#commission-form", "#edit-commission", "#change-commission-status",
    "#prepare-contract", "#record-payment", "#payment-form", "#create-delivery",
    "#edit-delivery", "#delivery-create-form", "#delivery-edit-form",
    "#delivery-cancel-confirmation", "#create-communication",
    "#new-communication-draft", "#record-manual-communication",
    "#commission-status-form", "#commission-status-confirmation",
    "#commission-edit-form", "[data-delivery-transition]",
    "[data-delivery-storage-action]", "#new-draft", "#new-from-template",
    "#record-manual", "#mark-communication-ready", "#send-communication",
    "#check-send-status", "#mark-reconciled-sent", "#mark-reconciled-failed",
    "#send-communication-confirmation", "#draft-edit-form",
    "#communication-template-create", "#communication-template-form",
    "#communication-create", "#communication-create-form",
    "#inquiry-status-form", "#convert-inquiry-client",
    "#create-inquiry-quotation", "#quotation-form", "#shipping-estimate-section",
    "#quotation-actions", "#quotation-acceptance-panel",
    "#quotation-acceptance-form", "#quotation-contract-action",
    "#prepare-contract-form", "#document-form", "#add-payment",
    "a.admin-button[href='/admin/create-contract.html']"
  ];
  const selector = writeSelectors.join(",");

  function markWriteControls(root) {
    const controls = [];
    if (root?.matches?.(selector)) controls.push(root);
    if (root?.querySelectorAll) controls.push(...root.querySelectorAll(selector));
    for (const control of controls) {
      control.classList.add("admin-write-control");
      control.setAttribute("aria-hidden", "true");
      for (const field of control.querySelectorAll?.("input, select, textarea, button") || []) {
        field.disabled = true;
      }
    }
    return controls;
  }

  function identityLabel(identity) {
    if (identity.legacy) return "Migration owner · temporary legacy session";
    const role = identity.role === "viewer" ? "Viewer · read only" : "Owner Admin";
    const person = identity.display_name || identity.email;
    return person ? `${person} · ${role}` : role;
  }

  function renderIdentity(documentObject, identity) {
    const badge = documentObject.createElement("p");
    badge.className = "admin-identity-badge";
    badge.setAttribute("role", "status");
    badge.textContent = identityLabel(identity);
    const header = documentObject.querySelector(".admin-header-actions");
    if (header) header.prepend(badge);
    else documentObject.querySelector("main")?.prepend(badge);

    if (identity.role !== "viewer") return;
    documentObject.body.classList.add("admin-role-viewer");
    const notice = documentObject.createElement("p");
    notice.className = "admin-viewer-notice";
    notice.textContent = "Read-only access. Changes, sends, and workflow actions are unavailable.";
    documentObject.querySelector("main")?.prepend(notice);
    markWriteControls(documentObject);

    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === 1) markWriteControls(node);
        }
      }
    });
    observer.observe(documentObject.body, { childList: true, subtree: true });
  }

  async function loadIdentity(documentObject, fetchImplementation, locationObject) {
    const response = await fetchImplementation("/admin/api/session", {
      headers: { Accept: "application/json" },
      credentials: "same-origin"
    });
    if (!response.ok) {
      locationObject.assign("/admin-login.html?error=session_expired");
      return null;
    }
    const result = await response.json();
    renderIdentity(documentObject, result.identity);
    return result.identity;
  }

  const api = { identityLabel, loadIdentity, markWriteControls, renderIdentity, writeSelectors };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalObject.SylvaAdminAccess = api;

  if (globalObject.document && globalObject.fetch) {
    loadIdentity(
      globalObject.document,
      globalObject.fetch.bind(globalObject),
      globalObject.location
    ).catch(() => {
      globalObject.location.assign("/admin-login.html?error=session_check_failed");
    });
  }
})(typeof window !== "undefined" ? window : globalThis);
