'use strict';

const { getHookTemplate } = require('./adminHookService');

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function approvedTemplatePayload(action = {}, after = {}) {
    return {
        ...(action.payload || {}),
        canonicalKey: after.canonicalKey,
        name: after.name,
        description: after.description,
        objectiveText: after.objectiveText,
        completionText: after.completionText,
        category: after.category,
        metadata: after.metadata || {},
    };
}

function approvedAssignmentPayload(action = {}, after = {}) {
    return {
        ...(action.payload || {}),
        title: after.title,
        body: after.body,
        developmentText: after.developmentText,
        privateNotes: after.privateNotes,
        priority: after.priority,
        metadata: after.metadata || {},
    };
}

function hardenHookV2Executors(executors = {}) {
    const result = { ...executors };

    const create = result['catalog.hook.create'];
    if (create) {
        result['catalog.hook.create'] = {
            ...create,
            async apply(context) {
                return create.apply({
                    ...context,
                    action: {
                        ...context.action,
                        payload: approvedTemplatePayload(context.action, context.after),
                    },
                });
            },
        };
    }

    const update = result['catalog.hook.update'];
    if (update) {
        result['catalog.hook.update'] = {
            ...update,
            async preview(context) {
                const metadata = context.action?.payload?.metadata;
                if (isPlainObject(metadata) && !isPlainObject(metadata.hookV2)) {
                    const current = await getHookTemplate(
                        context.db,
                        context.action.payload?.hookId || context.action.payload?.id
                    );
                    context.action.payload = {
                        ...(context.action.payload || {}),
                        metadata: { ...(current.metadata || {}), ...metadata },
                    };
                }
                return update.preview(context);
            },
        };
    }

    const assign = result['player.hook.assign'];
    if (assign) {
        result['player.hook.assign'] = {
            ...assign,
            async apply(context) {
                return assign.apply({
                    ...context,
                    action: {
                        ...context.action,
                        payload: approvedAssignmentPayload(context.action, context.after),
                    },
                });
            },
        };
    }

    return result;
}

module.exports = {
    approvedAssignmentPayload,
    approvedTemplatePayload,
    hardenHookV2Executors,
};
