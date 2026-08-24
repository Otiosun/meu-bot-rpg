# F10-F12 readiness map (read-only)

## F10 CI

Local validation is the npm test suite plus dedicated F4/F5/Phase 2/Phase 3
gates. Workflow and branch-protection configuration are repository-hosted
controls and require maintainer review; Windows is covered by the local
PowerShell/Node path, while hosted runner evidence remains deferred.

## F11 supply chain

`package-lock.json` is the dependency resolution authority. Dependencies are
installed through `npm ci`; native SQLite rebuilds are local build artifacts.
No provenance, SBOM or vulnerability-policy automation is introduced here;
those are explicit F11 follow-up decisions, not silent runtime changes.

## F12 application security

Existing controls include canonical Site sessions, integrated RBAC/default deny,
DTO/error sanitization, idempotent mutation gates and parameterized SQLite
access. The external frontend contract rejects client role/player/price/balance
authority. Remaining read-only review areas are hosted headers/rate limits,
CI secret scanning and deployment topology; no live configuration is changed.
