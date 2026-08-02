# P0 canonical role migration evidence

Host validation completed on 2026-08-01 against the immutable Phase 0 snapshot.

## Migration

- 18 canonical grants planned and inserted.
- 18 grant events recorded.
- 18 grants linked to migration batch 1.
- Legacy sources remained unchanged: 5 active Central ADM rows and 14 active access-role rows.
- Post-migration role shadow: 0 critical subjects, 0 unapproved expansions, 0 unapproved regressions, 0 scope leaks.
- SQLite integrity check: `ok`.

## Rollback

- 18 linked grants revoked atomically.
- 18 revocation events recorded.
- Batch status changed to `rolled_back`.
- Active canonical grants returned to 0.
- Legacy sources remained unchanged.
- Post-rollback role shadow: 0 critical subjects, 0 unapproved expansions, 0 unapproved regressions, 0 scope leaks.
- SQLite integrity check: `ok`.

The live database was not modified. Receipts and verification reports remain in the private Phase 0 evidence directory on the runtime host.
