'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadContinueWithState({ player = {}, phase = 'jogo_liberado', canPlay = true, rollCount = 2, pbFree = 0, phAvailable = 0 } = {}) {
    const replies = [];
    const effectivePlayer = {
        ficha_status: 'aprovada',
        magia: 'Fogo',
        numero_roll_escolhido: 1,
        ...player,
    };
    const stubs = {
        '../config/bot': { COMMAND_PREFIX: '.#', MAX_PLAYER_ROLLS: 4 },
        '../helpers/chatReply': { sendReply: async ({ text }) => replies.push(text) },
        '../helpers/magicManager': { getPendingMagicConfirmation: async () => null },
        '../helpers/profileForms': { getPendingConfirmation: async () => null },
        '../helpers/playerRegistry': {
            ensurePlayerRecord: async () => effectivePlayer,
            getExistingOnboardingState: async () => ({ current_step: 'roll_gerado', step_payload: {} }),
            getOnboardingState: async () => ({ current_step: 'roll_gerado', step_payload: {} }),
            updateOnboardingStep: async () => undefined,
        },
        '../helpers/rollManager': { getPlayerRollCount: async () => rollCount },
        '../helpers/clover/playerPhase': {
            PHASES: {
                APARENCIA_PENDENTE: 'aparencia_pendente',
                APARENCIA_REJEITADA: 'aparencia_rejeitada',
                HISTORIA_PENDENTE: 'historia_pendente',
                HISTORIA_APROVADA: 'historia_aprovada',
                JOGO_LIBERADO: 'jogo_liberado',
            },
            getPlayerPhase: async () => ({ phase, canPlay }),
        },
        '../helpers/clover/characterStats': {
            getCharacterStats: async () => ({ distribution_status: 'confirmed' }),
            getPbUsage: () => ({ free: pbFree }),
        },
        '../helpers/clover/skillTreeService': {
            getTreeState: async () => ({
                ph: { phAvailable },
                availableNodes: [],
            }),
        },
    };
    const modulePath = require.resolve('../comandos/continuar');
    delete require.cache[modulePath];
    const originalLoad = Module._load;
    Module._load = function fakeDeps(request, parent, isMain) {
        if (parent?.filename === modulePath && Object.prototype.hasOwnProperty.call(stubs, request)) {
            return stubs[request];
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    let command;
    try {
        command = require(modulePath);
    } finally {
        Module._load = originalLoad;
        delete require.cache[modulePath];
    }
    return {
        replies,
        execute: () => command.executar({
            sock: {},
            m: {},
            idChat: 'grupo@g.us',
            idJogador: 'player@s.whatsapp.net',
            nomeUsuario: 'Pessoa Teste',
            db: {},
        }),
    };
}

test('continuar: jogador liberado tem próximos passos implementados', async () => {
    const { replies, execute } = loadContinueWithState();
    await execute();
    const output = replies.at(-1);
    assert.match(output, /\.\#checklist/);
    assert.match(output, /\.\#raid listar/);
    assert.doesNotMatch(output, /missões entram em etapa futura/i);
});

test('continuar: PH disponível não oculta próximos passos jogáveis', async () => {
    const { replies, execute } = loadContinueWithState({ phAvailable: 20 });
    await execute();
    const output = replies.at(-1);
    assert.match(output, /\.\#arvores/);
    assert.match(output, /\.\#raid listar/);
    assert.match(output, /\.\#checklist/);
});

test('continuar: novato com menos de quatro rolls pode escolher agora', async () => {
    const { replies, execute } = loadContinueWithState({
        player: { ficha_status: 'incompleta', magia: '-', numero_roll_escolhido: null },
        phase: 'rolls_em_andamento',
        canPlay: false,
        rollCount: 2,
    });
    await execute();
    const output = replies.at(-1);
    assert.match(output, /\.\#ficha <número>/);
    assert.match(output, /sem precisar usar todos os quatro/);
    assert.match(output, /\.\#sortear/);
});
