# F10 — CI definitivo — status

F10 is now an active stabilization phase. This document is intentionally fail-closed: a correct CI contract is not the same thing as F10 completion.

## Canonical authority

- Contract: `config/f10-ci-contract.json`
- Contract validator: `scripts/checkF10CiContract.js`
- Syntax gate: `scripts/checkF10Syntax.js`
- Profile runner: `scripts/runF10CiProfile.js`
- Readiness report: `scripts/checkF10Readiness.js`
- GitHub workflow: `.github/workflows/f10-definitive-ci.yml`

## Current truthful state

`F10_CI_CONTRACT_GATE` can PASS when the source-controlled CI architecture is coherent.

`F10_READY` must remain **NO** until every master-plan category is covered and the remote CI signal is actually executable.

Known blockers at foundation creation:

- lint: GAP — syntax is not silently relabeled as lint;
- typecheck: GAP — no canonical JS typecheck strategy yet;
- migration fresh/legacy: PARTIAL — explicit current-chain gates still need closure;
- frontend build: EXTERNAL — frontend source is outside this backend repository;
- dependency/secret/static security scanning: DEFERRED_F11;
- remote GitHub Actions: `UNAVAILABLE_PRE_RUNNER` based on repeated `steps=[]`, `runner_id=0` evidence.

## Platform rule

Linux is the main CI profile. Windows-critical is independently mandatory because the operational runtime is Windows.

No F10 command may deploy, restart PM2, mutate the live database, enable pre-reset, touch Mudzap, or perform a real player/economy mutation.
