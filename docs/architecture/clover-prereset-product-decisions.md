# Clover pre-reset product decisions

Status: this manifest records the decisions still required before any
pre-reset feature can be enabled. The P2 policy registry defaults every item to
`NOT_CONFIGURED`; synthetic test policies are not product configuration.

## D-01 — PH conversion formula

- STATUS: PRODUCT_DECISION_REQUIRED
- EVIDENCE: PH has an append-only canonical ledger, but no approved conversion formula.
- OPTIONS: fixed rate, tiered rate, or no conversion.
- IMPACT: Return Points credit amount.
- DEFAULT_SAFE_BEHAVIOR: conversion disabled; no ledger write.

## D-02 — Conversion cutoff

- STATUS: PRODUCT_DECISION_REQUIRED
- EVIDENCE: no historical cutoff defines eligible PH entries.
- OPTIONS: timestamp, event boundary, or no cutoff.
- IMPACT: source provenance and replay.
- DEFAULT_SAFE_BEHAVIOR: conversion disabled.

## D-03 — Reset cycle/version

- STATUS: PRODUCT_DECISION_REQUIRED
- EVIDENCE: reset tooling is operational lifecycle tooling, not a published pre-reset cycle.
- OPTIONS: named cycle/version with immutable boundary.
- IMPACT: claim idempotency scope.
- DEFAULT_SAFE_BEHAVIOR: no cycle and no claim.

## D-04 — Rounding

- STATUS: PRODUCT_DECISION_REQUIRED
- EVIDENCE: no approved rounding semantics exist.
- OPTIONS: floor, ceiling, nearest, or exact integer policy.
- IMPACT: Return Points amount.
- DEFAULT_SAFE_BEHAVIOR: conversion disabled.

## D-05 — PH consumption

- STATUS: PRODUCT_DECISION_REQUIRED
- EVIDENCE: PH spenders are separate; no pre-reset consumption authorization exists.
- OPTIONS: snapshot-only or atomic consumption.
- IMPACT: PH ledger and reversibility.
- DEFAULT_SAFE_BEHAVIOR: never consume PH.

## D-06 — Shop catalogue and prices

- STATUS: PRODUCT_DECISION_REQUIRED
- EVIDENCE: no approved pre-reset catalogue or price list exists.
- OPTIONS: versioned server catalogue.
- IMPACT: Return Points debit and future entitlement.
- DEFAULT_SAFE_BEHAVIOR: empty shop; purchase disabled.

## D-07 — Limited choices/capacity

- STATUS: PRODUCT_DECISION_REQUIRED
- EVIDENCE: no capacity policy is assigned to future choices.
- OPTIONS: reservation, queue, or unlimited policy.
- IMPACT: entitlement availability.
- DEFAULT_SAFE_BEHAVIOR: no capacity reservation or limited-choice sale.

## D-08 — Refund

- STATUS: PRODUCT_DECISION_REQUIRED
- EVIDENCE: no cancellation/refund semantics are approved.
- OPTIONS: no refund, bounded refund, or review workflow.
- IMPACT: immutable Return Points counter-entry and entitlement revocation.
- DEFAULT_SAFE_BEHAVIOR: refunds disabled.

## D-09 — Pre-reset session eligibility

- STATUS: PRODUCT_DECISION_REQUIRED
- EVIDENCE: current site sessions only authenticate released players; that is not proof of pre-reset eligibility.
- OPTIONS: a separately approved eligibility policy.
- IMPACT: who may create or mutate a future character.
- DEFAULT_SAFE_BEHAVIOR: deny mutations unless an explicit eligibility policy is configured.
