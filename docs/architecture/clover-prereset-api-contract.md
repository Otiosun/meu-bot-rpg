# Clover pre-reset Site API contract

The canonical Site API owns `/pre-reset/*`. Every route first authenticates the
server-side Site session. Player routes derive the owner from that session; a
client never supplies an authoritative player, role, balance, price, or
entitlement.

Read routes: `GET /pre-reset/status`, `/future-character`,
`/return-points/balance`, `/conversion`, `/shop/catalog`, and `/entitlements`.
They expose only the authenticated player's records (except the policy status
and the server-side catalogue).

Mutation routes: `POST|PUT /pre-reset/future-character`,
`POST /pre-reset/future-character/submit`,
`POST /pre-reset/conversion/claim`, `POST /pre-reset/shop/purchase`, and
`POST /pre-reset/admin/future-characters/:playerId/review`. Mutations require
an `Idempotency-Key` and pass the mode, policy, session-eligibility,
ownership/RBAC, validation and canonical-service transaction gates.

Stable error codes include `unauthorized`, `ownership_denied`,
`capability_denied`, `prereset_mode_disabled`, `policy_not_configured`,
`policy_disabled`, `validation_failed`, `revision_conflict`,
`idempotency_conflict`, `insufficient_return_points`,
`catalog_item_not_found`, `entitlement_already_owned`, and `not_found`.
Responses never include SQL, stack traces, raw session tokens or phone data.

No in-repository frontend is introduced by P2. Consumers remain
**EXTERNAL_FRONTEND_PENDING** until product policies are approved and a UI is
separately authorized.
