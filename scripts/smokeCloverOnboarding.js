const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const startCommand = require('../comandos/start');
const sortearCommand = require('../comandos/sortear');
const sacrificarCommand = require('../comandos/sacrificar');
const rollsCommand = require('../comandos/rolls');
const fichaCommand = require('../comandos/ficha');
const fichaPessoalCommand = require('../comandos/fichaPessoal');
const confirmarCommand = require('../comandos/confirmarFicha');
const cancelarCommand = require('../comandos/cancelarFicha');
const continuarCommand = require('../comandos/continuar');
const statusCommand = require('../comandos/status');
const magiaCommand = require('../comandos/magia');
const ajudaCommand = require('../comandos/ajuda');
const aparenciaCommand = require('../comandos/aparencia');
const racasCommand = require('../comandos/racas');
const classesCommand = require('../comandos/classes');
const reinosCommand = require('../comandos/reinos');
const grimoriosCommand = require('../comandos/grimorios');
const familiasCommand = require('../comandos/familias');
const tracosCommand = require('../comandos/tracos');
const { MAX_PLAYER_ROLLS } = require('../config/bot');
const {
    ensureCloverArchiveCardsSchema,
    ensureCloverAppearanceReviewSchema,
    ensureCloverCharacterStatsSchema,
    ensureCloverManaHexagonSchema,
    ensureCloverPhLedgerSchema,
    ensureCloverSettingsSchema,
    ensureCloverSkillTreeSchema,
    ensureCloverTraitAttemptsSchema,
    ensureSlotReservationsSchema,
} = require('../database');
const {
    checkCommandCooldown,
    getCriticalLockKey,
    runWithCommandLock,
} = require('../helpers/commandGuards');
const { loadCloverConfigs } = require('../helpers/clover/configLoader');
const { generateAvailableBaseRoll, generateBaseRoll } = require('../helpers/clover/rollEngine');
const { countUsedSlots, occupySlot } = require('../helpers/clover/slotManager');
const {
    findMagicOption,
    findMagicOptions,
    getAllMagics,
    getAvailableMagicsForRoll,
    getMagicSlotKey,
    savePendingMagicConfirmation,
} = require('../helpers/magicManager');
const { isMagicReplyMessage } = require('../helpers/messageContext');
const { looksLikeProfileSubmission } = require('../helpers/profileForms');
const {
    getPlayerRollByNumber,
    getRareRollHighlights,
    getRareRollImagePath,
    listPlayerRolls,
} = require('../helpers/rollManager');
const { normalizeText: normalizeDecoratedText } = require('../helpers/textUtils');
const { clearWelcomeDebounce, shouldSendWelcome } = require('../helpers/welcomeDebounce');
const {
    tryAttachAppearanceImage,
    tryHandleAppearanceReaction,
    tryHandleAppearanceReviewReply,
} = require('../helpers/clover/appearanceManager');

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

function createFakeSock() {
    const sent = [];
    let counter = 0;
    return {
        sent,
        async groupMetadata(id) {
            return {
                id,
                participants: [
                    { id: 'admin@s.whatsapp.net', admin: 'admin' },
                    { id: 'member@s.whatsapp.net', admin: null },
                ],
            };
        },
        async sendMessage(idChat, message, options) {
            counter += 1;
            const response = { ok: true, key: { id: `fake-${counter}`, remoteJid: idChat } };
            sent.push({ idChat, message, options, response });
            return response;
        },
    };
}

function createFailingSock(message = 'Connection Closed') {
    return {
        sent: [],
        async sendMessage() {
            throw new Error(message);
        },
    };
}

async function createMemoryDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });

    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT,
            display_name TEXT DEFAULT '-',
            idade TEXT DEFAULT '-',
            reino TEXT DEFAULT '-',
            classe TEXT DEFAULT '-',
            familia TEXT DEFAULT '-',
            raca TEXT DEFAULT '-',
            grimorio TEXT DEFAULT '-',
            magia TEXT DEFAULT '-',
            formas TEXT DEFAULT '-',
            historia TEXT DEFAULT '-',
            aparencia TEXT DEFAULT '-',
            dinheiro INTEGER DEFAULT 0,
            esquadrao TEXT DEFAULT '-',
            estrelas INTEGER DEFAULT 0,
            atributos_max INTEGER DEFAULT 10,
            forca INTEGER DEFAULT 0,
            velocidade INTEGER DEFAULT 0,
            resistencia INTEGER DEFAULT 0,
            reflexos INTEGER DEFAULT 0,
            poder_magico INTEGER DEFAULT 0,
            mana INTEGER DEFAULT 0,
            pontos INTEGER DEFAULT 5,
            agilidade INTEGER DEFAULT 0,
            nome_real TEXT DEFAULT '-',
            idade_real INTEGER DEFAULT NULL,
            gosta_de_fazer TEXT DEFAULT '-',
            disponibilidade_detalhada TEXT DEFAULT '-',
            personagem_nome TEXT DEFAULT '-',
            personagem_idade INTEGER DEFAULT NULL,
            personagem_aparencia TEXT DEFAULT '-',
            personagem_aparencia_normalizada TEXT DEFAULT NULL,
            personagem_aparencia_status TEXT DEFAULT 'pending',
            personagem_aparencia_motivo TEXT DEFAULT NULL,
            personagem_aparencia_image_path TEXT DEFAULT NULL,
            personagem_aparencia_image_message_id TEXT DEFAULT NULL,
            personagem_aparencia_approved_by TEXT DEFAULT NULL,
            personagem_aparencia_approved_at TEXT DEFAULT NULL,
            personagem_aparencia_updated_at TEXT DEFAULT NULL,
            personagem_genero TEXT DEFAULT '-',
            numero_roll_escolhido INTEGER DEFAULT NULL,
            ficha_status TEXT DEFAULT 'incompleta',
            ultima_recepcao_em TEXT DEFAULT NULL,
            familia_key TEXT DEFAULT NULL,
            magia_key TEXT DEFAULT NULL,
            aptidao_comum TEXT DEFAULT '-',
            aptidao_comum_key TEXT DEFAULT NULL,
            marca_comum TEXT DEFAULT '-',
            marca_comum_key TEXT DEFAULT NULL,
            aptidao_rara TEXT DEFAULT '-',
            aptidao_rara_key TEXT DEFAULT NULL,
            marca_rara TEXT DEFAULT '-',
            marca_rara_key TEXT DEFAULT NULL,
            anomalia TEXT DEFAULT '-',
            anomalia_key TEXT DEFAULT NULL,
            tentativas_especiais TEXT DEFAULT '[]',
            roll_sacrifice_used INTEGER DEFAULT 0,
            roll_sacrifice_used_at TEXT DEFAULT NULL,
            historia_status TEXT DEFAULT 'pendente',
            historia_status_updated_at TEXT DEFAULT NULL,
            historia_aprovada_at TEXT DEFAULT NULL,
            historia_aprovada_by TEXT DEFAULT NULL,
            historia_pv_sent_at TEXT DEFAULT NULL,
            historia_motivo TEXT DEFAULT NULL,
            jogo_status TEXT DEFAULT 'bloqueado',
            jogo_liberado_at TEXT DEFAULT NULL,
            jogo_liberado_by TEXT DEFAULT NULL,
            jogo_bloqueio_motivo TEXT DEFAULT NULL
        )
    `);

    await db.exec(`
        CREATE TABLE player_onboarding (
            player_id TEXT PRIMARY KEY,
            started_at TEXT DEFAULT CURRENT_TIMESTAMP,
            welcome_sent_at TEXT DEFAULT CURRENT_TIMESTAMP,
            last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
            current_step TEXT DEFAULT 'inicio',
            step_payload TEXT DEFAULT '{}'
        )
    `);

    await db.exec(`
        CREATE TABLE player_rolls (
            player_id TEXT NOT NULL,
            roll_number INTEGER NOT NULL,
            kingdom TEXT DEFAULT '-',
            social_class TEXT NOT NULL,
            family TEXT DEFAULT '-',
            race TEXT NOT NULL,
            grimoire TEXT NOT NULL,
            grimoire_rank TEXT DEFAULT '-',
            grimoire_symbol TEXT DEFAULT '-',
            magic_rarity TEXT NOT NULL,
            magic_scope TEXT DEFAULT '-',
            summary TEXT DEFAULT '-',
            roll_version TEXT DEFAULT 'legacy',
            kingdom_key TEXT DEFAULT NULL,
            social_class_key TEXT DEFAULT NULL,
            race_key TEXT DEFAULT NULL,
            grimoire_key TEXT DEFAULT NULL,
            magic_rarity_key TEXT DEFAULT NULL,
            roll_payload TEXT DEFAULT '{}',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (player_id, roll_number)
        )
    `);

    await db.exec(`
        CREATE TABLE pending_profile_confirmations (
            player_id TEXT PRIMARY KEY,
            payload TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await db.exec(`
        CREATE TABLE pending_magic_confirmations (
            player_id TEXT PRIMARY KEY,
            magic_label TEXT NOT NULL,
            roll_number INTEGER DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await ensureSlotReservationsSchema(db);
    await ensureCloverTraitAttemptsSchema(db);
    await ensureCloverSettingsSchema(db);
    await ensureCloverArchiveCardsSchema(db);
    await ensureCloverAppearanceReviewSchema(db);
    await ensureCloverCharacterStatsSchema(db);
    await ensureCloverPhLedgerSchema(db);
    await ensureCloverSkillTreeSchema(db);
    await ensureCloverManaHexagonSchema(db);

    return db;
}

async function runCommand(command, context) {
    await command.executar({
        m: context.m || { key: { id: 'smoke-message' } },
        idChat: 'smoke-group@g.us',
        idJogador: context.playerId,
        nomeUsuario: context.name,
        db: context.db,
        sock: context.sock,
        body: context.body || '',
        comandos: context.comandos || [],
        downloadMediaMessage: context.downloadMediaMessage || (async () => Buffer.from('fake-image')),
        P: context.P || (() => ({ level: 'silent' })),
    });
}

function normalizeText(value) {
    return normalizeDecoratedText(value);
}

function normalizeLooseText(value) {
    return normalizeText(value).replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function latestText(sock) {
    const latest = sock.sent[sock.sent.length - 1]?.message || {};
    return latest.text || latest.caption || '';
}

function buildReplyMessage(quotedText, text = '') {
    return {
        key: { id: 'smoke-reply-message' },
        message: {
            extendedTextMessage: {
                text,
                contextInfo: {
                    stanzaId: 'bot-message',
                    quotedMessage: {
                        conversation: quotedText,
                    },
                },
            },
        },
    };
}

function buildMagicReplyMessage(text = '') {
    return buildReplyMessage('── MAGIAS DISPONIVEIS ──\nEscolha sua magia.\nRaridade do seu roll.', text);
}

function textSince(sock, index) {
    return sock.sent.slice(index)
        .map((item) => item.message?.text || item.message?.caption || '')
        .filter(Boolean)
        .join('\n');
}

function findCompatibleFamily(roll) {
    const configs = loadCloverConfigs();
    const family = configs.lists.families.find((item) => (
        item.capacity
        && item.kingdomKeys.includes(roll.kingdom_key)
        && item.socialClassKeys.includes(roll.social_class_key)
    )) || configs.lists.families.find((item) => (
        item.kingdomKeys.includes(roll.kingdom_key)
        && item.socialClassKeys.includes(roll.social_class_key)
    ));

    assert(family, `Nenhuma familia compativel para ${roll.kingdom}/${roll.social_class}.`);
    return family;
}

function pickMagicForRoll(roll) {
    const options = getAvailableMagicsForRoll(roll);
    const limited = options.find((option) => option.capacity);
    return limited || options[0];
}

async function fillAllMagicSlotsForRarity(db, rarity) {
    const normalizedRarity = normalizeDecoratedText(rarity);
    const configs = loadCloverConfigs();
    const magics = configs.lists.magics.filter((magic) => (
        normalizeDecoratedText(magic.rarity) === normalizedRarity
    ));

    for (const magic of magics) {
        const capacity = Number(magic.capacity || 0);
        for (let index = 0; index < capacity; index += 1) {
            const occupied = await occupySlot(
                db,
                `magic_fill_${normalizedRarity}_${magic.key}_${index}`,
                'magic',
                magic.key,
                'smoke_fill_magic',
                1
            );
            assert(occupied.ok, `Preenchimento de ${magic.name} deveria ocupar vaga livre.`);
        }
    }
}

function withMockedRandom(values, callback) {
    const originalRandom = Math.random;
    const queue = [...values];
    Math.random = () => queue.shift() ?? 0;
    try {
        return callback();
    } finally {
        Math.random = originalRandom;
    }
}

async function withMockedRandomAsync(values, callback) {
    const originalRandom = Math.random;
    const queue = [...values];
    Math.random = () => queue.shift() ?? 0;
    try {
        return await callback();
    } finally {
        Math.random = originalRandom;
    }
}

function validateGeneratedRaceClassRules() {
    const humanRoll = withMockedRandom([0, 0, 0, 0, 0], () => generateBaseRoll(1));
    assert(humanRoll.raceKey === 'humano', 'Roll humano deterministico deveria sair humano.');
    assert(humanRoll.socialClassKey !== 'nao_se_aplica', 'Roll humano deveria aplicar classe social.');

    const nonHumanRoll = withMockedRandom([0, 0.7, 0, 0], () => generateBaseRoll(2));
    assert(nonHumanRoll.raceKey !== 'humano', 'Roll nao humano deterministico deveria sair raca especial.');
    assert(nonHumanRoll.socialClassKey === 'nao_se_aplica', 'Roll nao humano deveria ter classe social N/A.');
}

function validateFamilyCapacities() {
    const { maps } = loadCloverConfigs();
    const expected = {
        vermillion: 3,
        silva: 3,
        kira: 2,
        roselei: 4,
        vaude: 4,
        vangeance: 2,
        faust: 2,
        feramena: 2,
        mars: 6,
        ladros: 6,
        broccos: 6,
        ragus: 6,
        yagos: 6,
        libardirt: 6,
        lolopechka: 2,
        gadjah: 6,
        potrof: 6,
        floga: 6,
        smurik: 6,
        sarado: 6,
        grinberryall: 3,
        zogratis: 3,
        godroc: 6,
        migusteau: 6,
        snyle: 6,
        ringert: 6,
        gatard: 6,
        chevour: 6,
        ongg: 6,
    };

    for (const [key, capacity] of Object.entries(expected)) {
        const family = maps.families.get(key);
        assert(family, `Familia esperada nao cadastrada: ${key}.`);
        assert(family.capacity === capacity, `Familia ${key} deveria ter capacity ${capacity}.`);
    }
}

function validateFinalAnomalies() {
    const { lists, maps } = loadCloverConfigs();
    const expected = {
        sem_mana: 2,
        mana_amaldicoada: 2,
        corpo_amaldicoado: 1,
        grimorio_amaldicoado: 1,
    };

    assert(lists.anomalies.length === 4, 'Anomalias finais deveriam ter somente 4 entradas.');
    for (const [key, capacity] of Object.entries(expected)) {
        const anomaly = maps.anomalies.get(key);
        assert(anomaly, `Anomalia final ausente: ${key}.`);
        assert(anomaly.capacity === capacity, `Anomalia ${key} deveria ter capacity ${capacity}.`);
    }

    ['eco_de_mana', 'grimorio_instavel', 'sangue_amaldicoado', 'olho_do_abismo'].forEach((key) => {
        assert(!maps.anomalies.has(key), `Anomalia antiga deveria sair do cadastro: ${key}.`);
    });
}

function validateRareGrimoiresEnabled() {
    const { maps } = loadCloverConfigs();
    const cloverFourLeaf = maps.grimoires.get('clover_4f');
    assert(cloverFourLeaf?.capacity === 2, 'Grimorio de 4 Folhas deveria ter 2 vagas.');

    const cloverFiveLeaf = maps.grimoires.get('clover_demonic');
    assert(cloverFiveLeaf?.name === 'Grimório de 5 Folhas', 'Clover deveria manter Grimorio de 5 Folhas.');
    assert(cloverFiveLeaf.capacity === 1, 'Grimorio de 5 Folhas deveria seguir limitado a 1.');
    assert(cloverFiveLeaf.chance > 0, 'Grimorio de 5 Folhas deveria continuar no pool de Clover.');

    [
        ['spade_demonic', 'Grimório de 3 Espadas', 0.5, 1],
        ['heart_demonic', 'Grimório de Coração Partido', 0.5, 1],
        ['diamond_broken', 'Grimório de Diamante Quebrado', 0, 1],
        ['diamond_demonic', 'Grimório Costurado', 0, null],
    ].forEach(([key, name, chance]) => {
        const grimoire = maps.grimoires.get(key);
        assert(grimoire?.name === name, `Grimorio raro/anomalo deveria estar cadastrado: ${key}.`);
        assert(grimoire.chance === chance, `${key} deveria ter ${chance}% no roll.`);
        if (key !== 'diamond_demonic') {
            assert(grimoire.capacity === 1, `${key} deveria ter apenas 1 vaga.`);
        } else {
            assert(grimoire.capacity === undefined, 'Grimorio Costurado deveria ser apenas narrativo no sistema.');
        }
    });
}

function validateMagicListenerRules() {
    const looseText = {
        message: {
            conversation: 'Feral',
        },
    };
    assert(!isMagicReplyMessage(looseText), 'Texto solto nao deveria ser interpretado como escolha de magia.');

    const magicReply = {
        message: {
            extendedTextMessage: {
                text: 'Feral',
                contextInfo: {
                    stanzaId: 'magic-list-message',
                    quotedMessage: {
                        conversation: '── MAGIAS DISPONIVEIS ──\nEscolha sua magia.',
                    },
                },
            },
        },
    };
    assert(isMagicReplyMessage(magicReply), 'Reply a mensagem de magia deveria ser aceito pelo listener.');

    const emptyQuotedReply = {
        message: {
            extendedTextMessage: {
                text: 'Feral',
                contextInfo: {
                    stanzaId: 'empty-message',
                    quotedMessage: {
                        conversation: '',
                    },
                },
            },
        },
    };
    assert(!isMagicReplyMessage(emptyQuotedReply), 'Reply sem texto citado nao deveria disparar escolha de magia.');

    const unrelatedReply = {
        message: {
            extendedTextMessage: {
                text: 'Feral',
                contextInfo: {
                    stanzaId: 'regular-message',
                    quotedMessage: {
                        conversation: 'Conversa normal do grupo.',
                    },
                },
            },
        },
    };
    assert(!isMagicReplyMessage(unrelatedReply), 'Reply a mensagem sem magia nao deveria disparar busca.');
}

function validatePartialMagicSearch() {
    const magics = getAllMagics();
    assert(findMagicOption(magics, 'Feral')?.label === 'Magia de Feral', 'Feral deveria encontrar Magia de Feral.');
    assert(findMagicOption(magics, 'Fogo')?.label === 'Magia de Fogo', 'Fogo deveria encontrar Magia de Fogo.');
    assert(findMagicOption(magics, 'Papel')?.label === 'Magia de Papel', 'Papel deveria encontrar Magia de Papel.');
    assert(findMagicOption(magics, 'Pintura')?.label === 'Magia de Pintura', 'Pintura deveria encontrar Magia de Pintura.');
    assert(findMagicOptions(magics, 'Planta').length > 1, 'Busca parecida deveria detectar multiplas magias.');
    assert(!findMagicOption(magics, 'Magia da Alma'), 'Magia da Alma nao deveria estar escolhivel.');
    assert(!findMagicOption(magics, 'Alma'), 'Alma solto nao deveria cair em outra magia.');
    assert(normalizeText(findMagicOption(magics, 'Cadaver da Alma')?.label).includes('cadaver da alma'), 'Cadaver da Alma deveria continuar escolhivel pelo nome completo.');
}

function validateRareRollImageRules() {
    const base = {
        race_key: 'humano',
        social_class_key: 'plebeu',
        grimoire_key: 'clover_3f',
        grimoire_rank: '3F',
        magic_rarity_key: 'comum',
    };

    assert(getRareRollHighlights(base).length === 0, 'Roll comum nao deveria acionar imagem rara.');
    assert(getRareRollImagePath({ ...base, grimoire_key: 'clover_demonic', grimoire_rank: 'Demonico' }), '5F/demonico deveria acionar imagem rara.');
    assert(getRareRollImagePath({ ...base, race_key: 'elfo', magic_rarity_key: 'lendaria' }), 'Elfo + Lendaria deveria acionar imagem rara.');
    assert(getRareRollImagePath({ ...base, race_key: 'elfo', grimoire_key: 'clover_4f', grimoire_rank: '4F' }), 'Elfo + 4F deveria acionar imagem rara.');
    assert(getRareRollImagePath({ ...base, grimoire_key: 'clover_4f', grimoire_rank: '4F', magic_rarity_key: 'lendaria' }), '4F + Lendaria deveria acionar imagem rara.');
    assert(getRareRollImagePath({ ...base, social_class_key: 'realeza', grimoire_key: 'clover_4f', grimoire_rank: '4F' }), 'Realeza + 4F deveria acionar imagem rara.');
    assert(getRareRollImagePath({ ...base, race_key: 'bruxa', grimoire_key: 'clover_4f', grimoire_rank: '4F', magic_rarity_key: 'lendaria' }), 'Bruxa + 4F + Lendaria deveria acionar imagem rara.');
    assert(getRareRollImagePath({ ...base, race_key: 'anao', grimoire_key: 'clover_4f', grimoire_rank: '4F', magic_rarity_key: 'lendaria' }), 'Anao + 4F + Lendaria deveria acionar imagem rara.');
}

function validateWelcomeDebounce() {
    clearWelcomeDebounce('debounce-group@g.us', 'debounce-player@s.whatsapp.net');
    assert(shouldSendWelcome('debounce-group@g.us', 'debounce-player@s.whatsapp.net', { now: 1000, ttlMs: 60000 }), 'Primeira recepcao deveria passar pelo debounce.');
    assert(!shouldSendWelcome('debounce-group@g.us', 'debounce-player@s.whatsapp.net', { now: 2000, ttlMs: 60000 }), 'Recepcao duplicada recente deveria ser bloqueada.');
    assert(shouldSendWelcome('debounce-group@g.us', 'debounce-player@s.whatsapp.net', { now: 70000, ttlMs: 60000 }), 'Recepcao depois do debounce deveria passar.');
}

async function validateCommandGuards() {
    const first = checkCommandCooldown('guard_player@s.whatsapp.net', '.#start', '', { now: 1000 });
    const second = checkCommandCooldown('guard_player@s.whatsapp.net', '.#racas', '', { now: 1100 });
    assert(first.ok && !second.ok, 'Cooldown por usuario deveria bloquear comandos em sequencia rapida.');

    const heavyFirst = checkCommandCooldown('guard_heavy@s.whatsapp.net', '.#sortear', '', { now: 1000 });
    const heavySecond = checkCommandCooldown('guard_heavy@s.whatsapp.net', '.#rolls', '', { now: 3000 });
    assert(heavyFirst.ok && !heavySecond.ok && heavySecond.retryMs >= 1000, 'Cooldown pesado deveria durar mais que comando comum.');

    const lockKey = getCriticalLockKey('guard_lock@s.whatsapp.net', '.#sortear', '');
    assert(lockKey, 'Comando critico deveria gerar lock por jogador.');

    let releaseLock;
    const running = runWithCommandLock(lockKey, () => new Promise((resolve) => {
        releaseLock = () => resolve('done');
    }));
    const blocked = await runWithCommandLock(lockKey, async () => 'duplicated');
    assert(blocked.locked, 'Lock critico deveria bloquear execucao duplicada simultanea.');
    releaseLock();
    const finished = await running;
    assert(!finished.locked && finished.result === 'done', 'Lock critico deveria liberar depois da execucao.');
}

function buildFichaBody({
    rollNumber,
    familyName,
    magic = '',
    appearance = 'Smoke Clover - Obra Teste',
    anomaly = '-',
    gender = 'Masculino',
    playerAge = 22,
    characterAge = 18,
}) {
    return [
        '.#Ficha pessoal',
        '     --  dados do jogador  --',
        '',
        '*Nome:* Jogador Smoke',
        `*Idade:* ${playerAge}`,
        '*O que gosta de fazer:* Testar fluxo do bot',
        '*Disponibilidade detalhada:* Noites de semana e domingos',
        '',
        '     --  dados do personagem  --',
        '',
        '*Nome:* Smoke Clover',
        `*Idade:* ${characterAge}`,
        `*Aparencia:* ${appearance}`,
        `*Genero:* ${gender}`,
        `*Numero do Roll:* ${rollNumber}`,
        `*Familia:* ${familyName}`,
        `*Magia:* ${magic}`,
        '',
        '     --  aptidao, marca e anomalia  --',
        '',
        '*Aptidao:* Voz de Salão',
        '*Marca:* Cria da Fronteira',
        `*Anomalia:* ${anomaly}`,
    ].join('\n');
}

async function main() {
    loadCloverConfigs({ forceReload: true });
    validateGeneratedRaceClassRules();
    validateFamilyCapacities();
    validateFinalAnomalies();
    validateRareGrimoiresEnabled();
    validateMagicListenerRules();
    validatePartialMagicSearch();
    validateRareRollImageRules();
    validateWelcomeDebounce();
    await validateCommandGuards();

    const db = await createMemoryDb();
    const sock = createFakeSock();
    const comandos = [
        ajudaCommand,
        startCommand,
        sortearCommand,
        sacrificarCommand,
        rollsCommand,
        fichaCommand,
        statusCommand,
        magiaCommand,
        aparenciaCommand,
        racasCommand,
        classesCommand,
        reinosCommand,
        grimoriosCommand,
        familiasCommand,
        tracosCommand,
        confirmarCommand,
        { nome: '.#fisico', descricao: 'Comando de jogador normal.' },
        { nome: '.#perfil', descricao: 'Comando de jogador normal.' },
    ];
    const context = {
        db,
        sock,
        playerId: 'smoke_player@s.whatsapp.net',
        name: 'Smoke Player',
        comandos,
    };

    await withMockedRandomAsync([0.99, 0, 0, 0, 0.999], async () => {
        const heartRoll = await generateAvailableBaseRoll(db, 1);
        assert(heartRoll.kingdomKey === 'heart', 'Smoke deveria forcar roll de Heart.');
        assert(heartRoll.magicRarityKey !== 'lendaria', 'Heart nao deveria sortear raridade lendaria.');
    });

    const legendaryDb = await createMemoryDb();
    await fillAllMagicSlotsForRarity(legendaryDb, 'Lendaria');
    await withMockedRandomAsync([0, 0, 0, 0, 0.999], async () => {
        const noLegendaryRoll = await generateAvailableBaseRoll(legendaryDb, 1);
        assert(noLegendaryRoll.kingdomKey === 'clover', 'Smoke deveria forcar roll de Clover.');
        assert(noLegendaryRoll.magicRarityKey !== 'lendaria', 'Lendaria lotada nao deveria aparecer no roll.');
    });
    await legendaryDb.close();

    const failingRollContext = {
        ...context,
        sock: createFailingSock(),
        playerId: 'smoke_send_fail_roll@s.whatsapp.net',
        name: 'Smoke Fail Roll',
    };
    let failedSend = false;
    try {
        await runCommand(sortearCommand, failingRollContext);
    } catch (error) {
        failedSend = String(error?.message || error).includes('Connection Closed');
    }
    assert(failedSend, 'Falha de envio em .#sortear deveria propagar Connection Closed.');
    const rollsAfterFailedSend = await db.get('SELECT COUNT(*) AS total FROM player_rolls WHERE player_id = ?', [failingRollContext.playerId]);
    assert(Number(rollsAfterFailedSend.total || 0) === 0, '.#sortear com envio falho nao deveria contar/salvar roll.');

    const failingTraitContext = {
        ...context,
        sock: createFailingSock(),
        playerId: 'smoke_send_fail_traits@s.whatsapp.net',
        name: 'Smoke Fail Traits',
        body: 'tentar anomalia',
    };
    failedSend = false;
    try {
        await runCommand(tracosCommand, failingTraitContext);
    } catch (error) {
        failedSend = String(error?.message || error).includes('Connection Closed');
    }
    assert(failedSend, 'Falha de envio em .#tracos tentar deveria propagar Connection Closed.');
    const attemptsAfterFailedSend = await db.get('SELECT COUNT(*) AS total FROM clover_trait_attempts WHERE player_id = ?', [failingTraitContext.playerId]);
    assert(Number(attemptsAfterFailedSend.total || 0) === 0, '.#tracos tentar com envio falho nao deveria contar/salvar tentativa.');

    await runCommand(ajudaCommand, context);
    const helpText = normalizeText(latestText(sock));
    assert(helpText.includes('menu da recepcao'), '.#ajuda deveria mostrar Menu da Recepcao.');
    assert(helpText.includes('sortear'), '.#ajuda de jogador novo deveria mostrar recepcao.');
    assert(helpText.includes('status'), '.#ajuda deveria listar .#status.');
    assert(!helpText.includes('fisico') && !helpText.includes('perfil'), '.#ajuda de jogador novo nao deveria mostrar comandos normais inutilizaveis.');

    let beforeCommand = sock.sent.length;
    await runCommand(statusCommand, context);
    const statusText = normalizeText(textSince(sock, beforeCommand));
    assert(statusText.includes('status do cadastro'), '.#status deveria mostrar o painel de progresso.');
    assert(statusText.includes('proximo passo'), '.#status deveria apontar o proximo passo.');

    beforeCommand = sock.sent.length;
    await runCommand(racasCommand, context);
    assert(normalizeText(textSince(sock, beforeCommand)).includes('humano'), '.#racas deveria listar Humano.');

    beforeCommand = sock.sent.length;
    await runCommand(classesCommand, context);
    const classesText = normalizeText(textSince(sock, beforeCommand));
    assert(classesText.includes('humano') && classesText.includes('classe'), '.#classes deveria orientar classe social para Humano.');

    beforeCommand = sock.sent.length;
    await runCommand(reinosCommand, context);
    assert(normalizeText(textSince(sock, beforeCommand)).includes('clover'), '.#reinos deveria listar Clover.');

    beforeCommand = sock.sent.length;
    await runCommand(grimoriosCommand, context);
    assert(normalizeText(textSince(sock, beforeCommand)).includes('folhas'), '.#grimorios deveria listar grimorios de Folhas.');

    beforeCommand = sock.sent.length;
    await runCommand(tracosCommand, context);
    const tracosText = normalizeText(textSince(sock, beforeCommand));
    assert(tracosText.includes('sistema de tracos') && tracosText.includes('sorteio de tracos'), '.#tracos deveria usar o texto oficial completo.');
    assert(tracosText.includes('mente matematica') && tracosText.includes('feitico de confianca'), '.#tracos deveria manter descricoes de aptidoes e marcas.');
    assert(tracosText.includes('sem mana') && tracosText.includes('(0/2)'), '.#tracos deveria listar anomalias com vagas do sistema.');

    const traitAttemptContext = {
        ...context,
        playerId: 'smoke_trait_attempt@s.whatsapp.net',
        body: 'tentar anomalia',
    };
    await runCommand(tracosCommand, traitAttemptContext);
    const savedAttempt = await db.get(
        `SELECT category, result
         FROM clover_trait_attempts
         WHERE player_id = ?`,
        [traitAttemptContext.playerId]
    );
    assert(savedAttempt?.category === 'anomaly', '.#tracos tentar anomalia deveria salvar tentativa.');

    await runCommand(startCommand, context);
    assert(sock.sent.length >= 2, '.#start deveria enviar resposta.');
    const startText = normalizeText(latestText(sock));
    ['reinos', 'racas', 'classes', 'grimorios', 'familias', 'tracos'].forEach((commandName) => {
        assert(startText.includes(commandName), `.#start deveria recomendar .#${commandName}.`);
    });
    assert(startText.includes('continuar'), '.#start deveria orientar .#continuar.');
    assert(looksLikeProfileSubmission('texto antes\n#Ficha pessoal\n*Nome:* X'), 'Mensagem contendo #Ficha pessoal deveria ser reconhecida como ficha.');

    const sacrificeContext = {
        ...context,
        playerId: 'smoke_sacrifice@s.whatsapp.net',
        name: 'Smoke Sacrifice',
        body: '',
    };
    for (let index = 0; index < MAX_PLAYER_ROLLS; index += 1) {
        await runCommand(sortearCommand, sacrificeContext);
    }
    await runCommand(sacrificarCommand, sacrificeContext);
    assert(normalizeText(latestText(sock)).includes('sacrificio de rolls'), '.#sacrificar deveria explicar o risco antes de confirmar.');
    await runCommand(sacrificarCommand, { ...sacrificeContext, body: 'confirmar' });
    const sacrificeRolls = await listPlayerRolls(db, sacrificeContext.playerId);
    assert(sacrificeRolls.length === 1 && Number(sacrificeRolls[0].roll_number) === 5, 'Sacrificio deveria trocar 4 rolls por roll final #5.');
    const sacrificePlayer = await db.get('SELECT roll_sacrifice_used, numero_roll_escolhido FROM jogadores WHERE id = ?', [sacrificeContext.playerId]);
    assert(Number(sacrificePlayer.roll_sacrifice_used) === 1 && Number(sacrificePlayer.numero_roll_escolhido) === 5, 'Sacrificio deveria marcar caminho definitivo e selecionar roll #5.');
    assert(normalizeText(latestText(sock)).includes('roll final'), 'Sacrificio deveria avisar que o roll final foi gerado.');
    await runCommand(sortearCommand, sacrificeContext);
    assert(normalizeText(latestText(sock)).includes('nao da para sortear de novo'), 'Depois do sacrificio, .#sortear deveria ficar bloqueado.');
    await runCommand(fichaCommand, sacrificeContext);
    assert(normalizeText(latestText(sock)).includes('numero do roll:* 5'), '.#ficha deveria usar o roll final #5 automaticamente.');

    await withMockedRandomAsync([0, 0.99, 0.95, 0.01], async () => {
        await runCommand(sortearCommand, context);
        const text = latestText(sock);
        assert(normalizeText(text).includes('roll'), '.#sortear deveria responder com roll salvo.');
        assert(normalizeText(text).includes('proximo passo'), '.#sortear deveria orientar o proximo passo automaticamente.');
        assert(!normalizeText(text).includes('famil'), '.#sortear nao deveria mostrar familia.');
        const latestMessage = sock.sent[sock.sent.length - 1]?.message || {};
        assert(latestMessage.image && latestMessage.caption, 'Roll raro deveria enviar imagem e texto na mesma mensagem.');
    });

    for (let index = 1; index < MAX_PLAYER_ROLLS; index += 1) {
        await runCommand(sortearCommand, context);
        const text = latestText(sock);
        assert(normalizeText(text).includes('roll'), '.#sortear deveria responder com roll salvo.');
        assert(normalizeText(text).includes('proximo passo'), '.#sortear deveria orientar o proximo passo automaticamente.');
        assert(!normalizeText(text).includes('famil'), '.#sortear nao deveria mostrar familia.');
    }

    await runCommand(sortearCommand, context);
    assert(await db.get('SELECT COUNT(*) AS total FROM player_rolls WHERE player_id = ?', [context.playerId])
        .then((row) => row.total) === MAX_PLAYER_ROLLS, '.#sortear deveria respeitar limite de 4 rolls.');

    await runCommand(rollsCommand, context);
    const rollsText = latestText(sock);
    assert(normalizeText(rollsText).includes('roll'), '.#rolls deveria listar rolls salvos.');
    assert(!normalizeText(rollsText).includes('familia / origem'), '.#rolls nao deveria listar familia do roll.');

    await runCommand(fichaCommand, context);
    assert(normalizeText(latestText(sock)).includes('ficha <numero do roll>'), '.#ficha sem numero deveria orientar escolha quando ha varios rolls.');

    await runCommand(fichaCommand, { ...context, body: '1' });
    const fichaText = latestText(sock);
    assert(normalizeText(fichaText).includes('famil'), '.#ficha deveria enviar campo Familia.');
    assert(normalizeText(fichaText).includes('disponibilidade detalhada'), '.#ficha deveria enviar campo Disponibilidade detalhada.');
    assert(normalizeText(fichaText).includes('numero do roll:* 1'), '.#ficha 1 deveria preencher Numero do Roll.');
    assert(normalizeText(fichaText).includes('roll escolhido'), '.#ficha 1 deveria mostrar resumo do roll escolhido.');
    assert(normalizeText(fichaText).includes('magia:'), '.#ficha deveria enviar campo Magia.');
    assert(!normalizeText(fichaText).includes('tentativa especial 1'), '.#ficha nao deveria mostrar Tentativa Especial no modelo clean.');
    assert(!normalizeText(fichaText).includes('aptidao rara') && !normalizeText(fichaText).includes('marca rara'), '.#ficha nao deveria separar tracos raros em campos extras.');
    assert(normalizeText(fichaText).includes('anomalia'), '.#ficha deveria enviar campo Anomalia.');

    await db.run(
        `UPDATE player_rolls
         SET kingdom = 'Clover',
             kingdom_key = 'clover',
             social_class = 'Nobreza',
             social_class_key = 'nobreza',
             race = 'Humano',
             race_key = 'humano',
             magic_rarity = 'Lendaria',
             magic_rarity_key = 'lendaria'
         WHERE player_id = ? AND roll_number = 1`,
        [context.playerId]
    );
    await db.run(
        `UPDATE player_rolls
         SET kingdom = 'Clover',
             kingdom_key = 'clover',
             social_class = 'N/A',
             social_class_key = 'nao_se_aplica',
             race = 'Bruxa',
             race_key = 'bruxa',
             magic_rarity = 'Comum',
             magic_rarity_key = 'comum'
         WHERE player_id = ? AND roll_number = 2`,
        [context.playerId]
    );
    await db.run(
        `UPDATE player_rolls
         SET magic_rarity = 'Comum', magic_rarity_key = 'comum'
         WHERE player_id = ? AND roll_number IN (3, 4)`,
        [context.playerId]
    );
    await db.run(
        'UPDATE jogadores SET numero_roll_escolhido = 1 WHERE id = ?',
        [context.playerId]
    );

    const roll = await getPlayerRollByNumber(db, context.playerId, 1);
    const nonHumanRoll = await getPlayerRollByNumber(db, context.playerId, 2);
    assert(roll.race_key === 'humano' && roll.social_class_key !== 'nao_se_aplica', 'Roll humano deveria manter classe social.');
    assert(nonHumanRoll.race_key !== 'humano' && nonHumanRoll.social_class === 'N/A', 'Roll nao humano deveria ficar com classe N/A.');

    await db.run(
        `UPDATE player_rolls
         SET magic_rarity = 'Comum', magic_rarity_key = 'comum'
         WHERE player_id = ? AND roll_number = 1`,
        [context.playerId]
    );
    await runCommand(magiaCommand, { ...context, body: '' });
    const allMagicsText = normalizeText(latestText(sock));
    assert(allMagicsText.includes('magia de corte') && allMagicsText.includes('acima do roll'), '.#magias deveria mostrar todas as magias e marcar bloqueadas.');

    await runCommand(magiaCommand, { ...context, body: 'Magia de Corte' });
    assert(normalizeText(latestText(sock)).includes('responda a mensagem de magias'), 'Comando de magia com nome solto deveria pedir reply na lista do bot.');

    await runCommand(magiaCommand, { ...context, body: 'Magia de Corte', m: buildMagicReplyMessage('Magia de Corte') });
    assert(normalizeText(latestText(sock)).includes('bloqueada'), 'Reservar magia acima da raridade do roll deveria bloquear.');

    await db.run(
        `UPDATE player_rolls
         SET magic_rarity = 'Lendaria', magic_rarity_key = 'lendaria'
         WHERE player_id = ? AND roll_number = 1`,
        [context.playerId]
    );
    await db.run('UPDATE jogadores SET numero_roll_escolhido = 1 WHERE id = ?', [context.playerId]);

    beforeCommand = sock.sent.length;
    await runCommand(familiasCommand, context);
    const familiasText = normalizeText(textSince(sock, beforeCommand));
    assert(familiasText.includes('vangeance') && familiasText.includes('[0/2]'), '.#familias deveria listar familias compativeis com Clover/Nobreza.');
    assert(familiasText.includes('compativeis com seu roll'), '.#familias deveria destacar compativeis com o roll.');
    assert(familiasText.includes('vermillion') && familiasText.includes('silva'), '.#familias deveria listar todas as familias cadastradas.');
    assert(familiasText.includes('feramena') && familiasText.includes('cristal de fortalecimento'), '.#familias deveria listar Diamond oficial com descricao.');
    assert(familiasText.includes('salario familiar') && familiasText.includes('bonus'), '.#familias deveria manter descricoes completas das familias.');

    const family = findCompatibleFamily(roll);
    const magic = pickMagicForRoll(roll);
    const magicKey = getMagicSlotKey(magic.label);

    const ageContext = {
        ...context,
        playerId: 'smoke_age@s.whatsapp.net',
        name: 'Smoke Age',
        body: '',
    };
    await runCommand(sortearCommand, ageContext);
    await db.run(
        `UPDATE player_rolls
         SET kingdom = 'Clover',
             kingdom_key = 'clover',
             social_class = 'Nobreza',
             social_class_key = 'nobreza',
             race = 'Humano',
             race_key = 'humano',
             magic_rarity = 'Lendaria',
             magic_rarity_key = 'lendaria'
         WHERE player_id = ? AND roll_number = 1`,
        [ageContext.playerId]
    );
    ageContext.body = buildFichaBody({
        rollNumber: 1,
        familyName: family.name,
        magic: 'pintura',
        appearance: 'Smoke Age - Obra Teste',
        playerAge: 1,
        characterAge: 14,
    });
    await runCommand(fichaPessoalCommand, ageContext);
    assert(normalizeText(latestText(sock)).includes('minimo 15'), 'Idade do personagem abaixo de 15 deveria ser recusada.');

    ageContext.body = buildFichaBody({
        rollNumber: 1,
        familyName: family.name,
        magic: 'pintura',
        appearance: 'Smoke Age - Obra Teste',
        playerAge: 1,
        characterAge: 15,
    });
    await runCommand(fichaPessoalCommand, ageContext);
    const agePending = await db.get('SELECT payload FROM pending_profile_confirmations WHERE player_id = ?', [ageContext.playerId]);
    assert(agePending, 'Idade pessoal baixa deveria ser aceita quando a idade do personagem tem minimo 15.');

    const heartContext = {
        ...context,
        playerId: 'smoke_heart@s.whatsapp.net',
        name: 'Smoke Heart',
        body: '',
    };
    await runCommand(sortearCommand, heartContext);
    await db.run(
        `UPDATE player_rolls
         SET kingdom = 'Heart',
             kingdom_key = 'heart',
             social_class = 'Plebeu',
             social_class_key = 'plebeu',
             race = 'Humano',
             race_key = 'humano',
             magic_rarity = 'Lendaria',
             magic_rarity_key = 'lendaria'
         WHERE player_id = ? AND roll_number = 1`,
        [heartContext.playerId]
    );

    const messagesBeforeHeartNonElemental = sock.sent.length;
    heartContext.body = buildFichaBody({
        rollNumber: 1,
        familyName: 'Sem linhagem registrada',
        magic: 'Pintura',
        appearance: 'Smoke Heart - Obra Teste',
    });
    await runCommand(fichaPessoalCommand, heartContext);
    const heartNonElementalText = normalizeText(textSince(sock, messagesBeforeHeartNonElemental));
    assert(heartNonElementalText.includes('aviso de heart'), 'Heart com magia nao elemental deveria receber aviso.');
    assert(heartNonElementalText.includes('perder parte desses beneficios'), 'Aviso de Heart deveria explicar perda de beneficios.');

    const messagesBeforeHeartElemental = sock.sent.length;
    heartContext.body = buildFichaBody({
        rollNumber: 1,
        familyName: 'Sem linhagem registrada',
        magic: 'Fogo',
        appearance: 'Smoke Heart - Obra Teste',
    });
    await runCommand(fichaPessoalCommand, heartContext);
    const heartElementalText = normalizeText(textSince(sock, messagesBeforeHeartElemental));
    assert(!heartElementalText.includes('aviso de heart'), 'Heart com magia elemental nao deveria receber aviso.');

    await runCommand(magiaCommand, { ...context, body: magic.label, m: buildMagicReplyMessage(magic.label) });

    context.body = buildFichaBody({
        rollNumber: 1,
        familyName: family.name,
        magic: magic.label,
        appearance: 'Smoke Clover - Obra Teste',
    });
    const messagesBeforeFichaValidation = sock.sent.length;
    await runCommand(fichaPessoalCommand, context);
    const pending = await db.get('SELECT payload FROM pending_profile_confirmations WHERE player_id = ?', [context.playerId]);
    assert(pending, 'Ficha valida deveria gerar confirmacao pendente.');
    const pendingAppearance = await db.get(
        'SELECT personagem_aparencia_status FROM jogadores WHERE id = ?',
        [context.playerId]
    );
    assert(pendingAppearance.personagem_aparencia_status === 'pending', 'Ficha com aparencia deveria criar status pending.');
    const fichaValidationMessages = sock.sent.slice(messagesBeforeFichaValidation);
    const receptionAppearanceNotice = fichaValidationMessages.find((item) => (
        item.idChat === 'smoke-group@g.us'
        && normalizeText(item.message?.text || item.message?.caption).includes('aparencia pendente')
        && normalizeLooseText(item.message?.text || item.message?.caption).includes('smoke clover obra teste')
    ));
    assert(!receptionAppearanceNotice, 'Ficha validada nao deveria enviar aparencia pendente antes do confirmar.');
    const privateInstruction = fichaValidationMessages.find((item) => (
        item.idChat === context.playerId
        && normalizeText(item.message?.text).includes('historia e personalidade')
        && normalizeText(item.message?.text).includes('lore pessoal')
    ));
    assert(!privateInstruction, 'Ficha OK nao deveria gerar instrucao no privado antes do confirmar.');

    await runCommand(fichaCommand, { ...context, body: '1' });
    const reusedFichaText = normalizeText(latestText(sock));
    assert(reusedFichaText.includes('smoke clover - obra teste'), 'Campos salvos deveriam reaparecer ao pedir ficha novamente.');
    assert(reusedFichaText.includes('numero do roll:* 1'), 'Roll escolhido deveria reaparecer ao pedir ficha novamente.');
    assert(reusedFichaText.includes(normalizeText(magic.label)), 'Magia escolhida deveria reaparecer preenchida na ficha.');

    if (magic.capacity) {
        const reservation = await db.get(
            `SELECT status, expires_at
             FROM slot_reservations
             WHERE player_id = ? AND category = 'magic' AND option_key = ? AND status IN ('pending', 'confirmed')`,
            [context.playerId, magicKey]
        );
        assert(!reservation, 'Magia limitada nao deveria criar reserva antes do confirmar.');
    }

    const messagesBeforeLooseImage = sock.sent.length;
    const imageAttached = await tryAttachAppearanceImage({
        sock,
        db,
        idChat: 'smoke-group@g.us',
        playerId: context.playerId,
        downloadMediaMessage: async () => Buffer.from('appearance-image'),
        loggerFactory: () => ({ level: 'silent' }),
        m: {
            key: { id: 'appearance-image-message', remoteJid: 'smoke-group@g.us', participant: context.playerId },
            message: { imageMessage: { mimetype: 'image/png' } },
        },
    });
    assert(!imageAttached, 'Imagem solta nao deveria ser tratada como aparencia.');
    assert(sock.sent.length === messagesBeforeLooseImage, 'Imagem solta nao deveria gerar resposta do bot.');
    const attachedAppearance = await db.get(
        'SELECT personagem_aparencia_image_path FROM jogadores WHERE id = ?',
        [context.playerId]
    );
    assert(!attachedAppearance.personagem_aparencia_image_path, 'Imagem solta nao deveria ser salva na aparencia.');

    await runCommand(cancelarCommand, { ...context, body: '' });
    const cancelledPending = await db.get('SELECT payload FROM pending_profile_confirmations WHERE player_id = ?', [context.playerId]);
    assert(!cancelledPending, '.#cancelarFicha deveria remover ficha pendente.');
    const afterCancel = await db.get('SELECT personagem_aparencia_normalizada FROM jogadores WHERE id = ?', [context.playerId]);
    assert(!afterCancel.personagem_aparencia_normalizada, '.#cancelarFicha nao deveria registrar aparencia.');
    if (magic.capacity) {
        const activeMagicSlot = await db.get(
            `SELECT status
             FROM slot_reservations
             WHERE player_id = ? AND category = 'magic' AND option_key = ?
               AND status IN ('pending', 'confirmed')
             ORDER BY id DESC LIMIT 1`,
            [context.playerId, magicKey]
        );
        assert(!activeMagicSlot, '.#cancelarFicha nao deveria deixar vaga de magia ativa antes do confirmar.');
    }

    const orphanImageMessagesBefore = sock.sent.length;
    const orphanImageHandled = await tryAttachAppearanceImage({
        sock,
        db,
        idChat: 'smoke-group@g.us',
        playerId: 'orphan_image@s.whatsapp.net',
        downloadMediaMessage: async () => Buffer.from('orphan-image'),
        loggerFactory: () => ({ level: 'silent' }),
        m: {
            key: { id: 'orphan-image-message', remoteJid: 'smoke-group@g.us', participant: 'orphan_image@s.whatsapp.net' },
            message: { imageMessage: { mimetype: 'image/png' } },
        },
    });
    assert(!orphanImageHandled, 'Imagem solta de outro player nao deveria ser tratada.');
    assert(sock.sent.length === orphanImageMessagesBefore, 'Imagem solta de outro player nao deveria gerar resposta.');

    await runCommand(magiaCommand, { ...context, body: magic.label, m: buildMagicReplyMessage(magic.label) });
    context.body = buildFichaBody({
        rollNumber: 1,
        familyName: family.name,
        appearance: 'Smoke Clover - Obra Teste',
    });
    await runCommand(fichaPessoalCommand, context);

    if (magic.capacity) {
        await db.run(
            `UPDATE slot_reservations
             SET expires_at = datetime('now', '-2 hours')
             WHERE player_id = ? AND category = 'magic' AND status = 'pending'`,
            [context.playerId]
        );
        await db.run(
            `UPDATE pending_magic_confirmations
             SET created_at = datetime('now', '-2 hours')
             WHERE player_id = ?`,
            [context.playerId]
        );
        await db.run(
            `UPDATE player_onboarding
             SET current_step = 'confirmar_magia'
             WHERE player_id = ?`,
            [context.playerId]
        );

        await runCommand(continuarCommand, { ...context, body: '' });
        const continueText = normalizeText(latestText(sock));
        assert(continueText.includes('continuar') && continueText.includes('proximo passo'), '.#continuar deveria usar modelo GPS.');
        assert(continueText.includes('escolha'), '.#continuar deveria avisar escolha de magia expirada.');

        await runCommand(magiaCommand, { ...context, body: magic.label, m: buildMagicReplyMessage(magic.label) });
    }

    await runCommand(confirmarCommand, { ...context, body: '' });
    const player = await db.get('SELECT * FROM jogadores WHERE id = ?', [context.playerId]);
    assert(player.ficha_status === 'aprovada', '.#confirmar deveria aprovar ficha final.');
    assert(player.personagem_aparencia_status === 'pending', '.#confirmar deveria manter aparencia pendente sem bloquear recepcao.');
    assert(player.familia_key === family.key, '.#confirmar deveria gravar familia.');
    assert(player.magia_key === magicKey, '.#confirmar deveria gravar magia.');
    assert(player.personagem_aparencia_normalizada === 'smoke clover obra teste', '.#confirmar deveria registrar aparencia normalizada.');
    assert(normalizeText(latestText(sock)).includes('nenhum grupo de registro clover'), 'Confirmacao nao deveria quebrar sem grupo de registro configurado.');

    const storedRolls = await listPlayerRolls(db, context.playerId);
    assert(storedRolls.length === MAX_PLAYER_ROLLS, 'Rolls salvos deveriam continuar acessiveis apos confirmacao.');

    await runCommand(confirmarCommand, { ...context, body: '' });
    assert(normalizeText(latestText(sock)).includes('ja estava confirmada'), '.#confirmarFicha duplicado deveria responder de forma idempotente.');

    await runCommand(aparenciaCommand, {
        ...context,
        body: 'Nova Aparencia — Obra Nova',
    });
    const updatedAppearance = await db.get(
        'SELECT personagem_aparencia, personagem_aparencia_status FROM jogadores WHERE id = ?',
        [context.playerId]
    );
    assert(updatedAppearance.personagem_aparencia === 'Nova Aparencia — Obra Nova', '.#aparencia deveria trocar somente a aparencia.');
    assert(updatedAppearance.personagem_aparencia_status === 'pending', '.#aparencia deveria voltar status para pending.');
    const appearanceReviewNotice = [...sock.sent].reverse().find((item) => (
        item.idChat === 'smoke-group@g.us'
        && normalizeText(item.message?.text || item.message?.caption).includes('aparencia pendente')
        && normalizeLooseText(item.message?.text || item.message?.caption).includes('nova aparencia obra nova')
    ));
    assert(appearanceReviewNotice?.response?.key?.id, '.#aparencia deveria gerar mensagem curta avaliavel.');

    const reviewImageAttached = await tryAttachAppearanceImage({
        sock,
        db,
        idChat: 'smoke-group@g.us',
        playerId: context.playerId,
        downloadMediaMessage: async () => Buffer.from('review-appearance-image'),
        loggerFactory: () => ({ level: 'silent' }),
        m: {
            key: { id: 'appearance-review-image-message', remoteJid: 'smoke-group@g.us', participant: context.playerId },
            message: {
                imageMessage: {
                    mimetype: 'image/png',
                    contextInfo: {
                        stanzaId: appearanceReviewNotice.response.key.id,
                        quotedMessage: { conversation: appearanceReviewNotice.message.text || appearanceReviewNotice.message.caption },
                    },
                },
            },
        },
    });
    assert(reviewImageAttached, 'Imagem respondendo aviso de aparencia deveria ser anexada.');
    const reviewImagePlayer = await db.get(
        'SELECT personagem_aparencia_image_path FROM jogadores WHERE id = ?',
        [context.playerId]
    );
    assert(reviewImagePlayer.personagem_aparencia_image_path, 'Imagem por reply em aviso de aparencia deveria ser salva.');

    const approvedByReply = await tryHandleAppearanceReviewReply({
        sock,
        db,
        idChat: 'smoke-group@g.us',
        reviewerId: 'admin@s.whatsapp.net',
        text: 'ok',
        m: {
            key: { id: 'admin-reply-ok', remoteJid: 'smoke-group@g.us', participant: 'admin@s.whatsapp.net' },
            message: {
                extendedTextMessage: {
                    text: 'ok',
                    contextInfo: {
                        stanzaId: appearanceReviewNotice.response.key.id,
                        quotedMessage: { conversation: appearanceReviewNotice.message.text || appearanceReviewNotice.message.caption },
                    },
                },
            },
        },
    });
    assert(approvedByReply, 'ADM respondendo ok na recepcao deveria aprovar aparencia.');
    const approvedAppearance = await db.get(
        'SELECT personagem_aparencia_status, personagem_aparencia_approved_by FROM jogadores WHERE id = ?',
        [context.playerId]
    );
    assert(approvedAppearance.personagem_aparencia_status === 'approved', 'Reply ok deveria marcar aparencia como approved.');

    const lateReview = await tryHandleAppearanceReviewReply({
        sock,
        db,
        idChat: 'smoke-group@g.us',
        reviewerId: 'admin@s.whatsapp.net',
        text: 'negado: tarde',
        m: {
            key: { id: 'admin-reply-late', remoteJid: 'smoke-group@g.us', participant: 'admin@s.whatsapp.net' },
            message: {
                extendedTextMessage: {
                    text: 'negado: tarde',
                    contextInfo: {
                        stanzaId: appearanceReviewNotice.response.key.id,
                        quotedMessage: { conversation: appearanceReviewNotice.message.text || appearanceReviewNotice.message.caption },
                    },
                },
            },
        },
    });
    assert(lateReview, 'Avaliacao atrasada deveria ser reconhecida e ignorada.');
    assert(normalizeText(latestText(sock)).includes('ja avaliada'), 'Avaliacao atrasada deveria avisar que ja foi avaliada.');

    const limitedContext = {
        ...context,
        playerId: 'smoke_limited@s.whatsapp.net',
        name: 'Smoke Limited',
        body: '',
    };
    await runCommand(sortearCommand, limitedContext);
    await db.run(
        `UPDATE player_rolls
         SET kingdom = 'Clover',
             kingdom_key = 'clover',
             social_class = 'N/A',
             social_class_key = 'nao_se_aplica',
             race = 'Bruxa',
             race_key = 'bruxa',
             grimoire = 'Grimorio de 5 Folhas',
             grimoire_key = 'clover_demonic',
             magic_rarity = 'Comum',
             magic_rarity_key = 'comum'
         WHERE player_id = ? AND roll_number = 1`,
        [limitedContext.playerId]
    );
    await savePendingMagicConfirmation(db, limitedContext.playerId, 'Magia de Algodao', 1);
    limitedContext.body = buildFichaBody({
        rollNumber: 1,
        familyName: '-',
        appearance: 'Smoke Limited - Obra Teste',
        gender: 'Feminijuo',
    });
    await runCommand(fichaPessoalCommand, limitedContext);
    await runCommand(confirmarCommand, { ...limitedContext, body: '' });
    const limitedPlayer = await db.get('SELECT ficha_status, personagem_genero FROM jogadores WHERE id = ?', [limitedContext.playerId]);
    assert(limitedPlayer.ficha_status === 'aprovada', 'Ficha com raca/grimorio limitado livres deveria aprovar.');
    assert(limitedPlayer.personagem_genero === 'Feminino', 'Genero Feminijuo deveria normalizar para Feminino.');
    assert(await countUsedSlots(db, 'race', 'bruxa') === 1, 'Raca limitada deveria ocupar ao confirmar.');
    assert(await countUsedSlots(db, 'grimoire', 'clover_demonic') === 1, 'Grimorio limitado deveria ocupar ao confirmar.');

    for (let index = 0; index < 8; index += 1) {
        const occupied = await occupySlot(db, `race_filler_${index}`, 'race', 'bruxa', 'smoke_fill', 1);
        assert(occupied.ok, 'Preenchimento de raca limitada deveria ocupar vaga livre.');
    }
    assert(await countUsedSlots(db, 'race', 'bruxa') === 9, 'Bruxa deveria ficar lotada em 9/9.');

    const cappedContext = {
        ...context,
        playerId: 'smoke_capped@s.whatsapp.net',
        name: 'Smoke Capped',
        body: '',
    };
    await withMockedRandomAsync([0, 0.7, 0, 0.999, 0], async () => {
        await runCommand(sortearCommand, cappedContext);
    });
    const cappedRoll = await getPlayerRollByNumber(db, cappedContext.playerId, 1);
    assert(cappedRoll.race_key !== 'bruxa', 'Raca lotada nao deveria aparecer em novos rolls.');
    assert(cappedRoll.grimoire_key !== 'clover_demonic', 'Grimorio lotado nao deveria aparecer em novos rolls.');

    const duplicateContext = {
        ...context,
        playerId: 'smoke_duplicate@s.whatsapp.net',
        name: 'Smoke Duplicate',
        body: '',
    };
    await runCommand(sortearCommand, duplicateContext);
    await db.run(
        `UPDATE player_rolls
         SET kingdom = 'Clover',
             kingdom_key = 'clover',
             social_class = 'Plebeu',
             social_class_key = 'plebeu',
             race = 'Humano',
             race_key = 'humano',
             magic_rarity = 'Comum',
             magic_rarity_key = 'comum'
         WHERE player_id = ? AND roll_number = 1`,
        [duplicateContext.playerId]
    );
    await savePendingMagicConfirmation(db, duplicateContext.playerId, 'Magia de Algodao', 1);
    duplicateContext.body = buildFichaBody({
        rollNumber: 1,
        familyName: 'Sem linhagem registrada',
        appearance: 'Smoke Clover — Obra Teste',
    });
    await runCommand(fichaPessoalCommand, duplicateContext);
    await db.run(
        `INSERT INTO clover_settings (key, value, updated_at)
         VALUES ('registration_group_jid', 'smoke-register@g.us', CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
    );
    await runCommand(confirmarCommand, { ...duplicateContext, body: '' });
    const duplicatePlayer = await db.get('SELECT ficha_status, personagem_aparencia_status FROM jogadores WHERE id = ?', [duplicateContext.playerId]);
    assert(duplicatePlayer.ficha_status === 'aprovada', 'Aparencia repetida nao deveria bloquear recepcao base.');
    assert(duplicatePlayer.personagem_aparencia_status === 'pending', 'Aparencia repetida deveria ficar pendente para ADM humano.');
    const duplicateAppearanceNotice = [...sock.sent].reverse().find((item) => (
        item.idChat === 'smoke-register@g.us'
        && item.message?.mentions?.includes(duplicateContext.playerId)
        && normalizeText(item.message?.text || item.message?.caption).includes('aparencia pendente')
        && normalizeLooseText(item.message?.text || item.message?.caption).includes('smoke clover obra teste')
    ));
    assert(duplicateAppearanceNotice?.response?.key?.id, 'Aparencia repetida deveria gerar aviso pendente avaliavel.');
    const rejectedByReply = await tryHandleAppearanceReviewReply({
        sock,
        db,
        idChat: 'smoke-register@g.us',
        reviewerId: 'admin@s.whatsapp.net',
        text: 'negado: visual ja usado',
        m: {
            key: { id: 'admin-reply-reject', remoteJid: 'smoke-register@g.us', participant: 'admin@s.whatsapp.net' },
            message: {
                extendedTextMessage: {
                    text: 'negado: visual ja usado',
                    contextInfo: {
                        stanzaId: duplicateAppearanceNotice.response.key.id,
                        quotedMessage: { conversation: duplicateAppearanceNotice.message.text || duplicateAppearanceNotice.message.caption },
                    },
                },
            },
        },
    });
    assert(rejectedByReply, 'ADM respondendo negado: motivo deveria reprovar aparencia.');
    const rejectedAppearance = await db.get(
        'SELECT personagem_aparencia_status, personagem_aparencia_motivo FROM jogadores WHERE id = ?',
        [duplicateContext.playerId]
    );
    assert(rejectedAppearance.personagem_aparencia_status === 'rejected', 'Reply negado deveria marcar aparencia como rejected.');
    assert(rejectedAppearance.personagem_aparencia_motivo === 'visual ja usado', 'Motivo da negacao deveria ser salvo.');

    const anomalyContext = {
        ...context,
        playerId: 'smoke_anomaly@s.whatsapp.net',
        name: 'Smoke Anomaly',
        body: '',
    };
    await runCommand(sortearCommand, anomalyContext);
    await db.run(
        `UPDATE player_rolls
         SET kingdom = 'Clover',
             kingdom_key = 'clover',
             social_class = 'Plebeu',
             social_class_key = 'plebeu',
             race = 'Humano',
             race_key = 'humano',
             magic_rarity = 'Comum',
             magic_rarity_key = 'comum'
         WHERE player_id = ? AND roll_number = 1`,
        [anomalyContext.playerId]
    );
    await savePendingMagicConfirmation(db, anomalyContext.playerId, 'Magia de Algodao', 1);
    await db.run(
        `INSERT INTO clover_trait_attempts
         (player_id, attempt_number, category, status, result, chosen_key, created_at)
         VALUES (?, 1, 'anomaly', 'completed', 'success', 'sem_mana', CURRENT_TIMESTAMP)`,
        [anomalyContext.playerId]
    );
    anomalyContext.body = buildFichaBody({
        rollNumber: 1,
        familyName: 'Sem linhagem registrada',
        appearance: 'Smoke Anomaly - Obra Teste',
        anomaly: 'Sem Mana',
    });
    await runCommand(fichaPessoalCommand, anomalyContext);
    await db.run(
        `INSERT INTO clover_settings (key, value, updated_at)
         VALUES ('registration_group_jid', 'smoke-register@g.us', CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
    );
    const registerMessagesBefore = sock.sent.filter((item) => item.idChat === 'smoke-register@g.us').length;
    await runCommand(confirmarCommand, { ...anomalyContext, body: '' });
    const registerMessagesAfterFirst = sock.sent.filter((item) => item.idChat === 'smoke-register@g.us').length;
    assert(registerMessagesAfterFirst - registerMessagesBefore === 2, 'Confirmacao deveria enviar registro completo e aparencia pendente no grupo de registro.');
    const registrationAppearanceNotice = [...sock.sent].reverse().find((item) => (
        item.idChat === 'smoke-register@g.us'
        && normalizeText(item.message?.text || item.message?.caption).includes('aparencia pendente')
        && normalizeLooseText(item.message?.text || item.message?.caption).includes('smoke anomaly obra teste')
    ));
    assert(registrationAppearanceNotice?.response?.key?.id, 'Grupo de registro deveria receber mensagem curta avaliavel de aparencia.');

    const approvedByReaction = await tryHandleAppearanceReaction({
        sock,
        db,
        idChat: 'smoke-register@g.us',
        reviewerId: 'admin@s.whatsapp.net',
        m: {
            key: { id: 'reaction-ok', remoteJid: 'smoke-register@g.us', participant: 'admin@s.whatsapp.net' },
            message: {
                reactionMessage: {
                    text: '✅',
                    key: { id: registrationAppearanceNotice.response.key.id, remoteJid: 'smoke-register@g.us' },
                },
            },
        },
    });
    assert(approvedByReaction, 'Reacao ✅ no grupo de registro deveria aprovar aparencia.');

    const lateReaction = await tryHandleAppearanceReaction({
        sock,
        db,
        idChat: 'smoke-register@g.us',
        reviewerId: 'admin@s.whatsapp.net',
        m: {
            key: { id: 'reaction-late', remoteJid: 'smoke-register@g.us', participant: 'admin@s.whatsapp.net' },
            message: {
                reactionMessage: {
                    text: '❌',
                    key: { id: registrationAppearanceNotice.response.key.id, remoteJid: 'smoke-register@g.us' },
                },
            },
        },
    });
    assert(lateReaction, 'Reacao atrasada deveria ser reconhecida e ignorada.');

    const registerMessagesBeforeSecondConfirm = sock.sent.filter((item) => item.idChat === 'smoke-register@g.us').length;
    await runCommand(confirmarCommand, { ...anomalyContext, body: '' });
    const registerMessagesAfterSecond = sock.sent.filter((item) => item.idChat === 'smoke-register@g.us').length;
    assert(registerMessagesAfterSecond === registerMessagesBeforeSecondConfirm, 'Confirmacao duplicada nao deveria duplicar registro/aparencia no grupo.');
    assert(normalizeText(latestText(sock)).includes('ja estava confirmada'), 'Confirmacao duplicada deveria avisar ficha ja confirmada.');
    const anomalyPlayer = await db.get('SELECT ficha_status, anomalia_key FROM jogadores WHERE id = ?', [anomalyContext.playerId]);
    assert(anomalyPlayer.ficha_status === 'aprovada', 'Ficha com anomalia permitida deveria aprovar.');
    assert(anomalyPlayer.anomalia_key === 'sem_mana', 'Anomalia permitida deveria ser gravada.');

    await db.close();

    console.log('Smoke Clover onboarding passou com sucesso.');
}

main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
});
