import { readCommissionProduction } from "./commission-production.mjs";
import { resolveAcceptedQuotation } from "./contract-eligibility.mjs";
import { COMMISSION_AGREEMENT_TERMS } from "./contract-terms.mjs";
import { isQuotationExpired } from "./quotation-state.mjs";

const nextActionStates = Object.freeze(["action", "waiting", "blocked", "none"]);
const activeQuotationStatuses = new Set(["draft", "issued", "sent"]);

function createNextAction({
  code,
  state,
  label,
  reason,
  domain,
  target = null,
  blockingReason = null
}) {
  if (!nextActionStates.includes(state)) {
    throw new Error(`Unsupported next action state: ${state}`);
  }

  return {
    code,
    state,
    label,
    reason,
    domain,
    target,
    blocking_reason: blockingReason
  };
}

function quotationTarget(quotation, label) {
  return {
    label,
    href: `/admin/quotation.html?id=${encodeURIComponent(quotation.id)}`
  };
}

function selectEffectiveQuotation(quotations, now = new Date()) {
  const families = new Map();

  for (const quotation of quotations) {
    const family = families.get(quotation.quotation_number) || [];
    family.push(quotation);
    families.set(quotation.quotation_number, family);
  }

  const activeFamilies = [];
  const expiredFamilies = [];

  for (const family of families.values()) {
    const ordered = [...family].sort((left, right) =>
      Number(right.version) - Number(left.version) || Number(right.id) - Number(left.id)
    );
    const active = ordered.filter((quotation) =>
      activeQuotationStatuses.has(quotation.quotation_status)
        && !isQuotationExpired(quotation, now)
    );
    const expired = ordered.filter((quotation) =>
      quotation.quotation_status === "expired"
        || (["issued", "sent"].includes(quotation.quotation_status)
          && isQuotationExpired(quotation, now))
    );

    if (active.length) activeFamilies.push({ ordered, active });
    else if (expired.length) expiredFamilies.push({ ordered, expired });
  }

  if (activeFamilies.length > 1) return { outcome: "ambiguous_active_families" };

  if (activeFamilies.length === 1) {
    const { active } = activeFamilies[0];
    const current = active[0];
    const coexistingStatuses = active.slice(1).map((quotation) => quotation.quotation_status);
    const allowedDraftOverlap = current.quotation_status === "draft"
      && coexistingStatuses.length <= 1
      && coexistingStatuses.every((status) => ["issued", "sent"].includes(status));

    if (active.length > 1 && !allowedDraftOverlap) {
      return { outcome: "ambiguous_active_versions" };
    }

    return { outcome: "selected", quotation: current };
  }

  if (expiredFamilies.length > 1) return { outcome: "ambiguous_expired_families" };
  if (expiredFamilies.length === 1) {
    return { outcome: "expired", quotation: expiredFamilies[0].expired[0] };
  }

  return { outcome: quotations.length ? "no_effective_quotation" : "no_quotation" };
}

function findQuotationIntegrityIssue(quotations, now) {
  const effective = quotations.filter((quotation) =>
    quotation.quotation_status === "accepted"
      || (activeQuotationStatuses.has(quotation.quotation_status)
        && !isQuotationExpired(quotation, now))
  );
  const families = new Set(effective.map((quotation) => quotation.quotation_number));
  const accepted = effective.filter((quotation) => quotation.quotation_status === "accepted");

  if (families.size > 1) return "ambiguous_active_families";
  if (accepted.length > 1 || (accepted.length === 1 && effective.length > 1)) {
    return "ambiguous_accepted_quotation";
  }
  return null;
}

function productionGuard(production) {
  if (!production?.initialized || production.production_status === "not_started") return null;

  if (["completed", "cancelled"].includes(production.production_status)) {
    return createNextAction({
      code: "production_state_observed",
      state: "none",
      label: "No available action",
      reason: `Canonical Production is ${production.production_status.replaceAll("_", " ")}. Phase 8 does not define a later operational action.`,
      domain: "production"
    });
  }

  return createNextAction({
    code: "production_workflow_unavailable",
    state: "blocked",
    label: "Production action unavailable",
    reason: `Canonical Production is ${production.production_status.replaceAll("_", " ")}, but Production mutations are not enabled in this phase.`,
    domain: "production",
    blockingReason: "production_mutations_unavailable"
  });
}

function resolveCommissionNextAction({
  commission,
  quotations = [],
  contractEligibility,
  production,
  termsApproved = false,
  now = new Date()
}) {
  const quotationIntegrityIssue = findQuotationIntegrityIssue(quotations, now);
  if (quotationIntegrityIssue) {
    return createNextAction({
      code: "data_integrity_review",
      state: "blocked",
      label: "Data integrity review required",
      reason: "Multiple effective Quotation records make the next action ambiguous.",
      domain: "system",
      blockingReason: quotationIntegrityIssue
    });
  }

  const guardedProduction = productionGuard(production);
  if (guardedProduction) return guardedProduction;

  if (contractEligibility.outcome !== "no_accepted_quotation") {
    if (contractEligibility.outcome === "eligible") {
      return createNextAction({
        code: "prepare_contract",
        state: "action",
        label: "Prepare Contract",
        reason: termsApproved
          ? "The accepted Quotation and Acceptance are valid for Contract preparation."
          : "The accepted Quotation and Acceptance are valid for Contract draft preparation. Contract issuance remains unavailable while terms are under review.",
        domain: "contract",
        target: {
          label: "Prepare Contract",
          href: `/admin/create-contract.html?commission_id=${encodeURIComponent(commission.id)}`
        },
        blockingReason: termsApproved ? null : "contract_terms_under_review"
      });
    }

    if (contractEligibility.outcome === "contract_conflict") {
      return createNextAction({
        code: termsApproved ? "contract_exists" : "contract_terms_under_review",
        state: termsApproved ? "none" : "blocked",
        label: termsApproved ? "Contract already exists" : "Contract terms under review",
        reason: termsApproved
          ? "A Contract already exists for the accepted Quotation."
          : "A Contract record exists, but Contract issuance remains unavailable while terms are under review.",
        domain: "contract",
        blockingReason: termsApproved ? null : "contract_terms_under_review"
      });
    }

    return createNextAction({
      code: "data_integrity_review",
      state: "blocked",
      label: "Data integrity review required",
      reason: "Accepted Quotation or Acceptance evidence is incomplete, inconsistent, ambiguous, or no longer eligible for Contract preparation.",
      domain: "system",
      blockingReason: contractEligibility.outcome
    });
  }

  const selection = selectEffectiveQuotation(quotations, now);

  if (selection.outcome.startsWith("ambiguous_")) {
    return createNextAction({
      code: "data_integrity_review",
      state: "blocked",
      label: "Data integrity review required",
      reason: "Multiple effective Quotation records make the next action ambiguous.",
      domain: "system",
      blockingReason: selection.outcome
    });
  }

  if (selection.outcome === "no_quotation") {
    return createNextAction({
      code: "legacy_commission_no_source_quotation",
      state: "none",
      label: "Legacy Commission",
      reason: "Legacy Commission — no canonical source quotation. New Quotations are created before a Commission exists.",
      domain: "quotation",
      blockingReason: "legacy_commission_no_source_quotation"
    });
  }

  if (selection.outcome === "expired") {
    return createNextAction({
      code: "prepare_new_quotation_version",
      state: "action",
      label: "Prepare New Quotation Version",
      reason: "The effective Quotation has expired without a valid Acceptance.",
      domain: "quotation",
      target: quotationTarget(selection.quotation, "Prepare New Quotation Version")
    });
  }

  if (selection.outcome === "no_effective_quotation") {
    return createNextAction({
      code: "no_available_action",
      state: "none",
      label: "No available action",
      reason: "The existing Quotations are no longer active, and Phase 8 does not infer a replacement workflow.",
      domain: "quotation"
    });
  }

  const quotation = selection.quotation;
  if (quotation.quotation_status === "draft") {
    return createNextAction({
      code: "continue_quotation",
      state: "action",
      label: "Continue Quotation",
      reason: `${quotation.quotation_number} v${quotation.version} is still a draft.`,
      domain: "quotation",
      target: quotationTarget(quotation, "Continue Quotation")
    });
  }

  if (quotation.quotation_status === "issued") {
    return createNextAction({
      code: "mark_quotation_sent",
      state: "action",
      label: "Mark Quotation Sent",
      reason: `${quotation.quotation_number} v${quotation.version} is issued but has not been marked sent.`,
      domain: "quotation",
      target: quotationTarget(quotation, "Mark Quotation Sent")
    });
  }

  return createNextAction({
    code: "await_quotation_acceptance",
    state: "waiting",
    label: "Await Quotation Acceptance",
    reason: `${quotation.quotation_number} v${quotation.version} was sent and remains valid.`,
    domain: "quotation"
  });
}

async function readCommissionNextAction(db, commissionId, {
  now = new Date(),
  termsDefinition = COMMISSION_AGREEMENT_TERMS
} = {}) {
  const production = await readCommissionProduction(db, commissionId);
  if (!production) return null;

  const quotations = (await db.pool.query(
    `SELECT id, quotation_number, version, quotation_status, expires_at
     FROM quotations
     WHERE commission_id = $1
     ORDER BY quotation_number, version DESC, id DESC`,
    [commissionId]
  )).rows;
  const contractEligibility = await resolveAcceptedQuotation(db, commissionId, now);

  return resolveCommissionNextAction({
    commission: { id: String(commissionId) },
    quotations,
    contractEligibility,
    production,
    termsApproved: termsDefinition.approved === true,
    now
  });
}

export {
  nextActionStates,
  readCommissionNextAction,
  resolveCommissionNextAction,
  selectEffectiveQuotation
};
