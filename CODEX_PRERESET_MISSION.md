# CLOVER RPG — CODEX OVERNIGHT MISSION

## Mission

Finish as much of **CLOVER RPG — BACKEND STABILIZATION / PRE_RESET / RESET-READY** as can be completed safely and autonomously while the user is away.

This is an execution task, not a planning exercise. Inspect, modify, test, re-test, commit, and leave a precise final report. Do not stop after identifying issues if they can be fixed safely in this branch.

## Repository state at mission creation

- Repository: `Otiosun/meu-bot-rpg`
- Work only on branch: `codex/prereset-finalization-20260828`
- This branch was created from candidate HEAD: `97173324656ed48ff4e29efb09e851487a3ba4fc`
- Candidate source branch: `candidate/prereset-mythic-launch-v1`
- Canonical stabilization branch: `stabilize/f10-definitive-ci-v1`
- Canonical HEAD at handoff: `f08d9a475d6deff0160e1e29eed1ce9832d3bbb7`
- PR `#311`: OPEN + DRAFT + NOT MERGED. It points to the canonical stabilization branch, not this Codex branch.
- Formal pre-reset progress before this mission: **92%**. Do not increase that number without real new execution evidence.
- `PRE_RESET` must remain `OFF`.

FIRST ACTION: refetch/revalidate the actual refs. If the Codex work branch no longer descends from `97173324656ed48ff4e29efb09e851487a3ba4fc`, inspect exactly what changed before editing anything. Never overwrite unexpected work.

## Absolute safety rules

MUST NOT:

- merge PR #311;
- merge this branch into candidate/canonical/main;
- deploy;
- restart/stop PM2;
- touch Mudzap runtime;
- enable `PRE_RESET`;
- enable destructive launch gates;
- execute a live reset;
- mutate the production/live SQLite database;
- finalize/apply the real KEEP roster;
- invent the real PR→PV conversion rate;
- run `npm audit fix --force`;
- use `git reset --hard`, `git clean`, or destructive operations against the user's dirty Windows checkout;
- commit private phone numbers / private roster PII to GitHub;
- silently weaken fail-closed behavior to make tests pass.

If a task requires user-private Windows data, live auth data, or a product decision, do not wait for the user. Continue all independent tasks, then prepare one single safe read-only local command/script for the user to run later.

## Canonical product decisions already closed

1. The administrative KEEP whitelist is the sole authority for KEEP.
2. Every eligible player not in the finalized KEEP whitelist becomes RESET.
3. The bot never autonomously changes KEEP/RESET. It may validate, detect conflicts, fail closed, and block ambiguity.
4. Existing PV is preserved for everyone.
5. Owned boxes are preserved through launch reset.
6. Legacy PR is converted to PV using an explicit versioned policy and preserved.
7. Real PR→PV rate is still a product decision. `TEST_ONLY_1_TO_1` is test-only and MUST NOT become production policy by inference.
8. Normal character/progress and non-box inventory are disposable for RESET players.
9. `PRE_RESET=OFF` must prevent destructive launch apply.

## Known evidence before this mission

### F6–F10

- F6–F9: previous real local SQLite run was 5/5 PASS.
- F10: previous real local SQLite run was 3/3 PASS.
- Migrations `0034 → 0037` were reconciled and validated.

### F11/F12

Initial audit found 11 PASS, 1 PARTIAL, 4 real bugs:

- literal `#retorno` incompatible with `.#` prefix;
- anti-ghost could mutate/archive during PRE_RESET;
- ambiguous identity could choose a candidate unsafely;
- site/bot activation gates diverged;
- ADM 3/4 authority was only partially formalized.

Subsequent candidate commits addressed those issues. A real local run at commit `37f7560cfec6b9583e388a61166d3a6d17f8a852` reported **18/18 PASS**, including reset smoke. After that, `00c168e...` changed only the AUTH roster resolver + test to collapse multiple identity candidates only when exactly one candidate is eligible.

GitHub Actions has repeatedly failed before runner allocation (`runner_id=0`, `steps=[]`). Treat this as `UNAVAILABLE_PRE_RUNNER`, neither code failure nor PASS.

### Current candidate additions before Codex branch

Commit `97173324656ed48ff4e29efb09e851487a3ba4fc` added only:

- `scripts/previewPreResetLaunchReadOnly.js`
- `tests/preResetLaunchPreviewReadOnly.test.js`

Purpose: a read-only per-player launch preview containing character, KEEP/RESET, current PV, legacy PR, conversion state, resulting PV, owned boxes, deletion counts, and explicit preservation/discard plan. The script uses SQLite `OPEN_READONLY`, `PRAGMA query_only=ON`, and verifies SQLite SHA before/after.

This new test has NOT yet received integrated execution evidence. Validate it carefully.

## Existing workflow baseline

`.github/workflows/prereset-f6-f9.yml` is named `Pre-reset F6-F12 gates` and currently runs the following regression set:

```text
node --test tests/preResetTransitionService.test.js
node --test tests/preResetCharacterLaunchFoundation.test.js
node --test tests/preResetF6F9LaunchGates.test.js
node --test tests/preResetF10AdminRosterLaunch.test.js
node --test tests/preResetF11Hardening.test.js
node --test tests/preResetF11AdminAccess.test.js
node --test tests/preResetTransitionAdminHttp.test.js
node --test tests/preResetRosterReadOnlyResolver.test.js
node --test tests/preResetRosterAuthReadOnlyResolver.test.js
node --test tests/resetSnapshotIntegrityRoundTrip.test.js
node --test tests/resetGoNoGoSmoke.test.js
```

The workflow does **not yet include** the new launch preview script/test. If the new preview proves correct, add syntax + test coverage to the workflow.

# EXECUTION ORDER

## Phase 0 — Anti-race and workspace safety

1. Confirm current branch = `codex/prereset-finalization-20260828`.
2. Confirm its ancestry includes `97173324656ed48ff4e29efb09e851487a3ba4fc`.
3. Inspect `git status` before changing files.
4. Do not use the user's dirty runtime checkout if a clean workspace/worktree can be used.
5. Record starting SHA in the final report.

## Phase 1 — Establish a real local baseline

Run dependency install appropriate to the environment (`npm ci` preferred in a clean workspace), syntax checks, then the complete F6–F12 regression suite above PLUS:

```text
node --check scripts/previewPreResetLaunchReadOnly.js
node --check tests/preResetLaunchPreviewReadOnly.test.js
node --test tests/preResetLaunchPreviewReadOnly.test.js
```

Also run `git diff --check`.

If any test fails:

- diagnose the actual root cause;
- fix the smallest correct production/test contract;
- do not weaken safety semantics;
- rerun the failed test, its neighboring suite, and then the entire F6–F12 regression set.

Do not declare PASS based on static reading alone.

## Phase 2 — Audit the new economic preview deeply

Validate `scripts/previewPreResetLaunchReadOnly.js` against the real launch/reset semantics, not just its test fixture.

It must correctly and explicitly expose per player:

- canonical player ID;
- KEEP or RESET;
- character name/state;
- current PV;
- legacy PR;
- conversion policy status/version/rate/rounding;
- converted PV;
- resulting PV;
- owned boxes preserved;
- what disposable state will be removed;
- what state will be preserved.

Required semantics:

- no write to SQLite;
- SHA before/after identical when used against a file;
- pending PR→PV policy must block a final reviewable economic snapshot when PR > 0;
- zero legacy PR may be `not_required` without inventing a rate;
- KEEP players must not be described as losing character/progress;
- RESET players must not be described as losing boxes/PV/converted PR value;
- box identification must match the actual catalog/launch preservation mechanism;
- deletion preview must match `playerResetService` / actual launch reset behavior;
- draft roster projection must never masquerade as finalized launch truth;
- finalized roster state must be clearly distinguished from draft projection.

Look for false positives from absent tables, schema variants, old data, negative/invalid ledger balances, duplicate preservation rows, or legacy inventory rows. Add focused regression tests for any real gap you find.

If correct, update `.github/workflows/prereset-f6-f9.yml` to include the preview syntax/test.

## Phase 3 — F11/F12 contract re-audit on current branch

Re-audit the actual current code against the F11/F12 requirements, with tests where practical:

- real SQLite, not pure mocks for DB-critical behavior;
- `decision_pending` blocks normal flow and points to the public return command;
- literal `#retorno` works under the public command contract;
- KEEP/RESET decisions are irreversible where required;
- operation idempotency;
- competing confirmations/concurrency do not produce double state transitions;
- new player behavior is safe;
- deadline `AUTO_RESET` is one-shot/resumable/idempotent;
- current character remains intact before real launch reset;
- community-exit / anti-ghost / timeout / ambiguity cannot mutate reset state automatically;
- ambiguous identity fails closed;
- approved/locked future character cannot be edited;
- site and bot use the same activation gate semantics;
- canonical ADM authority represents level 4 owner and level 3 global admin without reintroducing a second authority model;
- PRE_RESET must not make unrelated PR shop/economy behavior part of the activation gate;
- RESET_GO_NO_GO smoke remains valid on migration 0037.

If a previously fixed bug has regressed, fix and add regression coverage.

## Phase 4 — KEEP identity resolver hardening

Private roster details must NOT be committed to GitHub.

Current known operational state from the private run:

- roster has 14 entries;
- one run against a wrong auth root saw 0 auth directories / 0 reverse mappings and produced 4 RESOLVED, 8 NOT_FOUND, 1 NAME_ONLY_REVIEW, 1 INELIGIBLE;
- previous correct AUTH/LID run read about 604 reverse mappings and resolved 10/14, leaving 4 JID/LID collisions;
- hardening at `00c168e...` changed the resolver to collapse multiple candidates only when exactly one candidate is eligible; true eligible collisions remain ambiguous.

Audit the resolver for:

- JID/LID canonicalization correctness;
- aliases and merged/canonical IDs;
- exactly-one-eligible rule;
- zero eligible candidates;
- multiple eligible candidates;
- shadow/purged/unapproved handling;
- duplicate reverse mappings;
- stale backups;
- deterministic output independent of directory order;
- no name-only fallback being promoted to resolved;
- PII-safe logs/reports;
- read-only DB behavior and SHA equality.

Add tests for missing edge cases.

### If private AUTH/SQLite data is unavailable in Codex environment

Do NOT stop the mission.

Prepare a single Windows PowerShell script, committed to this Codex branch, that the user can run once after waking. It should be named something like:

`scripts/runPreResetFinalReadOnlyEvidence.ps1`

Requirements:

- safe on the user's dirty main checkout;
- create/use an isolated temporary worktree at an exact SHA rather than modifying tracked runtime files;
- never `reset --hard`, `clean`, stash, checkout-overwrite, deploy, restart PM2, or mutate production DB;
- verify exact target SHA before tests;
- require/confirm `PRE_RESET` is not ON;
- run the complete F6–F12 suite + preview test;
- locate or accept the private roster input without embedding it in the script;
- locate AUTH roots safely or accept explicit `-AuthRoot`; if auto-discovery finds several credible roots, report them and fail closed rather than guessing;
- run the AUTH resolver read-only;
- run the economic preview read-only;
- record SQLite hash before/after;
- write all evidence to a timestamped private output directory outside Git tracking;
- emit one concise final summary with PASS/FAIL/BLOCKED and paths to reports.

Prefer auto-discovery with safe fail-closed behavior so the user does not need to execute many commands.

## Phase 5 — Roster/economy launch consistency audit

Without using private PII or applying anything live, verify structurally that once the roster is fully resolved:

1. exact KEEP IDs can be written/finalized idempotently;
2. every eligible player outside KEEP becomes RESET;
3. finalization freezes roster revision/hash;
4. apply cannot start while conversion policy is pending when needed;
5. existing PV survives;
6. boxes survive through the 0037 preservation trigger;
7. non-box inventory for RESET players is removed;
8. PR conversion cannot double-claim;
9. partial player failure cannot silently report whole campaign complete;
10. retry/recovery behavior is idempotent;
11. `PRE_RESET=OFF` blocks destructive apply before DB mutation.

Add regression tests only where coverage is genuinely missing.

## Phase 6 — Dependencies/security without scope creep

Known previous `npm audit`: 5 vulnerabilities, 4 high + 1 moderate, involving packages including sharp, protobufjs, brace-expansion, ip-address, tar.

Re-run audit if network/registry access is available. Classify:

- production runtime reachable or dev/tooling only;
- exploitable in this bot's use or not demonstrably reachable;
- safe non-breaking upgrade available or not;
- launch blocker vs tracked debt.

Do NOT run `npm audit fix --force`.

Only make dependency changes if they are clearly safe, compatible, and regression-tested. Do not turn this mission into a dependency-upgrade project.

## Phase 7 — CI/workflow closure

If tests are green locally:

- ensure workflow contains all current F6–F12 critical suites, including preview;
- ensure no critical migration/reset suite is accidentally skipped;
- inspect Actions if possible.

If GitHub Actions again shows `steps=[]` / `runner_id=0`, record `UNAVAILABLE_PRE_RUNNER`. Do not call it PASS and do not waste the mission repeatedly rerunning infrastructure failures.

## Phase 8 — Final hardening sweep

Before stopping, review the diff from mission start and ask:

- Did any change expand destructive authority?
- Did any test pass by weakening fail-closed behavior?
- Did any PII enter Git?
- Did any launch path gain an implicit default PR→PV rate?
- Can PRE_RESET=OFF still stop apply before mutation?
- Are KEEP/RESET authority and site/bot gates still single-source?
- Are boxes truly protected during reset, not merely reported as protected?
- Are resolver results deterministic and auditable?

Run the complete relevant suite again after the final code change.

# Commit discipline

Use small logical commits. Suggested prefixes:

- `fix(prereset): ...`
- `test(prereset): ...`
- `ci(prereset): ...`
- `chore(prereset): ...`

Do not squash/merge into candidate/canonical. Leave commits on `codex/prereset-finalization-20260828` for review.

# Definition of DONE for this overnight mission

The mission is complete when every item that can be completed without private/live authority has been completed and tested, and the branch contains:

1. corrected code for every real defect found;
2. regression tests for those defects;
3. workflow coverage for all relevant suites, including economic preview;
4. a green full local F6–F12 run if environment supports dependencies;
5. robust read-only roster/economic tooling;
6. a single safe local evidence script if private Windows data is the only remaining blocker;
7. `CODEX_FINAL_REPORT.md` containing:
   - starting SHA;
   - final SHA;
   - commits created;
   - files changed;
   - exact tests run and pass/fail counts;
   - F11/F12 gate matrix with evidence;
   - preview audit result;
   - identity resolver audit result;
   - npm audit classification;
   - CI status (including PRE_RUNNER if applicable);
   - remaining blockers categorized as `PRIVATE_DATA`, `PRODUCT_DECISION`, `INFRA`, or `NONE`;
   - explicit confirmation: no merge, no deploy, no reset live, no PRE_RESET activation, no production DB mutation.

Do not claim the real roster is finalized unless all 14 identities were actually resolved against authoritative private data and an authorized roster write/finalization occurred — which this mission is NOT authorized to perform.

Do not claim 100% RESET-READY merely because code looks correct. Distinguish code readiness, local test evidence, private operational evidence, and product decision status.

# If you finish early

Do one additional adversarial pass focused on failure injection and crash/idempotency boundaries around launch apply, roster finalization, PR→PV claims, box preservation, and resolver ambiguity. Add tests for any realistic bug you can reproduce. Do not invent speculative abstractions or refactor unrelated systems.
