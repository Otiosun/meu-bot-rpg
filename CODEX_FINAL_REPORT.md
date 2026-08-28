# CLOVER PRE_RESET finalization report

## Scope and revisions

- Starting branch SHA: `19c687f0d1b01ec326af55a1de34bab8c618ae3e`.
- Candidate base verified: `97173324656ed48ff4e29efb09e851487a3ba4fc`.
- Canonical ref observed: `f08d9a475d6deff0160e1e29eed1ce9832d3bbb7`.
- Final code checkpoint: `1ac7b5e3c369c1686048f2f81b57303d120992aa` (`fix(prereset): harden read-only launch preview`).
- This report and the private-evidence runner are committed separately after that checkpoint; use the branch HEAD in the handoff for the final documentation commit SHA.

## Changes delivered

- `scripts/previewPreResetLaunchReadOnly.js`
  - Uses the reset service's exported deletion-table contract rather than a copied list.
  - Reports each preserved box row's quantity and status, plus both preserved-row and preserved-unit totals.
  - Treats absent/invalid PV or PR ledger state as review-blocking rather than silently showing zero.
  - Validates an approved PR-to-PV policy before projecting a conversion; no implicit rate exists.
  - Reads an existing idempotency claim and distinguishes a completed conversion from zero legacy PR. Inconsistent claims are blocked for review.
- `tests/preResetLaunchPreviewReadOnly.test.js`
  - Adds real-SQLite coverage for multi-unit box preservation, repeated read-only preview SHA equality, post-conversion recovery, invalid policy, inconsistent claim, and absent ledger behavior.
- `.github/workflows/prereset-f6-f9.yml`
  - Adds preview syntax and regression coverage to the F6-F12 workflow.
- `scripts/runPreResetFinalReadOnlyEvidence.ps1`
  - Provides one private, read-only Windows evidence runner. It requires a disposable SQLite copy, verifies an exact SHA in an isolated temporary worktree, forces `PRE_RESET=OFF`, fails closed for ambiguous AUTH/roster discovery, records SQLite hashes, and writes private reports outside Git.

## Local evidence

All commands below ran from an isolated clean worktree. No command used the runtime database.

| Command | Result |
| --- | --- |
| `node --test tests/preResetTransitionService.test.js tests/preResetCharacterLaunchFoundation.test.js tests/preResetF6F9LaunchGates.test.js tests/preResetF10AdminRosterLaunch.test.js` | PASS, 19/19 |
| `node --test tests/preResetF11Hardening.test.js tests/preResetF11AdminAccess.test.js tests/preResetTransitionAdminHttp.test.js tests/preResetRosterReadOnlyResolver.test.js tests/preResetRosterAuthReadOnlyResolver.test.js tests/preResetLaunchPreviewReadOnly.test.js` | PASS, 19/19 |
| `node --test tests/resetSnapshotIntegrityRoundTrip.test.js tests/resetGoNoGoSmoke.test.js` | PASS, 2/2 |
| Complete F6-F12 selection above | PASS, 40/40 |
| `node --check scripts/previewPreResetLaunchReadOnly.js` | PASS |
| PowerShell parse of `scripts/runPreResetFinalReadOnlyEvidence.ps1` | PASS |
| `git diff --check` | PASS |

The evidence runner was syntax-checked and exercised through its fail-closed AUTH-root branch using a disposable SQLite fixture. It correctly kept the fixture SHA unchanged and rejected two credible AUTH roots instead of choosing one. The local tool host interrupted a longer runner invocation at its wall-clock limit before the runner could write its final summary; this is not treated as a successful operational run.

## F11/F12 gate matrix

| Gate | Code/test evidence | Result |
| --- | --- | --- |
| `decision_pending` and literal `#retorno` | `tests/preResetF11Hardening.test.js` | PASS |
| Site/bot use the same fail-closed gate | `tests/preResetF11Hardening.test.js` | PASS |
| ADM 3/4 authority follows canonical mapping | `tests/preResetF11AdminAccess.test.js` | PASS |
| Anti-ghost does not mutate during PRE_RESET | `tests/preResetF11Hardening.test.js` | PASS |
| Current/future character and deadline safety | `tests/preResetF6F9LaunchGates.test.js` | PASS |
| Real SQLite KEEP/RESET, one-time PR claim, box trigger, and PRE_RESET-off apply block | `tests/preResetF10AdminRosterLaunch.test.js` | PASS |
| Resolver fails closed for collisions and reverse-LID ambiguity | `tests/preResetRosterReadOnlyResolver.test.js`, `tests/preResetRosterAuthReadOnlyResolver.test.js` | PASS (code/local fixture) |
| Private 14-entry roster against authoritative SQLite/AUTH | Private runner prepared; not authorized/executed here | BLOCKED: `PRIVATE_DATA` |

## Preview audit result

The launch preview remains read-only (`OPEN_READONLY`, `PRAGMA query_only=ON`, before/after SHA assertion). It now reports the same reset deletion domain as `playerResetService`, exact owned-box row and unit evidence, policy validation, conversion claim/recovery data, ledger availability, and review issues. The preview exits blocked when the roster is not finalized, a conversion policy is needed but pending/invalid, a claim is inconsistent, or a critical ledger cannot be read.

No real PR-to-PV rate was added. `TEST_ONLY_1_TO_1` appears only in temporary tests.

## Identity resolver audit

The AUTH resolver is deterministic: it merges exact DB and reverse-LID candidates, canonicalizes aliases, only collapses multiple candidates when exactly one is eligible, and otherwise preserves an `AMBIGUOUS` result with auditable candidate detail. The runner keeps its private resolver output outside Git and refuses auto-discovery when more than one credible AUTH root exists.

## npm audit

`npm audit --json` reports 5 vulnerabilities: 4 high and 1 moderate. No dependency change or audit fix was applied.

| Package | Advisory / chain | Classification |
| --- | --- | --- |
| `sharp@0.34.5` | `GHSA-f88m-g3jw-g9cj`; direct root runtime dependency | Runtime reachable; fix requires semver-major `0.35.4`; tracked debt, not changed in PRE_RESET work |
| `protobufjs@7.6.4` | `GHSA-j3f2-48v5-ccww`; `@whiskeysockets/baileys` and `libsignal` | Runtime reachable through WhatsApp stack; safe compatibility upgrade needs separate validation |
| `brace-expansion@5.0.7` | `GHSA-mh99-v99m-4gvg`, `GHSA-rgw5-rvv9-x895`; optional `sqlite3 -> node-gyp -> cacache -> glob -> minimatch` | Install/tooling-only optional chain, not a demonstrated bot runtime path |
| `ip-address@10.2.0` | `GHSA-mwp4-54f8-5fhr` plus two moderate SSRF advisories; optional `sqlite3 -> node-gyp -> make-fetch-happen -> socks` | Install/tooling-only optional chain, not a demonstrated bot runtime path |
| `tar@7.5.20` | `GHSA-r292-9mhp-454m`; `sqlite3` and optional `node-gyp` | Package/install dependency; not demonstrated in ordinary bot message handling |

## CI and remaining blockers

- CI status: `INFRA`. GitHub Actions could not be inspected because `gh` is unavailable in this environment. No remote run was claimed as green, and no workflow was dispatched.
- `PRIVATE_DATA`: run the committed evidence script with an authorized disposable SQLite copy, the private roster input, and one explicit authoritative AUTH root. Do not commit its output.
- `PRODUCT_DECISION`: approve the real PR-to-PV policy before any launch apply. The preview intentionally blocks positive legacy PR without it.
- `INFRA`: inspect the workflow after this branch is pushed; do not call it PASS until a real runner has executed it.

## Safety confirmation

No merge was performed (including PR #311). No deploy, PM2 action, live reset, roster write/finalization, `PRE_RESET` activation, production database mutation, or PII commit was performed. The branch only contains code, tests, CI coverage, a private read-only runner, and this report.
