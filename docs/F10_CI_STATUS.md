# F10 — CI definitivo — status

F10 is now an active stabilization phase. This document is intentionally fail-closed: a correct CI contract is not the same thing as F10 completion.

## Canonical authority

- Contract: `config/f10-ci-contract.json`
- Contract validator: `scripts/checkF10CiContract.js`
- Syntax gate: `scripts/checkF10Syntax.js`
- Migration chain gate: `helpers/ci/f10MigrationGate.js`
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

The F10 migration gate freezes the current sequence exactly as `0001..0029`, ending in `0029_prereset_character_launch_foundation`.

The behavior suite must prove, using real disposable SQLite and the same `database.criarBanco({ filename })` entrypoint used by runtime:

1. fresh database reaches the exact canonical head and reruns without changing the migration ledger or schema fingerprint;
2. representative legacy database created by `database/legacy.js` preserves a sentinel player while migrating to the same head;
3. the legacy database also reruns idempotently;
4. missing latest migration, gaps, reorder, duplicate keys and key drift fail closed.

No result is promoted from PARTIAL to COVERED merely because the test exists in source control.

## Platform rule

Linux is the main CI profile. Windows-critical is independently mandatory because the operational runtime is Windows.

No F10 command may deploy, restart PM2, mutate the live database, enable pre-reset, touch Mudzap, or perform a real player/economy mutation.
