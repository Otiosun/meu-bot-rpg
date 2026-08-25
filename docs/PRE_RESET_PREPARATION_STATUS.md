# PRE-RESET — preparation status

This checkpoint prepares the future pre-reset systems without launching them.

## Canonical current state

- `PRE_RESET_SYSTEM_PREPARED`: target of the preparation gate.
- `PRODUCT_DECISIONS_RESOLVED`: **NO**. D01-D09 remain explicitly `UNRESOLVED`.
- `PRE_RESET_LAUNCH_ENABLED`: OFF by default; only exact literal `true` is accepted.
- Player-functional `/pre-reset/*` reads and mutations are locked while OFF.
- `/pre-reset/status` remains authenticated status-only inspection.
- Production policy compilation is forbidden in this foundation.
- Synthetic approved decisions live only under `tests/fixtures/` and compile only as `testOnly`.
- Frontend remains external to this repository.
- `PRE_RESET_LAUNCH_READY`: **NO**.

## D01-D09 technical support matrix

| Decision | Current technical support |
| --- | --- |
| D01 conversion formula/source | PARTIALLY_SUPPORTED — rational rate exists; current runtime source is available PH |
| D02 cutoff | PARTIALLY_SUPPORTED — provenance field exists; PH snapshot is not cutoff-filtered yet |
| D03 reset cycle/version | SUPPORTED_NOW |
| D04 rounding | SUPPORTED_NOW |
| D05 PH consumption | PARTIALLY_SUPPORTED — test-only `none`; real consumption remains forbidden |
| D06 catalog/prices | SUPPORTED_NOW for server-authoritative simple catalog |
| D07 limited capacity/limits | REQUIRES_FUTURE_IMPLEMENTATION for global/product limits |
| D08 refunds | REQUIRES_FUTURE_IMPLEMENTATION |
| D09 session eligibility | PARTIALLY_SUPPORTED — canonical released-session eligibility exists; extra criteria remain product-defined |

## Future activation sequence

1. Approve D01-D09 explicitly.
2. Replace `UNRESOLVED` entries with approved canonical values.
3. Re-run the support matrix and implement only semantics selected by the approved decisions that remain unsupported.
4. Connect the external frontend.
5. Run the preparation gate and the true launch gate.
6. Only after explicit authorization, add/enable production policy compilation and set the launch switch.

Preparation PASS is not launch PASS.
