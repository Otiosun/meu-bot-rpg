'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const originalLoad = Module._load;
const replies = [];
let approvalResult = null;
let approvalCalls = [];
let postCommitCalls = [];

Module._load = function loadWithSpellCommandStubs(request, parent, isMain) {
    const parentFile = String(parent?.filename || '').replace(/\\/g, '/');
    if (!parentFile.endsWith('/comandos/feitico.js')) {
        return originalLoad.call(this, request, parent, isMain);
    }

    if (request === '../config/bot') return { COMMAND_PREFIX: '.#' };
    if (request === '../helpers/chatReply') {
        return {
            sendReply: async (payload) => {
                replies.push(payload);
                return payload;
            },
        };
    }
    if (request === '../helpers/textUtils') {
        return {
            normalizeText: (value) => String(value || '')
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .toLowerCase()
                .trim(),
        };
    }
    if (request === '../helpers/clover/commandTargetUtils') {
        return {
            canManagePlayer: async () => true,
            formatMention: () => '@player',
            getPlayerById: async () => ({ id: 'player@lid', personagem_nome: 'Player de Teste' }),
            getQuotedParticipant: () => null,
            playerDisplayName: () => 'Player de Teste',
            resolveTargetAndRest: () => ({
                targetId: 'player@lid',
                targetText: null,
                rest: 'ficha completa',
            }),
            resolveTargetPlayer: async () => ({
                ok: true,
                player: { id: 'player@lid', personagem_nome: 'Player de Teste' },
            }),
        };
    }
    if (request === '../helpers/clover/accessIntegrationService') {
        return {
            ACCESS_PERMISSIONS: {
                GRIMOIRE_READ: 'read',
                GRIMOIRE_TECHNICAL: 'technical',
            },
            authorizeCharacterCommandAccess: async () => ({ ok: true }),
        };
    }
    if (request === '../helpers/clover/spellApprovalService') {
        return {
            approveCalledSpell: async (...args) => {
                approvalCalls.push(args);
                return approvalResult;
            },
        };
    }
    if (request === '../helpers/clover/spellbookService') {
        return {
            findSpell: async () => ({ ok: false, code: 'not_found' }),
            listApprovedSpells: async () => [],
            parseSpellSheet: () => ({
                ok: true,
                errors: [],
                sheet: {
                    name: 'Mão de Lama',
                    normalizedName: 'mao_de_lama',
                    type: 'Criação',
                },
            }),
            removeSpell: async () => ({ ok: false, code: 'not_found' }),
            renderSpellSheetTemplate: () => 'FICHA MODELO',
        };
    }
    if (request === '../helpers/clover/spellbookPresentation') {
        return {
            renderSpellCardPlayer: () => 'CARD PLAYER',
            renderSpellCardTechnical: (spell) => `CARD ${spell.name}`,
            renderSpellbookUsage: () => 'AJUDA',
            selectSpellByIndex: () => null,
        };
    }
    if (request === '../helpers/clover/spellReviewFlowOrchestrator') {
        return {
            completeSpellReviewPostCommit: async (payload) => {
                postCommitCalls.push(payload);
                return {
                    handled: true,
                    removal: { ok: true },
                    fill: { called: [] },
                };
            },
        };
    }

    return originalLoad.call(this, request, parent, isMain);
};

const commandPath = require.resolve('../comandos/feitico');
delete require.cache[commandPath];
const spellCommand = require('../comandos/feitico');
Module._load = originalLoad;

function resetState() {
    replies.length = 0;
    approvalCalls = [];
    postCommitCalls = [];
}

async function executeAdd() {
    await spellCommand.executar({
        sock: {},
        m: {},
        idChat: 'group@g.us',
        idJogador: 'admin@lid',
        db: {},
        body: 'adicionar @player ficha completa',
        matchedCommand: '.#feitico',
    });
}

test('comando preserva fila e explica bloqueio quando não existe slot', async () => {
    resetState();
    approvalResult = {
        ok: false,
        code: 'spell_capacity_full',
        capacity: {
            totalSlots: 1,
            occupiedSlots: 1,
            capacityDebt: 0,
        },
        preservesQueueEntry: true,
    };

    await executeAdd();

    assert.equal(approvalCalls.length, 1);
    assert.equal(postCommitCalls.length, 0);
    assert.equal(replies.length, 1);
    assert.match(replies[0].text, /Slots:\* 1\/1/i);
    assert.match(replies[0].text, /posição na fila foram preservadas/i);
    assert.match(replies[0].text, /Ticket de Feitiço/i);
});

test('comando executa efeitos pós-commit somente depois da aprovação atômica', async () => {
    resetState();
    approvalResult = {
        ok: true,
        code: 'spell_approved',
        mode: 'created',
        spell: {
            name: 'Mão de Lama',
            version: 1,
        },
    };

    await executeAdd();

    assert.equal(approvalCalls.length, 1);
    assert.equal(approvalCalls[0][1], 'player@lid');
    assert.equal(approvalCalls[0][3], 'admin@lid');
    assert.equal(postCommitCalls.length, 1);
    assert.equal(postCommitCalls[0].playerId, 'player@lid');
    assert.equal(replies.length, 1);
    assert.match(replies[0].text, /FEITIÇO ADICIONADO/i);
    assert.match(replies[0].text, /avaliação concluída/i);
});
