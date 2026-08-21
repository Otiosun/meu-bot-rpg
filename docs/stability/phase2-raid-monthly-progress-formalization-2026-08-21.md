# Phase 2 — Raid Monthly Progress formalization (0024)

Date: 2026-08-21
Migration: `0024_raid_monthly_progress`

## Scope

This slice formalizes only the canonical table/index shape already used by
`helpers/clover/raidMonthlyProgressService.js`:

- `clover_raid_monthly_reservations`
- `clover_raid_monthly_ledger`
- the four canonical Monthly indexes.

It deliberately does **not** promote 0024 to canonical pre-bootstrap yet and
does **not** remove or change `ensureRaidMonthlyProgressSchema()`.

## Deployment semantics

- both Monthly tables absent -> create both canonical tables and all four
  canonical indexes, with zero reservation/ledger rows;
- both tables already exact + all four canonical indexes exact -> no-op;
- only one table present, incompatible table SQL, missing canonical index, or
  homonymous canonical index with another shape -> fail closed;
- an extra unrelated index is preserved and is not treated as a mapping error;
- stored CHECK-domain violations detected in an exact table shape -> fail
  closed instead of normalizing data.

## Non-retroactive invariant

Migration 0024 never reads Raid history to synthesize a Monthly reservation or
ledger credit. Existing Monthly rows and AUTOINCREMENT sequences are preserved.
No reward/grant is applied or reapplied.

## Deliberately outside this slice

- pre-bootstrap promotion of 0024;
- coverage proof / runtime-removal gate for Monthly;
- cleanup or mass removal of Monthly runtime callsites;
- Campaign B SQLite/runtime work;
- live DB/runtime, PM2, Mudzap, deploy, or reset.
