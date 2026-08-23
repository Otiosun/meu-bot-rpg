# Clover critical operation inventory

Classification is deliberate: **KERNELIZED** operations use the F5 operation
kernel; **CANONICAL_EXISTING** already have a proven owner/transaction model;
**DEFERRED_WITH_REASON** stays outside until a semantic migration is justified;
and **PRODUCT_DECISION_REQUIRED** remains disabled. P0/P1 has no unclassified
operation.

| Priority | Operation / entry point | Actor + authorization | Idempotency / concurrency / transaction | Owner + evidence | Class |
| --- | --- | --- | --- | --- | --- |
| P0 | Site session create/login/revoke | phone code + `siteAuthService` | token uniqueness, `BEGIN IMMEDIATE` | `siteAuthService`; auth tests | CANONICAL_EXISTING |
| P0 | Canonical role grant/revoke | owner/admin controls | canonical grant constraints | role grant/access services; RBAC tests | CANONICAL_EXISTING |
| P0 | Raid finalization | authenticated host/narrator | request receipts, exclusive mutation, transaction | Raid services and finalization HTTP tests | CANONICAL_EXISTING |
| P0 | Squad membership transfer | canonical actor/scoped access | idempotent transfer transaction | Squad transfer service tests | CANONICAL_EXISTING |
| P0 | Market/economy purchase | authenticated player | idempotency key, economy queue, ledger transaction | market/economy services | CANONICAL_EXISTING |
| P1 | Pre-reset future character create/update/submit | Site actor owns itself, policy/mode | operation key, revision, queue, service transaction | character service + HTTP E2E | KERNELIZED |
| P1 | Pre-reset Return Points conversion claim | Site actor owns itself, policy/mode | deterministic claim, queue, ledger transaction | conversion service + HTTP E2E | KERNELIZED |
| P1 | Pre-reset shop purchase | Site actor owns itself, policy/mode | idempotency key, queue, debit+entitlement transaction | shop service + HTTP E2E | KERNELIZED |
| P1 | Pre-reset approve/lock review | canonical capability `prereset.review` | operation key, queue, revision transaction | character review service + HTTP E2E | KERNELIZED |
| P1 | Yulls ledger credit/debit | domain caller access | idempotency key and ledger transaction | `yullsService` tests | CANONICAL_EXISTING |
| P1 | Inventory/redemption/title changes | player/admin service access | receipts and transactions | possession/title services tests | CANONICAL_EXISTING |
| P1 | PH adjustment/spend | command/admin policy | PH ledger transaction | `phService` tests | CANONICAL_EXISTING |
| P1 | Admin operation apply/undo | canonical administrative controls | operation state/audit transaction | admin operation service tests | CANONICAL_EXISTING |
| P1 | Active profile/onboarding confirmation | current command actor | owner-aware active-character writes | `profileForms`; active lifecycle semantics | DEFERRED_WITH_REASON |
| P1 | Operational player reset/restore | explicit operator tooling | backup/restore controls | `playerResetService`; not pre-reset | DEFERRED_WITH_REASON |
| P1 | Real PH conversion, catalogue, capacity/refund/eligibility | product policy | disabled; no production mutation | D-01..D-09 manifest | PRODUCT_DECISION_REQUIRED |

For every kernelized operation, the HTTP boundary supplies canonical actor,
authorization/mode policy, validation, exclusive serialization, canonical
service transaction, idempotency and its ledger/audit evidence. Rollback,
revision conflict, duplicate and concurrent-spend evidence lives in
`preResetSiteApiE2E.test.js`.
