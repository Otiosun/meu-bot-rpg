'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'helpers', 'chatReply.js');
const CONTRACT = path.join(ROOT, 'tests', 'chatReplyPolicyHookContract.test.js');
const EXPECTED_BLOB_SHA = '51a6c3e1a969dd716023df0676f08ee949003397';
const INTEGRATION_MARKER = "require('./clover/privateMessagePolicyRuntime')";

function gitBlobSha(content) {
    const body = Buffer.from(content, 'utf8');
    const header = Buffer.from(`blob ${body.length}\0`, 'utf8');
    return crypto.createHash('sha1').update(header).update(body).digest('hex');
}

function replaceExactly(content, before, after, label) {
    const first = content.indexOf(before);
    if (first < 0) throw new Error(`Trecho obrigatório ausente: ${label}`);
    if (content.indexOf(before, first + before.length) >= 0) {
        throw new Error(`Trecho ambíguo, encontrado mais de uma vez: ${label}`);
    }
    return content.slice(0, first) + after + content.slice(first + before.length);
}

function buildIntegratedContent(original) {
    let content = original;

    content = replaceExactly(
        content,
        "const fs = require('fs');\nconst path = require('path');\n\n",
        "const fs = require('fs');\nconst path = require('path');\n\nconst {\n    buildPolicySkipResult,\n    evaluateRuntimePrivateMessage,\n} = require('./clover/privateMessagePolicyRuntime');\n\n",
        'import do adaptador'
    );

    content = replaceExactly(
        content,
        "async function sendMessageWithFallback(sock, idChat, message, m) {\n    const original = normalizeJid(idChat);\n    const privateTarget = original && !original.endsWith('@g.us');\n    const privateCommandReply = privateTarget && isPrivateCommandReply(original, m);\n    const reachoutLock = privateTarget ? getActivePrivateReachoutLock() : null;",
        "function buildRuntimePolicyInput({ idChat, privateCommandReply, policy = {} }) {\n    const metadata = policy && typeof policy === 'object' ? policy : {};\n    return {\n        targetJid: normalizeJid(idChat),\n        source: metadata.source || (privateCommandReply ? 'command_reply' : null),\n        category: metadata.category,\n        targetCount: metadata.targetCount,\n        explicitConfirmation: metadata.explicitConfirmation,\n        dedupeKey: metadata.dedupeKey,\n    };\n}\n\nfunction logRuntimePolicyDecision(runtimeDecision) {\n    if (!runtimeDecision?.privateTarget || runtimeDecision.mode === 'off') return;\n    console.log('[pv-policy] decisão de envio:', {\n        mode: runtimeDecision.mode,\n        allowed: runtimeDecision.allowed,\n        wouldAllow: runtimeDecision.wouldAllow,\n        source: runtimeDecision.policyDecision?.policy?.source || null,\n        category: runtimeDecision.policyDecision?.policy?.category || null,\n        reason: runtimeDecision.policyDecision?.reason || runtimeDecision.reason,\n    });\n}\n\nasync function sendMessageWithFallback(sock, idChat, message, m, policy = {}) {\n    const original = normalizeJid(idChat);\n    const privateTarget = original && !original.endsWith('@g.us');\n    const privateCommandReply = privateTarget && isPrivateCommandReply(original, m);\n    const policyInput = buildRuntimePolicyInput({ idChat: original, privateCommandReply, policy });\n    const runtimePolicyDecision = evaluateRuntimePrivateMessage(policyInput);\n    logRuntimePolicyDecision(runtimePolicyDecision);\n    const policySkip = buildPolicySkipResult(runtimePolicyDecision);\n    if (policySkip) return policySkip;\n\n    const reachoutLock = privateTarget ? getActivePrivateReachoutLock() : null;",
        'gancho principal do transporte'
    );

    content = replaceExactly(
        content,
        "        const queued = await enqueuePrivateDeliveryFallback({\n            idChat: original,\n            message,\n            reason: 'pv_reachout_locked',\n        });",
        "        const queued = await enqueuePrivateDeliveryFallback({\n            idChat: original,\n            message,\n            reason: 'pv_reachout_locked',\n            source: policyInput.source || 'chatReply',\n        });",
        'fila durante reachout lock'
    );

    content = replaceExactly(
        content,
        "        const queued = await enqueuePrivateDeliveryFallback({\n            idChat: original,\n            message,\n            reason: lastError?.message || 'send_failed',\n        });",
        "        const queued = await enqueuePrivateDeliveryFallback({\n            idChat: original,\n            message,\n            reason: lastError?.message || 'send_failed',\n            source: policyInput.source || 'chatReply',\n        });",
        'fila após falha de envio'
    );

    content = replaceExactly(
        content,
        "async function sendReply({ sock, idChat, m, text, mentions, imagePath }) {\n    const safeMentions = mentions || [];\n    const message = imagePath && fs.existsSync(imagePath)\n        ? { image: fs.readFileSync(imagePath), caption: text, mentions: safeMentions }\n        : { text, mentions: safeMentions };\n\n    return sendMessageWithFallback(sock, idChat, message, m);\n}\n\nasync function sendPrivateText({ sock, playerId, text, mentions }) {\n    const safeMentions = mentions || [];\n    return sendMessageWithFallback(sock, playerId, { text, mentions: safeMentions }, null);\n}\n\nasync function sendPrivateMessage({ sock, playerId, message }) {\n    return sendMessageWithFallback(sock, playerId, message, null);\n}",
        "async function sendReply({ sock, idChat, m, text, mentions, imagePath, policy }) {\n    const safeMentions = mentions || [];\n    const message = imagePath && fs.existsSync(imagePath)\n        ? { image: fs.readFileSync(imagePath), caption: text, mentions: safeMentions }\n        : { text, mentions: safeMentions };\n\n    return sendMessageWithFallback(sock, idChat, message, m, policy);\n}\n\nasync function sendPrivateText({ sock, playerId, text, mentions, policy }) {\n    const safeMentions = mentions || [];\n    return sendMessageWithFallback(sock, playerId, { text, mentions: safeMentions }, null, policy);\n}\n\nasync function sendPrivateMessage({ sock, playerId, message, policy }) {\n    return sendMessageWithFallback(sock, playerId, message, null, policy);\n}",
        'APIs públicas de envio'
    );

    return content;
}

function contractSource() {
    return `'use strict';\n\nconst assert = require('node:assert/strict');\nconst test = require('node:test');\n\nconst CHAT_REPLY_PATH = require.resolve('../helpers/chatReply');\n\nfunction freshChatReply() {\n    delete require.cache[CHAT_REPLY_PATH];\n    return require(CHAT_REPLY_PATH);\n}\n\nfunction makeSocket() {\n    const calls = [];\n    return {\n        calls,\n        sock: {\n            async sendMessage(jid, message) {\n                calls.push({ jid, message });\n                return {\n                    key: { id: 'message-' + calls.length, remoteJid: jid },\n                    message,\n                };\n            },\n        },\n    };\n}\n\nfunction withEnv(values, fn) {\n    const previous = {};\n    for (const [key, value] of Object.entries(values)) {\n        previous[key] = process.env[key];\n        if (value === undefined) delete process.env[key];\n        else process.env[key] = value;\n    }\n    return Promise.resolve()\n        .then(fn)\n        .finally(() => {\n            for (const [key, value] of Object.entries(previous)) {\n                if (value === undefined) delete process.env[key];\n                else process.env[key] = value;\n            }\n        });\n}\n\ntest('modo off mantém envio privado legado sem metadados', async () => {\n    await withEnv({\n        CLOVER_PV_POLICY_MODE: 'off',\n        CLOVER_PRIVATE_SEND_THROTTLE: '0',\n    }, async () => {\n        const { sendPrivateText } = freshChatReply();\n        const { sock, calls } = makeSocket();\n        const result = await sendPrivateText({\n            sock,\n            playerId: '5511999999999@s.whatsapp.net',\n            text: 'teste',\n        });\n        assert.equal(calls.length, 1);\n        assert.equal(result?.key?.id, 'message-1');\n    });\n});\n\ntest('modo observe mede desconhecido sem impedir envio', async () => {\n    await withEnv({\n        CLOVER_PV_POLICY_MODE: 'observe',\n        CLOVER_PRIVATE_SEND_THROTTLE: '0',\n    }, async () => {\n        const { sendPrivateText } = freshChatReply();\n        const { sock, calls } = makeSocket();\n        await sendPrivateText({\n            sock,\n            playerId: '5511888888888@s.whatsapp.net',\n            text: 'teste',\n        });\n        assert.equal(calls.length, 1);\n    });\n});\n\ntest('modo enforce bloqueia privado desconhecido antes do socket', async () => {\n    await withEnv({\n        CLOVER_PV_POLICY_MODE: 'enforce',\n        CLOVER_PRIVATE_SEND_THROTTLE: '0',\n    }, async () => {\n        const { sendPrivateText } = freshChatReply();\n        const { sock, calls } = makeSocket();\n        const result = await sendPrivateText({\n            sock,\n            playerId: '5511777777777@s.whatsapp.net',\n            text: 'teste',\n        });\n        assert.equal(calls.length, 0);\n        assert.equal(result.skipped, true);\n        assert.equal(result.reason, 'pv_policy_blocked');\n        assert.equal(result.policy.decisionReason, 'classification_required');\n    });\n});\n\ntest('modo enforce preserva transação identificada e deduplicável', async () => {\n    await withEnv({\n        CLOVER_PV_POLICY_MODE: 'enforce',\n        CLOVER_PRIVATE_SEND_THROTTLE: '0',\n    }, async () => {\n        const { sendPrivateText } = freshChatReply();\n        const { sock, calls } = makeSocket();\n        const result = await sendPrivateText({\n            sock,\n            playerId: '5511666666666@s.whatsapp.net',\n            text: 'aparência aprovada',\n            policy: {\n                source: 'appearance_result',\n                dedupeKey: 'appearance:player:revision-1',\n            },\n        });\n        assert.equal(calls.length, 1);\n        assert.equal(result?.key?.id, 'message-1');\n    });\n});\n\ntest('resposta a comando no PV é inferida como reativa', async () => {\n    await withEnv({\n        CLOVER_PV_POLICY_MODE: 'enforce',\n        CLOVER_PRIVATE_SEND_THROTTLE: '0',\n        CLOVER_HUMAN_TYPING_ENABLED: '0',\n    }, async () => {\n        const { sendReply } = freshChatReply();\n        const { sock, calls } = makeSocket();\n        await sendReply({\n            sock,\n            idChat: '5511555555555@s.whatsapp.net',\n            m: { message: { conversation: '.#ajuda' } },\n            text: 'menu',\n        });\n        assert.equal(calls.length, 1);\n    });\n});\n\ntest('alvo de grupo continua fora da política privada', async () => {\n    await withEnv({\n        CLOVER_PV_POLICY_MODE: 'enforce',\n        CLOVER_PRIVATE_SEND_THROTTLE: '0',\n    }, async () => {\n        const { sendReply } = freshChatReply();\n        const { sock, calls } = makeSocket();\n        await sendReply({\n            sock,\n            idChat: '120363000000000000@g.us',\n            text: 'grupo',\n        });\n        assert.equal(calls.length, 1);\n    });\n});\n`;\n}

function main() {
    const args = new Set(process.argv.slice(2));
    const apply = args.has('--apply');
    const check = args.has('--check') || !apply;

    const original = fs.readFileSync(TARGET, 'utf8');
    const currentBlobSha = gitBlobSha(original);

    if (original.includes(INTEGRATION_MARKER)) {
        console.log('[pv-policy-integrator] integração já aplicada.');
        if (!fs.existsSync(CONTRACT)) {
            throw new Error('Integração presente, mas contrato permanente ausente.');
        }
        return;
    }

    if (currentBlobSha !== EXPECTED_BLOB_SHA) {
        throw new Error(
            `chatReply.js divergiu. Esperado ${EXPECTED_BLOB_SHA}; atual ${currentBlobSha}. `
            + 'Rebase/revisão manual obrigatória antes de integrar.'
        );
    }

    const integrated = buildIntegratedContent(original);
    const integratedBlobSha = gitBlobSha(integrated);

    console.log('[pv-policy-integrator] pré-condições aprovadas.');
    console.log(`[pv-policy-integrator] blob original: ${currentBlobSha}`);
    console.log(`[pv-policy-integrator] blob integrado: ${integratedBlobSha}`);

    if (check) {
        console.log('[pv-policy-integrator] check concluído; nenhum arquivo alterado.');
    }

    if (!apply) return;

    fs.writeFileSync(TARGET, integrated, 'utf8');
    fs.writeFileSync(CONTRACT, contractSource(), 'utf8');

    console.log('[pv-policy-integrator] chatReply.js atualizado.');
    console.log('[pv-policy-integrator] contrato permanente criado.');
}

try {
    main();
} catch (error) {
    console.error(`[pv-policy-integrator] falha: ${error?.message || error}`);
    process.exitCode = 1;
}
