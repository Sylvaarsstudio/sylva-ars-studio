import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  API_PATH,
  buildPayload,
  buildTemplatePayload,
  createApp,
  describeAutomation,
  formatStatus,
  getCommunicationActionState,
  renderDetailMarkup,
  renderListMarkup,
  renderTemplateOptions,
  renderTemplatePreview,
  renderTypeOptions
} = require("../../web/js/admin-communications.js");

function element(value = "") {
  const listeners = new Map();
  return {
    value, textContent: "", innerHTML: "", hidden: false, href: "",
    classList: { add() {}, remove() {} },
    addEventListener(type, listener) { listeners.set(type, listener); },
    getListener(type) { return listeners.get(type); }
  };
}

function form(fieldNames) {
  const fields = Object.fromEntries(fieldNames.map((name) => [name, element()]));
  const formElement = element();
  formElement.elements = { namedItem: (name) => fields[name] };
  formElement.fields = fields;
  formElement.reset = () => Object.values(fields).forEach((field) => { field.value = ""; });
  return formElement;
}

function documentFixture() {
  const createForm = form([
    "channel", "communication_type", "recipient", "subject", "body_snapshot",
    "commission_id", "client_id", "inquiry_id", "quotation_id", "document_id"
  ]);
  const editForm = form(["communication_type", "recipient", "subject", "body_snapshot"]);
  const templateForm = form(["template_key", "commission_id", "inquiry_id", "quotation_id", "document_id"]);
  const elements = {
    "#communication-count": element(), "#communications-list": element(),
    "#communications-list-panel": element(), "#communications-status": element(),
    "#communication-status-filter": element(), "#communication-type-filter": element(),
    "#communication-channel-filter": element(), "#new-draft": element(),
    "#new-from-template": element(), "#record-manual": element(), "#communication-detail": element(),
    "#communication-detail-fields": element(), "#close-communication-detail": element(),
    "#mark-communication-ready": element(),
    "#send-communication": element(), "#send-communication-confirmation": element(),
    "#send-communication-recipient": element(), "#send-communication-subject": element(),
    "#cancel-send-communication": element(), "#confirm-send-communication": element(),
    "#check-send-status": element(), "#mark-reconciled-sent": element(),
    "#mark-reconciled-failed": element(),
    "#draft-edit-form": editForm, "#communication-create": element(),
    "#communication-create-form": createForm, "#communication-create-title": element(),
    "#communication-create-help": element(), "#communication-create-submit": element(),
    "#communication-channel-field": element(), "#cancel-communication-create": element(),
    "#communication-template-create": element(), "#communication-template-form": templateForm,
    "#cancel-template-create": element(), "#preview-template": element(),
    "#generate-template-draft": element(), "#template-preview-status": element(),
    "#template-preview": element()
  };
  elements["#communication-detail"].hidden = true;
  elements["#communication-create"].hidden = true;
  elements["#communication-template-create"].hidden = true;
  elements["#send-communication-confirmation"].hidden = true;
  return { elements, createForm, editForm, templateForm, querySelector: (selector) => elements[selector] };
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

const sample = {
  id: "8", commission_id: "3", commission_number: "SAS-COM-2026-0003",
  channel: "email", communication_type: "quotation", communication_status: "draft",
  recipient: "client@example.invalid", subject: "Your quotation", body_snapshot: "Exact body.",
  created_at: "2026-10-11T16:00:00Z", sent_at: null
};

test("Communications page exposes explicit reviewed-email sending without Queue or Retry controls", () => {
  const html = readFileSync(new URL("../../web/admin/communications.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../../web/css/admin.css", import.meta.url), "utf8");
  assert.match(html, /id="communication-status-filter"/);
  assert.match(html, /id="communication-type-filter"/);
  assert.match(html, /id="communication-channel-filter"/);
  assert.match(html, /id="draft-edit-form"/);
  assert.match(html, /id="new-from-template"/);
  assert.match(html, /id="communication-template-form"/);
  assert.match(html, /id="preview-template"/);
  assert.match(html, /id="generate-template-draft"/);
  assert.match(html, /Mark Ready for Sending/);
  assert.match(html, /id="send-communication"[^>]*>Send Email</);
  assert.match(html, /This will send the reviewed snapshot exactly as shown\./);
  assert.match(html, /id="check-send-status"[^>]*>Check Send Status</);
  assert.match(html, /id="mark-reconciled-sent"[^>]*>Mark as Sent</);
  assert.match(html, /id="mark-reconciled-failed"[^>]*>Mark as Failed</);
  for (const id of [
    "mark-communication-ready", "send-communication", "check-send-status",
    "mark-reconciled-sent", "mark-reconciled-failed"
  ]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*\\shidden(?:\\s|>)`));
  }
  assert.match(html, /Record Manual Communication/);
  assert.doesNotMatch(html, /<button[^>]*>\s*(Queue|Retry)\s*<\/button>/i);
  assert.match(html, /data-glossary-key="communication"/);
  assert.match(
    css,
    /\.admin-communications-page #communication-detail \.admin-button\[hidden\]\s*\{\s*display:\s*none;\s*\}/
  );
});

test("list and detail render safe persistent communication data and escaped body content", () => {
  const list = renderListMarkup([sample]);
  assert.match(list, /SAS-COM-2026-0003/);
  assert.match(list, /Quotation/);
  assert.match(renderListMarkup([]), /No communications found/);
  const detail = renderDetailMarkup({ ...sample, body_snapshot: "Hello <script>alert(1)</script>\nSecond line" });
  assert.match(detail, /Recipient Snapshot/);
  assert.match(detail, /Hello &lt;script&gt;/);
  assert.doesNotMatch(detail, /<script>alert/);
  assert.match(detail, /Second line/);
});

test("automatic Communications show approved labels and provider-pending status without Retry", () => {
  const labels = {
    inquiry_received_confirmation: "Automated · Inquiry Confirmation",
    quotation_acceptance_confirmation: "Automated · Quotation Acceptance Confirmation",
    receipt_delivery: "Automated · Receipt Delivery",
    final_invoice_delivery: "Automated · Final Invoice Delivery"
  };
  for (const [automation_key, label] of Object.entries(labels)) {
    const item = {
      ...sample,
      automation_key,
      automation_mode: "auto_send",
      communication_status: "ready"
    };
    assert.equal(describeAutomation(item), label);
    assert.equal(
      formatStatus(item.communication_status, item),
      "Ready — Automatic send pending provider configuration"
    );
    const markup = renderDetailMarkup(item);
    assert.match(markup, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(markup, /Retry|Send Again/);
  }
});

test("communication actions are state- and provider-aware", () => {
  const ready = {
    ...sample, communication_status: "ready", ready_at: sample.created_at,
    automation_mode: "auto_send"
  };
  assert.deepEqual(getCommunicationActionState(ready, false), {
    editDraft: false, markReady: false, send: false, reconcile: false,
    markSent: false, markFailed: false,
    message: "Automatic send pending provider configuration"
  });
  assert.deepEqual(getCommunicationActionState(ready, true), {
    editDraft: false, markReady: false, send: true, reconcile: false,
    markSent: false, markFailed: false, message: ""
  });
  const recent = { ...sample, communication_status: "queued", queued_stale: false };
  assert.equal(getCommunicationActionState(recent, true).message, "Sending / Processing");
  assert.equal(getCommunicationActionState(recent, true).reconcile, false);
  const stale = { ...recent, queued_stale: true, reconciliation_required: true };
  assert.equal(getCommunicationActionState(stale, true).reconcile, true);
  assert.equal(getCommunicationActionState(stale, true).markSent, false);
  const inconclusive = { ...stale, reconciliation_status: "inconclusive" };
  assert.equal(getCommunicationActionState(inconclusive, true).reconcile, false);
  assert.equal(getCommunicationActionState(inconclusive, true).markSent, true);
  assert.equal(getCommunicationActionState(inconclusive, true).markFailed, true);
  for (const terminal of [
    { ...sample, communication_status: "sent" },
    { ...sample, communication_status: "failed" },
    { ...sample, channel: "manual", communication_status: "sent" }
  ]) {
    const actions = getCommunicationActionState(terminal, true);
    assert.equal(actions.send, false);
    assert.equal(actions.reconcile, false);
    assert.equal(actions.markSent, false);
    assert.equal(actions.markFailed, false);
  }
});

test("Communication Detail renders only the actions allowed by status and provider capability", async () => {
  const actionSelectors = [
    "#mark-communication-ready",
    "#send-communication",
    "#check-send-status",
    "#mark-reconciled-sent",
    "#mark-reconciled-failed"
  ];
  const cases = [
    {
      name: "ready with provider missing",
      communication: {
        ...sample, communication_status: "ready", automation_mode: "auto_send"
      },
      providerConfigured: false,
      visible: [],
      message: "Automatic send pending provider configuration"
    },
    {
      name: "ready with provider configured",
      communication: { ...sample, communication_status: "ready" },
      providerConfigured: true,
      visible: ["#send-communication"]
    },
    {
      name: "recent queued",
      communication: {
        ...sample, communication_status: "queued", queued_stale: false,
        reconciliation_required: false
      },
      providerConfigured: true,
      visible: [],
      message: "Sending / Processing"
    },
    {
      name: "stale queued",
      communication: {
        ...sample, communication_status: "queued", queued_stale: true,
        reconciliation_required: true, reconciliation_status: null
      },
      providerConfigured: true,
      visible: ["#check-send-status"]
    },
    {
      name: "inconclusive queued",
      communication: {
        ...sample, communication_status: "queued", queued_stale: true,
        reconciliation_required: true, reconciliation_status: "inconclusive"
      },
      providerConfigured: true,
      visible: ["#mark-reconciled-sent", "#mark-reconciled-failed"]
    },
    {
      name: "sent",
      communication: { ...sample, communication_status: "sent" },
      providerConfigured: true,
      visible: []
    },
    {
      name: "failed",
      communication: { ...sample, communication_status: "failed" },
      providerConfigured: true,
      visible: []
    },
    {
      name: "manual sent",
      communication: { ...sample, channel: "manual", communication_status: "sent" },
      providerConfigured: true,
      visible: []
    }
  ];

  for (const scenario of cases) {
    const fixture = documentFixture();
    const app = createApp(fixture, async () => response({
      communication: scenario.communication,
      email_provider_configured: scenario.providerConfigured
    }));
    await app.openDetail(scenario.communication.id);
    const visible = actionSelectors.filter((selector) => fixture.elements[selector].hidden === false);
    assert.deepEqual(visible, scenario.visible, scenario.name);
    if (scenario.message) {
      assert.equal(fixture.elements["#communications-status"].textContent, scenario.message, scenario.name);
    }
  }
});

test("type options contain the approved minimal vocabulary", () => {
  const options = renderTypeOptions("receipt");
  for (const type of ["general", "inquiry_reply", "quotation", "contract", "payment_request", "receipt", "final_invoice", "final_presentation", "delivery", "storage_notice", "final_storage_notice", "thank_you", "manual_note"]) {
    assert.match(options, new RegExp(`value="${type}"`));
  }
  assert.match(options, /value="receipt" selected/);
});

test("draft creation posts only to the draft collection and never sends", async () => {
  const fixture = documentFixture();
  const calls = [];
  const app = createApp(fixture, async (url, options = {}) => {
    calls.push({ url, options });
    if (options.method === "POST") return response({ communication: sample }, 201);
    if (url === `${API_PATH}/8`) return response({ communication: sample });
    return response({ communications: [sample] });
  }, () => "00000000-0000-4000-8000-000000000001", { search: "?commission_id=3" });
  app.openCreate(false);
  Object.assign(fixture.createForm.fields.channel, { value: "email" });
  fixture.createForm.fields.communication_type.value = "quotation";
  fixture.createForm.fields.recipient.value = "client@example.invalid";
  fixture.createForm.fields.body_snapshot.value = "Exact body.";
  await app.submitCreate({ preventDefault() {} });
  assert.equal(calls[0].url, API_PATH);
  assert.equal(calls[0].options.method, "POST");
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.commission_id, "3");
  assert.equal(payload.request_id, "00000000-0000-4000-8000-000000000001");
  assert.equal(calls.some((call) => /send|queue|provider/i.test(call.url)), false);
});

test("manual record uses the explicit manual endpoint and preserves exact snapshot", async () => {
  const fixture = documentFixture();
  const calls = [];
  const manual = { ...sample, channel: "manual", communication_status: "sent", sent_at: sample.created_at };
  const app = createApp(fixture, async (url, options = {}) => {
    calls.push({ url, options });
    if (options.method === "POST") return response({ communication: manual }, 201);
    if (url === `${API_PATH}/8`) return response({ communication: manual });
    return response({ communications: [manual] });
  }, () => "00000000-0000-4000-8000-000000000002", { search: "?commission_id=3" });
  app.openCreate(true);
  fixture.createForm.fields.communication_type.value = "manual_note";
  fixture.createForm.fields.recipient.value = "Client";
  fixture.createForm.fields.body_snapshot.value = "Phone conversation recorded exactly.";
  await app.submitCreate({ preventDefault() {} });
  assert.equal(calls[0].url, `${API_PATH}/manual`);
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.channel, "manual");
  assert.equal(payload.body_snapshot, "Phone conversation recorded exactly.");
  assert.match(fixture.elements["#communication-create-help"].textContent, /Nothing will be sent/);
});

test("list filters are transmitted and API errors remain visible to callers", async () => {
  const fixture = documentFixture();
  fixture.elements["#communication-status-filter"].value = "draft";
  fixture.elements["#communication-type-filter"].value = "quotation";
  fixture.elements["#communication-channel-filter"].value = "email";
  let requestedUrl;
  const app = createApp(fixture, async (url) => { requestedUrl = url; return response({ communications: [sample] }); });
  const items = await app.loadList();
  assert.equal(items.length, 1);
  assert.match(requestedUrl, /status=draft/);
  assert.match(requestedUrl, /type=quotation/);
  assert.match(requestedUrl, /channel=email/);

  await assert.rejects(
    createApp(documentFixture(), async () => response({ message: "Unable to load communications." }, 500)).loadList(),
    /Unable to load communications/
  );
});

test("draft edit payload excludes relationships, channel, and workflow status", async () => {
  const fixture = documentFixture();
  let patchPayload;
  const app = createApp(fixture, async (url, options = {}) => {
    if (options.method === "PATCH") { patchPayload = JSON.parse(options.body); return response({ communication: { ...sample, ...patchPayload } }); }
    return response({ communication: sample });
  });
  await app.openDetail("8");
  fixture.editForm.fields.communication_type.value = "general";
  fixture.editForm.fields.recipient.value = "new@example.invalid";
  fixture.editForm.fields.subject.value = "Changed";
  fixture.editForm.fields.body_snapshot.value = "Changed body.";
  await app.submitEdit({ preventDefault() {} });
  assert.deepEqual(Object.keys(patchPayload).sort(), ["body_snapshot", "communication_type", "recipient", "subject"]);
});

test("buildPayload retains fixed relationship inputs and request id", () => {
  const fixture = documentFixture();
  fixture.createForm.fields.channel.value = "email";
  fixture.createForm.fields.communication_type.value = "general";
  fixture.createForm.fields.recipient.value = "x@example.invalid";
  fixture.createForm.fields.body_snapshot.value = "Body";
  fixture.createForm.fields.inquiry_id.value = "00000000-0000-4000-8000-000000000005";
  const payload = buildPayload(fixture.createForm, "00000000-0000-4000-8000-000000000006", false);
  assert.equal(payload.inquiry_id, "00000000-0000-4000-8000-000000000005");
  assert.equal(payload.request_id, "00000000-0000-4000-8000-000000000006");
});

test("template selector is server-driven and labels template versions", async () => {
  const fixture = documentFixture();
  const templates = [{ key: "quotation", name: "Quotation", version: 1 }];
  const app = createApp(fixture, async (url) => {
    assert.equal(url, `${API_PATH}/templates`);
    return response({ templates });
  });
  await app.loadTemplates();
  assert.match(fixture.templateForm.fields.template_key.innerHTML, /Quotation · v1/);
  assert.match(renderTemplateOptions(templates, "quotation"), /value="quotation" selected/);
});

test("template preview displays exact plain text and does not generate automatically", async () => {
  const fixture = documentFixture();
  const calls = [];
  const app = createApp(fixture, async (url, options = {}) => {
    calls.push({ url, options });
    return response({
      success: true, complete: true, template: "quotation", version: 1,
      recipient: "client@example.invalid", subject: "Quotation SAS-QUO-2026-0001",
      body: "Dear Client,\n\nPlease review.", missing_context: []
    });
  }, () => "00000000-0000-4000-8000-000000000010", { search: "?commission_id=3" });
  app.openTemplateCreate();
  fixture.templateForm.fields.template_key.value = "quotation";
  fixture.templateForm.fields.quotation_id.value = "9";
  const preview = await app.previewSelectedTemplate();
  assert.equal(preview.complete, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${API_PATH}/template-preview`);
  assert.equal(fixture.elements["#generate-template-draft"].disabled, false);
  assert.match(fixture.elements["#template-preview"].innerHTML, /Plain-text Preview/);
  assert.match(renderTemplatePreview(preview), /Dear Client/);
  assert.equal(calls.some((call) => call.url.includes("from-template")), false);
});

test("missing template context remains visible and blocks Generate Draft", async () => {
  const fixture = documentFixture();
  const app = createApp(fixture, async () => response({
    success: true, complete: false, template: "contract", version: 1,
    recipient: null, subject: null, body: null, missing_context: ["document_id"]
  }));
  app.openTemplateCreate();
  fixture.templateForm.fields.template_key.value = "contract";
  await app.previewSelectedTemplate();
  assert.equal(fixture.elements["#generate-template-draft"].disabled, true);
  assert.match(fixture.elements["#template-preview"].innerHTML, /document_id/);
  await assert.rejects(app.generateTemplateDraft({ preventDefault() {} }), /Preview is required/);
});

test("Generate Draft follows Preview and uses a stable request id", async () => {
  const fixture = documentFixture();
  const calls = [];
  const generated = { ...sample, template_key: "quotation", template_version: 1 };
  const app = createApp(fixture, async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/template-preview")) return response({
      success: true, complete: true, template: "quotation", version: 1,
      recipient: generated.recipient, subject: generated.subject, body: generated.body_snapshot,
      missing_context: []
    });
    if (url.endsWith("/from-template")) return response({ communication: generated }, 201);
    if (url === `${API_PATH}/8`) return response({ communication: generated });
    return response({ communications: [generated] });
  }, () => "00000000-0000-4000-8000-000000000011", { search: "?commission_id=3" });
  app.openTemplateCreate();
  fixture.templateForm.fields.template_key.value = "quotation";
  fixture.templateForm.fields.quotation_id.value = "9";
  await app.previewSelectedTemplate();
  await app.generateTemplateDraft({ preventDefault() {} });
  const generateCall = calls.find((call) => call.url.endsWith("/from-template"));
  const payload = JSON.parse(generateCall.options.body);
  assert.equal(payload.request_id, "00000000-0000-4000-8000-000000000011");
  assert.equal(payload.commission_id, "3");
  assert.equal(calls.some((call) => /send|queue|provider/.test(call.url)), false);
});

test("Mark Ready is explicit, freezes the editor, and renders Reviewed / Ready rather than Sent", async () => {
  const fixture = documentFixture();
  const ready = { ...sample, communication_status: "ready", ready_at: "2026-10-11T18:00:00Z" };
  const calls = [];
  const app = createApp(fixture, async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/ready")) return response({ communication: ready, changed: true });
    if (url === `${API_PATH}/8`) return response({ communication: sample, email_provider_configured: true });
    return response({ communications: [ready], email_provider_configured: true });
  });
  await app.openDetail("8");
  assert.equal(fixture.elements["#mark-communication-ready"].hidden, false);
  await app.markReady();
  assert.equal(fixture.elements["#draft-edit-form"].hidden, true);
  assert.equal(fixture.elements["#mark-communication-ready"].hidden, true);
  assert.equal(fixture.elements["#send-communication"].hidden, false);
  assert.match(fixture.elements["#communication-detail-fields"].innerHTML, /Reviewed \/ Ready/);
  assert.doesNotMatch(fixture.elements["#communication-detail-fields"].innerHTML, /<dd>Sent<\/dd>/);
  assert.equal(formatStatus("ready"), "Reviewed / Ready");
  assert.equal(calls.find((call) => call.url.endsWith("/ready")).options.method, "POST");
});

test("Send Email is visible only for a ready email and requires recipient and subject confirmation", async () => {
  const fixture = documentFixture();
  const ready = { ...sample, communication_status: "ready", ready_at: "2026-10-11T18:00:00Z" };
  let calls = 0;
  const app = createApp(fixture, async () => {
    calls += 1;
    return response({ communication: ready, email_provider_configured: true });
  });
  await app.openDetail("8");
  assert.equal(fixture.elements["#send-communication"].hidden, false);
  assert.equal(fixture.elements["#send-communication-confirmation"].hidden, true);
  assert.equal(app.openSendConfirmation(), true);
  assert.equal(fixture.elements["#send-communication-confirmation"].hidden, false);
  assert.equal(fixture.elements["#send-communication-recipient"].textContent, ready.recipient);
  assert.equal(fixture.elements["#send-communication-subject"].textContent, ready.subject);
  assert.equal(calls, 1);
  app.showIndex();
  assert.equal(fixture.elements["#send-communication-confirmation"].hidden, true);

  const manualFixture = documentFixture();
  const manual = { ...ready, channel: "manual", communication_status: "sent" };
  const manualApp = createApp(manualFixture, async () => response({ communication: manual }));
  await manualApp.openDetail("8");
  assert.equal(manualFixture.elements["#send-communication"].hidden, true);
  assert.equal(manualApp.openSendConfirmation(), false);
});

test("confirmed send shows queued processing then the persisted sent state", async () => {
  const fixture = documentFixture();
  const ready = { ...sample, communication_status: "ready", ready_at: "2026-10-11T18:00:00Z" };
  const sent = {
    ...ready, communication_status: "sent", queued_at: "2026-10-11T18:01:00Z",
    sent_at: "2026-10-11T18:01:01Z", provider_message_id: "external-8"
  };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const app = createApp(fixture, async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/send")) {
      await gate;
      return response({ communication: sent, changed: true, provider: "fake" });
    }
    if (url === `${API_PATH}/8`) return response({ communication: ready, email_provider_configured: true });
    return response({ communications: [sent], email_provider_configured: true });
  });
  await app.openDetail("8");
  app.openSendConfirmation();
  const sending = app.sendSelected();
  assert.match(fixture.elements["#communication-detail-fields"].innerHTML, /Sending \/ Processing/);
  assert.equal(fixture.elements["#send-communication"].hidden, true);
  release();
  const result = await sending;
  assert.equal(result.communication_status, "sent");
  assert.match(fixture.elements["#communication-detail-fields"].innerHTML, /<dt>Sent<\/dt>/);
  assert.equal(fixture.elements["#communications-status"].textContent, "Email sent.");
  assert.equal(calls.find((call) => call.url.endsWith("/send")).options.method, "POST");
});

test("failed send refreshes terminal failure details and exposes no Retry action", async () => {
  const fixture = documentFixture();
  const ready = { ...sample, communication_status: "ready", ready_at: "2026-10-11T18:00:00Z" };
  const failed = {
    ...ready, communication_status: "failed", queued_at: "2026-10-11T18:01:00Z",
    failed_at: "2026-10-11T18:01:02Z", error_code: "provider_unavailable"
  };
  let current = ready;
  const app = createApp(fixture, async (url) => {
    if (url.endsWith("/send")) {
      current = failed;
      return response({ code: "provider_unavailable", message: "The email provider did not accept this communication." }, 503);
    }
    if (url === `${API_PATH}/8`) return response({ communication: current, email_provider_configured: true });
    return response({ communications: [current], email_provider_configured: true });
  });
  await app.openDetail("8");
  const result = await app.sendSelected();
  assert.equal(result, null);
  assert.match(fixture.elements["#communication-detail-fields"].innerHTML, /provider_unavailable/);
  assert.equal(fixture.elements["#send-communication"].hidden, true);
  assert.equal(fixture.elements["#communications-status"].textContent, "The email provider did not accept this communication.");
  assert.doesNotMatch(fixture.elements["#communication-detail-fields"].innerHTML, /Retry/);
  assert.equal(formatStatus("queued"), "Sending / Processing");
});

test("stale queued communications expose reconciliation without Send Again or Retry", async () => {
  const fixture = documentFixture();
  const stale = {
    ...sample, communication_status: "queued", queued_at: "2026-10-11T18:00:00Z",
    queued_stale: true, reconciliation_required: true, reconciliation_status: null
  };
  const calls = [];
  const app = createApp(fixture, async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/reconcile")) return response({ result: "inconclusive", communication: stale });
    if (url === `${API_PATH}/8`) return response({ communication: stale });
    return response({ communications: [stale] });
  });
  await app.openDetail("8");
  assert.equal(fixture.elements["#check-send-status"].hidden, false);
  assert.equal(fixture.elements["#send-communication"].hidden, true);
  assert.equal(formatStatus("queued", stale), "Reconciliation Required");
  await app.reconcileSelected();
  assert.equal(calls.filter((call) => call.url.endsWith("/reconcile")).length, 1);
  assert.equal(calls.some((call) => call.url.endsWith("/send")), false);
});

test("inconclusive reconciliation offers confirmed manual resolution but never sends", async () => {
  const fixture = documentFixture();
  const inconclusive = {
    ...sample, communication_status: "queued", queued_at: "2026-10-11T18:00:00Z",
    queued_stale: true, reconciliation_required: true, reconciliation_status: "inconclusive",
    reconciled_at: "2026-10-11T18:05:00Z", reconciliation_note: "gmail_send_scope_cannot_read_mailbox"
  };
  const manuallySent = {
    ...inconclusive, communication_status: "sent", sent_at: "2026-10-11T18:06:00Z",
    reconciliation_status: "confirmed_sent", reconciliation_note: "admin_verified_externally_sent",
    queued_stale: false, reconciliation_required: false
  };
  const calls = [];
  let current = inconclusive;
  const app = createApp(fixture, async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/manual-sent")) { current = manuallySent; return response({ communication: current, result: "confirmed_sent" }); }
    if (url === `${API_PATH}/8`) return response({ communication: current });
    return response({ communications: [current] });
  }, undefined, undefined, () => true);
  await app.openDetail("8");
  assert.equal(formatStatus("queued", inconclusive), "Manual Review Required");
  assert.equal(fixture.elements["#mark-reconciled-sent"].hidden, false);
  assert.equal(fixture.elements["#mark-reconciled-failed"].hidden, false);
  const result = await app.resolveManually("sent");
  assert.equal(result.communication_status, "sent");
  const resolutionCall = calls.find((call) => call.url.endsWith("/manual-sent"));
  assert.deepEqual(JSON.parse(resolutionCall.options.body), { confirmation: "MARK_AS_SENT_VERIFIED_EXTERNALLY" });
  assert.equal(calls.some((call) => call.url.endsWith("/send")), false);
});

test("manual reconciliation requires confirmation and Mark as Failed never retries", async () => {
  const fixture = documentFixture();
  const inconclusive = {
    ...sample, communication_status: "queued", queued_at: "2026-10-11T18:00:00Z",
    queued_stale: true, reconciliation_required: true, reconciliation_status: "inconclusive"
  };
  const calls = [];
  const denied = createApp(fixture, async (url) => {
    calls.push(url);
    return response({ communication: inconclusive });
  }, undefined, undefined, () => false);
  await denied.openDetail("8");
  assert.equal(await denied.resolveManually("failed"), null);
  assert.equal(calls.length, 1);

  const failedFixture = documentFixture();
  const failed = {
    ...inconclusive, communication_status: "failed", failed_at: "2026-10-11T18:07:00Z",
    error_code: "manual_reconciliation_failed", reconciliation_required: false, queued_stale: false
  };
  const failedCalls = [];
  let current = inconclusive;
  const approved = createApp(failedFixture, async (url, options = {}) => {
    failedCalls.push({ url, options });
    if (url.endsWith("/manual-failed")) { current = failed; return response({ communication: current, result: "inconclusive" }); }
    if (url === `${API_PATH}/8`) return response({ communication: current });
    return response({ communications: [current] });
  }, undefined, undefined, () => true);
  await approved.openDetail("8");
  await approved.resolveManually("failed");
  assert.equal(failedCalls.some((call) => /send|retry/.test(call.url)), false);
  assert.deepEqual(JSON.parse(failedCalls.find((call) => call.url.endsWith("/manual-failed")).options.body), {
    confirmation: "MARK_AS_FAILED_NO_RETRY"
  });
});

test("template payload contains only controlled identifiers", () => {
  const fixture = documentFixture();
  fixture.templateForm.fields.template_key.value = "shipping_notice";
  fixture.templateForm.fields.commission_id.value = "3";
  const payload = buildTemplatePayload(fixture.templateForm, "00000000-0000-4000-8000-000000000012");
  assert.deepEqual(Object.keys(payload).sort(), [
    "commission_id", "document_id", "inquiry_id", "quotation_id", "request_id", "template_key"
  ]);
});
