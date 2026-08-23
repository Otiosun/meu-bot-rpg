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
const LOCAL_REQUIRE = /require\(['"](\.\/[^'"]+)['"]\)/g;
const PUBLIC_ERROR_SCHEMA = Object.freeze({ type: 'object', required: ['ok', 'error', 'message'], properties: { ok: 'boolean', error: 'string', message: 'string' } });
const PUBLIC_RESPONSE_SCHEMA = Object.freeze({ type: 'object', required: ['ok'], properties: { ok: 'boolean' } });

function normalize(value) { return String(value); }

function canonicalRuntimeDescriptors() {
    return Object.freeze(RUNTIME_DESCRIPTOR_GROUPS.flat().slice());
}

function localModulePath(parentFile, request) {
    const resolved = path.resolve(path.dirname(parentFile), request);
    return fs.existsSync(`${resolved}.js`) ? `${resolved}.js` : fs.existsSync(resolved) ? resolved : null;
}

function reachableRuntimeFiles(entries = ROUTER_FILES.map((file) => path.join(ROOT, file))) {
    const pending = [...entries];
    const seen = new Set();
    while (pending.length) {
        const file = pending.pop();
        if (!file || seen.has(file) || !fs.existsSync(file)) continue;
        seen.add(file);
        const source = fs.readFileSync(file, 'utf8');
        for (const match of source.matchAll(LOCAL_REQUIRE)) pending.push(localModulePath(file, match[1]));
    }
    return [...seen].sort();
}

function runtimeRouteOwners(entries) {
    return reachableRuntimeFiles(entries).filter((file) => {
        const source = fs.readFileSync(file, 'utf8');
        return /new URL\(req\.url|safeRequestPath\(req\)|\.pathname\.match\(/.test(source);
    });
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
    const descriptorFiles = new Set(descriptors.map((descriptor) => path.resolve(ROOT, descriptor.sourceFile)));
    const owners = runtimeRouteOwners();
    const unclassifiedOwners = owners.filter((file) => !descriptorFiles.has(file));
    return Object.freeze({
        discovered: discoveredRoutes(),
        registered: descriptors.map((descriptor) => descriptor.template),
        unclassified: [
            ...missingMetadata.map((descriptor) => descriptor.id || descriptor.template),
            ...unclassifiedOwners.map((file) => path.relative(ROOT, file).replaceAll('\\', '/')),
        ].sort(),
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
    reachableRuntimeFiles,
    runtimeRouteOwners,
    normalize,
};
