# Phase 3 Squad policy and repair dry-run

Base: `1823ad80f079ffb9996fee5b97104d23c4843eed`
Branch: `stabilize/phase3-squad-policy-repair-dryrun-f3f1`

## Canonical policy

`clover_squad_memberships.active` is the sole Squad authority. The
`jogadores.esquadrao` column remains a temporary compatibility projection and
reader fallback until a separately approved live repair and later cutover.
Neither fallback nor dual-write behavior is removed by this campaign.

### Policy A: archive ends active membership

Archiving a player now ends exactly one active canonical membership in the same
SQLite transaction as the lifecycle archive. The membership receives status
`archived`, `ended_at`, an actor/reason and provenance; a corresponding
membership event is written with the existing `removed` action and explicit
`archive_ends_active_membership` policy metadata. The player projection remains
neutral.

An archive without a membership still succeeds. Repeating an archive remains
idempotent. A failure while writing the membership event rolls back both the
lifecycle change and the membership change. Reactivation deliberately restores
neither a membership nor `jogadores.esquadrao`; a future Squad entry requires
the explicit membership flow.

### Policy B: one-time legacy grandfather

The versioned `planSquadPolicyRepair.js` tool treats an active, approved and
released player with a valid legacy projection and no canonical history/event
as an eligible one-time grandfather candidate. It rejects unknown Squad keys
and leaves any failed lifecycle, eligibility, departure-history, duplicate or
transition precondition in `MANUAL_REVIEW` or `BLOCKED_INVALID_STATE`.

The repair creates an active canonical membership at migration time. It does
not invent a historical join timestamp. Its membership and `added` event record
`source: phase3_legacy_grandfather`, `campaign: F3F1`, and explicit migration
provenance, while preserving the observed legacy projection.

## Protected planner and disposable proof

The planner requires an explicit `--db` path and defaults to `DRY_RUN`.
Mutation requires both `--apply` and `--non-live-copy-confirmed`, an existing
regular file with the campaign disposable filename marker, and no pre-existing
WAL/SHM sidecars. It refuses the known runtime path and any `banco.sqlite`
target. Planner output is aggregate-only; raw player identifiers remain local
to the disposable execution.

The existing F3D1 reference snapshot was SHA-256 verified as
`f0970a54f5c6a83b9401d7f1d82b2275fc063e4273dd8a13be0df620534b62e2` and
opened read-only. One disposable copy received the protected apply. No live
database, runtime, PM2, Mudzap or deployment was touched.

| Metric | Before | After disposable apply |
| --- | ---: | ---: |
| Players checked | 627 | 627 |
| Match | 614 | 627 |
| Canonical-only | 4 | 0 |
| Legacy-only | 9 | 0 |
| Mismatch | 0 | 0 |
| Duplicate active membership | 0 | 0 |
| Unknown Squad key | 0 | 0 |
| Safe to cut over | false | true |

The plan contained four `ARCHIVE_END_MEMBERSHIP` actions and nine
`LEGACY_GRANDFATHER` actions, with zero manual or blocked items. The apply made
13 repairs. Aggregate postconditions confirmed zero archived players with an
active membership, nine grandfathered canonical resolver matches, unchanged
player rows, exactly four expected existing-membership updates, nine new active
grandfather memberships, and zero unintended membership changes.

## Idempotence and next gate

The second plan on the repaired disposable copy contained zero safe actions.
The second protected apply performed zero writes and left no WAL/SHM sidecars.
Focused lifecycle, membership-reader, eligibility and policy-repair planner
tests cover rollback, reactivation-without-rejoin, invalid candidates,
dry-run, target refusal and second-apply no-op behavior.

This proves the repair policy only on a disposable snapshot. It does not
authorize or execute a live repair. `SQUAD_P1=READY_FOR_APPROVED_LIVE_REPAIR`.
