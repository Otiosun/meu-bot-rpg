# F4–5 pre-reset character launch foundation

Status: technical foundation only. The pre-reset mode is disabled by default;
this document does not authorize a reset, a live migration, or a gameplay
release.

## Discovery record

### Current character creation

`helpers/profileForms.js` parses and validates the current profile, then
`confirmPendingProfile` persists it directly to `jogadores`. The confirmation
command also advances onboarding and registration/appearance flows. Its fields
and side effects belong to the active character and must not be reused as a
pre-reset store. Useful pure validation rules (minimum character age, gender and
appearance checks) may be reused by a separate future-character validator.

### PH

`helpers/clover/phService.js` is the PH authority. `clover_ph_ledger` is
append-only and `clover_character_stats.ph_available` / `ph_accumulated` are
derived projections rebuilt from the ledger. PH spenders use transaction-scoped
helpers such as `spendPhInTransaction`. A pre-reset conversion must read ledger
history only; it must never consume PH or trust the projection.

### Recruitment PR is not Return Points

`comandos/pr.js`, `helpers/clover/prService.js` and `clover_pr_ledger` implement
Recruitment Points for referrals, group promotion and its shop. This is a
separate currency with its own event and idempotency semantics. F4–5 must never
read, write, join or repurpose `clover_pr_ledger`.

### Shops and inventory

The economy, PA and Recruitment shops use server-side catalogues, immutable
ledger entries, idempotency keys and transaction-scoped inventory helpers.
Existing shop services grant active inventory, therefore cannot be used by the
pre-reset shop. A pre-reset purchase may only debit Return Points and create a
future entitlement in the same transaction.

### Site, identity and authorization

The existing site authenticates through `siteAuthService`, which resolves a
canonical player identity from a server-side session. The current site session
is intentionally limited to released players. F4–5 introduces no parallel
authentication system and does not bypass that guard. The future external UI is
therefore contract-only until product/auth policy explicitly authorizes access.
Canonical role grants and existing admin access services remain the only RBAC
authority; no role supplied by a client is trusted.

### Reset history

`playerReset` is lifecycle archival compatibility and
`playerResetService` contains explicit operational reset/restore tooling. Neither
is a pre-reset mechanism. F4–5 does not invoke, import or adapt those mutation
paths.

### Schema ownership

The current formal migration catalog ends at `0028`. Canonical prebootstrap runs
approved formal migrations before the legacy bootstrap without changing the
migration ledger or `user_version`. F4–5 owns new tables through `0029` only;
runtime services do not create or repair their schema.

## Canonical model and invariants

```
jogadores (active character; unchanged)
             |
             +-- clover_prereset_characters (one future aggregate per player)
             +-- clover_return_points_ledger (sole Return Points authority)
             +-- clover_return_point_conversion_claims (future policy receipts)
             +-- clover_prereset_purchases -> clover_prereset_entitlements
```

The future character uses `draft`, `submitted`, `approved` and `locked` states,
with optimistic `revision` control and idempotency receipts. `applied_at_reset`
is deliberately impossible in this campaign: no service or schema transition
can set it.

Return Points are a new, distinct ledger domain. The initial balance is zero;
there is no inferred or copied balance. Conversion infrastructure snapshots PH
ledger provenance for deterministic preview/reconciliation but remains disabled
and makes no write while no approved policy exists.

The pre-reset catalogue is empty/disabled in production. Tests may inject a
synthetic server-side catalogue solely to prove debit + entitlement atomicity.
No entitlement changes active `jogadores.raca` or active inventory.

## Product decisions still required

1. PH-to-Return-Points formula, rounding, cutoff and reset-cycle identity.
2. Whether conversion consumes PH or is snapshot-only.
3. Real pre-reset catalogue, prices, refund policy and limited-choice capacity.
4. The permitted number of future characters beyond the conservative one-row
   aggregate.
5. Session eligibility for players who are preparing a future character while
   normal gameplay remains unreleased.

Until those decisions are approved, conversion and purchase endpoints remain
disabled, no real catalogue is published, and the launch is not ready.

`PH_CONVERSION_POLICY_STATUS=PRODUCT_DECISION_REQUIRED`.

## API contract status

The reserved contract is `/pre-reset/*`: future-character read/draft/submit,
Return Points balance and conversion preview, catalogue, purchase, entitlements
and explicit admin review. Mutations require an authenticated canonical identity,
same-player ownership (or an existing capability-based admin decision), an
idempotency key and `PRE_RESET_LAUNCH_ENABLED=true`. No route is enabled in this
foundation because the current site-session eligibility and product catalogue are
not yet approved.
