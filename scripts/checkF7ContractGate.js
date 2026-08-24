'use strict';

const { auditRoutes, auditEvidenceOnlyRuntimeImports, canonicalRuntimeDescriptors, runtimeRouteOwners } = require('../helpers/clover/routeSourceAudit');
const { auditPublicContracts, criticalSchemaDrift, normalizedContractBaseline } = require('../helpers/clover/siteApiContractAudit');
const { runCriticalHandlerBoundaryProbes } = require('../helpers/clover/siteApiHandlerBoundaryProbes');

function count(values) { return values.length; }
async function main() {
    const descriptors = canonicalRuntimeDescriptors();
    const boundary = await runCriticalHandlerBoundaryProbes({
        onProgress: ({ stage, status, captures, total, probed }) => {
            const detail = captures !== undefined ? ` captures=${captures}` : total !== undefined ? ` total=${total} probed=${probed}` : '';
            process.stderr.write(`[F7_PROGRESS] ${status} ${stage}${detail}\n`);
        },
    });
    const audit = auditPublicContracts(descriptors, { captures: boundary.captures });
    const criticalCaptures = boundary.captures.filter((probe) => probe.descriptorId && audit.criticalEvidence.proven.includes(probe.descriptorId));
    // Runtime handler responses are asserted in the focused boundary/schema
    // tests.  This executable gate intentionally refuses to call their proof
    // complete until that independent evidence is supplied.
    const schemaDrift = criticalSchemaDrift(descriptors, audit.registry);
    const requestSchemaDrift = schemaDrift.request;
    const responseSchemaDrift = schemaDrift.response;
    const evidenceOnlyRuntimeImports = auditEvidenceOnlyRuntimeImports();
    const methodContractIncomplete = audit.criticalEvidence.methodContractIncomplete;
    const failures = [
        audit.unresolvedPublicContractShapes, audit.opaqueDtoLabelsCritical, audit.stalePublicContracts, audit.unreachablePublicDescriptors,
        audit.sourceOnlyPublicRoutes, audit.publicDuplicateMethodPaths, audit.shadowedPublicLeaks,
        audit.genericMethodDescriptors, audit.genericHandlerOwnerDescriptors, audit.handlerOwnerDrift, audit.authContractDrift, audit.descriptorSampleFailures, audit.methodContractDrift, methodContractIncomplete,
        auditRoutes().unclassified, boundary.failures, requestSchemaDrift, responseSchemaDrift, evidenceOnlyRuntimeImports, audit.criticalEvidence.unevidenced,
    ].some((entry) => entry.length);
    const result = Object.freeze({
        ROUTE_OWNERS_TOTAL: runtimeRouteOwners().length,
        RUNTIME_DESCRIPTORS_TOTAL: descriptors.length,
        PUBLIC_DESCRIPTORS_TOTAL: audit.publicRoutes.length,
        UNCLASSIFIED_RUNTIME_ROUTES: count(auditRoutes().unclassified),
        STALE_PUBLIC_CONTRACTS: count(audit.stalePublicContracts),
        UNREACHABLE_PUBLIC_DESCRIPTORS: count(audit.unreachablePublicDescriptors),
        PUBLIC_DUPLICATE_METHOD_PATHS: count(audit.publicDuplicateMethodPaths),
        SHADOWED_PUBLIC_LEAKS: count(audit.shadowedPublicLeaks),
        GENERIC_METHOD_DESCRIPTORS: count(audit.genericMethodDescriptors),
        GENERIC_HANDLER_OWNER_DESCRIPTORS: count(audit.genericHandlerOwnerDescriptors),
        HANDLER_OWNER_DRIFT: count(audit.handlerOwnerDrift),
        AUTH_CONTRACT_DRIFT: count(audit.authContractDrift),
        METHOD_CONTRACT_DRIFT: count(audit.methodContractDrift),
        METHOD_CONTRACT_INCOMPLETE: count(methodContractIncomplete),
        REQUEST_SCHEMA_DRIFT: count(requestSchemaDrift),
        RESPONSE_SCHEMA_DRIFT: count(responseSchemaDrift),
        DESCRIPTOR_SAMPLE_PROBE: audit.descriptorSampleFailures.length ? 'FAIL' : 'PASS',
        CRITICAL_HANDLER_BOUNDARY_PROBE: boundary.failures.length || boundary.probed !== boundary.total ? 'FAIL' : 'PASS',
        HANDLER_BOUNDARY_FAMILIES_TOTAL: boundary.total,
        HANDLER_BOUNDARY_FAMILIES_PROBED: boundary.probed,
        HANDLER_BOUNDARY_PROBE_FAILURES: count(boundary.failures),
        PROBE_GROUPS_TOTAL: boundary.schedule.groups,
        PROBE_GROUPS_EXECUTED: boundary.schedule.executed,
        PROBE_GROUPS_MISSING: boundary.schedule.missing.length,
        PROBE_GROUPS_DUPLICATED: boundary.schedule.duplicated.length,
        PROBE_MAX_CONCURRENCY: boundary.schedule.maxConcurrency,
        PROBE_MAX_IN_FLIGHT_OBSERVED: boundary.schedule.maxInFlightObserved,
        PROBE_SERIAL_GROUPS: boundary.schedule.serialGroups,
        PROBE_PARALLEL_SAFE_GROUPS: boundary.schedule.parallelSafeGroups,
        PROBE_TOTAL_WALLCLOCK_MS: boundary.schedule.wallClockMs,
        UNRESOLVED_PUBLIC_CONTRACT_SHAPES: count(audit.unresolvedPublicContractShapes),
        EVIDENCE_ONLY_RUNTIME_IMPORTS: count(evidenceOnlyRuntimeImports),
        OPAQUE_DTO_LABELS_CRITICAL: count(audit.opaqueDtoLabelsCritical),
        CRITICAL_PUBLIC_DESCRIPTORS_TOTAL: count(audit.criticalPublicDescriptors),
        CRITICAL_CONTRACT_EVIDENCE_TOTAL: audit.criticalEvidence.total,
        CRITICAL_CONTRACT_EVIDENCED: audit.criticalEvidence.evidenced,
        CRITICAL_CONTRACT_PROVEN_TOTAL: count(audit.criticalEvidence.proven),
        CRITICAL_CONTRACT_UNPROVEN_TOTAL: count(audit.criticalEvidence.unproven),
        CRITICAL_CONTRACT_UNEVIDENCED: count(audit.criticalEvidence.unevidenced),
        CRITICAL_REQUEST_FAMILIES_TOTAL: audit.criticalEvidence.requestFamilies,
        CRITICAL_REQUEST_FAMILIES_EVIDENCED: audit.criticalEvidence.requestFamiliesEvidenced,
        CRITICAL_RESPONSE_FAMILIES_TOTAL: audit.criticalEvidence.responseFamilies,
        BOUNDARY_SUCCESS_CAPTURES_TOTAL: boundary.captures.length,
        CRITICAL_RESPONSE_FAMILIES_CAPTURED: audit.criticalEvidence.responseFamiliesCaptured,
        CRITICAL_SUCCESS_CAPTURES_TOTAL: criticalCaptures.length,
        CRITICAL_PUBLIC_CONTRACT_SHAPES_VALIDATED: count(audit.criticalPublicDescriptors) - count(audit.opaqueDtoLabelsCritical),
        RUNTIME_ROUTE_PROBE: audit.descriptorSampleFailures.length || boundary.failures.length || boundary.probed !== boundary.total ? 'FAIL' : 'PASS',
        SCHEMA_FIXTURE_VALIDATION: requestSchemaDrift.length || responseSchemaDrift.length ? 'FAIL' : 'PASS',
        CONTRACT_BASELINE_ENTRIES: normalizedContractBaseline(descriptors, audit.registry).length,
        F7_STRUCTURAL_ROUTE_GATE: auditRoutes().unclassified.length || audit.stalePublicContracts.length || audit.unreachablePublicDescriptors.length || audit.publicDuplicateMethodPaths.length || audit.shadowedPublicLeaks.length || audit.genericMethodDescriptors.length || audit.genericHandlerOwnerDescriptors.length || audit.handlerOwnerDrift.length || audit.authContractDrift.length || audit.methodContractDrift.length || methodContractIncomplete.length ? 'FAIL' : 'PASS',
        F7_RUNTIME_CONTRACT_GATE: boundary.failures.length || boundary.probed !== boundary.total || evidenceOnlyRuntimeImports.length || requestSchemaDrift.length || responseSchemaDrift.length || audit.criticalEvidence.unevidenced.length ? 'FAIL' : 'PASS',
        F7_CONTRACT_GATE: failures ? 'FAIL' : 'PASS',
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (failures) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
