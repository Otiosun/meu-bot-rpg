'use strict';

function routeDescriptor({ id, methods, template, samplePath, match, handlerOwner, sourceFile, visibility = 'PUBLIC_CONTRACT', authClass, contractId, contractShapeId }) {
    if (!id || !Array.isArray(methods) || !methods.length || !template || !samplePath || typeof match !== 'function' || !handlerOwner || !sourceFile) {
        throw new Error('Invalid HTTP route descriptor.');
    }
    return Object.freeze({ id, methods: Object.freeze([...methods]), template, samplePath, match, handlerOwner, sourceFile, visibility, authClass, contractId, contractShapeId: contractShapeId || contractId });
}

function matchDescriptor(descriptors, method, pathname) {
    const normalizedMethod = String(method || '').toUpperCase();
    return descriptors.find((descriptor) => descriptor.methods.includes(normalizedMethod) && descriptor.match(pathname)) || null;
}

module.exports = { matchDescriptor, routeDescriptor };
