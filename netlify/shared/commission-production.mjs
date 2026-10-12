import { appendCommissionEvent } from "./commission-events.mjs";

const productionStatuses = Object.freeze([
  "not_started",
  "reserved",
  "in_progress",
  "awaiting_client_review",
  "revision_in_progress",
  "final_presented",
  "final_accepted",
  "paused",
  "completed",
  "cancelled"
]);

const productionTransitionMap = Object.freeze({
  not_started: Object.freeze(["reserved"]),
  reserved: Object.freeze(["in_progress", "paused"]),
  in_progress: Object.freeze(["awaiting_client_review", "final_presented", "paused"]),
  awaiting_client_review: Object.freeze(["revision_in_progress", "final_presented", "paused"]),
  revision_in_progress: Object.freeze(["awaiting_client_review", "final_presented", "paused"]),
  final_presented: Object.freeze(["revision_in_progress", "final_accepted"]),
  final_accepted: Object.freeze([]),
  paused: Object.freeze([]),
  completed: Object.freeze([]),
  cancelled: Object.freeze([])
});

const resumableProductionStatuses = new Set([
  "reserved",
  "in_progress",
  "awaiting_client_review",
  "revision_in_progress"
]);

const transitionEventTypes = Object.freeze({
  reserved: "production_reserved",
  in_progress: "production_started",
  awaiting_client_review: "production_awaiting_client_review",
  revision_in_progress: "production_revision_started",
  final_presented: "production_final_presented",
  paused: "production_paused"
});

function normalizeProductionRow(row) {
  if (!row) return null;

  return {
    initialized: true,
    commission_id: String(row.commission_id),
    production_status: row.production_status,
    paused_from_status: row.paused_from_status,
    reserved_at: row.reserved_at,
    started_at: row.started_at,
    final_presented_at: row.final_presented_at,
    final_accepted_at: row.final_accepted_at,
    completed_at: row.completed_at,
    paused_at: row.paused_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

async function initializeCommissionProduction(queryable, commissionId, occurredAt = new Date()) {
  const result = await queryable.query(
    `INSERT INTO commission_production (
       commission_id, production_status, created_at, updated_at
     ) VALUES ($1, 'not_started', $2, $2)
     ON CONFLICT (commission_id) DO NOTHING
     RETURNING *`,
    [commissionId, occurredAt]
  );
  const created = result.rows[0];

  if (created) {
    await appendCommissionEvent(queryable, {
      commissionId,
      eventType: "production_initialized",
      occurredAt,
      actorType: "system",
      sourceType: "commission",
      sourceId: commissionId,
      payload: {
        previous_status: null,
        new_status: "not_started"
      }
    });
  }

  return {
    created: Boolean(created),
    production: normalizeProductionRow(created || (await queryable.query(
      "SELECT * FROM commission_production WHERE commission_id = $1",
      [commissionId]
    )).rows[0])
  };
}

async function readCommissionProduction(db, commissionId) {
  const result = await db.pool.query(
    `SELECT
       c.id AS existing_commission_id,
       p.*
     FROM commissions AS c
     LEFT JOIN commission_production AS p ON p.commission_id = c.id
     WHERE c.id = $1`,
    [commissionId]
  );
  const row = result.rows[0];

  if (!row) return null;
  if (row.commission_id === null) {
    return {
      initialized: false,
      commission_id: String(row.existing_commission_id),
      production_status: null,
      paused_from_status: null,
      reserved_at: null,
      started_at: null,
      final_presented_at: null,
      final_accepted_at: null,
      completed_at: null,
      paused_at: null,
      created_at: null,
      updated_at: null
    };
  }

  return normalizeProductionRow(row);
}

async function transitionCommissionProduction(db, commissionId, nextStatus, {
  now = () => new Date(),
  actorType = "admin"
} = {}) {
  const connection = await db.pool.connect();

  try {
    await connection.query("BEGIN");
    await connection.query(
      "SELECT pg_advisory_xact_lock(hashtext('commission-production'), hashtext($1::text))",
      [commissionId]
    );
    const current = (await connection.query(
      `SELECT *
       FROM commission_production
       WHERE commission_id = $1
       FOR UPDATE`,
      [commissionId]
    )).rows[0];

    if (!current) {
      await connection.query("ROLLBACK");
      return { outcome: "not_initialized" };
    }

    if (!productionStatuses.includes(nextStatus) || nextStatus === "cancelled") {
      await connection.query("ROLLBACK");
      return { outcome: "invalid_transition", current_status: current.production_status };
    }

    const previousStatus = current.production_status;
    const isResume = previousStatus === "paused";
    const allowedTargets = productionTransitionMap[previousStatus] || [];
    const resumeTarget = isResume ? current.paused_from_status : null;
    const isAllowedResume = isResume
      && resumableProductionStatuses.has(resumeTarget)
      && nextStatus === resumeTarget;

    if (!allowedTargets.includes(nextStatus) && !isAllowedResume) {
      await connection.query("ROLLBACK");
      return { outcome: "invalid_transition", current_status: previousStatus };
    }

    const occurredAt = now();

    if (nextStatus === "final_accepted") {
      const completed = (await connection.query(
        `UPDATE commission_production
         SET production_status = 'completed',
             paused_from_status = NULL,
             final_accepted_at = $2,
             completed_at = $2,
             updated_at = $2
         WHERE commission_id = $1
           AND production_status = 'final_presented'
         RETURNING *`,
        [commissionId, occurredAt]
      )).rows[0];
      if (!completed) {
        await connection.query("ROLLBACK");
        return { outcome: "invalid_transition", current_status: previousStatus };
      }
      await appendCommissionEvent(connection, {
        commissionId,
        eventType: "production_final_accepted",
        occurredAt,
        actorType,
        sourceType: "commission",
        sourceId: commissionId,
        payload: {
          previous_status: previousStatus,
          new_status: "final_accepted"
        }
      });
      await appendCommissionEvent(connection, {
        commissionId,
        eventType: "production_completed",
        occurredAt,
        actorType: "system",
        sourceType: "commission",
        sourceId: commissionId,
        payload: {
          previous_status: "final_accepted",
          new_status: "completed"
        }
      });
      await connection.query("COMMIT");
      return { outcome: "success", production: normalizeProductionRow(completed) };
    }

    const pausedFromStatus = nextStatus === "paused" ? previousStatus : null;
    const updated = (await connection.query(
      `UPDATE commission_production
       SET production_status = $2,
           paused_from_status = $3,
           reserved_at = CASE
             WHEN $2 = 'reserved' AND NOT $5 THEN $4
             ELSE reserved_at
           END,
           started_at = CASE
             WHEN $2 = 'in_progress' AND NOT $5 THEN $4
             ELSE started_at
           END,
           final_presented_at = CASE
             WHEN $2 = 'final_presented' AND NOT $5 THEN $4
             ELSE final_presented_at
           END,
           paused_at = CASE WHEN $2 = 'paused' THEN $4 ELSE paused_at END,
           updated_at = $4
       WHERE commission_id = $1
         AND production_status = $6
         AND paused_from_status IS NOT DISTINCT FROM $7
       RETURNING *`,
      [
        commissionId,
        nextStatus,
        pausedFromStatus,
        occurredAt,
        isResume,
        previousStatus,
        current.paused_from_status
      ]
    )).rows[0];
    if (!updated) {
      await connection.query("ROLLBACK");
      return { outcome: "invalid_transition", current_status: previousStatus };
    }
    await appendCommissionEvent(connection, {
      commissionId,
      eventType: isResume ? "production_resumed" : transitionEventTypes[nextStatus],
      occurredAt,
      actorType,
      sourceType: "commission",
      sourceId: commissionId,
      payload: {
        previous_status: previousStatus,
        new_status: nextStatus
      }
    });
    await connection.query("COMMIT");
    return { outcome: "success", production: normalizeProductionRow(updated) };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

export {
  initializeCommissionProduction,
  normalizeProductionRow,
  productionStatuses,
  productionTransitionMap,
  readCommissionProduction,
  transitionCommissionProduction
};
