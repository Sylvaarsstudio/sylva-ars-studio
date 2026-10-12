(function initializeAdminGlossary(globalObject) {
  function entry(key, term, domain, definition, whyItMatters, notTheSameAs, example) {
    return Object.freeze({
      key,
      term,
      domain,
      definition,
      why_it_matters: whyItMatters,
      not_the_same_as: notTheSameAs,
      ...(example ? { example } : {})
    });
  }

  const glossaryEntries = Object.freeze([
    entry("commission.draft", "Draft", "Commission", "The Commission record is being prepared and is not operationally active.", "It allows the Studio to organize scope and commercial information before work is activated.", "It is not an issued Quotation, an accepted Contract, or authorization to begin production."),
    entry("commission.active", "Active Commission", "Commission", "The required deposit has been received and verified, making the Commission operationally active.", "It allows production reservation and the active management of the Commission.", "It does not mean that a Quotation or Contract was merely accepted, or that physical production has already started.", "Contract accepted + required deposit received and verified → Commission active."),
    entry("commission_activation", "Commission Activation", "Commission", "The automatic creation and activation of a Commission after the complete Required Deposit has been received and verified against the accepted commercial context.", "It marks the controlled handoff from Pre-Commission records into an Active Commission.", "It is not a manual Create Commission action, Contract Acceptance alone, or a promise to pay."),
    entry("commission.on_hold", "On Hold", "Commission", "A global pause affecting the Commission as a whole.", "It records that the Studio should not advance the overall Commission until the hold is resolved.", "It is not the same as Production paused, which concerns only productive work."),
    entry("commission.cancelled", "Cancelled", "Commission", "The Commission has been stopped before normal administrative closure.", "It distinguishes stopped business from work that reached its intended conclusion.", "It is not the cancellation of only a delivery plan, quotation, or production step."),
    entry("commission.closed", "Closed", "Commission", "The Commission has reached its final administrative and commercial closure.", "It marks that the Studio considers the overall Commission lifecycle finished.", "It is not the same as Production completed, paid in full, or delivered on their own."),
    entry("commission.legacy_status", "Legacy Commission Status", "Commission", "The current Admin status is a temporary compatibility projection using draft, quoted, approved, in progress, completed, and cancelled.", "It keeps the existing system working while canonical lifecycle domains are introduced gradually.", "It is not the canonical multi-domain lifecycle and should not be interpreted as financial, contractual, production, and delivery state at once."),
    entry("commission_overview", "Commission Overview", "Commission", "The always-visible summary of a Commission's identity, Client, artwork scope, legacy lifecycle indicator, commercial totals, and current Next Action.", "It keeps the most useful orientation visible while detailed domains remain available in accessible collapsible sections.", "It is not a replacement for the canonical Commercial, Production, Financial, Delivery, Communications, Documents, Timeline, or Activity records."),

    entry("quotation", "Quotation", "Quotation", "A versioned pre-Commission commercial proposal owned by a Client that records artwork scope, price, tax, shipping, required deposit, validity, and specific terms.", "An accepted Quotation is the required canonical commercial source for every new Commission.", "It is not a Client, Inquiry, Contract, Payment, Invoice, or Commission."),
    entry("pre_commission", "Pre-Commission", "Quotation", "The commercial stage in which a Client, optional source Inquiry, Quotation, and Acceptance exist before a Commission is created.", "It prevents operational Commission records from being created before commercial terms are accepted.", "It is not an active or draft Commission."),
    entry("manual_client", "Manual Client", "Client", "A real Client record created by Admin from an offline or external contact without fabricating an Inquiry.", "It supports referrals, phone, social, in-person, and returning Client workflows.", "It is not an Inquiry or a Commission."),
    entry("source_quotation", "Source Quotation", "Commission", "The one valid accepted Quotation that canonically created a Commission.", "It provides an auditable commercial origin for the Commission and Contract preparation.", "It is not a mutable copy of current Commission fields."),
    entry("create_commission", "Create Commission", "Commission", "The atomic administrative action that creates one Commission from one valid accepted Quotation, initializes Production, and preserves real Inquiry provenance when present.", "It enforces that new Commissions begin only after commercial acceptance.", "It is not direct creation from a Client or Inquiry."),
    entry("quotation.draft", "Draft", "Quotation", "A Quotation version is being prepared and has not been issued.", "It can still be reviewed before it becomes an immutable commercial version.", "It is not an offer already issued to the Client."),
    entry("quotation.issued", "Issued", "Quotation", "A specific immutable Quotation version has been formally created by the Studio.", "It establishes exactly which commercial proposal can be sent and accepted.", "It does not prove that the Client received or accepted it."),
    entry("quotation.sent", "Sent", "Quotation", "An issued Quotation version has been sent to the Client.", "It records the communication stage separately from creation and acceptance.", "It does not mean accepted, contracted, deposited, or active."),
    entry("quotation.accepted", "Accepted", "Quotation", "The Client accepted a specific immutable Quotation version.", "It identifies the commercial version accepted by the Client.", "It does not mean Contract accepted, deposit received, or Commission active."),
    entry("quotation.declined", "Declined", "Quotation", "The Client declined a specific Quotation version.", "It preserves the outcome of that proposal without rewriting its history.", "It is not a cancellation of the entire Commission."),
    entry("quotation.expired", "Expired", "Quotation", "The validity period of a Quotation ended without acceptance.", "It prevents an outdated proposal from being treated as currently available.", "It is not the same as declined or withdrawn."),
    entry("quotation.superseded", "Superseded", "Quotation", "A newer Quotation version replaced this version.", "It preserves immutable version history while identifying the current proposal.", "It is not deletion and does not change what the earlier version contained."),
    entry("quotation.withdrawn", "Withdrawn", "Quotation", "The Studio withdrew a Quotation version from further consideration.", "It records a Studio action separately from Client decline or automatic expiry.", "It does not automatically cancel the Commission."),
    entry("acceptance", "Acceptance", "Acceptance", "A permanent record that a Client explicitly agreed to a specific immutable Quotation or Contract version.", "It preserves exactly what was accepted, when, by whom, and through which approved method.", "It is not a payment, a deposit, a Contract, or automatic Commission activation."),
    entry("electronic_acceptance", "Electronic Acceptance", "Acceptance", "Acceptance captured through an approved electronic workflow and linked to an immutable subject snapshot.", "It provides durable evidence without changing the accepted source document.", "It is not a typed signature image or an informal status change."),
    entry("admin_recorded_acceptance", "Admin Recorded Acceptance", "Acceptance", "An authorized Studio administrator records explicit Client acceptance that was received through a written channel.", "It allows current written confirmations to be preserved before a Client Portal exists.", "It is not an administrator accepting on the Client's behalf without confirmation."),
    entry("acceptance_method", "Acceptance Method", "Acceptance", "The controlled channel through which an Acceptance was captured, such as admin_recorded or portal.", "It distinguishes how the evidence entered the system without changing what was accepted.", "It is not the Quotation delivery method or payment method."),
    entry("accepted_at", "Accepted At", "Acceptance", "The server-recorded timestamp when the immutable Acceptance was created.", "It establishes the effective acceptance moment independently from later edits elsewhere.", "It is not the Quotation issued, sent, or expiry timestamp."),
    entry("snapshot_hash", "Snapshot Hash", "Acceptance", "A SHA-256 integrity value derived from the immutable accepted snapshot.", "It proves that the Acceptance still points to the exact content validated by the server.", "It is not a document number, request id, or secret."),
    entry("immutable_acceptance", "Immutable Acceptance", "Acceptance", "An append-only Acceptance record that cannot be edited or deleted after creation.", "It protects historical evidence and prevents silent changes to the acceptance event.", "It does not prevent later superseding documents or separate lifecycle actions."),

    entry("contract.draft", "Draft", "Contract", "A Contract preview is being prepared and has not been issued.", "It supports review without representing a final studio document.", "It is not issued, accepted, or legally finalized within the SAS workflow."),
    entry("contract.issued", "Issued", "Contract", "A specific immutable Contract version has been formally created by the Studio.", "It establishes the exact version available for acceptance.", "It does not mean that the Client has accepted it or paid the required deposit."),
    entry("contract.accepted", "Accepted", "Contract", "The Client accepted a specific immutable Contract version.", "It records which contractual version was accepted.", "It does not by itself mean deposit received or Commission active."),
    entry("contract.superseded", "Superseded", "Contract", "A newer Contract version replaced this version before the workflow continued.", "It keeps version history intact while identifying the applicable version.", "It is not deletion or silent editing of the earlier Contract."),
    entry("contract.withdrawn", "Withdrawn", "Contract", "The Studio withdrew an unaccepted Contract version.", "It distinguishes a Studio withdrawal from Client acceptance or later termination.", "It is not termination of an already accepted Contract."),
    entry("contract.terminated", "Terminated", "Contract", "An accepted Contract relationship was ended through the applicable studio process.", "It preserves the distinction between withdrawing an unaccepted document and ending an accepted arrangement.", "It is not deletion of the Contract record or automatic erasure of related obligations."),
    entry("accepted_quotation", "Accepted Quotation", "Quotation", "A specific immutable Quotation version with a valid append-only Acceptance record.", "It is the canonical commercial source for Contract preparation.", "It is not merely a Quotation whose status was changed without Acceptance evidence."),
    entry("contract_source_quotation", "Contract Source Quotation", "Contract", "The accepted Quotation version and snapshot from which a Contract draft derives its artwork and commercial terms.", "It makes the Contract's commercial origin explicit and auditable.", "It is not the current mutable Commission record."),
    entry("contract_eligibility", "Contract Eligibility", "Contract", "The verified condition that one valid accepted Quotation and matching Acceptance can support Contract preparation.", "It prevents Contracts from being prepared from incomplete or inconsistent evidence.", "It is not determined by the legacy Commission status."),
    entry("quotation_acceptance", "Quotation Acceptance", "Acceptance", "The append-only evidence linking a Client to the exact Quotation version and snapshot hash accepted.", "It proves which commercial proposal supports the Contract draft.", "It is not a Contract acceptance or payment."),
    entry("terms_version", "Terms Version", "Contract", "The identifier for the contractual terms module embedded in a Contract snapshot.", "It makes future terms changes traceable without rewriting earlier drafts or documents.", "It is not the Quotation version or Contract document version."),
    entry("contract_draft", "Contract Draft", "Contract", "A non-issued preview derived from an eligible accepted Quotation while contractual terms remain under review.", "It supports review without consuming a Contract number or creating a Document.", "It is not an issued or accepted Contract."),
    entry("contract_issuance", "Contract Issuance", "Contract", "The future controlled action that will create an immutable numbered Contract Document once terms are approved.", "It separates preview preparation from formal document creation.", "It is currently disabled and is not performed by Prepare Contract."),
    entry("pre_commission_contract", "Pre-Commission Contract", "Contract", "A Contract derived directly from an accepted Quotation before a Commission exists.", "It preserves the approved commercial sequence without inventing an early Commission.", "It is not a Commission and does not authorize production before the remaining activation conditions are satisfied."),
    entry("contract_preparation", "Contract Preparation", "Contract", "The read-only creation of a draft preview from the accepted Quotation, its Acceptance, and the current terms module.", "It allows review while terms remain under review.", "Prepare Contract does not issue a numbered Contract Document."),
    entry("prepare_contract", "Prepare Contract", "Contract", "The Admin action that opens a draft Contract preview from an eligible accepted Quotation.", "It allows the Studio to review the canonical Client, artwork, and commercial context before issuance is enabled.", "It does not issue, accept, or activate a Contract or Commission."),
    entry("contract_acceptance", "Contract Acceptance", "Acceptance", "Append-only evidence that the Client accepted one exact issued Contract version and snapshot hash.", "It preserves which contractual text was accepted before the deposit stage.", "Contract accepted does not mean that a Commission was created; deposit satisfaction is still required."),
    entry("terms_under_review", "Terms Under Review", "Contract", "The Contract terms module has not been approved for production issuance.", "It keeps draft preview work separate from legal approval.", "It does not prevent preparation, but it does prevent Contract issuance."),

    entry("production.status", "Production Status", "Production", "The current canonical stage of the artwork's productive workflow.", "It separates studio-making progress from commercial, financial, delivery, and legacy Commission states.", "It is not Legacy Commission Status, payment status, or delivery status."),
    entry("production.canonical", "Canonical Production", "Production", "The authoritative current production state stored independently for a Commission.", "It prevents Legacy Commission Status or isolated payments from being treated as proof that production started.", "It is not inferred from commissions.status, Commission Events, a Quotation, a Contract preview, or a Payment."),
    entry("production.not_started", "Not Started", "Production", "Productive work has not begun.", "It distinguishes preparation and commercial setup from actual artwork production.", "It does not mean the Commission is necessarily inactive."),
    entry("production.reserved", "Reserved", "Production", "Studio production capacity has been reserved for the Commission.", "It records scheduling commitment before active making begins.", "It is not the same as Production in progress."),
    entry("production.in_progress", "In Progress", "Production", "The artwork is actively being produced.", "It identifies the main working stage for studio planning.", "It is not a financial status or proof of final presentation."),
    entry("production.awaiting_client_review", "Awaiting Client Review", "Production", "The Studio is waiting for Client review of work presented during production.", "It makes the next responsible party clear.", "It is not final acceptance unless the final work was formally presented and accepted."),
    entry("production.revision_in_progress", "Revision In Progress", "Production", "The Studio is completing an agreed revision after review.", "It distinguishes revision work from initial production and waiting periods.", "It does not mean unlimited or unapproved changes."),
    entry("production.final_presented", "Final Presented", "Production", "The Studio officially presented the artwork as final for Client review.", "It establishes the final-review milestone.", "It does not mean the Client accepted the artwork, paid in full, or received delivery."),
    entry("production.final_accepted", "Final Accepted", "Production", "The Client accepted the artwork presented as final.", "It records Client acceptance of the final artwork state.", "It does not necessarily mean production administration, payment, delivery, or Commission closure is complete."),
    entry("production.paused", "Paused", "Production", "Productive work is temporarily paused while the broader Commission may remain active.", "It records a production-specific interruption.", "It is not Commission on hold, which pauses the overall Commission."),
    entry("production.completed", "Completed", "Production", "The productive work required for the artwork has finished.", "It marks completion of the production domain.", "It does not necessarily mean paid in full, delivered, or Commission closed."),
    entry("production.cancelled", "Cancelled", "Production", "The production workflow was stopped and will not continue in its current form.", "It records the outcome of productive work separately from other domains.", "It does not automatically define financial resolution or cancel unrelated records."),

    entry("next_action", "Next Action", "Workflow", "The current operational step derived from canonical Commission records.", "It gives Admin one concise direction without introducing another persisted status.", "It is not stored as a Commission status and is not derived from Commission Events or Legacy Commission Status."),
    entry("derived_state", "Derived State", "Workflow", "A read-only result calculated from current canonical source records whenever it is requested.", "It stays aligned with Quotation, Acceptance, Contract eligibility, and Production truth without synchronization jobs.", "It is not a database column, event, task, or manually assigned status."),
    entry("action_required", "Action Required", "Workflow", "A derived state indicating that an existing, currently permitted Admin action can advance the workflow.", "It distinguishes available work from waiting or blocked conditions.", "It does not authorize actions that their source workflow still prohibits."),
    entry("waiting", "Waiting", "Workflow", "A derived state indicating that no Admin action is currently required while an existing process awaits an external outcome.", "It prevents unnecessary workflow changes while preserving a clear reason.", "It is not a pause, error, or persisted lifecycle status."),
    entry("blocked", "Blocked", "Workflow", "A derived state indicating that the workflow cannot safely advance with the currently available canonical evidence or capabilities.", "It makes integrity issues and unavailable workflow stages explicit.", "It is not automatic cancellation and does not mutate any source record."),
    entry("data_integrity_review", "Data Integrity Review", "Workflow", "A manual review required when canonical records are missing, inconsistent, or ambiguous enough that the resolver cannot select one safe next action.", "It prevents the system from silently choosing among incompatible records.", "It is not an automatic repair and does not use the audit trail as current truth."),

    entry("financial.unpaid", "Unpaid", "Financial", "No qualifying payment has been received against the current financial obligation.", "It provides a derived view of the amount still due.", "It is not a Commission status."),
    entry("financial.partially_paid", "Partially Paid", "Financial", "Some payment has been received, but an outstanding balance remains.", "It communicates financial progress without changing operational status.", "It is not Production progress or Commission completion."),
    entry("financial.paid", "Paid", "Financial", "The financial state derived from recorded obligations and payments shows no outstanding amount due.", "It provides a reliable financial result without manually assigning a Commission status.", "It is not a Commission status and does not mean delivered or closed."),
    entry("financial.refund_due", "Refund Due", "Financial", "The financial records indicate that money is owed back to the Client.", "It identifies an unresolved refund obligation.", "It is not the same as a refund already completed."),
    entry("financial.partially_refunded", "Partially Refunded", "Financial", "Part, but not all, of the refund obligation has been returned.", "It distinguishes progress toward refund completion.", "It is not a fully refunded state."),
    entry("financial.refunded", "Refunded", "Financial", "The applicable refund obligation has been fully completed.", "It closes the derived refund state for that obligation.", "It does not automatically cancel or close the Commission."),

    entry("delivery", "Delivery", "Delivery", "The canonical record of how a finished artwork will be picked up or shipped for a Commission.", "It keeps fulfillment facts and historical destination data separate from commercial charges and other lifecycle domains.", "It is not a Shipping Charge, Payment, Production status, or Legacy Commission Status."),
    entry("fulfillment", "Fulfillment", "Delivery", "The operational process of transferring the artwork to its recipient through pickup or shipping.", "It groups the destination, carrier, tracking, actual costs, and operational timestamps for the artwork handoff.", "It is not the commercial sale, Quotation, or payment process."),
    entry("delivery_method", "Delivery Method", "Delivery", "The controlled fulfillment method selected for a Delivery: pickup or shipping.", "It determines which operational path will eventually apply.", "It is not Delivery Status or proof that fulfillment has occurred."),
    entry("delivery_status", "Delivery Status", "Delivery", "The canonical current state of a Delivery record.", "It tracks fulfillment independently from Commission, Production, and financial states.", "Delivery cancelled does not mean the Commission itself was cancelled."),
    entry("pickup", "Pickup", "Delivery", "A Delivery Method in which the recipient collects the artwork rather than receiving a shipment.", "It distinguishes collection from carrier fulfillment.", "It is not the picked up status until collection actually occurs."),
    entry("shipping", "Shipping", "Delivery", "A Delivery Method in which the artwork is transferred through a carrier or shipment process.", "It provides the operational context for destination, carrier, service, tracking, and actual costs.", "It is not Shipping Charge, which is the amount billed to the Client."),
    entry("actual_shipping_cost", "Actual Shipping Cost", "Delivery", "The actual fulfillment shipping cost incurred by SAS.", "It allows the Studio to track operational cost separately from the amount billed to the Client.", "It is not Shipping Charge and does not create a Client obligation by itself."),
    entry("protection_cost", "Protection Cost", "Delivery", "The actual carrier protection or insurance cost incurred for fulfillment.", "It preserves the real protection cost independently from commercial pricing.", "It is not automatically a protection charge or Financial Obligation to the Client."),
    entry("tracking_number", "Tracking Number", "Delivery", "The carrier reference used to track a shipment.", "It connects the Delivery record to its operational shipment progress.", "It is not a document number, Commission number, or proof of delivery by itself."),
    entry("delivery.pending", "Pending", "Delivery", "Delivery or pickup fulfillment has not yet been prepared or scheduled.", "It identifies that a fulfillment step remains outstanding.", "It is not the same as Production not started."),
    entry("delivery.ready", "Delivery Ready", "Delivery", "The artwork is ready for its delivery or pickup plan to proceed.", "It separates readiness from actual scheduling or shipment.", "It does not mean delivered or picked up."),
    entry("delivery.scheduled", "Scheduled Pickup", "Delivery", "A pickup has been scheduled for a future date and time.", "It records a concrete pickup arrangement.", "It does not mean the artwork has been picked up."),
    entry("delivery.shipped", "Shipped", "Delivery", "The artwork has been transferred to the shipping process.", "It marks the start of physical shipment tracking.", "It does not mean delivered."),
    entry("delivery.delivered", "Delivered", "Delivery", "The artwork was delivered through the selected fulfillment method.", "It records completion of a delivery shipment.", "It is not the same as Client pickup or Commission closure."),
    entry("delivery.picked_up", "Picked Up", "Delivery", "The artwork was collected through the pickup process.", "It records pickup fulfillment separately from shipment delivery.", "It does not automatically close the Commission."),
    entry("delivery.in_storage", "In Storage", "Delivery", "The artwork is being held in Studio-managed storage pending fulfillment or another approved arrangement.", "It makes continued custody visible.", "It is not delivered, picked up, or automatically cancelled."),
    entry("delivery.cancelled", "Delivery Cancelled", "Delivery", "The specific delivery or pickup plan was cancelled.", "It records that fulfillment plan outcome without changing unrelated domains.", "It does not automatically cancel the Commission."),
    entry("actual_fulfillment_cost", "Actual Fulfillment Cost", "Delivery", "The operational cost actually incurred by SAS to fulfill a Delivery.", "It distinguishes Studio cost from the commercial Shipping Charge billed to the Client.", "It does not change a Financial Obligation, Payment, or Commission balance."),
    entry("release_eligibility", "Release Eligibility", "Delivery", "The canonical check that Production is completed and every Financial Obligation is satisfied, waived, or voided before a Delivery is created.", "It prevents fulfillment from being released from legacy or inferred financial state.", "It is not a payment status, Delivery Status, or manual override."),
    entry("storage_period", "Storage Period", "Storage", "The period during which a completed artwork remains in Studio custody pending pickup or shipping.", "It makes continued custody and its timing visible without treating the artwork as fulfilled.", "It is not Delivery completion, automatic abandonment, or permission to dispose of the artwork."),
    entry("free_storage", "Free Storage", "Storage", "The first 30 calendar days after an artwork enters Storage, during which no Storage Fee accrues.", "It provides the approved grace period before storage becomes billable.", "Its expiration does not mean that the artwork is abandoned."),
    entry("storage_fee", "Storage Fee", "Storage", "The canonical Financial Obligation that accrues after Free Storage at $10 per week or fraction of a week per artwork.", "It records the amount owed before artwork release without creating a new obligation every week.", "It is not a Payment, automatic allocation, Shipping Charge, or Studio fulfillment cost."),
    entry("billable_week", "Billable Week", "Storage", "A seven-day storage interval, including any partial interval, after the Free Storage period ends.", "It determines the current Storage Fee using upward rounding for every fraction of a week.", "It is not a calendar week beginning on a particular weekday."),
    entry("storage_notice", "Storage Notice", "Storage", "An Admin record that a storage-related notice was communicated through an external authorized channel.", "It preserves when the Studio recorded the notice without pretending that this system sent it.", "It is not an automatic email, Final Written Notice, or proof of abandonment."),
    entry("final_written_notice", "Final Written Notice", "Storage", "An Admin record that the final written storage notice was communicated externally, starting the 180-calendar-day review threshold.", "It establishes the earliest future date for an abandonment review.", "It does not automatically abandon the artwork or authorize sale, disposal, or transfer."),
    entry("abandonment_eligibility", "Abandonment Eligibility", "Storage", "The derived condition reached 180 calendar days after the Final Written Notice.", "It signals that the matter may be reviewed under applicable law.", "Eligible does not mean automatically abandoned and does not change Delivery Status."),
    entry("abandonment_review", "Abandonment Review", "Storage", "A future legal and administrative review required before any abandonment or disposition action.", "It preserves human and legal judgment after the timing threshold is reached.", "It is not implemented disposition, automatic cancellation, sale, or authority to mark the artwork abandoned."),

    entry("calendar", "Calendar", "Calendar", "The read-only Admin view of operational and contractual dates derived from canonical Commission records.", "It brings future deadlines and historical milestones together without duplicating their source dates.", "It is not a scheduler, reminder system, automation engine, or source of truth."),
    entry("commission_timeline", "Commission Timeline", "Calendar", "The chronological sequence of derived milestones and dates for one Commission.", "It explains when commercial, production, financial, and delivery milestones occur in relation to each other.", "It is not Activity / History, which is the append-only audit trail of recorded actions."),
    entry("milestone", "Milestone", "Calendar", "A meaningful dated point derived from a canonical Commission record.", "It helps the Studio understand progress and upcoming commitments across workflow domains.", "It is not a persisted Calendar event or an automatic task."),
    entry("upcoming", "Upcoming", "Calendar", "A Calendar Entry whose date is after today in the Studio timezone.", "It identifies future operational or contractual dates without creating reminders.", "It is not overdue and does not trigger an automated action."),
    entry("overdue", "Overdue", "Calendar", "A passed deadline whose expected canonical condition remains incomplete.", "It distinguishes unresolved deadlines from ordinary historical milestones.", "It does not apply to every timestamp in the past and does not mutate source records."),
    entry("inspection_window", "Inspection Window", "Production", "The seven-calendar-day period following final presentation of the artwork.", "It makes the contractual review period visible from the canonical final presentation timestamp.", "It is not persisted separately and does not imply final acceptance."),
    entry("estimated_completion", "Estimated Completion", "Production", "The completion date committed in the accepted Quotation snapshot.", "It preserves the historical commercial expectation while no later canonical operational estimate exists.", "It is not a guarantee, Production completed, or Legacy Commission Status."),
    entry("calendar_entry", "Calendar Entry", "Calendar", "A normalized read-only representation of one dated milestone from a canonical source record.", "It allows Month, Agenda, and Commission Timeline views to share one safe format.", "It is not a database row or an editable manual event."),
    entry("derived_calendar_entry", "Derived Calendar Entry", "Calendar", "A Calendar Entry calculated at read time from Commission, Quotation, Acceptance, Production, Obligation, Delivery, or fallback audit evidence.", "It stays aligned with canonical records without synchronization or duplicated timestamps.", "It is not a new source of truth and cannot be used to reconstruct current state from the audit trail."),

    entry("communication", "Communication", "Communications", "A persistent record of an SAS message draft or a communication completed outside the system.", "It preserves message context and history independently from live Client or document data.", "A Communication record does not mean an email was sent automatically."),
    entry("communication_channel", "Communication Channel", "Communications", "The controlled medium recorded for a Communication: Email or Manual.", "It distinguishes message drafts from externally completed calls, meetings, or messages.", "It is not a provider integration or permission to send."),
    entry("communication_type", "Communication Type", "Communications", "A controlled business-purpose label such as Inquiry Reply, Quotation, Receipt, Delivery, or Manual Note.", "It makes Communication records consistently searchable without changing their exact content.", "It is not a template or delivery status."),
    entry("communication_status", "Communication Status", "Communications", "The canonical workflow state of a Communication record.", "It separates editable Drafts from historical or future provider states.", "It is not Commission Status, Delivery Status, or proof of provider activity by itself."),
    entry("draft_communication", "Draft Communication", "Communications", "An editable Communication record that has not been sent or queued.", "It allows exact message content to be prepared and retained before a later review-and-send phase exists.", "Draft does not mean Sent, Ready, or approved for sending."),
    entry("manual_communication", "Manual Communication", "Communications", "A record of a communication already completed through an external authorized channel.", "It preserves history without pretending this system delivered the message.", "It does not send an email, SMS, portal notification, or other message."),
    entry("body_snapshot", "Body Snapshot", "Communications", "The exact message content represented by a Communication at that moment.", "It keeps historical wording stable after a communication becomes a delivery record.", "It is not reconstructed from a future template and is not copied into Commission Event payloads."),
    entry("recipient_snapshot", "Recipient Snapshot", "Communications", "The recipient text recorded with the Communication at that moment.", "It preserves who the message was directed to even if live Client details later change.", "It is not a live lookup of the current Client email."),
    entry("communication.ready", "Ready", "Communications", "A reviewed and frozen Email Communication approved for an explicit Admin send action.", "It is the only state eligible to enter the sending engine.", "Ready does not mean Queued, Sent, Delivered, or provider-accepted."),
    entry("communication.queued", "Queued", "Communications", "An Email Communication atomically claimed by the sending engine and currently being processed.", "It prevents concurrent Admin requests from producing duplicate provider calls.", "Queued does not mean Sent or provider-accepted, and Phase 11C.1 has no background worker."),
    entry("communication.sent", "Sent", "Communications", "For Email, the provider accepted the exact reviewed snapshot; for Manual records, it records an externally completed communication.", "It separates a successful send result from Ready and Queued states.", "Sent does not mean Delivered, read, or replied."),
    entry("communication.delivered", "Delivered", "Communications", "A future provider-confirmed delivery state.", "It reserves a distinct state for delivery confirmation rather than assuming Sent means Delivered.", "Phase 11A does not set this state."),
    entry("communication.bounced", "Bounced", "Communications", "A future provider-reported state indicating that delivery was rejected or returned.", "It preserves provider outcome separately from the message content.", "Phase 11A has no provider and does not set this state."),
    entry("communication.failed", "Failed", "Communications", "A terminal Phase 11C.1 state indicating that the provider attempt did not complete successfully.", "It retains a normalized non-sensitive error code while preserving the reviewed snapshot.", "It is not automatically retried or returned to Ready."),
    entry("communication_template", "Communication Template", "Communications", "A versioned plain-text pattern in the central server-side registry used to generate a reviewable Communication Draft.", "It provides consistent starting language while keeping every generated message subject to human review.", "It is not a historical message, sending instruction, provider integration, or source of truth for business records."),
    entry("template_version", "Template Version", "Communications", "The numbered registry version used when a Communication Draft was generated.", "It identifies which approved pattern produced the initial snapshot even after the Draft is edited.", "It is not the Communication ID or a live link that rewrites existing Drafts."),
    entry("template_variable", "Template Variable", "Communications", "A controlled placeholder such as client_name or quotation_number resolved from canonical server-side records.", "It allows factual data to enter a template without arbitrary code evaluation.", "It is not JavaScript, a free-form expression, or Client-provided executable content."),
    entry("template_context", "Template Context", "Communications", "The required canonical Inquiry, Commission, Quotation, Document, Production, Delivery, or Obligation records used to resolve template variables.", "It prevents partial messages containing undefined or stale reconstructed values.", "It is not a manually entered substitute for missing source records."),
    entry("template_preview", "Template Preview", "Communications", "A non-persistent rendering of a template with its current canonical context.", "It allows the Admin to inspect recipient, subject, body, and missing context before creating a Draft.", "It does not create, send, queue, or mark a Communication ready."),
    entry("review_before_send", "Review Before Send", "Communications", "The required human review and optional Draft editing that occurs before Mark Ready for Sending.", "It keeps automated generation separate from approval to proceed toward delivery.", "It is not automatic approval, sending, or provider queuing."),
    entry("ready_for_sending", "Ready for Sending", "Communications", "A reviewed and frozen Communication whose recipient, subject, body, relationships, and template metadata passed validation.", "It records explicit human readiness for a future sending phase.", "Ready does not mean Sent, Queued, Delivered, or provider-accepted."),
    entry("generated_draft", "Generated Draft", "Communications", "An editable Communication Draft created from a specific template version and canonical context.", "It preserves the exact rendered result in Body Snapshot while allowing human revision before readiness.", "It does not update automatically when its source records change and is not a sent message."),
    entry("send_communication", "Send Communication", "Communications", "The explicit Admin action that submits one reviewed Email Communication to the sending engine.", "It requires confirmation of the recipient and subject before the reviewed snapshot is processed.", "It is not automatic sending, template rendering, or permission to edit the snapshot."),
    entry("sending_engine", "Sending Engine", "Communications", "The server-side workflow that atomically claims a Ready Communication and records a provider success or normalized failure.", "It centralizes eligibility, idempotency, concurrency, and audit rules independently from any provider.", "It is not a scheduler, background worker, automation trigger, or live provider."),
    entry("email_provider", "Email Provider", "Communications", "An injected adapter that accepts an exact reviewed email snapshot and returns a normalized external result.", "It keeps sending logic independent from Gmail, SMTP, or any future vendor.", "No live Email Provider is configured in Phase 11C.1."),
    entry("provider_message_id", "Provider Message ID", "Communications", "The immutable external identifier returned after a provider accepts an Email Communication.", "It supports audit and future delivery reconciliation without exposing message content.", "It is not editable input, a Communication ID, or proof of final delivery."),
    entry("send_failure", "Send Failure", "Communications", "A provider attempt that ended with a controlled non-sensitive error code and a Failed Communication.", "It makes the unsuccessful result auditable without storing raw provider responses or secrets.", "It does not trigger an automatic retry in Phase 11C.1."),
    entry("idempotent_send", "Idempotent Send", "Communications", "A send operation keyed by the Communication ID so repeated requests cannot intentionally create another provider delivery.", "It protects against duplicate clicks, HTTP retries, and concurrent Admin requests.", "It is not a retry workflow for a Failed Communication."),
    entry("reconciliation", "Reconciliation", "Communications", "A controlled check of a stale Queued Communication against available provider evidence.", "It protects Clients from duplicate messages when provider acceptance may have occurred before SAS persisted Sent.", "It does not send, retry, or prove a result when the authorized provider scope cannot supply evidence."),
    entry("queued_stale", "Queued Stale", "Communications", "A Queued Communication that has remained unresolved beyond the controlled processing window.", "It signals that reconciliation is required rather than permitting another send.", "It does not mean Sent, Failed, or safe to resend."),
    entry("confirmed_sent", "Confirmed Sent", "Communications", "A reconciliation result supported by provider evidence or explicit external Admin verification.", "It closes an uncertain Queued record as Sent without making a second provider call.", "It does not mean Delivered, read, or replied."),
    entry("confirmed_not_sent", "Confirmed Not Sent", "Communications", "A reconciliation result used only when sufficiently strong evidence proves the provider did not send the message.", "It closes the uncertain attempt as Failed without automatically retrying.", "A missing search result alone is not sufficient proof."),
    entry("inconclusive", "Inconclusive", "Communications", "A reconciliation result where available evidence cannot prove whether provider acceptance occurred.", "It keeps the record safe for explicit human review instead of risking a duplicate email.", "Inconclusive does not mean Not Sent."),
    entry("manual_reconciliation", "Manual Reconciliation", "Communications", "An explicit Admin resolution after externally verifying an inconclusive stale Queued Communication.", "It records Mark as Sent or closes the attempt as Failed without calling the provider.", "Mark as Sent does not send a message, and Mark as Failed does not retry one."),
    entry("duplicate_send_risk", "Duplicate Send Risk", "Communications", "The risk of contacting a Client twice when Gmail may have accepted a message but SAS did not persist the success.", "It explains why uncertain Queued records require reconciliation and never automatic resend.", "It is not resolved by assuming that Gmail deduplicates custom headers."),
    entry("safe_automation", "Safe Automation", "Communications", "A centrally approved low-risk rule that acknowledges receipt or confirms a canonical fact already persisted.", "It reduces routine work without allowing Communications to create or alter commercial, financial, Production, or Delivery decisions.", "It is not permission to auto-send sensitive messages or promises."),
    entry("automatic_communication", "Automatic Communication", "Communications", "A Ready Communication created transactionally from a canonical source and eligible for a post-commit send attempt.", "It preserves the exact template snapshot before any provider call and isolates business success from email failure.", "It is not an untracked provider call or a Calendar trigger."),
    entry("inquiry_confirmation", "Inquiry Confirmation", "Communications", "A neutral acknowledgment that Sylva Ars Studio successfully received an Inquiry.", "It reassures the sender that the request was recorded while preserving human review of the request.", "It does not mean the Inquiry was accepted, availability was confirmed, pricing was approved, or Production was scheduled."),
    entry("automation_trigger", "Automation Trigger", "Communications", "A demonstrated canonical event such as Inquiry creation, Quotation acceptance, Receipt issuance, or Final Invoice issuance.", "It limits automatic Communications to facts already committed by their source transaction.", "It is not a Calendar date, reminder, or inferred state."),
    entry("automation_policy", "Automation Policy", "Communications", "The single versioned code registry that determines which Communication templates are auto-send or review-required.", "It prevents Functions from defining inconsistent or hidden sending behavior.", "It is not editable browser configuration or a provider credential."),
    entry("auto_send", "Auto Send", "Communications", "A policy mode that attempts the existing Sending Engine only after the source record and Ready outbox Communication commit.", "It keeps provider failure from invalidating the canonical business operation.", "It is not direct Gmail access inside a database transaction, automatic retry, or guaranteed delivery."),
    entry("review_required", "Review Required", "Communications", "A policy mode requiring Draft generation, human review, Mark Ready, and explicit Send Email.", "It keeps sensitive or judgment-based messages under Admin control.", "It is not eligible for Safe Automation."),
    entry("automation_pending", "Automation Pending", "Communications", "A Ready automatic Communication waiting because the email provider is not configured or the post-commit send has not started.", "It preserves the message without failing the Inquiry, Acceptance, Payment, Receipt, or Final Invoice.", "It is not Failed and does not trigger retry automatically."),

    entry("provenance.origin", "Origin", "Provenance", "The linked Inquiry directly originated the Commission.", "It provides auditable context for why the Commission exists.", "It does not mean Quotation acceptance, Contract acceptance, Client ownership, or financial authorization."),
    entry("provenance.supporting", "Supporting", "Provenance", "The linked Inquiry provides relevant context for the Commission but was not necessarily its initial origin.", "It allows related historical context without rewriting the Commission.", "It is not the primary origin unless explicitly recorded as origin."),

    entry("commission_event", "Commission Event", "Audit", "A timestamped append-only record of a demonstrated business action associated with a Commission.", "It makes important actions traceable without changing their source records.", "It is not the primary source of truth or an instruction to trigger another action."),
    entry("audit_trail", "Audit Trail", "Audit", "The chronological collection of Commission Events retained for review.", "It helps the Studio understand what occurred and which object produced each event.", "It is not an editable activity log or a replacement for Quotations, Payments, Documents, or Acceptances."),
    entry("event_type", "Event Type", "Audit", "A controlled, specific name describing the demonstrated action, such as quotation_issued or payment_recorded.", "Specific names make history understandable and queryable.", "It is not a general status field or an unrestricted note."),
    entry("event_source", "Event Source", "Audit", "The master record that directly produced a Commission Event, identified by a controlled source type and textual ID.", "It allows the event to point back to authoritative evidence without copying the full record.", "It is not a polymorphic foreign key or a duplicate snapshot."),
    entry("append_only", "Append-only", "Audit", "Records may be added but existing history cannot be updated or deleted through ordinary operations.", "It prevents silent rewriting of audit evidence.", "It does not prevent a later compensating event from documenting a correction."),
    entry("activity_history", "Activity History", "Audit", "The Admin timeline that presents Commission Events in reverse chronological order.", "It gives the Studio a concise view of demonstrated actions across the Commission.", "It is not raw JSON, a Client communication feed, or an event-sourcing engine."),

    entry("financial_obligation", "Financial Obligation", "Financial", "A canonical amount the Client owes SAS for a Commission.", "It separates money owed from money actually received and provides the future basis for auditable charges.", "It is not a Payment, a legacy Commission balance, or proof that money was received."),
    entry("charge", "Charge", "Financial", "A commercial amount represented by a Financial Obligation, such as a deposit, final balance, modification, storage, shipping adjustment, or protection charge.", "It identifies why an amount is owed.", "It is not a Payment or a payment processor transaction."),
    entry("payment_allocation", "Payment Allocation", "Financial", "The link assigning part of a received Payment to a specific Financial Obligation.", "It demonstrates how received money satisfies an amount owed without changing the original Payment.", "It is not a second Payment or an additional charge."),
    entry("allocated_amount", "Allocated Amount", "Financial", "The sum of Payment Allocation amounts assigned to one Financial Obligation.", "It shows how much of the obligation has been satisfied by received money.", "It is not the total paid across the Commission unless every Payment was allocated to that obligation."),
    entry("outstanding_amount", "Outstanding Amount", "Financial", "The active portion of a Financial Obligation not yet covered by Payment Allocations.", "It provides the canonical per-obligation amount still owed.", "It is not the legacy Commission balance; waived and voided obligations have no operational outstanding amount."),
    entry("satisfied_obligation", "Satisfied Obligation", "Financial", "A Financial Obligation whose full amount has been covered by Payment Allocations.", "It records that the specific amount owed has been fully satisfied.", "It is not merely a partially allocated obligation or proof that the entire Commission is paid."),
    entry("waived_obligation", "Waived Obligation", "Financial", "A Financial Obligation the Studio intentionally chose not to collect.", "It preserves the original charge while removing it from operational outstanding amounts.", "It is not a Payment, refund, or deletion of financial history."),
    entry("voided_obligation", "Voided Obligation", "Financial", "A Financial Obligation invalidated because it should no longer remain collectible.", "It retains an auditable record while excluding the amount from operational outstanding totals.", "It is not a received Payment, waiver, or deletion."),
    entry("required_deposit", "Required Deposit", "Financial", "Fifty percent of the base artwork price required by SAS before a Commission becomes active.", "It communicates the amount that must be received and verified for activation.", "It is not Deposit Received and does not include sales tax or shipping."),
    entry("deposit_obligation", "Deposit Obligation", "Financial", "The canonical full amount owed after the Client accepts an issued Contract.", "It preserves the required deposit from the accepted Quotation before a Commission exists.", "It is not a Payment, Deposit Received, or permission to activate a Commission."),
    entry("awaiting_deposit", "Awaiting Deposit", "Financial", "The pre-Commission condition in which the Contract is accepted but the complete required deposit has not yet been received and verified.", "It distinguishes an accepted commercial agreement from a financially activated Commission.", "It is not a partial-payment state and does not mean production may begin."),
    entry("deposit_received", "Deposit Received", "Financial", "The amount of deposit money actually received and recorded.", "It distinguishes real money received from the commercial deposit requirement.", "It is not the calculated Required Deposit."),
    entry("outstanding_balance", "Outstanding Balance", "Financial", "The amount still due after recorded payments are applied to price, sales tax, and shipping.", "It shows the current monetary obligation remaining.", "It is not a Commission or Production status."),
    entry("payment", "Payment", "Financial", "A recorded transfer of money associated with a Commission.", "It provides the financial event used to update received amounts and derived balance.", "It is not a Receipt or Invoice, which document financial information."),
    entry("receipt", "Receipt", "Document", "A persistent document confirming a recorded payment.", "It preserves the payment facts as they existed when the receipt was created.", "It is not an Invoice or a Payment itself."),
    entry("deposit_payment", "Deposit Payment", "Financial", "The complete required upfront payment that satisfies the canonical pre-Commission Deposit Obligation.", "It records money actually received before Commission activation.", "It is not a partial deposit, a promise to pay, or a Commission balance."),
    entry("deposit_receipt", "Deposit Receipt", "Document", "Immutable evidence that the required deposit was received and applied in full before Commission activation.", "It references the accepted Quotation as the commercial source.", "It does not invent a Commission number or activate Production."),
    entry("final_invoice", "Final Invoice", "Document", "The persistent paid-in-full invoice created from the final balance payment workflow.", "It records the final commercial snapshot and completed payment history.", "It is not a Receipt and does not independently change the Commission lifecycle."),
    entry("document", "Document", "Document", "A persistent studio record linked to a Commission, such as a Contract, Receipt, Invoice, or Certificate of Authenticity.", "It preserves an auditable output and its version or snapshot where applicable.", "It is not the live Commission record that may continue to change."),
    entry("commission_number", "Commission Number", "Commission", "The stable SAS identifier assigned to a Commission.", "It allows the Commission and its documents to be referenced consistently.", "It is not the database ID or a document number."),
    entry("quotation_version", "Quotation Version", "Quotation", "The version number identifying one immutable form of a Quotation.", "It makes changes traceable without overwriting earlier proposals.", "It is not a new Commission or acceptance by itself."),
    entry("contract_version", "Contract Version", "Contract", "The version number identifying one immutable form of a Contract.", "It preserves exactly which Contract was issued or accepted.", "It is not the Contract number and does not itself indicate acceptance."),
    entry("snapshot", "Snapshot", "Document", "An immutable copy of the relevant business data stored when a persistent document is created.", "It keeps historical documents stable even if live Client or Commission data later changes.", "It is not a live reference that automatically updates."),
    entry("special_terms", "Special Terms", "Quotation", "Commercial terms that apply specifically to one Quotation version.", "They preserve negotiated details with the exact proposal that was issued.", "They do not replace the Commission Agreement."),
    entry("shipping_charge", "Shipping Charge", "Quotation", "The commercial shipping amount charged to the Client in a Quotation.", "It contributes to the quoted total while remaining distinct from artwork price and tax.", "It is not carrier cost, delivery status, or fulfillment cost."),
    entry("shipping_estimate", "Shipping Estimate", "Quotation", "A temporary pre-sale rate estimate returned by a configured shipping rate provider for one destination and parcel profile.", "It helps the Studio decide what commercial Shipping Charge to use in a Quotation.", "It is not the Shipping Charge, Actual Shipping Cost, Protection Cost, Payment, or Financial Obligation."),
    entry("shipping_rate", "Shipping Rate", "Quotation", "One normalized carrier and service price returned by a Rate Provider for a specific estimate request.", "It provides a comparable provider result without coupling the Quotation to a particular carrier API.", "It is not automatically charged to the Client or persisted unless explicitly selected for the draft."),
    entry("shipping_origin", "Shipping Origin", "Quotation", "The private server-side location from which a future shipment rate is requested.", "It provides the starting point needed by a Rate Provider while remaining outside public JavaScript.", "It is not the Client destination and is not returned to the Admin browser."),
    entry("shipping_destination", "Shipping Destination", "Quotation", "The destination address submitted only to calculate a pre-sale Shipping Estimate.", "It provides the endpoint needed by the Rate Provider.", "Requesting an estimate does not create a Delivery or persist the full address in the Quotation."),
    entry("parcel_profile", "Parcel Profile", "Quotation", "The single package dimensions, units, and weight used to request Shipping Rates.", "It makes the rate request reproducible and provider-agnostic.", "It is not artwork dimensions, a multi-package shipment, or an Actual Shipping Cost."),
    entry("carrier", "Carrier", "Quotation", "The shipping company identified by a normalized provider rate.", "It tells the Admin which fulfillment network would handle the estimated service.", "It does not mean a shipment has been booked or created."),
    entry("service_level", "Service Level", "Quotation", "The normalized shipping service associated with a carrier rate.", "It distinguishes delivery speeds or service products without carrier-specific UI logic.", "It is not a Delivery Status or guarantee of arrival."),
    entry("estimated_transit_time", "Estimated Transit Time", "Quotation", "The provider's estimated number of transit days for a Shipping Rate.", "It helps compare future fulfillment options.", "It is not a guaranteed delivery date or Production schedule."),
    entry("rate_provider", "Rate Provider", "Quotation", "A server-side adapter that obtains and normalizes live Shipping Rates.", "It keeps Quotations and the Admin UI independent from any specific carrier or shipping platform.", "It is not configured in Phase 10B.5A and never generates fake rates."),
    entry("sales_tax_rate", "Sales Tax Rate", "Quotation", "The explicit rate used by the Studio to calculate sales tax for a Quotation.", "It preserves how the issued tax amount was calculated.", "It is not an arbitrary tax amount entered by the browser."),
    entry("expires_at", "Expires At", "Quotation", "The date and time when an issued Quotation reaches the end of its 30-calendar-day validity period.", "It indicates whether a proposal remains commercially current.", "It does not automatically delete or rewrite the Quotation."),
    entry("request_id", "Request ID", "System", "A unique identifier used to make a creation request safely repeatable.", "It prevents retries from creating duplicate payments or documents.", "It is not a Commission number, document number, or Client-facing reference unless explicitly shown." )
  ]);

  function createRegistry(entries = glossaryEntries) {
    const registry = new Map();

    entries.forEach((item) => {
      if (!item?.key || registry.has(item.key)) {
        throw new Error(`Duplicate or invalid glossary key: ${item?.key || "missing"}`);
      }
      registry.set(item.key, item);
    });

    return registry;
  }

  const glossaryRegistry = createRegistry();

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function getEntry(key) {
    return glossaryRegistry.get(key) || null;
  }

  function renderHelpContent(item) {
    return `
      <button type="button" class="admin-help-close" data-admin-help-close aria-label="Close help">×</button>
      <p class="admin-help-domain">${escapeHtml(item.domain)}</p>
      <h2>${escapeHtml(item.term)}</h2>
      <dl>
        <div><dt>What it means in SAS</dt><dd>${escapeHtml(item.definition)}</dd></div>
        <div><dt>Why it matters</dt><dd>${escapeHtml(item.why_it_matters)}</dd></div>
        <div><dt>What it does not mean</dt><dd>${escapeHtml(item.not_the_same_as)}</dd></div>
        ${item.example ? `<div><dt>Example</dt><dd>${escapeHtml(item.example)}</dd></div>` : ""}
      </dl>
      <a class="admin-text-link" href="/admin/glossary.html#${encodeURIComponent(item.key)}">View in Glossary</a>`;
  }

  function createHelpController(documentObject, windowObject = globalObject) {
    let currentTrigger = null;
    let popover = null;

    function ensurePopover() {
      if (popover) return popover;
      popover = documentObject.createElement("section");
      popover.id = "admin-glossary-popover";
      popover.className = "admin-help-popover";
      popover.hidden = true;
      popover.tabIndex = -1;
      popover.setAttribute("role", "dialog");
      popover.setAttribute("aria-modal", "false");
      documentObject.body.append(popover);
      return popover;
    }

    function prepareTrigger(trigger) {
      const key = trigger.getAttribute("data-glossary-key");
      const item = getEntry(key);
      trigger.setAttribute("aria-expanded", "false");
      trigger.setAttribute("aria-controls", "admin-glossary-popover");
      if (!trigger.getAttribute("aria-label")) {
        trigger.setAttribute("aria-label", item ? `Learn about ${item.term}` : "Glossary help unavailable");
      }
    }

    function close(options = {}) {
      if (!currentTrigger) return false;
      const triggerToRestore = currentTrigger;
      currentTrigger.setAttribute("aria-expanded", "false");
      currentTrigger = null;
      if (popover) popover.hidden = true;
      if (options.restoreFocus) triggerToRestore.focus?.();
      return true;
    }

    function positionPopover(trigger) {
      const rect = trigger.getBoundingClientRect?.() || { left: 16, bottom: 16 };
      const viewportWidth = Number(windowObject.innerWidth) || 1024;
      const viewportHeight = Number(windowObject.innerHeight) || 768;
      const left = Math.max(12, Math.min(rect.left, viewportWidth - 392));
      popover.style.left = `${left}px`;
      popover.style.top = `${Math.max(12, Math.min(rect.bottom + 8, viewportHeight - 440))}px`;
    }

    function open(trigger) {
      const item = getEntry(trigger?.getAttribute?.("data-glossary-key"));
      if (!item) {
        trigger?.setAttribute?.("aria-expanded", "false");
        return false;
      }

      prepareTrigger(trigger);

      if (currentTrigger && currentTrigger !== trigger) {
        currentTrigger.setAttribute("aria-expanded", "false");
      }

      const panel = ensurePopover();
      currentTrigger = trigger;
      trigger.setAttribute("aria-expanded", "true");
      panel.setAttribute("aria-label", `${item.term} — ${item.domain}`);
      panel.innerHTML = renderHelpContent(item);
      panel.hidden = false;
      positionPopover(trigger);
      panel.focus?.();
      return true;
    }

    function onClick(event) {
      const closeButton = event.target.closest?.("[data-admin-help-close]");
      if (closeButton) {
        event.preventDefault?.();
        close({ restoreFocus: true });
        return;
      }

      const trigger = event.target.closest?.("[data-glossary-key]");
      if (trigger) {
        event.preventDefault?.();
        if (trigger === currentTrigger) close({ restoreFocus: true });
        else open(trigger);
        return;
      }

      if (currentTrigger && !popover?.contains?.(event.target)) close();
    }

    function onKeydown(event) {
      if (event.key === "Escape" && currentTrigger) {
        event.preventDefault?.();
        close({ restoreFocus: true });
      }
    }

    function bind() {
      documentObject.querySelectorAll("[data-glossary-key]").forEach(prepareTrigger);
      documentObject.addEventListener("click", onClick);
      documentObject.addEventListener("keydown", onKeydown);
      return glossaryRegistry.size;
    }

    return { bind, close, open, prepareTrigger };
  }

  function filterEntries(query, entries = glossaryEntries) {
    const normalized = String(query || "").trim().toLowerCase();
    if (!normalized) return [...entries];
    return entries.filter((item) => [
      item.key,
      item.term,
      item.domain,
      item.definition,
      item.why_it_matters,
      item.not_the_same_as,
      item.example
    ].some((value) => String(value || "").toLowerCase().includes(normalized)));
  }

  function renderGlossary(entries = glossaryEntries) {
    const domains = new Map();
    entries.forEach((item) => {
      if (!domains.has(item.domain)) domains.set(item.domain, []);
      domains.get(item.domain).push(item);
    });

    return [...domains.entries()].map(([domain, items]) => `
      <section class="admin-glossary-domain" data-glossary-domain="${escapeHtml(domain)}">
        <h2>${escapeHtml(domain)}</h2>
        <div class="admin-glossary-grid">
          ${items.map((item) => `
            <article class="admin-glossary-entry" id="${escapeHtml(item.key)}" data-glossary-entry="${escapeHtml(item.key)}" tabindex="-1">
              <h3>${escapeHtml(item.term)}</h3>
              <dl>
                <div><dt>What it means in SAS</dt><dd>${escapeHtml(item.definition)}</dd></div>
                <div><dt>Why it matters</dt><dd>${escapeHtml(item.why_it_matters)}</dd></div>
                <div><dt>What it does not mean</dt><dd>${escapeHtml(item.not_the_same_as)}</dd></div>
                ${item.example ? `<div><dt>Example</dt><dd>${escapeHtml(item.example)}</dd></div>` : ""}
              </dl>
              <a class="admin-glossary-anchor" href="#${encodeURIComponent(item.key)}" aria-label="Link to ${escapeHtml(item.term)}">#</a>
            </article>`).join("")}
        </div>
      </section>`).join("");
  }

  function createGlossaryPage(documentObject, locationObject = globalObject.location) {
    const search = documentObject.querySelector("#glossary-search");
    const list = documentObject.querySelector("#admin-glossary-list");
    const count = documentObject.querySelector("#glossary-count");

    function focusHash() {
      const key = decodeURIComponent(String(locationObject?.hash || "").replace(/^#/, ""));
      if (!key || !getEntry(key)) return false;
      const target = documentObject.querySelector(`[data-glossary-entry="${key}"]`);
      target?.scrollIntoView?.({ block: "start" });
      target?.focus?.({ preventScroll: true });
      return Boolean(target);
    }

    function render(query = "") {
      const filtered = filterEntries(query);
      list.innerHTML = renderGlossary(filtered);
      count.textContent = String(filtered.length);
      return filtered;
    }

    function bind() {
      search.addEventListener("input", () => render(search.value));
      globalObject.addEventListener?.("hashchange", focusHash);
      render(search.value);
      focusHash();
    }

    return { bind, focusHash, render };
  }

  const api = {
    createGlossaryPage,
    createHelpController,
    createRegistry,
    filterEntries,
    getEntry,
    glossaryEntries,
    glossaryRegistry,
    renderGlossary,
    renderHelpContent
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalObject.AdminGlossary = api;

  if (globalObject.document) {
    const help = createHelpController(globalObject.document, globalObject);
    help.bind();
    if (globalObject.document.querySelector("#admin-glossary-list")) {
      createGlossaryPage(globalObject.document, globalObject.location).bind();
    }
  }
})(typeof window !== "undefined" ? window : globalThis);
