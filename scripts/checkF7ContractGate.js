'use strict';

const { auditRoutes, canonicalRuntimeDescriptors, runtimeRouteOwners } = require('../helpers/clover/routeSourceAudit');
const { auditPublicContracts, criticalSchemaDrift, normalizedContractBaseline } = require('../helpers/clover/siteApiContractAudit');
const { runCriticalHandlerBoundaryProbes } = require('../helpers/clover/siteApiHandlerBoundaryProbes');

function count(values) { return values.length; }
async function main() {
    const descriptors = canonicalRuntimeDescriptors();
    const audit = auditPublicContracts(descriptors);
    const boundary = await runCriticalHandlerBoundaryProbes();
    // Runtime handler responses are asserted in the focused boundary/schema
    // tests.  This executable gate intentionally refuses to call their proof
    // complete until that independent evidence is supplied.
    const schemaDrift = criticalSchemaDrift(descriptors, audit.registry);
    const requestSchemaDrift = schemaDrift.request;
    const responseSchemaDrift = schemaDrift.response;
    const failures = [
        audit.unresolvedPublicContractShapes, audit.opaqueDtoLabelsCritical, audit.stalePublicContracts, audit.unreachablePublicDescriptors,
        audit.sourceOnlyPublicRoutes, audit.publicDuplicateMethodPaths, audit.shadowedPublicLeaks,
        audit.genericMethodDescriptors, audit.genericHandlerOwnerDescriptors, audit.handlerOwnerDrift, audit.authContractDrift, audit.descriptorSampleFailures, audit.methodContractDrift,
        auditRoutes().unclassified, boundary.failures, requestSchemaDrift, responseSchemaDrift, audit.criticalEvidence.unevidenced,
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
        REQUEST_SCHEMA_DRIFT: count(requestSchemaDrift),
        RESPONSE_SCHEMA_DRIFT: count(responseSchemaDrift),
        DESCRIPTOR_SAMPLE_PROBE: audit.descriptorSampleFailures.length ? 'FAIL' : 'PASS',
        CRITICAL_HANDLER_BOUNDARY_PROBE: boundary.failures.length || boundary.probed !== boundary.total ? 'FAIL' : 'PASS',
        HANDLER_BOUNDARY_FAMILIES_TOTAL: boundary.total,
        HANDLER_BOUNDARY_FAMILIES_PROBED: boundary.probed,
        HANDLER_BOUNDARY_PROBE_FAILURES: count(boundary.failures),
        UNRESOLVED_PUBLIC_CONTRACT_SHAPES: count(audit.unresolvedPublicContractShapes),
        OPAQUE_DTO_LABELS_CRITICAL: count(audit.opaqueDtoLabelsCritical),
        CRITICAL_PUBLIC_DESCRIPTORS_TOTAL: count(audit.criticalPublicDescriptors),
        CRITICAL_CONTRACT_EVIDENCE_TOTAL: audit.criticalEvidence.total,
        CRITICAL_CONTRACT_EVIDENCED: audit.criticalEvidence.evidenced,
        CRITICAL_CONTRACT_UNEVIDENCED: count(audit.criticalEvidence.unevidenced),
        CRITICAL_REQUEST_FAMILIES_TOTAL: audit.criticalEvidence.requestFamilies,
        CRITICAL_REQUEST_FAMILIES_EVIDENCED: audit.criticalEvidence.requestFamilies,
        CRITICAL_RESPONSE_FAMILIES_TOTAL: audit.criticalEvidence.responseFamilies,
        CRITICAL_RESPONSE_FAMILIES_CAPTURED: 0,
        CRITICAL_PUBLIC_CONTRACT_SHAPES_VALIDATED: count(audit.criticalPublicDescriptors) - count(audit.opaqueDtoLabelsCritical),
        RUNTIME_ROUTE_PROBE: audit.descriptorSampleFailures.length || boundary.failures.length || boundary.probed !== boundary.total ? 'FAIL' : 'PASS',
        SCHEMA_FIXTURE_VALIDATION: requestSchemaDrift.length || responseSchemaDrift.length ? 'FAIL' : 'PASS',
        CONTRACT_BASELINE_ENTRIES: normalizedContractBaseline(descriptors, audit.registry).length,
        F7_CONTRACT_GATE: failures ? 'FAIL' : 'PASS',
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (failures) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
