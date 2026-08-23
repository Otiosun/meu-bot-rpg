# F7/F8 external frontend integration

`FRONTEND_CODE=EXTERNAL`; this repository contains no UI and has no deployment
action. Consumers use contract `v1`, `Authorization: Bearer <site-session>` and
`Idempotency-Key` for mutations. The contract registry is
`helpers/clover/siteApiContractRegistry.js`; the real HTTP harness is
`tests/preResetSiteApiE2E.test.js`.

The covered flows are session/status, player/future character, Return Points,
conversion, shop/catalog, purchase/entitlement and administrative review.
Responses are DTO envelopes only. Failures are `{ ok: false, error, message }`;
unknown failures become a generic 500 with no SQL, stack, token, JID or phone
data. v1 compatibility is additive-only: stable paths, fields and error codes
cannot be removed or retyped.

The client integration checklist is: retain the server session token securely;
send idempotency keys once per mutation; render disabled policy modes; map only
stable error codes; never supply player/role/capability/balance/price authority;
and perform admin review only after server capability confirmation.
