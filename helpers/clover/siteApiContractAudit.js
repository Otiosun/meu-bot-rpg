'use strict';

const fs = require('fs');
const path = require('path');
const { matchDescriptor } = require('./httpRouteDescriptor');
const { buildContractShapeRegistry, resolveContractShape } = require('./siteApiContractShapes');
const { auditCriticalContractEvidence } = require('./siteApiCriticalContractEvidence');

const ROOT = path.resolve(__dirname, '..', '..');
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const AUTH_CLASSES = /^(PUBLIC_SAFE|PUBLIC_AUTH_ENTRY|PUBLIC|OWNER|SITE_SESSION(?:[_:].*)?|ADMIN_CAPABILITY(?::.*)?(?:;REVIEW_ROLE)?|SITE_SESSION_CAPABILITY)$/;

function publicDescriptors(descriptors) { return descriptors.filter((descriptor) => descriptor.visibility === 'PUBLIC_CONTRACT'); }
function isCriticalPublicDescriptor(descriptor) {
    if (descriptor.visibility !== 'PUBLIC_CONTRACT') return false;
    if (descriptor.id === 'site.routePublic.post.auth.login' || descriptor.id === 'site.routeAuthed.post.auth.logout') return true;
    if (descriptor.methods.some((method) => !['GET', 'OPTIONS'].includes(method))) return true;
    return /^admin\.|^raid\.|^skill\.|^squad\.|^prereset\.(future-character|return-points|conversion|shop)/.test(descriptor.id);
}
function routeKey(descriptor) { return descriptor.methods.map((method) => `${method} ${descriptor.template}`); }

function sourceFor(descriptor) { return path.resolve(ROOT, descriptor.sourceFile); }
function ownerExists(descriptor) {
    const file = sourceFor(descriptor);
    if (!fs.existsSync(file)) return false;
    const source = fs.readFileSync(file, 'utf8');
    const name = descriptor.handlerOwner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:function|class|const|let|var)\\s+${name}\\b|\\b${name}\\s*[:,]`).test(source);
}

function baseSourceWitnesses(source) {
    return source.split(/\r?\n/).flatMap((line, index) => {
        const match = line.match(/\bif \((.*)\) \{/);
        if (!match || !match[1].includes("method === '")) return [];
        const methods = [...match[1].matchAll(/method === '([A-Z]+)'/g)].map((entry) => entry[1]);
        const literalMatches = [...match[1].matchAll(/parts\[(\d+)\] === '([^']+)'/g)].map((entry) => ({ index: Number(entry[1]), value: entry[2] }));
        const alternatives = [...new Set(literalMatches.map(({ index: partIndex }) => partIndex))].map((partIndex) => literalMatches.filter((entry) => entry.index === partIndex));
        const length = match[1].match(/parts\.length === (\d+)/);
        const literalSets = alternatives.reduce((sets, choices) => sets.flatMap((set) => choices.map((choice) => [...set, choice])), [[]]);
        return methods.flatMap((method) => literalSets.map((literals) => Object.freeze({ method, literals, length: length ? Number(length[1]) : null, line: index + 1, condition: match[1] })));
    });
}

function baseWitnessMatches(descriptor, witness) {
    if (!descriptor.methods.includes(witness.method)) return false;
    const parts = descriptor.template.split('/').filter(Boolean);
    if (witness.length !== null && witness.length !== parts.length) return false;
    if (!witness.literals.length) return parts.length === 0 && witness.length === 0;
    return witness.literals.every(({ index, value }) => parts[index] === value);
}

function witnessTemplate(witness) {
    if (witness.length === null || witness.literals.some(({ index }) => index >= witness.length)) return null;
    const byIndex = new Map(witness.literals.map(({ index, value }) => [index, value]));
    if (byIndex.size !== witness.literals.length) return null; // alternatives need an explicit descriptor witness
    return `/${Array.from({ length: witness.length }, (_, index) => byIndex.get(index) || ':value').join('/')}`;
}

function normalizedTemplate(template) { return template.replace(/:[^/]+/g, ':value'); }

function baseRouteAudit(descriptors, source) {
    const witnesses = baseSourceWitnesses(source);
    const base = descriptors.filter((descriptor) => descriptor.sourceFile === 'helpers/clover/siteApiServerBase.js');
    const nestedContexts = new Set();
    if (source.includes("if (parts[0] === 'raids')")) nestedContexts.add('raids');
    if (source.includes("if (parts[0] === 'trees' && parts[1])")) nestedContexts.add('trees');
    const hasBaseWitness = (descriptor) => witnesses.some((witness) => baseWitnessMatches(descriptor, witness))
        || (nestedContexts.has(descriptor.template.split('/')[1]) && witnesses.some((witness) => (
            descriptor.methods.includes(witness.method) && witness.literals.length === 0 && witness.length === descriptor.template.split('/').filter(Boolean).length
        )));
    const unreachable = base.filter((descriptor) => !hasBaseWitness(descriptor)).map((descriptor) => descriptor.id);
    const sourceOnly = witnesses.filter((witness) => witness.literals.some(({ index }) => index === 0))
        .map((witness) => ({ method: witness.method, template: witnessTemplate(witness), line: witness.line }))
        .filter((witness) => witness.template && !base.some((descriptor) => descriptor.methods.includes(witness.method) && normalizedTemplate(descriptor.template) === witness.template));
    return Object.freeze({ witnesses, unreachable, sourceOnly });
}

function auditPublicContracts(descriptors, options = {}) {
    const publicRoutes = publicDescriptors(descriptors);
    const registry = options.registry || buildContractShapeRegistry(publicRoutes.map((descriptor) => descriptor.contractId));
    const duplicateKeys = publicRoutes.flatMap(routeKey).filter((key, index, all) => all.indexOf(key) !== index);
    const shadowedLeaks = descriptors.filter((descriptor) => descriptor.visibility === 'INTERNAL_COMPAT_SHADOWED' && publicRoutes.includes(descriptor)).map((descriptor) => descriptor.id);
    const unresolved = publicRoutes.filter((descriptor) => !resolveContractShape(descriptor.contractId, registry)).map((descriptor) => descriptor.id);
    const criticalPublicDescriptors = publicRoutes.filter(isCriticalPublicDescriptor);
    const criticalEvidence = auditCriticalContractEvidence(publicRoutes, isCriticalPublicDescriptor, options.evidence, {
        captures: options.captures,
        registry,
    });
    const opaqueCritical = criticalPublicDescriptors.filter((descriptor) => {
        const shape = resolveContractShape(descriptor.contractId, registry);
        return !shape || shape.broad === true || (shape.response.required.length === 1 && shape.response.required[0] === 'ok' && !shape.response.atLeastOne?.length);
    }).map((descriptor) => descriptor.id);
    const genericMethods = publicRoutes.filter((descriptor) => descriptor.methods.some((method) => !HTTP_METHODS.has(method))).map((descriptor) => descriptor.id);
    const ownerDrift = publicRoutes.filter((descriptor) => !ownerExists(descriptor)).map((descriptor) => descriptor.id);
    const authDrift = publicRoutes.filter((descriptor) => !AUTH_CLASSES.test(descriptor.authClass || '')).map((descriptor) => descriptor.id);
    const baseFile = path.join(ROOT, 'helpers/clover/siteApiServerBase.js');
    const base = baseRouteAudit(descriptors, options.baseSource === undefined ? fs.readFileSync(baseFile, 'utf8') : options.baseSource);
    const descriptorSampleFailures = publicRoutes.filter((descriptor) => descriptor.methods.some((method) => !matchDescriptor(publicRoutes, method, descriptor.samplePath))).map((descriptor) => descriptor.id);
    const methodContractDrift = base.unreachable.slice();
    return Object.freeze({
        registry,
        publicRoutes,
        criticalPublicDescriptors,
        criticalEvidence,
        baseWitnesses: base.witnesses,
        stalePublicContracts: base.sourceOnly.map((witness) => `${witness.method} ${witness.template}`),
        sourceOnlyPublicRoutes: base.sourceOnly,
        unreachablePublicDescriptors: base.unreachable,
        publicDuplicateMethodPaths: [...new Set(duplicateKeys)].sort(),
        shadowedPublicLeaks: shadowedLeaks,
        genericMethodDescriptors: genericMethods,
        genericHandlerOwnerDescriptors: publicRoutes.filter((descriptor) => !descriptor.handlerOwner || /^(handler|route)$/i.test(descriptor.handlerOwner)).map((descriptor) => descriptor.id),
        handlerOwnerDrift: ownerDrift,
        authContractDrift: authDrift,
        unresolvedPublicContractShapes: unresolved,
        opaqueDtoLabelsCritical: opaqueCritical,
        descriptorSampleFailures,
        methodContractDrift,
    });
}

function criticalSchemaDrift(descriptors, registry) {
    const critical = publicDescriptors(descriptors).filter(isCriticalPublicDescriptor);
    const request = [];
    const response = [];
    for (const descriptor of critical) {
        const shape = resolveContractShape(descriptor.contractId, registry);
        if (!shape || shape.broad || (descriptor.methods.some((method) => !['GET', 'OPTIONS'].includes(method)) && !shape.request.required.length)) request.push(descriptor.id);
        if (!shape || shape.broad || (shape.response.required.length === 1 && shape.response.required[0] === 'ok' && !shape.response.atLeastOne?.length)) response.push(descriptor.id);
    }
    return Object.freeze({ request: Object.freeze(request), response: Object.freeze(response) });
}

function normalizedContractBaseline(descriptors, registry) {
    return Object.freeze(publicDescriptors(descriptors).flatMap((descriptor) => descriptor.methods.map((method) => {
        const shape = resolveContractShape(descriptor.contractId, registry);
        return Object.freeze({ descriptorId: descriptor.id, method, template: descriptor.template, authClass: descriptor.authClass, contractId: descriptor.contractId, requiredRequest: shape?.request.required || [], requiredResponse: shape?.response.required || [], oneOfResponse: shape?.response.atLeastOne || [], responseTypes: shape?.response.properties || {}, visibility: descriptor.visibility });
    })).sort((a, b) => `${a.method} ${a.template}`.localeCompare(`${b.method} ${b.template}`)));
}

function compareContractBaselines(before, after) {
    const byId = new Map(after.map((entry) => [`${entry.descriptorId}:${entry.method}`, entry]));
    const breaking = [];
    for (const prior of before) {
        const current = byId.get(`${prior.descriptorId}:${prior.method}`);
        if (!current || current.template !== prior.template || current.authClass !== prior.authClass || current.contractId !== prior.contractId) { breaking.push(prior.descriptorId); continue; }
        for (const field of prior.requiredResponse) if (!current.requiredResponse.includes(field) || current.responseTypes[field] !== prior.responseTypes[field]) breaking.push(prior.descriptorId);
        for (const field of prior.oneOfResponse || []) if (!(current.oneOfResponse || []).includes(field)) breaking.push(prior.descriptorId);
    }
    return Object.freeze([...new Set(breaking)].sort());
}

module.exports = { auditPublicContracts, baseRouteAudit, baseSourceWitnesses, baseWitnessMatches, compareContractBaselines, criticalSchemaDrift, isCriticalPublicDescriptor, normalizedContractBaseline, ownerExists, publicDescriptors };
