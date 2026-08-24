'use strict';

const { createAgentBridgeClient } = require('./chatgptAgentBridgeClient');

function isDeliverableAnswer(item) {
    return Boolean(
        item
        && String(item.id || '').trim()
        && String(item.chat_id || '').trim()
        && String(item.answer || '').trim()
    );
}

async function runAgentAnswerSweep({ sock, env = process.env, fetchImpl = global.fetch, limit = 10 } = {}) {
    if (!sock || typeof sock.sendMessage !== 'function') {
        return { ok: false, skipped: true, reason: 'missing_socket', delivered: 0, failed: 0 };
    }

    const client = createAgentBridgeClient({ env, fetchImpl });
    if (!client.config.enabled) {
        return { ok: true, skipped: true, reason: 'bridge_disabled', delivered: 0, failed: 0 };
    }
    if (!client.config.valid) {
        return { ok: false, skipped: true, reason: 'bridge_misconfigured', delivered: 0, failed: 0 };
    }

    const fetched = await client.fetchAnswered({ limit });
    if (fetched?.skipped) {
        return { ok: fetched.ok !== false, skipped: true, reason: fetched.reason, delivered: 0, failed: 0 };
    }

    let delivered = 0;
    let failed = 0;
    const errors = [];

    for (const item of fetched.answers || []) {
        if (!isDeliverableAnswer(item)) {
            failed += 1;
            errors.push({ id: item?.id || null, reason: 'invalid_answer_payload' });
            continue;
        }

        try {
            const sent = await sock.sendMessage(String(item.chat_id), {
                text: String(item.answer).trim(),
            });
            if (sent?.skipped) {
                failed += 1;
                errors.push({ id: item.id, reason: sent.reason || 'send_skipped' });
                continue;
            }

            const ack = await client.ackDelivered(item.id);
            if (!ack?.ok || ack?.skipped) {
                failed += 1;
                errors.push({ id: item.id, reason: ack?.reason || 'ack_failed' });
                continue;
            }
            delivered += 1;
        } catch (error) {
            failed += 1;
            errors.push({ id: item.id, reason: error?.code || error?.message || 'delivery_failed' });
        }
    }

    return {
        ok: failed === 0,
        skipped: false,
        fetched: fetched.answers?.length || 0,
        delivered,
        failed,
        errors,
    };
}

module.exports = {
    isDeliverableAnswer,
    runAgentAnswerSweep,
};
