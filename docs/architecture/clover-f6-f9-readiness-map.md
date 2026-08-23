# F6–F9 readiness map (read-only)

| Next area | Reusable foundation | Main remaining dependency |
| --- | --- | --- |
| F6 domains | SQLite migrations, ledgers, operation inventory, F5 kernel | approved domain/product rules |
| F7 contracts | Site HTTP boundary, public DTO/error map, canonical actor | versioned frontend-facing contracts per domain |
| F8 frontend | documented `/pre-reset/*` contract | frontend is external; no UI exists in this repository |
| F9 ADM Central | canonical roles, access context, existing admin operation surfaces | scoped product workflows and UI decisions |

Recommended order: formalize domain boundaries and DTO contracts, then agree the
external frontend integration, then extend admin workflows. The largest P0/P1
gap remains product approval for D-01..D-09; it does not authorize enabling
pre-reset production mode.
