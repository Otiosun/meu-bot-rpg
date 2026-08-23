# Clover F5 operation kernel

`operationKernelService.runOperationKernel` is a small composition boundary, not
a replacement session framework or a generic domain engine.

```
authenticated canonical actor
  -> authorization / mode-policy closure
  -> validation closure
  -> runEconomyMutationExclusive
  -> canonical domain service
  -> service-owned idempotency + BEGIN IMMEDIATE + ledger/audit
  -> public DTO or closed HTTP error map
```

The HTTP boundary remains responsible for Site-session authentication. The
kernel only accepts an already authenticated actor and refuses a missing actor.
It does not conceal business semantics: each adopted route passes explicit
authorization, validation and mutation closures.

| Adopted operation | Canonical service keeps | Kernel adds |
| --- | --- | --- |
| Future character create/update/submit | revision, operation receipt, transaction | actor, ownership/mode policy, serialization |
| Return Point conversion claim | deterministic claim, ledger provenance, transaction | actor, policy/ownership, serialization |
| Pre-reset purchase | debit + entitlement atomic transaction | actor, policy/ownership, serialization |
| Admin review/approve/lock | review receipt, revision transition, transaction | canonical RBAC, mode policy, serialization |

`skillApprovalHttp` was investigated as a non-pre-reset representative. It is
already a mature canonical HTTP adapter with its own access resolver,
idempotent tree/pending-approval semantics and exclusive mutation runner. A
mechanical migration would duplicate or reorder its authorization semantics;
therefore **NON_PRERESET_REPRESENTATIVE_ADOPTION=DEFERRED_SAFE**. This is a
documented exclusion, not an unclassified critical operation.
