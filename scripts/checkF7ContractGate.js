'use strict';

const { auditRoutes, canonicalRuntimeDescriptors, runtimeRouteOwners } = require('../helpers/clover/routeSourceAudit');
const { auditPublicContracts, normalizedContractBaseline } = require('../helpers/clover/siteApiContractAudit');
const { CRITICAL_SCHEMA_FIXTURES, FAMILY_SCHEMA_FIXTURES, validateContractPayload } = require('../helpers/clover/siteApiContractShapes');

function count(values) { return values.length; }
function main() {
    const descriptors = canonicalRuntimeDescriptors();
    const audit = auditPublicContracts(descriptors);
    const fixtures = [...CRITICAL_SCHEMA_FIXTURES, ...FAMILY_SCHEMA_FIXTURES];
    const invalidFixtures = fixtures.filter((fixture) => !validateContractPayload(fixture.contractId, 'response', fixture.response, audit.registry).ok);
    const failures = [
        audit.unresolvedPublicContractShapes, audit.opaqueDtoLabelsCritical, audit.stalePublicContracts, audit.unreachablePublicDescriptors,
        audit.sourceOnlyPublicRoutes, audit.publicDuplicateMethodPaths, audit.shadowedPublicLeaks,
        audit.genericMethodDescriptors, audit.genericHandlerOwnerDescriptors, audit.handlerOwnerDrift, audit.authContractDrift, audit.routeProbeFailures,
        auditRoutes().unclassified, invalidFixtures,
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
        UNRESOLVED_PUBLIC_CONTRACT_SHAPES: count(audit.unresolvedPublicContractShapes),
        OPAQUE_DTO_LABELS_CRITICAL: count(audit.opaqueDtoLabelsCritical),
        RUNTIME_ROUTE_PROBE: audit.routeProbeFailures.length ? 'FAIL' : 'PASS',
        SCHEMA_FIXTURE_VALIDATION: invalidFixtures.length ? 'FAIL' : 'PASS',
        CRITICAL_SCHEMA_FIXTURES_TOTAL: CRITICAL_SCHEMA_FIXTURES.length,
        CRITICAL_SCHEMA_FIXTURES_VALIDATED: CRITICAL_SCHEMA_FIXTURES.length - invalidFixtures.filter((fixture) => CRITICAL_SCHEMA_FIXTURES.includes(fixture)).length,
        FAMILY_SCHEMA_FIXTURES_TOTAL: FAMILY_SCHEMA_FIXTURES.length,
        FAMILY_SCHEMA_FIXTURES_VALIDATED: FAMILY_SCHEMA_FIXTURES.length - invalidFixtures.filter((fixture) => FAMILY_SCHEMA_FIXTURES.includes(fixture)).length,
        CONTRACT_BASELINE_ENTRIES: normalizedContractBaseline(descriptors, audit.registry).length,
        F7_CONTRACT_GATE: failures ? 'FAIL' : 'PASS',
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (failures) process.exitCode = 1;
}

main();
