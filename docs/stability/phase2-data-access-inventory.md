# Phase 2 data-access inventory (C0/C6)

The versioned ownership audit scans every local JavaScript file (excluding only `.git`, `node_modules`, and generated coverage) and emits one exact entry for every direct SQLite driver import, `sqlite3.Database`, or physical `open({ filename })` use.

| Category | Final decision |
| --- | --- |
| A | `helpers/clover/databaseConnection.js` is the sole application connection/driver owner. |
| B | Schema/prebootstrap/migration code receives an injected connection and owns only schema history. |
| C | Runtime repositories/services use their injected `db`; no driver/open ownership. |
| D | `database.js` orchestrates lifecycle and injects the connection into `database/legacy.js`; legacy has no physical open. |
| E | Tests, scripts, and the single exact `helpers/clover/sqliteBackupService.js` backup verifier are classified non-runtime/devtool contexts. |
| F | Documentation has no executable ownership. |

`helpers/clover/sqliteOwnershipAudit.js` is the executable, deterministic source of the complete file-level inventory. Its blocker rules apply to runtime files; test and script entries are still recorded rather than hidden by a glob allowlist. The only non-owner runtime exception is the exact backup verifier path above.
