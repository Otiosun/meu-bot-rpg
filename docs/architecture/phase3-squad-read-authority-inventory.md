# F3H1 Squad read-authority inventory

This inventory classifies the production references to `jogadores.esquadrao`
after the F3H1 cutover. It distinguishes a stored compatibility projection from
an effective membership decision.

| Class | Production use | Result |
| --- | --- | --- |
| A — projection write | `squadMembershipService`, `squadMembershipTransitionService`, lifecycle flows, and the explicit compatibility adapters in the squad command/CloverScript path maintain the field alongside a canonical change. | Preserved. Canonical-to-projection writes remain allowed. |
| B — consistency audit | `squadMembershipDivergenceAudit`, `squadMembershipIntegrityAudit`, read-shadow/reconciliation tools, and integrity diagnostics compare the field to active membership. | Preserved read-only/fail-closed evidence. |
| C — compatibility output | profile, raid option/finalization serialization, captain/admin views, presentation, and selector labels may display the projection or record it as historical context. | Preserved; these paths do not select an effective membership. |
| D — historical tooling | versioned `scripts/*` planners, repairs, migrations, smoke fixtures, and diagnostics read historical projections only under their explicit tool boundary. | Preserved and excluded from runtime authority. |
| E — business decision read | squad command resolution, access/squad operations, upgrade context, admin operation targets, raid progress/reward stars, Dream Worlds eligibility, performance-team eligibility, PA-shop stars, economy salary, quick evaluation, and legacy raid/CloverScript star effects. | **0 direct legacy reads.** These paths use `squadMembershipReadService` and active canonical membership. |

`scripts/auditSquadReadAuthority.js` is the executable counterpart. It rejects
an effective legacy fallback, a direct legacy squad SQL decision outside the
explicit compatibility view boundary, or a registered business consumer that
stops importing the canonical membership reader. Its negative test injects an
artificial `allowLegacyFallback: true` production reader and must fail.

The F3G1 post-repair evidence remains the data gate: 627 checked and 627 match,
with zero canonical-only, legacy-only, mismatch, duplicate-active, and unknown
states. F3H1 does not mutate the live database.
