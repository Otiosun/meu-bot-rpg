# Clover Core: identity, authentication and access

| Boundary | Canonical owner | Authority source | Default deny |
| --- | --- | --- | --- |
| Site HTTP session | `siteAuthService.authenticateSiteSession` | Server-side hashed session record and canonical identity graph | Missing, expired, ambiguous, archived or unreleased sessions fail |
| Player identity | `siteAuthService` / `groupAccess.normalizeJid` | Session's canonical player, never request body/query | Site pre-reset routes derive `actor.playerId` only from session |
| Role/capability | `integratedAccessContextService.getIntegratedAccessContext` | Canonical role grants, with documented compatibility fallback | `contextCanAnywhere` requires the permission or owner |
| Pre-reset mode/policy | `preResetAccessService` + `preResetPolicyRegistryService` | Server environment plus default-deny registry | Missing/malformed mode or policy is denied |
| HTTP public errors | `preResetSiteApiService.httpError` | Closed public error-code map | Unknown causes are generic `internal_error` |

Site and bot are separate authenticated boundaries, not parallel auth systems: Site
uses the Site session service; bot commands use their transport/group identity
adapters. Both consume the same canonical player/role authorities where access
is required. No F4 work introduces a second session, role, or capability store.

`preResetSiteApiService` creates an authenticated actor only after the Site
session boundary. Its player operations derive owner from that actor; administrative
review resolves canonical access context server-side. Client `playerId`, `role`,
`capabilities`, balance, price and entitlement authority are rejected.
