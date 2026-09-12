# F10 — CI definitivo — status

F10 is now an active stabilization phase. This document is intentionally fail-closed: a correct CI contract is not the same thing as F10 completion.

## Canonical authority

- Contract: `config/f10-ci-contract.json`
- Contract validator: `scripts/checkF10CiContract.js`
- Syntax gate: `scripts/checkF10Syntax.js`
- Migration chain gate: `helpers/ci/f10MigrationGate.js`
- Canonical migration plan: `helpers/clover/schemaMigrationPlan.js`
- Reset journal migration: `helpers/clover/resetJournalSchemaMigration.js`
- CloverScript journal migration: `helpers/clover/cloverScriptSchemaMigration.js`
- Migration bootstrap behavior: `tests/f10MigrationBootstrap.test.js`
- Profile runner: `scripts/runF10CiProfile.js`
- Readiness report: `scripts/checkF10Readiness.js`
- GitHub workflow: `.github/workflows/f10-definitive-ci.yml`

## Current truthful state

`F10_CI_CONTRACT_GATE` can PASS when the source-controlled CI architecture is coherent.

`F10_READY` must remain **NO** until every master-plan category is covered and the remote CI signal is actually executable.

Current blockers:

- lint: GAP — syntax is not silently relabeled as lint;
- typecheck: GAP — no canonical JS typecheck strategy yet;
- migration fresh/legacy: PARTIAL — the explicit production-bootstrap gate is now source-controlled and mandatory in both Linux and Windows profiles, but behavioral execution evidence is still required before either category becomes COVERED;
- frontend build: EXTERNAL — frontend source is outside this backend repository;
- dependency/secret/static security scanning: DEFERRED_F11;
- remote GitHub Actions: `UNAVAILABLE_PRE_RUNNER` after repeated jobs ended before checkout/steps on both the temporary checkpoint workflow and the F10 Linux/Windows workflow.

## Canonical migration proof

The F10 migration gate freezes the current runtime sequence exactly as `0001..0031`, ending in `0031_clover_script_journal_foundation`.

Migration 0030 formalizes the individual/global reset journals that previously could be created by runtime `ensure*Schema` DDL after the migration ledger had already recorded the 0029 fingerprint. Migration 0031 formalizes `clover_script_runs`, its two indexes, and `clover_script_actions`, because `ensurePlayerResetSchema()` reaches `ensureCloverScriptSchema()` before operating. Together, the two migrations make the structural ensure path a no-op on a canonical production-bootstrap database.

0030 accepts journals fully absent, the exact historical player-journal prefix with global journals absent, or the complete exact reset-journal set. 0031 accepts the CloverScript journal fully absent or fully exact. Partial/divergent schema in either migration requires explicit reconciliation and fails closed.

The migration gate additionally requires the current schema fingerprint to equal the fingerprint stored by the latest migration. A post-head DDL mutation therefore fails the canonical migration P0 gate even if its table is outside the migration-specific inspectors.

The behavior suite must prove, using real disposable SQLite and the same `database.criarBanco({ filename })` entrypoint used by runtime:

1. fresh database reaches the exact canonical head and reruns without changing the migration ledger or schema fingerprint;
2. representative legacy database created by `database/legacy.js` preserves a sentinel player while migrating to the same head;
3. true historical legacy data is preserved while upgrading to 0031 and reopening as a no-op;
4. exact pre-0030 runtime reset journals are adopted without losing journal data;
5. the safe player-only reset-journal prefix is completed without losing journal data;
6. partial/divergent reset journals fail closed without advancing the ledger;
7. exact pre-0031 CloverScript journals are adopted without losing run/action data;
8. partial/divergent CloverScript journals fail closed without advancing the ledger;
9. calling CloverScript/player/global reset ensures at canonical head does not change the schema fingerprint;
10. missing latest migration, gaps, reorder, duplicate keys and key drift fail closed.

No result is promoted from PARTIAL to COVERED merely because the test exists in source control.

## Platform rule

Linux is the main CI profile. Windows-critical is independently mandatory because the operational runtime is Windows.

No F10 command may deploy, restart PM2, mutate the live database, enable pre-reset, touch Mudzap, or perform a real player/economy mutation.
