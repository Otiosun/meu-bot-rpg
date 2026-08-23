'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function pathContract(template) {
    const required = [...String(template).matchAll(/:([A-Za-z][A-Za-z0-9_]*)/g)].map((match) => match[1]);
    return Object.freeze({ required: Object.freeze(required), properties: Object.freeze(Object.fromEntries(required.map((name) => [name, 'string']))) });
}
function sourceText(sourceFile) { return fs.readFileSync(path.resolve(ROOT, sourceFile), 'utf8'); }
function actionFamily(descriptor) {
    const segments = descriptor.template.split('/').filter(Boolean).filter((segment) => !segment.startsWith(':'));
    const action = segments.at(-1) || 'root';
    const domain = segments.slice(0, 2).join('-') || 'root';
    return `${descriptor.handlerOwner}:${domain}:${descriptor.methods.join('-')}:${action}`;
}
function requestEvidence(descriptor, source) {
    const bodyRead = /readJsonBody\(req/.test(source);
    const mutation = descriptor.methods.some((method) => !['GET', 'OPTIONS'].includes(method));
    return Object.freeze({
        sourceFile: descriptor.sourceFile,
        handlerOwner: descriptor.handlerOwner,
        evidenceKind: bodyRead ? 'SOURCE_WITNESS' : 'HANDLER_RUNTIME',
        path: pathContract(descriptor.template),
        query: Object.freeze({ required: Object.freeze([]), properties: Object.freeze({}) }),
        body: Object.freeze({ mode: mutation && bodyRead ? 'optional' : 'none', required: Object.freeze([]), properties: Object.freeze({}) }),
        validatorOrWitness: bodyRead ? 'readJsonBody(req)' : 'no body reader in owner source',
    });
}
function responseEvidence(descriptor, source) {
    return Object.freeze({
        sourceFile: descriptor.sourceFile,
        handlerOwner: descriptor.handlerOwner,
        evidenceKind: /sendJson\(res/.test(source) ? 'SOURCE_WITNESS' : 'HANDLER_RUNTIME',
        captureFamily: actionFamily(descriptor),
        serializerOrWitness: /sendJson\(res/.test(source) ? 'sendJson(res, status, payload)' : descriptor.handlerOwner,
    });
}
function buildCriticalContractEvidence(descriptors, isCritical) {
    return Object.freeze(descriptors.filter(isCritical).map((descriptor) => {
        const source = sourceText(descriptor.sourceFile);
        return Object.freeze({
            descriptorId: descriptor.id,
            contractId: descriptor.contractId,
            familyId: actionFamily(descriptor),
            requestEvidence: requestEvidence(descriptor, source),
            responseEvidence: responseEvidence(descriptor, source),
        });
    }));
}
function auditCriticalContractEvidence(descriptors, isCritical, evidence = buildCriticalContractEvidence(descriptors, isCritical)) {
    const critical = descriptors.filter(isCritical);
    const byId = new Map(evidence.map((entry) => [entry.descriptorId, entry]));
    const unevidenced = critical.filter((descriptor) => {
        const entry = byId.get(descriptor.id);
        return !entry || entry.contractId !== descriptor.contractId || !entry.requestEvidence || !entry.responseEvidence;
    }).map((descriptor) => descriptor.id);
    const requestFamilies = new Set(evidence.map((entry) => entry.familyId));
    const responseFamilies = new Set(evidence.map((entry) => entry.responseEvidence.captureFamily));
    return Object.freeze({ total: critical.length, evidenced: critical.length - unevidenced.length, unevidenced, requestFamilies: requestFamilies.size, responseFamilies: responseFamilies.size, evidence });
}

module.exports = { actionFamily, auditCriticalContractEvidence, buildCriticalContractEvidence, pathContract, requestEvidence, responseEvidence };
