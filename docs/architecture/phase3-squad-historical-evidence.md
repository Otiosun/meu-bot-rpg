# Phase 3 Squad historical evidence

Base: `fd2d589403788432169cd3d71bd44ee93ade6d98`
Branch: `stabilize/phase3-squad-historical-evidence-f3e1`

## Scope and sources

This investigation reused the F3D1 reference snapshot only in read-only mode.
It did not create a new online backup or mutate live data. Active
`clover_squad_memberships` remains the canonical Squad authority and
`jogadores.esquadrao` remains its compatibility projection.

The 13 cases below are stable local aliases only. No player identifiers, names,
phone numbers, JIDs, free-text reasons, or raw metadata are recorded here.

Primary evidence consulted:

- historical membership rows and membership events;
- explicit player lifecycle events and their before/after snapshots;
- recruitment/referral and available application histories;
- two earlier non-live F3 snapshots, compared with F3D1;
- the membership, lifecycle, transition and reader services;
- focused lifecycle and membership tests; and
- the relevant commits: lifecycle introduction (`9309d795`), membership
  introduction (`b0065297`), and the read-only global backfill planner
  (`1fe8f4f9`).

## Findings

The four canonical-only cases all have one historical active membership and an
`added` event that precede their final lifecycle archive event. The archive
event explicitly changes the player lifecycle/game status and clears the legacy
projection. The lifecycle service predates canonical membership and does not
end membership; current tests intentionally allow an already archived member to
be removed later through the explicit membership-removal flow.

This proves why the two representations diverged, and proves that restoring the
legacy projection would be wrong. It does **not** prove that archive itself
historically meant “end membership”: there is no corresponding membership
`removed`/`archived` event, transition receipt, or lifecycle-to-membership rule.
Ending a membership would therefore be a new policy decision rather than a
history-preserving repair.

The nine legacy-only cases are active, approved and released in F3D1 and in the
two earlier available non-live snapshots. In all three snapshots each has a
legacy projection but zero membership rows, membership events, lifecycle events,
referrals, and relevant application rows. The historical global backfill
planner is explicitly read-only and `SafeToApply: false`; its existence does not
prove an intended membership for any individual player. Legacy projection alone
is insufficient evidence to create canonical membership.

## Case matrix

| Case | Initial state | Final classification | Evidence types | Confidence | Future repair class | Missing evidence |
| --- | --- | --- | --- | --- | --- | --- |
| CASE-01 | CANONICAL_ONLY | AMBIGUOUS_MANUAL | membership history + added event + archive lifecycle event | INSUFFICIENT | NONE | explicit rule or event linking archive to membership end |
| CASE-02 | CANONICAL_ONLY | AMBIGUOUS_MANUAL | membership history + added event + archive lifecycle event + referral history checked | INSUFFICIENT | NONE | explicit rule or event linking archive to membership end |
| CASE-03 | CANONICAL_ONLY | AMBIGUOUS_MANUAL | membership history + added event + archive lifecycle event + referral history checked | INSUFFICIENT | NONE | explicit rule or event linking archive to membership end |
| CASE-04 | CANONICAL_ONLY | AMBIGUOUS_MANUAL | membership history + added event + archive/reactivate/archive lifecycle sequence | INSUFFICIENT | NONE | explicit rule or event linking final archive to membership end |
| CASE-05 | LEGACY_ONLY | AMBIGUOUS_MANUAL | current + two historical snapshots; membership/event/lifecycle/recruitment/application histories absent | INSUFFICIENT | NONE | explicit join/add or leave/transfer history |
| CASE-06 | LEGACY_ONLY | AMBIGUOUS_MANUAL | current + two historical snapshots; membership/event/lifecycle/recruitment/application histories absent | INSUFFICIENT | NONE | explicit join/add or leave/transfer history |
| CASE-07 | LEGACY_ONLY | AMBIGUOUS_MANUAL | current + two historical snapshots; membership/event/lifecycle/recruitment/application histories absent | INSUFFICIENT | NONE | explicit join/add or leave/transfer history |
| CASE-08 | LEGACY_ONLY | AMBIGUOUS_MANUAL | current + two historical snapshots; membership/event/lifecycle/recruitment/application histories absent | INSUFFICIENT | NONE | explicit join/add or leave/transfer history |
| CASE-09 | LEGACY_ONLY | AMBIGUOUS_MANUAL | current + two historical snapshots; membership/event/lifecycle/recruitment/application histories absent | INSUFFICIENT | NONE | explicit join/add or leave/transfer history |
| CASE-10 | LEGACY_ONLY | AMBIGUOUS_MANUAL | current + two historical snapshots; membership/event/lifecycle/recruitment/application histories absent | INSUFFICIENT | NONE | explicit join/add or leave/transfer history |
| CASE-11 | LEGACY_ONLY | AMBIGUOUS_MANUAL | current + two historical snapshots; membership/event/lifecycle/recruitment/application histories absent | INSUFFICIENT | NONE | explicit join/add or leave/transfer history |
| CASE-12 | LEGACY_ONLY | AMBIGUOUS_MANUAL | current + two historical snapshots; membership/event/lifecycle/recruitment/application histories absent | INSUFFICIENT | NONE | explicit join/add or leave/transfer history |
| CASE-13 | LEGACY_ONLY | AMBIGUOUS_MANUAL | current + two historical snapshots; membership/event/lifecycle/recruitment/application histories absent | INSUFFICIENT | NONE | explicit join/add or leave/transfer history |

## Totals and next gate

| Classification | Count |
| --- | ---: |
| PROVEN_CANONICAL_PROJECTION_STALE | 0 |
| PROVEN_CANONICAL_MEMBERSHIP_STALE | 0 |
| PROVEN_LEGACY_STALE | 0 |
| PROVEN_CANONICAL_MEMBERSHIP_MISSING | 0 |
| PROVEN_TRANSITION_STATE | 0 |
| AMBIGUOUS_MANUAL | 13 |
| BLOCKED_INVALID_STATE | 0 |

`AUTO_REPAIRABLE_WITH_SEPARATE_APPROVAL=0`,
`MANUAL_DECISION_REQUIRED=13`, and `NO_REPAIR_REQUIRED=0`.

No repair manifest is created because no case has a deterministic,
history-preserving repair. `SQUAD_P1=READY_FOR_MANUAL_POLICY_DECISION`: a
separate policy decision must first define whether archival ends active Squad
membership and how to establish membership where only a legacy projection
survives. This campaign performs no repair, cutover, reader change, migration,
or live action.
