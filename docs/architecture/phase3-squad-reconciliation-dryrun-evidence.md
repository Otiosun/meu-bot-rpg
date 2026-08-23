# Phase 3 Squad reconciliation dry-run evidence

Base: `30fc5bb0f68646f9efe1917fc93caf0f7d28a801`  
Branch: `stabilize/phase3-squad-reconciliation-dryrun-f3d1`

## Authority and guardrail

Active `clover_squad_memberships` is the canonical Squad authority. The
`jogadores.esquadrao` value remains a compatibility projection. The planner
does not create, remove, or alter memberships; a SAFE_AUTO action can only
project one proven active canonical membership into a neutral legacy value.

The versioned planner defaults to dry-run, requires an explicit `--db` path,
and requires both `--apply` and `--non-live-copy-confirmed` before it can open
a disposable copy for writes. It rejects the known runtime path, non-regular
files, paths without the disposable campaign marker, and preexisting WAL/SHM
sidecars. Aggregate CLI output deliberately excludes player identifiers.

## Fresh online backup

The fresh source was accessed only through `node:sqlite.backup` in
`sqliteBackupService`; no live mutation, runtime action, PM2 action, or Mudzap
action occurred.

| Evidence | Value |
| --- | --- |
| SHA-256 | `f0970a54f5c6a83b9401d7f1d82b2275fc063e4273dd8a13be0df620534b62e2` |
| Size | 192,614,400 bytes |
| `quick_check` | `ok` |
| `integrity_check` | `ok` |
| `foreign_key_check` rows | 0 |

## Fresh snapshot assessment

| Metric | Count |
| --- | ---: |
| Players checked | 627 |
| Match | 614 |
| Canonical-only | 4 |
| Legacy-only | 9 |
| Mismatch | 0 |
| Duplicate active membership | 0 |
| Unknown squad key | 0 |

The planner found no deterministic repair:

| Classification | Count |
| --- | ---: |
| Canonical-only SAFE_AUTO | 0 |
| Canonical-only MANUAL_REVIEW | 4 |
| Legacy-only SAFE_AUTO | 0 |
| Legacy-only MANUAL_REVIEW | 9 |
| BLOCKED_INVALID_STATE | 0 |
| SAFE_ACTIONS_TOTAL | 0 |
| MANUAL_REVIEW_TOTAL | 13 |

Reason totals are `CANONICAL_PROJECTION_PRECONDITION_FAILED=4` and
`AMBIGUOUS=9`. The four canonical-only cases do not meet the lifecycle safety
precondition. The nine legacy-only cases have no objective immutable evidence
that establishes the canonical membership that should exist, so they were not
promoted by inference.

## Disposable proof and idempotency

A second disposable copy was derived from the fresh snapshot. Protected apply
executed zero repairs; no MANUAL_REVIEW or blocked item was changed. Post-apply
divergence counts remained 614 match, 4 canonical-only, 9 legacy-only, and
zero mismatch, duplicate-active, and unknown-key cases.

A second planner run reported `SAFE_ACTIONS_TOTAL=0`; a second protected apply
also executed zero actions. This proves no-op idempotency for the observed
state. The original fresh snapshot was never used as an apply target.

## Remaining approval gate

`SQUAD_P1` remains `OPEN`. A separate, explicit approval with additional
historical evidence is required before any live reconciliation can be
considered. This campaign made no cutover, reader change, fallback removal,
dual-write change, migration, or live repair.
