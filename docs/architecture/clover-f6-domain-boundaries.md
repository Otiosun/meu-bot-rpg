# F6 domain boundary inventory

The executable inventory is `helpers/clover/domainBoundaryRegistry.js`. Every
record contains data authority, service/data-access owner, public entrypoints,
writers/readers, cross-domain calls, ledger/audit, kernel, legacy adapters,
direct-SQL review, P0/P1 and deferred gaps. It has 20 granular domains:

Player/Identity/Profile; Squad; PH; Yulls; Return Points; Recruitment Points;
Inventory; Progression/Stats; Skills; Spells; Hexagon; Raid; Dream Worlds;
Recruitment; Stars; Onboarding; Future Character; Reset Conversion; Reset Shop;
and Admin-facing orchestration.

The audit requires every field and fails on an unclassified boundary or P0/P1
gap. Future Character, Reset Conversion and Reset Shop are intentionally
`PRODUCT_DECISION_REQUIRED`, policy-gated and disabled by default; this does
not make pre-reset launch-ready.
