# Phase 3 P1 fresh divergence evidence

Base and evidence head: `c6ce4a96690390283ee9ad80d19bd80ec1b9a67d`.

## Fresh, consistent snapshot

A new online snapshot was created during this evidence run with
`helpers/clover/sqliteBackupService.js`, using `node:sqlite.backup`. The
runtime source and temporary destination paths are intentionally redacted; the
source was accessed only by SQLite's read-only backup mechanism. No source SQL,
checkpoint, WAL/SHM copy, PM2, Mudzap, or live data mutation occurred.

| Evidence | Value |
| --- | --- |
| Snapshot freshness | `FRESH_ENOUGH` (created in this run) |
| Created UTC | `2026-08-22T23:01:28.9268873Z` |
| Backup finished UTC | `2026-08-22T23:01:50.9207266Z` |
| Bytes | `192614400` |
| SHA-256 | `0d70856e427242820179b6d1edcfcc9cd1de290b3baad2d62e6ad2793b69b9fd` |
| Snapshot integrity | `ok` (`integrity_check` performed on the snapshot) |

The only audit targets were that fresh temporary snapshot and its local,
untracked JSON outputs. No identifier-level output is recorded here.

## Squad membership result

| Metric | Fresh snapshot | Prior stale diagnostic |
| --- | ---: | ---: |
| players checked | 627 | 627 |
| canonical only | 4 | 3 |
| legacy only | 9 | 9 |
| match | 614 | 615 |
| mismatch | 0 | 0 |
| duplicate active memberships | 0 | 0 |
| unknown squad keys | 0 | 0 |
| safe to cut over | false | false |

The comparison is **WORSENED** only in the narrow aggregate sense that one
additional canonical-only record exists. This is not evidence of a regression:
the earlier result was stale and is diagnostic only.

`SQUAD_P1=OPEN`. The canonical map continues to define one active
`clover_squad_memberships` row as the membership authority and
`jogadores.esquadrao` as its compatibility projection. The fresh divergence
classes are:

| Class | Count | Snapshot-only evidence | Automated action now |
| --- | ---: | --- | --- |
| Canonical-only: missing legacy projection | 4 | valid active canonical membership; legacy projection blank | none in this run |
| Legacy-only: canonical membership absent | 9 | valid legacy squad projection; no active or historical canonical membership | none in this run |
| Other / invalid / mismatch | 0 | no additional category observed | none |

## Squad reconciliation plan (not executed)

1. **Canonical-only missing projection.** The active canonical row is the
   authority. A future, separately approved repair may update only a blank
   legacy projection when a fresh transaction re-reads exactly one valid active
   membership, the squad key is currently valid, and the legacy value is still
   blank. It must create a dedicated reconciliation receipt containing
   before/after fingerprints and an operator/reason. Rollback restores only the
   prior blank projection from that receipt. Any nonblank legacy value, duplicate
   active row, unknown key, or changed precondition fails closed.
2. **Legacy-only canonical absence.** The legacy projection is not sufficient
   proof to invent a canonical membership. A future repair may create one only
   after deterministic evidence establishes current intended membership:
   normalized valid squad, no active canonical row, eligibility and leadership/
   reservation checks pass, and an approved source record identifies the actor
   and reason. The new canonical row and its transition receipt must be
   append-only; rollback must end the created membership through the normal
   transition path, never delete history. With the evidence currently present,
   all nine remain manual-review/fail-closed cases.

## Role and permission result

The role auditor reads the same persisted legacy sources as
`getCanonicalRoleContext` (`clover_role_grants`, `clover_access_roles`, and
`clover_admin_roles`) and keeps owner configuration external rather than
inventing it in SQLite.

| Metric | Fresh snapshot |
| --- | ---: |
| principals checked | 15 |
| agreements | 18 |
| conflicts | 0 |
| legacy only | 0 |
| canonical only | 0 |
| unresolved external | 0 |
| safe to cut over | true |

`ROLE_P1=RESOLVED` as an evidence decision: the fresh snapshot satisfies every
role criterion and has no canonical-only grants needing reader-absence analysis.
This does not itself change runtime authorization or retire any compatibility
reader.

## Gate decision

`SQUAD_P1` remains open, so the Phase 3 gate remains `PARTIAL_SAFE`. The
community-exit source remains a product/security decision with fail-closed
private delivery, and specialized inventory writers remain bounded and
justified. No live data was mutated.
