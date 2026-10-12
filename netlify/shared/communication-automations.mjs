import { appendCommissionEvent } from "./commission-events.mjs";
import { getCommunicationAutomationRule } from "./communication-automation-policy.mjs";
import { resolveCommunicationTemplate } from "./communication-templates.mjs";
import { sendCommunication } from "./communications.mjs";

async function createAutomaticCommunication(queryable, {
  automationKey,
  sourceKey,
  templateRequest,
  occurredAt = new Date()
}) {
  const policy = getCommunicationAutomationRule(automationKey);
  if (!policy?.enabled || policy.mode !== "auto_send") {
    return { outcome: "automation_not_enabled" };
  }
  if (typeof sourceKey !== "string" || !sourceKey.trim()) {
    return { outcome: "invalid_source_key" };
  }

  const resolved = await resolveCommunicationTemplate(
    { pool: queryable },
    { ...templateRequest, template_key: policy.template_key }
  );
  if (resolved.outcome !== "success") return resolved;

  const inserted = (await queryable.query(
    `INSERT INTO communications (
       inquiry_id, client_id, commission_id, quotation_id, document_id,
       channel, communication_type, communication_status, recipient,
       subject, body_snapshot, ready_at, template_key, template_version,
       automation_key, automation_mode, automation_source_key
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, 'ready', $8,
       $9, $10, $11, $12, $13, $14, $15, $16
     )
     ON CONFLICT (automation_source_key) WHERE automation_source_key IS NOT NULL
     DO NOTHING
     RETURNING *`,
    [
      resolved.relationships.inquiry_id, resolved.relationships.client_id,
      resolved.relationships.commission_id, resolved.relationships.quotation_id,
      resolved.relationships.document_id, resolved.template.channel,
      resolved.template.communication_type, resolved.recipient, resolved.subject,
      resolved.body, occurredAt, resolved.template.key, resolved.template.version,
      policy.key, policy.mode, sourceKey.trim()
    ]
  )).rows[0];

  if (!inserted) {
    const existing = (await queryable.query(
      "SELECT * FROM communications WHERE automation_source_key = $1",
      [sourceKey.trim()]
    )).rows[0];
    return { outcome: "success", created: false, communication: existing };
  }

  if (inserted.commission_id) {
    await appendCommissionEvent(queryable, {
      commissionId: inserted.commission_id,
      eventType: "communication_automation_created",
      occurredAt,
      actorType: "system",
      sourceType: "communication",
      sourceId: inserted.id,
      payload: {
        communication_id: String(inserted.id),
        automation_key: policy.key,
        template_key: resolved.template.key,
        template_version: Number(resolved.template.version),
        communication_type: resolved.template.communication_type
      }
    });
  }

  return { outcome: "success", created: true, communication: inserted };
}

async function attemptAutomaticCommunicationSend(db, communicationId, emailProvider, now = () => new Date()) {
  if (!communicationId) return { outcome: "not_applicable" };
  if (!emailProvider || emailProvider.configured === false) {
    return { outcome: "pending_provider_configuration" };
  }
  try {
    return await sendCommunication(db, communicationId, emailProvider, now);
  } catch {
    return { outcome: "send_error" };
  }
}

export { attemptAutomaticCommunicationSend, createAutomaticCommunication };
