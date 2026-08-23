# F3G1 — Squad live repair evidence

The approved F3G1 live repair ran as one narrow transaction after the runtime
identity, a fresh online backup, SQLite integrity, and the exact policy plan
were all verified.

## Preconditions

- Canonical base: `ccc1079920668cc4e4ff095c016f42a4ad0f7e00`.
- Pre-repair online-backup SHA-256:
  `c5e318af1502080d4135ef3801534d2a0ca032268a4d497d1ca908ea8958c4c2`.
- Pre-repair SQLite checks: `quick_check=ok`, `integrity_check=ok`, and
  `foreign_key_check=0`.
- Pre-repair reconciliation audit: 627 checked; 614 match; 4 canonical-only;
  9 legacy-only; zero mismatches, duplicate active memberships, and unknown
  keys.
- Approved policy plan: 13 actions exactly: 4 archive/end-membership actions,
  9 legacy-grandfather actions, and zero manual or blocked actions.

## Result

- The transaction applied exactly 13 approved actions and changed no player
  projection row.
- Post-repair audit: 627 checked and 627 match, with zero canonical-only,
  legacy-only, mismatch, duplicate-active, or unknown-key states.
- The second policy plan contained zero actions.
- Post-repair online-backup SHA-256:
  `bb5570545cd5eb46ee201d3768da27392241e20daec1a60393e56b573c9e0e81`.
- Post-repair SQLite checks: `quick_check=ok`, `integrity_check=ok`, and
  `foreign_key_check=0`.

No player identifiers, JIDs, telephone numbers, or names are recorded here.
The repair did not control PM2, touch Mudzap, deploy, reset, or remove the
legacy fallback.
