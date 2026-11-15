const COMMISSION_COMPARISON_WARNING =
  "Substantive equivalence between the code-defined terms and the HTML Commission Agreement sources has not been established. The sources remain separate Draft inventory candidates.";

const SOURCE_HASHES = Object.freeze({
  commissionCode: "4935981132ddd227963890e4fdc7ae81c79d133777e8e8e5c4f9f58cdafa315d",
  commissionAdminHtml: "be201d51fd83bf04d9ad2b5546fb90a41b7835ca6b4104130054767ba47ede4e",
  commissionPublicHtml: "7a2fa0db8d990549742cbf586fd80e7ab6cd0d9a289b108c3c24c03e704cdfdf",
  artworkSalesAdminHtml: "79bf2e94806df3845c86ab1c6c4923c0784b0a3ab5a1b1ad175b530dbded380e",
  artworkSalesPublicHtml: "baac646f58914b9f15b285d57dbb5ecb224ef446e3ad500a655f45d3da7e840a",
  invoiceAdminHtml: "6bc63c4f5820cd850417dad012d387796fbe5102161b5154568f7c7ecc4cb6e0",
  coaAdminHtml: "60da92270967a1d5136288ece8e4327d430a0ccee3c790d22473bd9eb341c454",
  legacyGeneratorHtml: "907537c130df532ddc579f8da5ad6cc8f632a3fb7d71c860d5835365bf2fd655",
  legacyGeneratorScript: "f84bb1ba8da4582e242d588790c4c3ecaa35c805f1775b4147a95c8a1b092a13",
  publicViewGenerator: "189f03559108b2389b236c9e0eddb78df7a9a2c32890fecc88a938b8b7e0a8f5"
});

const LEGACY_TEMPLATE_FAMILIES = Object.freeze([
  Object.freeze({
    templateKey: "commission-agreement",
    name: "Commission Agreement",
    templateKind: "agreement",
    description: "Read-only inventory of pre-governance Commission Agreement sources.",
    comparison: Object.freeze({
      equivalence_status: "not_established",
      warning: COMMISSION_COMPARISON_WARNING
    }),
    sources: Object.freeze([
      Object.freeze({
        versionNumber: 1,
        versionLabel: "draft-1 · code-defined legacy candidate",
        sourceIdentity: "commission-agreement:code-defined:draft-1",
        sourceLabel: "COMMISSION_AGREEMENT_TERMS draft-1",
        sourceType: "code_definition",
        sourcePath: "netlify/shared/contract-terms.mjs",
        sourceHash: SOURCE_HASHES.commissionCode,
        sourceRole: "legacy_candidate",
        currentUsage: "contract_runtime_terms_definition",
        contentFormat: "structured_terms",
        reviewNotes: COMMISSION_COMPARISON_WARNING
      }),
      Object.freeze({
        versionNumber: 2,
        versionLabel: "legacy protected Admin HTML candidate",
        sourceIdentity: "commission-agreement:protected-admin-html",
        sourceLabel: "Protected Admin Commission Agreement HTML",
        sourceType: "html_template",
        sourcePath: "web/admin/document-templates/commission-agreement.html",
        sourceHash: SOURCE_HASHES.commissionAdminHtml,
        sourceRole: "legacy_candidate",
        currentUsage: "protected_admin_generator_template",
        contentFormat: "html",
        reviewNotes: COMMISSION_COMPARISON_WARNING
      }),
      Object.freeze({
        versionNumber: 3,
        versionLabel: "legacy public HTML reference",
        sourceIdentity: "commission-agreement:public-static-html",
        sourceLabel: "Public Commission Agreement HTML",
        sourceType: "public_html_reference",
        sourcePath: "web/documents/commission-agreement.html",
        sourceHash: SOURCE_HASHES.commissionPublicHtml,
        sourceRole: "legacy_reference",
        currentUsage: "current_static_public_display",
        contentFormat: "html",
        reviewNotes: COMMISSION_COMPARISON_WARNING
      })
    ])
  }),
  Object.freeze({
    templateKey: "artwork-sales-agreement",
    name: "Artwork Sales Agreement",
    templateKind: "agreement",
    description: "Read-only inventory of pre-governance Artwork Sales Agreement sources.",
    comparison: Object.freeze({
      equivalence_status: "not_assessed",
      warning: "The public reference is generated from the protected HTML source. Legal approval and effectivity are not established."
    }),
    sources: Object.freeze([
      Object.freeze({
        versionNumber: 1,
        versionLabel: "legacy protected Admin HTML candidate",
        sourceIdentity: "artwork-sales-agreement:protected-admin-html",
        sourceLabel: "Protected Admin Artwork Sales Agreement HTML",
        sourceType: "html_template",
        sourcePath: "web/admin/document-templates/artwork-sales-agreement.html",
        sourceHash: SOURCE_HASHES.artworkSalesAdminHtml,
        sourceRole: "legacy_candidate",
        currentUsage: "protected_admin_generator_template",
        contentFormat: "html",
        reviewNotes: "Legacy candidate imported for inventory only. Public availability does not establish legal approval or effectivity."
      }),
      Object.freeze({
        versionNumber: 2,
        versionLabel: "legacy public HTML reference",
        sourceIdentity: "artwork-sales-agreement:public-static-html",
        sourceLabel: "Public Artwork Sales Agreement HTML",
        sourceType: "public_html_reference",
        sourcePath: "web/documents/artwork-sales-agreement.html",
        sourceHash: SOURCE_HASHES.artworkSalesPublicHtml,
        sourceRole: "legacy_reference",
        currentUsage: "current_static_public_display",
        contentFormat: "html",
        reviewNotes: "Legacy reference imported for inventory only. Public availability does not establish legal approval or effectivity."
      })
    ])
  })
]);

const OPERATIONAL_LEGACY_SOURCES = Object.freeze([
  Object.freeze({
    source_key: "admin-invoice-template",
    name: "Admin Invoice template",
    source_type: "operational_html_template",
    source_path: "web/admin/document-templates/invoice-template.html",
    source_hash: SOURCE_HASHES.invoiceAdminHtml,
    governance_status: "not_governed",
    treatment: "Operational/private source; not imported as a Legal Template family in LT-2."
  }),
  Object.freeze({
    source_key: "admin-coa-template",
    name: "Admin COA template",
    source_type: "operational_html_template",
    source_path: "web/admin/document-templates/coa-template.html",
    source_hash: SOURCE_HASHES.coaAdminHtml,
    governance_status: "not_governed",
    treatment: "Operational/private source; not imported as a Legal Template family in LT-2."
  }),
  Object.freeze({
    source_key: "legacy-browser-document-generator",
    name: "Legacy browser document generator",
    source_type: "browser_generator",
    source_path: "web/admin/generate-documents.html + web/js/admin.js",
    source_hash: `${SOURCE_HASHES.legacyGeneratorHtml}:${SOURCE_HASHES.legacyGeneratorScript}`,
    governance_status: "not_governed",
    treatment: "Existing operational generator inventoried only; no Legal Template family created."
  }),
  Object.freeze({
    source_key: "public-document-view-generator",
    name: "Public agreement view generator",
    source_type: "build_generator",
    source_path: "scripts/generate-public-document-views.js",
    source_hash: SOURCE_HASHES.publicViewGenerator,
    governance_status: "not_governed",
    treatment: "Build relationship recorded for inventory; current public routes remain unchanged."
  })
]);

export {
  COMMISSION_COMPARISON_WARNING,
  LEGACY_TEMPLATE_FAMILIES,
  OPERATIONAL_LEGACY_SOURCES,
  SOURCE_HASHES
};
