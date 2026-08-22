# Clover Canonical Data Map

Status: inventory grounded in the local source at `90cdc2061cd0dd17e6d787d7fa53850f3ae99115`.
This is an authority map, not a migration plan: a persisted duplicate is never
assumed to be a second source of truth merely because it has a table or column.

## Reading this map

`Authority` is the service/entity permitted to decide a fact. `Projection` may
be persisted, but is derived from that authority and must not be repaired by
guessing. `Writers` and `readers` name production service entry points; bot,
admin and API consumers are called out where distinct. SQL is accessed through
the injected database owner established in Phase 2
([phase2-data-access-inventory.md](../stability/phase2-data-access-inventory.md)).

| Kind | Meaning |
| --- | --- |
| canonical authority | sole semantic owner for new decisions |
| projection / read model | persisted or assembled representation derived from an authority |
| compatibility alias | legacy representation kept while consumers are migrated |
| derived value | computed at read/mutation time, not an independently editable fact |
| historical artifact | immutable event, ledger, revision, receipt or audit trail |
| external projection | WhatsApp/device/config state outside SQLite |
| temporary migration compatibility | a bounded legacy source still read during a documented cutover |

## Critical-fact register

Every row records the entity/key, storage and authority, then the complete
operational shape requested for a business fact. `Bot` includes command and
WhatsApp flows; `Admin/API` includes the local admin and site service surfaces.

| Domain / fact | Canonical entity and authority | Storage, writers and readers | Projections, aliases, history, invariants and status |
| --- | --- | --- | --- |
| Player profile and lifecycle | `jogadores.id`; `registrationManager`, `playerLifecycleService` and `playerResetService` own respectively creation, lifecycle transitions and archival reset. | `jogadores`; supporting `player_onboarding`, `player_rolls`, lifecycle/archival events. Writers: registration, appearance, lifecycle/reset, archive, CloverScript lifecycle. Readers: profile, target resolution, capacity, raid/economy eligibility. Bot: registration/profile; Admin: lifecycle/recovery. | `ficha_status`, appearance and game status are the state machine; snapshots/backup paths are historical artifacts. Invariant: lifecycle transitions validate active reservations, queue and leadership before archive. **P2:** several specialized writers share one row, but own disjoint transition fields and use lifecycle guards; no generic profile writer is authority for lifecycle. |
| Identity | player JID is `jogadores.id`; `targetResolver` is the canonical runtime resolver. | `jogadores.id`, profile fields and optional target lookup state. Writers: registration and identity-link commands; readers: all player-targeting services. | `playerIdentityEquivalenceService` computes equivalent IDs rather than deciding ownership. Invariant: normalize JID before target matching. **P3** derived resolver. |
| WhatsApp aliases/devices | normalized JID plus phone digits; `groupAccess`/`chatReply` own transport normalization, `playerIdentityEquivalenceService` owns DB equivalence lookup. | SQLite player ID and external `auth_info` LID/device mapping files. Writers: WhatsApp transport/auth state; readers: chat reply, archive, exit, target resolver. | LID/device files are external projections/caches, not player identity authority. Fallback is digit equivalence only where a LID can be resolved. **P3**, external-projection risk documented; never write aliases back as a guessed player identity. |
| Squad membership | one active `clover_squad_memberships` row per `player_id`; `squadMembershipService` and atomic `squadMembershipTransitionService`. | `clover_squad_memberships`, membership events and transition receipts; `jogadores.esquadrao`; `clover_squads`. Writers: membership add/remove/transfer and legacy registration/lifecycle paths. Readers: `squadMembershipReadService`, `squadStateService`, raids and squad commands. Bot: `.times`/squad operations; Admin: captain/admin membership. | `jogadores.esquadrao` is a compatibility projection, updated in the same transaction. Events/transitions are history. Invariants: partial unique active membership; mutation validates both representations and fails closed on mismatch. **P1 OPEN:** legacy field remains a real consumer fallback, so authority cutover cannot be asserted without the documented live divergence audit. |
| Squad definition and leadership | `clover_squads.key`; `squadService`/`squadUpgradeService` own squad state, with captain persona services for presentation. | `clover_squads`, star ledger, upgrade/service records. Writers: squad service, captain/persona, admin/squad upgrades. Readers: squad state/dashboard, membership and raids. | Captain/vice fields are squad-state facts; membership transfers refuse to move a leader. Star records are history. **P2** because presentation personas copy leadership context but do not decide it. |
| Yulls / money balance | `clover_yulls_ledger` entries plus `yullsService` balance calculation. | Ledger, reservations; legacy `jogadores.dinheiro`. Writers: `yullsService`, economy/market/box/reward flows through its transaction helpers; admin reward uses `addYulls...`-compatible ledger semantics. Readers: balance/extract, shops, market and profile. Bot: `.saldo`, `.extrato`; Admin: reward. | `jogadores.dinheiro` is a cached compatibility projection updated after ledger append; reservations are temporary holds; ledger is history. Invariant: append and projection update happen in one transaction and `balance_after` is checked. **P2** projection divergence risk; never recalculate/rewrite ledger from money column. |
| PH | player PH ledger and stat summary; `phService` is authority. | `clover_ph_ledger`, `clover_character_stats`. Writers: PH service, admin reward/character adjustment via PH helpers. Readers: profile, capacity, rewards. | Character stat PH total is a derived/read-model value; ledger is historical authority. Invariant: transactions and recalculation verify consistency. **P2** persisted summary projection. |
| PA / admin work credit | `clover_pa_ledger`; `paService` is authority. | PA ledger, shop purchases, admin service entries/payouts. Writers: PA service, scene/week, item-use, shop and payout services. Readers: admin dashboard and commands. | Shop purchase and service-entry status are workflow projections/receipts, not an alternate PA balance. **P2**; mutations use service-specific idempotency/ledger rows. |
| PM / private delivery state | `clover_delivery_jobs` key and `deliveryService`; private transport policy is `privateMessagePolicy`. | delivery tables/jobs and external WhatsApp transport. Writers: delivery service, `chatReply` fallback only through `enqueuePrivateMessage`. Readers: worker/chat reply. | Queue is a delivery projection of an already authorized message; policy source catalog is configuration. Invariant: strict source allowlist hard-blocks unapproved private sends. **P3** external transport state. |
| Inventory holdings | `clover_inventory_items.id` and `inventoryService`. | item templates, inventory items, grants, history and reservations. Writers: inventory service; economy, box, market and redemption call inventory transaction helpers; legacy repair is explicit repair tooling. Readers: inventory, economy, market, profile. Bot: inventory/box/market; Admin: item grants. | `clover_inventory_item_history` immutable history; reservations are temporary holds. Legacy inventory hydration is one-way compatibility import. Invariants: quantity/reservation availability and transactional history. **P2** legacy-hydration compatibility only. |
| Possessions/equipment | possession slot by player and item; `possessionsSchema` plus inventory/equipment consumers. | possession records and `clover_inventory_items`; historical item grants. Writers: inventory/economy/item admin. Readers: profile, combat/raid capacity. | Equipped/active effect is a projection of owned inventory and slot rules. Invariant: cannot equip unavailable/reserved item. **P2** if old possession shape is present; no two-way reconciler. |
| Item catalog and admin definitions | `clover_item_templates.template_key`; `itemAdminService` owns catalog mutation. | templates, item grants and inventory records. Writers: item admin/catalog seed only. Readers: inventory, economy, boxes, rewards. Admin: item administration. | Seed catalog is a controlled catalog projection, not player possession; grants/history preserve provenance. **P3** catalog/read model separation. |
| Boxes and pity | box opening key; `boxService` and `boxPityStateService`. | `clover_box_openings`, pity state and inventory/yulls ledgers. Writers: box service. Readers: box commands/dashboard. | Opening is history; pity state is deterministic derived mutation state. Invariant: opening and inventory grant are transactional/idempotent. **P2** across bounded domain services, no generic direct writer. |
| Progression / level / patent | player progression keyed by `jogadores.id`; `characterStats` and progression services own calculation/mutation. | `player_progress`, `clover_character_stats`, selected `jogadores` fields. Writers: stats adjustment, evaluation/reward and lifecycle-aware services. Readers: profile, capacity, salary, raid. | Capacity and level thresholds are derived; adjustment history/audit records preserve cause. **P2** multiple specialized writers, each owns explicit adjustment type. |
| Character attributes | `clover_character_stats.player_id`; `characterStats` and `characterStatAdjustmentService`. | character stats and adjustment/history fields. Writers: stat adjustment, admin reward/evaluation. Readers: profile/capacity/raid. | Derived bonus summaries and technical capacity are read models. Invariant: changes carry actor/reason and use transactional update. **P2** persisted summary versus adjustment history. |
| Skills/tree | skill node/player key; `skillTreeService` and `skillApprovalService`. | `clover_skill_nodes`, `player_skill_trees`, pending purchases. Writers: skill purchase/approval. Readers: profile, capacity and skills bot flows. | Pending purchase is a workflow projection; owned skill tree is canonical player entitlement. Invariant: approval consumes exactly one pending request. **P2** temporary pending state. |
| Spells and reviews | spell/review key; `spellbookService` and `spellReviewFlowService`. | spellbook tables, review queue/events and related settings. Writers: spellbook/review flow, admin review. Readers: grimoire/review inbox/raid eligibility. | Review events are history; inbox is read model. Invariant: review flow constrains state transitions. **P2** queue/read-model duplication. |
| Hexagon / location | `clover_mana_hexagon.player_id`; `hexagonService`. | mana hexagon, ledger and pending upgrades. Writers: hexagon service/admin approval. Readers: profile/capacity. | pending upgrade is workflow state; derived limits are computed. Invariant: side/value validation and approval requirement by tier. **P3** derived limits and bounded pending projection. |
| Raids | `clover_raids.raid_key`; `raidV2Service`/`raidService` orchestration with formal migration ownership. | raids, participants, rewards, checklist, monthly progress, mutation receipts. Writers: raid creation/finalization/mutation services. Readers: raid command/dashboard/admin. | monthly progress, reward proposals/revisions/authors and idempotency events are read/history workflow state. Invariants: formal 0023–0028 schema lineage, idempotency and atomic finalization. **P2** intentional read models/history; no runtime schema fabrication authority. |
| Raid reward review | proposal `raid_key` + revision/intent key; `raidRewardProposalService` composed core/authors/revisions/idempotency. | proposals, authors, revisions, review intents/events/context guard. Writers: proposal/revision/review services. Readers: raid/admin review. | snapshots/revisions/events are immutable historical artifacts. Invariant: 0027 exact Family B precedes 0028 Family C; strict review context guard. **P3** history and receipts. |
| Dream Worlds | world/run key; `dreamWorldsService` and operations service. | Dream World tables, player/world state and operation records. Writers: operations service. Readers: Dream Worlds commands/admin. | operation records are history/idempotency; dashboards are read models. Invariant: service owns transition validation. **P2** workflow projection. |
| Recruitment / candidatures/referrals | referral/code/event keys; `recruitmentService` and `recruitmentGroupService`. | recruitment events/codes/referrals/reward deliveries. Writers: recruitment services, evaluation-triggered delivery. Readers: recruitment dashboard/bot. | delivery is an immutable receipt; code is a compatibility-facing public identifier. Invariant: referral eligibility and exactly-once reward delivery. **P2** event-delivery projection. |
| Stars / seasonal rewards | squad-star ledger record; `squadSeasonStarService` and `quickEvaluationService`. | `clover_squad_star_ledger`, quick evaluations and backfill/repair records. Writers: evaluation and season star service; repair tools are explicit historical remediation. Readers: squads/leaderboard/rewards. | ledger is history; totals are derived. Invariant: idempotent evaluation source link. **P2** repair tooling must remain explicit, never background reconciliation. |
| Roles and permissions | effective grant context; `canonicalRoleGrantService` currently aggregates canonical plus legacy grants. | `clover_role_grants`, grant events; `clover_access_roles`, legacy admin/team fields and owner config. Writers: canonical admin team/grant service, access role assignment and legacy access control. Readers: admin access, command authorization, squad authorization. | owner config is external configuration; legacy rows are temporary migration compatibility; grant events are history. Invariant: global legacy conflicts are detected and blocked. **P1 OPEN:** actual authorization deliberately merges sources; history shows offline migration was planned but not cut over, so a sole persisted winner cannot safely be selected without a live conflict audit. |
| Admin operations/audit | operation code; `adminOperationServiceBase` / atomic and recovery services. | admin operation, hook, service-entry/payout and trait audit tables. Writers: admin operations/services. Readers: admin APIs/dashboards. | operation logs and recoveries are history; they do not own the domain fact they invoke. Invariant: operation code/atomic receipts prevent replay. **P3** audit/workflow domain. |
| Appearance, traits and titles | player/trait/title keys; appearance manager, trait manager/admin trait service, title service. | appearance reviews, trait templates/assignments, player titles. Writers: approval/admin trait/title services. Readers: profile/admin. | review and migration records are historical; personalized override is a constrained projection over catalog trait. **P2** because legacy migration executors are explicit one-time compatibility tools. |
| Group/community membership and exit confirmation | confirmation `id` + player identity; `communityExitManager`. | group settings/member welcomes; `clover_exit_confirmations`; player lifecycle data. Writers: group events/exit manager. Readers: exit reply/expiry worker and lifecycle. Bot: community participant events; Admin: archival outcome. | confirmation status is workflow state; archive backup is historical external artifact. Invariants: one pending confirmation per player, claim token and stale-claim recovery. **P2:** `community_exit_confirmation` source is classified `preserve` but strict private policy blocks it (`private_source_not_allowlisted`). Git history proves the safety policy was introduced later and current test explicitly requires state persistence without transport bypass. Semantic product intent for notification remains ambiguous; current fail-closed transport is retained. |
| Site sessions/login | login code/session key; `siteAuthService`. | `clover_site_login_codes`, `clover_site_sessions`. Writers: site auth command/API service. Readers: site authentication. | sessions are temporary security credentials; login codes are short-lived receipts. Invariant: expiry/one-time consumption. **P3** bounded auth state. |
| Anti-ghost/checklists and delivery auxiliaries | player/job key; respective service owns its operational state. | anti-ghost, checklist and delivery tables/settings. Writers: antiGhost/checklist/delivery services and CloverScript adapters. Readers: bot/admin workers. | These are workflow/read-model facts over player state, not profile authority. Invariant: task/result keys and idempotent handling. **P3** operational auxiliary state. |

## Conflict ledger and selected authorities

| ID | Priority | Competing representations | Decision / evidence | Safe next action |
| --- | --- | --- | --- | --- |
| C-01 | P1 | `clover_squad_memberships` vs `jogadores.esquadrao` | Membership service dual-writes inside one transaction and refuses mismatch; read-shadow documentation records consumers still on the legacy field. | Keep legacy as compatibility projection; require an offline/live divergence snapshot before consumer cutover. |
| C-02 | P1 | `clover_role_grants` vs `clover_access_roles`/legacy admin/team/owner config | `getCanonicalRoleContext` explicitly reads and merges all sources; canonical-role migration evidence records a rollback/no cutover. | Keep aggregation fail-closed for global conflicts; do not delete or select a persisted winner without audited source data. |
| C-03 | P2 | `clover_yulls_ledger` vs `jogadores.dinheiro` | `yullsService` appends ledger and updates money projection in its transaction; balance readers calculate from ledger. | Treat `dinheiro` as projection; add regression guard against direct mutation outside approved owners. |
| C-04 | P2 | PH ledger vs character-stat PH summary | PH helpers write ledger and recalculate summary. | Treat ledger as history/authority; summary stays derived. |
| C-05 | P2 | exit policy disposition vs strict private allowlist | Commit `60b1af16` required a notification; later private-policy commits made unallowlisted sources hard blocks. Current test asserts no bypass. | Preserve fail-closed behavior; product owner must decide whether this source should enter strict allowlist. |
| C-06 | P2 | inventory legacy hydration vs structured inventory | `hydrateLegacyInventory` imports compatibility state into structured inventory; all normal mutations use transaction helpers. | Never run a reverse sync or infer values; retain explicit repair-only paths. |
| C-07 | P3 | JID/LID/device aliases | resolver normalizes and uses external mapping; no independent player row is created by alias handling. | Retain read-only alias resolution. |
| C-08 | P3 | raid proposal/revision/intents/events | Formal 0027/0028 establish ordered historical families and guards. | Preserve append/history semantics; no recomputation of snapshots. |
| C-09 | P2 | inventory persistence API vs specialized transaction writers | Economy, PA, raid, CloverScript, item/admin and explicit repair flows contain bounded direct item mutations alongside `inventoryService` helpers. Their callsites own distinct business transitions and record history where relevant; they do not reconcile state bidirectionally. | The authority audit makes every current direct writer explicit and rejects a new one. A future convergence can move bounded operations behind inventory transaction helpers without inferring or rewriting holdings. |

## Writer classification boundary

Phase 2's `sqliteOwnershipAudit` is the physical data-access inventory. For
Phase 3, every production SQL mutator found under `helpers/clover`, `comandos`
and `database` is classified as one of: domain authority writer, controlled
projection writer, migration/schema infrastructure, explicit repair/historical
tool, or command adapter delegating to one of those services.
`scripts/auditCanonicalDataAuthority.js` is an executable, table-aware contract:
it scans direct SQL mutation forms in the critical tables, registers every
current owner, and rejects a mutation in one of those tables from an unapproved
module. It deliberately records the remaining specialized inventory adapters
instead of concealing them as a false single-writer claim.

The bounded exception categories are intentionally visible: formal migration
infrastructure owns schema only; explicit `legacy*`, `*Repair*`, `*Backfill*`
and admin operation modules are historical remediation/audit flows and must not
be promoted to ordinary domain authorities.

## Evidence consulted

- `database/legacy.js`, schema migration catalog/service and Phase 2 ownership
  audit for physical schema/data-access ownership.
- Domain services and command callers named in the register; direct SQL mutation
  inventory from local `rg`.
- Squad transition/read-shadow evidence in `docs/clover/p0-squad-membership-*`.
- Canonical-role migration evidence in `docs/p0-canonical-role-migration-evidence.md`.
- `communityExitManager`, private-message policy/runtime, tests and commits
  `60b1af16`, `6a79295d`, `e2765752` and `ffb87378` for the exit-policy result.
- Raid formal migration lineage 0023–0028 and their tests.

## Explicit genuine ambiguities

1. Whether legacy squad consumers can be cut over is a data-dependent question:
   current production state has not been inspected and the repository deliberately
   requires a divergence audit before switching readers.
2. Whether legacy role grants can be retired is also data-dependent: the effective
   authorization function currently merges sources and may contain real conflicts.
3. Product intent for a private community-exit notification conflicts with the
   security allowlist. The code/history proves the current fail-closed behavior,
   but not permission to allow private delivery.
