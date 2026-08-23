'use strict';

const fs = require('fs');
const path = require('path');
const { RUNTIME_DESCRIPTOR_GROUPS } = require('./siteApiContractRegistry');

const ROOT = path.resolve(__dirname, '..', '..');
const ROUTER_FILES = Object.freeze([
    'helpers/clover/siteApiServer.js',
    'helpers/clover/siteApiServerLegacy.js',
]);
const ROUTE_LITERAL = /['`](\/(?:[A-Za-z0-9_\-:{}*]+\/?)*)['`]/g;
const PUBLIC_ERROR_SCHEMA = Object.freeze({ type: 'object', required: ['ok', 'error', 'message'], properties: { ok: 'boolean', error: 'string', message: 'string' } });
const PUBLIC_RESPONSE_SCHEMA = Object.freeze({ type: 'object', required: ['ok'], properties: { ok: 'boolean' } });

function normalize(value) { return String(value); }

function canonicalRuntimeDescriptors() {
    return Object.freeze(RUNTIME_DESCRIPTOR_GROUPS.flat().slice());
}

function discoveredRoutes(files = null) {
    if (!files) return canonicalRuntimeDescriptors().map((descriptor) => descriptor.template).sort();
    return [...new Set(files.flatMap((file) => [...fs.readFileSync(file, 'utf8').matchAll(ROUTE_LITERAL)]
        .map((match) => normalize(match[1]))
        .filter((route) => route.length > 1)))].sort();
}

function auditRoutes(files = null) {
    const descriptors = canonicalRuntimeDescriptors();
    if (files) {
        const routes = discoveredRoutes(files);
        const registered = descriptors.flatMap((descriptor) => [descriptor.template, descriptor.samplePath]);
        return Object.freeze({
            discovered: routes,
            registered,
            unclassified: routes.filter((route) => !registered.includes(route)),
            stale: [],
            descriptors,
        });
    }
    const missingMetadata = descriptors.filter((descriptor) => !descriptor.id
        || !descriptor.methods?.length || !descriptor.template || !descriptor.samplePath
        || !descriptor.handlerOwner || !descriptor.sourceFile || !descriptor.authClass || !descriptor.contractId);
    return Object.freeze({
        discovered: discoveredRoutes(),
        registered: descriptors.map((descriptor) => descriptor.template),
        unclassified: missingMetadata.map((descriptor) => descriptor.id || descriptor.template),
        stale: [],
        descriptors,
    });
}

module.exports = {
    PUBLIC_ERROR_SCHEMA,
    PUBLIC_RESPONSE_SCHEMA,
    ROUTER_FILES,
    auditRoutes,
    canonicalRuntimeDescriptors,
    discoveredRoutes,
    normalize,
};
