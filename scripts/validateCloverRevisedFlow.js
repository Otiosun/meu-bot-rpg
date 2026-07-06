const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const { ensureCloverAppearanceReviewSchema, ensureCloverTraitAttemptsSchema, ensureSlotReservationsSchema } = require('../database');
const { loadCloverConfigs } = require('../helpers/clover/configLoader');
const { generateBaseRoll } = require('../helpers/clover/rollEngine');
const { countUsedSlots, occupySlot } = require('../helpers/clover/slotManager');
const { getAttemptsForPlayer, runSpecialAttempt, validateTraitSubmission } = require('../helpers/clover/traitManager');
const { createAndStoreRoll } = require('../helpers/rollManager');
const {
    clearPendingMagicConfirmation,
    findMagicOption,
    getAvailableMagicsForRoll,
    getMagicSlotKey,
    getPendingMagicConfirmation,
    savePendingMagicConfirmation,
} = require('../helpers/magicManager');
const { confirmPendingProfile, savePendingConfirmation } = require('../helpers/profileForms');

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
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

async function createMemoryDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });

    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT DEFAULT '-',
            idade TEXT DEFAULT '-',
            reino TEXT DEFAULT '-',
            classe TEXT DEFAULT '-',
            familia TEXT DEFAULT '-',
            raca TEXT DEFAULT '-',
            grimorio TEXT DEFAULT '-',
            magia TEXT DEFAULT '-',
            aparencia TEXT DEFAULT '-',
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
        CREATE TABLE pending_profile_confirmations (
            player_id TEXT PRIMARY KEY,
            payload TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
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
            roll_version TEXT DEFAULT 'clover_base_v1',
            kingdom_key TEXT DEFAULT NULL,
            social_class_key TEXT DEFAULT NULL,
            race_key TEXT DEFAULT NULL,
            grimoire_key TEXT DEFAULT NULL,
            magic_rarity_key TEXT DEFAULT NULL,
            roll_payload TEXT DEFAULT '{}',
            summary TEXT DEFAULT '-',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (player_id, roll_number)
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
    await ensureCloverAppearanceReviewSchema(db);

    return db;
}

async function insertRollForPayload(db, playerId, payload) {
    await db.run(
        `INSERT INTO player_rolls
         (player_id, roll_number, kingdom, social_class, family, race, grimoire, magic_rarity,
          kingdom_key, social_class_key, race_key, grimoire_key, magic_rarity_key)
         VALUES (?, ?, ?, ?, '-', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            playerId,
            payload.numeroRoll,
            payload.roll.kingdom,
            payload.roll.social_class,
            payload.roll.race,
            payload.roll.grimoire,
            payload.roll.magic_rarity,
            payload.roll.kingdom_key,
            payload.roll.social_class_key,
            payload.roll.race_key,
            payload.roll.grimoire_key,
            payload.roll.magic_rarity_key,
        ]
    );
}

function createProfilePayload({ playerId, familyKey = 'vangeance', familyName = 'Vangeance', magicLabel = 'Magia de Corte' } = {}) {
    const roll = {
        roll_number: 1,
        kingdom: 'Clover',
        kingdom_key: 'clover',
        social_class: 'Nobreza',
        social_class_key: 'nobreza',
        race: 'Humano',
        race_key: 'humano',
        grimoire: 'Trevo',
        grimoire_key: 'trevo',
        magic_rarity: 'Lendaria',
        magic_rarity_key: 'lendaria',
    };
    const magic = findMagicOption(getAvailableMagicsForRoll(roll), magicLabel);
    assert(magic, `Magia de teste nao encontrada: ${magicLabel}`);

    return {
        nomeReal: `Jogador ${playerId}`,
        idadeReal: 20,
        gostaDeFazer: 'Treinar magia',
        disponibilidadeDetalhada: 'Disponivel a noite durante a semana',
        personagemNome: `Personagem ${playerId}`,
        personagemIdade: 19,
        personagemAparencia: `Referencia visual exclusiva ${playerId}`,
        personagemAparenciaNormalizada: `referencia visual exclusiva ${playerId}`.replace(/[^a-z0-9]+/g, ' ').trim(),
        personagemGenero: 'Masculino',
        numeroRoll: 1,
        roll,
        family: {
            key: familyKey,
            name: familyName,
        },
        magic,
        magicKey: getMagicSlotKey(magic.label),
        traits: {
            commonAptitude: { key: 'voz_de_salao', name: 'Voz de Salão' },
            commonMark: { key: 'cria_da_fronteira', name: 'Cria da Fronteira' },
            rareAptitude: null,
            rareMark: null,
            anomaly: { key: 'sem_mana', name: 'Sem Mana' },
            attempts: [
                {
                    attempt_number: 1,
                    category: 'anomaly',
                    status: 'completed',
                    result: 'success',
                    chosen_key: 'sem_mana',
                },
            ],
        },
        appearanceConflict: null,
    };
}

async function validateBaseRoll() {
    const roll = generateBaseRoll(1);

    assert(roll.rollVersion === 'clover_base_v2', 'roll base deveria usar versao nova.');
    assert(roll.kingdomKey && roll.raceKey && roll.socialClassKey, 'roll base deveria ter keys de reino, raca e classe.');
    assert(roll.grimoireKey && roll.magicRarityKey, 'roll base deveria ter keys de grimorio e raridade.');
    assert(roll.family === '-' && roll.familyKey === null, 'roll base nao deveria sortear familia.');

    const previousBadRolls = [1, 2, 3].map((rollNumber) => ({
        roll_number: rollNumber,
        kingdom_key: 'spade',
        social_class_key: 'plebeu',
        race_key: 'humano',
        grimoire_key: 'spade_3f',
        grimoire_rank: '3F',
        magic_rarity_key: 'comum',
    }));
    const mercyRoll = withMockedRandom([
        0.3,
        0,
        0,
        0,
        0,
        0,
        0,
    ], () => generateBaseRoll(4, { previousRolls: previousBadRolls }));
    const mercyGood = mercyRoll.magicRarityKey === 'epica'
        || mercyRoll.raceKey === 'bruxa'
        || mercyRoll.raceKey === 'anao';
    assert(mercyGood, 'quarto roll ruim deveria receber favorecimento minimo permitido.');
    assert(mercyRoll.magicRarityKey !== 'lendaria' && mercyRoll.raceKey !== 'elfo', 'favorecimento nao deveria forcar Lendaria ou Elfo.');
}

async function validateRollGrimoireReservations() {
    const db = await createMemoryDb();
    const forceCloverFourLeaf = [0, 0, 0, 0.96, 0];

    const first = await withMockedRandomAsync(forceCloverFourLeaf, () => createAndStoreRoll(db, 'four_leaf_a'));
    const second = await withMockedRandomAsync(forceCloverFourLeaf, () => createAndStoreRoll(db, 'four_leaf_b'));
    const third = await withMockedRandomAsync(forceCloverFourLeaf, () => createAndStoreRoll(db, 'four_leaf_c'));

    assert(first.roll.grimoireKey === 'clover_4f', 'primeiro Clover 4F deveria cair com vaga livre.');
    assert(second.roll.grimoireKey === 'clover_4f', 'segundo Clover 4F deveria cair apos aumentar capacidade para 2.');
    assert(third.roll.grimoireKey !== 'clover_4f', 'terceiro Clover 4F deveria ser filtrado por reserva de 24h.');

    const active = await db.get(
        `SELECT COUNT(*) AS total
         FROM slot_reservations
         WHERE category = 'grimoire'
           AND option_key = 'clover_4f'
           AND status = 'pending'
           AND expires_at > CURRENT_TIMESTAMP`
    );
    assert(Number(active.total) === 2, 'Clover 4F deveria ter duas reservas pendentes de roll.');

    await db.close();
}

async function validateRollRaceReservations() {
    const db = await createMemoryDb();
    const forceCloverWitch = [0, 0.7, 0, 0];

    for (let index = 1; index <= 9; index += 1) {
        const result = await withMockedRandomAsync(forceCloverWitch, () => createAndStoreRoll(db, `witch_${index}`));
        assert(result.roll.raceKey === 'bruxa', `Bruxa deveria cair enquanto houver vaga livre (${index}/9).`);
    }

    const blocked = await withMockedRandomAsync(forceCloverWitch, () => createAndStoreRoll(db, 'witch_10'));
    assert(blocked.roll.raceKey !== 'bruxa', 'decima Bruxa deveria ser filtrada por reserva de roll.');

    const active = await db.get(
        `SELECT COUNT(*) AS total
         FROM slot_reservations
         WHERE category = 'race'
           AND option_key = 'bruxa'
           AND status = 'pending'
           AND source = 'roll_race'
           AND expires_at > CURRENT_TIMESTAMP`
    );
    assert(Number(active.total) === 9, 'Bruxa deveria ter nove reservas pendentes de roll.');

    await db.close();
}

async function validateMagicReservationRules() {
    const db = await createMemoryDb();

    await db.run(
        `INSERT INTO jogadores (id, magia, magia_key, ficha_status)
         VALUES ('legacy_1', 'Magia de Luz', 'magia_de_luz', 'aprovada'),
                ('legacy_2', 'Magia de Luz', 'magia_de_luz', 'aprovada')`
    );

    const pendingAgainstLegacy = await savePendingMagicConfirmation(db, 'new_player', 'Magia de Luz', 1);
    assert(pendingAgainstLegacy.ok, 'magia pendente nao deveria ocupar nem travar vaga antes da confirmacao.');
    assert(await countUsedSlots(db, 'magic', 'magia_de_luz') === 2, 'magia cheia por legados deveria continuar cheia por confirmados.');

    await db.run('DELETE FROM jogadores');
    await clearPendingMagicConfirmation(db, 'new_player');

    const first = await savePendingMagicConfirmation(db, 'player_a', 'Magia de Corte', 1);
    assert(first.ok, 'deveria salvar magia pendente limitada livre.');
    assert(await countUsedSlots(db, 'magic', 'magia_de_corte') === 0, 'magia pendente nao deveria contar vaga.');

    const secondPending = await savePendingMagicConfirmation(db, 'player_b', 'Magia de Corte', 1);
    assert(secondPending.ok, 'segunda escolha pendente da mesma magia deveria aguardar confirmacao sem bloquear.');
    assert(await countUsedSlots(db, 'magic', 'magia_de_corte') === 0, 'duas escolhas pendentes nao deveriam ocupar vaga.');

    await clearPendingMagicConfirmation(db, 'player_a');
    assert(await countUsedSlots(db, 'magic', 'magia_de_corte') === 0, 'cancelamento de pendencia nao deveria alterar vagas.');

    const second = await savePendingMagicConfirmation(db, 'player_b', 'Magia de Corte', 1);
    assert(second.ok, 'deveria atualizar a propria escolha pendente.');

    await db.run(
        `UPDATE pending_magic_confirmations
         SET created_at = datetime('now', '-2 hours')
         WHERE player_id = 'player_b'`
    );

    const expiredPending = await getPendingMagicConfirmation(db, 'player_b');
    assert(!expiredPending, 'escolha antiga de magia deveria expirar.');
    assert(await countUsedSlots(db, 'magic', 'magia_de_corte') === 0, 'escolha expirada nao deveria contar vaga.');

    await db.close();
}

async function validateTraitRules() {
    const db = await createMemoryDb();

    const commonOnly = await validateTraitSubmission(db, 'traits_common', {
        aptidao_comum: 'Voz de Salão',
        marca_comum: 'Cria da Fronteira',
        tentativa_especial_1: '-',
        tentativa_especial_2: '-',
        aptidao_rara: '-',
        marca_rara: '-',
        anomalia: '-',
    });
    assert(commonOnly.ok, 'aptidao comum + marca comum deveriam validar sem tentativa especial.');

    const rareSuccess = await validateTraitSubmission(db, 'traits_rare', {
        aptidao_comum: 'Voz de Salão',
        marca_comum: 'Cria da Fronteira',
        tentativa_especial_1: 'Aptidao Rara',
        tentativa_especial_2: '-',
        aptidao_rara: 'Prodígio de Mana',
        marca_rara: '-',
        anomalia: '-',
    }, { forceResults: { 1: true } });
    assert(rareSuccess.ok && rareSuccess.payload.rareAptitude?.key === 'prodigio_de_mana', 'tentativa rara bem sucedida deveria liberar aptidao rara.');

    const rareFailure = await validateTraitSubmission(db, 'traits_fail', {
        aptidao_comum: 'Voz de Salão',
        marca_comum: 'Cria da Fronteira',
        tentativa_especial_1: 'Marca Rara',
        tentativa_especial_2: '-',
        aptidao_rara: '-',
        marca_rara: 'Dívida de Vida',
        anomalia: '-',
    }, { forceResults: { 1: false } });
    assert(!rareFailure.ok, 'tentativa rara falha deveria bloquear a opcao rara na ficha.');

    const repeatFirst = await runSpecialAttempt(db, 'traits_repeat', 'marca', { forceResults: { 1: false } });
    const repeatSecond = await runSpecialAttempt(db, 'traits_repeat', 'marca', { forceResults: { 2: true } });
    const repeatAttempts = await getAttemptsForPlayer(db, 'traits_repeat');
    assert(repeatFirst.ok && repeatSecond.ok, 'deveria permitir tentar a mesma categoria de traco duas vezes.');
    assert(repeatAttempts.length === 2 && repeatAttempts.every((attempt) => attempt.category === 'rare_mark'), 'tentativas repetidas deveriam ficar na mesma categoria escolhida.');

    const reusedAttempt = await validateTraitSubmission(db, 'traits_rare', {
        aptidao_comum: 'Voz de Salão',
        marca_comum: 'Cria da Fronteira',
        tentativa_especial_1: 'Marca Rara',
        tentativa_especial_2: '-',
        aptidao_rara: '-',
        marca_rara: 'Dívida de Vida',
        anomalia: '-',
    }, { forceResults: { 1: true } });
    assert(!reusedAttempt.ok, 'tentativa ja usada em outra categoria nao deveria trocar categoria.');

    const partialNames = await validateTraitSubmission(db, 'traits_partial', {
        aptidao_comum: 'salao',
        marca_comum: 'fronteira',
        tentativa_especial_1: '-',
        tentativa_especial_2: '-',
        aptidao_rara: '-',
        marca_rara: '-',
        anomalia: '-',
    });
    assert(partialNames.ok, 'tracos deveriam aceitar trecho unico do nome.');

    await db.close();
}

async function validateFamilyAndAnomalyOccupation() {
    const db = await createMemoryDb();

    const family = await occupySlot(db, 'family_owner', 'family', 'lolopechka', 'profile_family', 1);
    assert(family.ok, 'confirmacao deveria ocupar familia livre.');

    const familySecond = await occupySlot(db, 'family_other', 'family', 'lolopechka', 'profile_family', 1);
    const familyBlocked = await occupySlot(db, 'family_third', 'family', 'lolopechka', 'profile_family', 1);
    assert(familySecond.ok && !familyBlocked.ok, 'familia 2/2 deveria bloquear terceiro jogador.');

    const anomalyOne = await occupySlot(db, 'anomaly_1', 'anomaly', 'sem_mana', 'profile_anomaly', 1);
    const anomalyTwo = await occupySlot(db, 'anomaly_2', 'anomaly', 'sem_mana', 'profile_anomaly', 1);
    const anomalyBlocked = await occupySlot(db, 'anomaly_3', 'anomaly', 'sem_mana', 'profile_anomaly', 1);
    assert(anomalyOne.ok && anomalyTwo.ok && !anomalyBlocked.ok, 'anomalia 2/2 deveria bloquear terceira ocupacao.');

    await db.close();
}

async function validateProfileConfirmation() {
    const db = await createMemoryDb();
    const playerId = 'profile_player';

    await db.run('INSERT INTO jogadores (id, ficha_status, magia) VALUES (?, ?, ?)', [playerId, 'incompleta', '-']);

    const payload = createProfilePayload({ playerId });
    await insertRollForPayload(db, playerId, payload);
    assert(await countUsedSlots(db, 'magic', 'magia_de_corte') === 0, 'magia da ficha nao deveria ocupar vaga antes da confirmacao.');

    await savePendingConfirmation(db, playerId, payload);
    const confirmed = await confirmPendingProfile(db, playerId);
    assert(confirmed.ok, `confirmacao da ficha deveria aprovar: ${(confirmed.errors || []).join(', ')}`);
    assert(confirmed.player.ficha_status === 'aprovada', 'ficha confirmada deveria ficar aprovada.');
    assert(confirmed.player.personagem_aparencia_status === 'pending', 'aparencia deveria ficar pendente de aprovacao humana.');
    assert(confirmed.player.familia_key === 'vangeance', 'familia deveria ser gravada no jogador.');
    assert(confirmed.player.magia_key === 'magia_de_corte', 'magia_key deveria ser gravada no jogador.');
    assert(confirmed.player.anomalia_key === 'sem_mana', 'anomalia deveria ser gravada no jogador.');
    assert(await countUsedSlots(db, 'family', 'vangeance') === 1, 'confirmacao deveria ocupar vaga da familia.');
    assert(await countUsedSlots(db, 'anomaly', 'sem_mana') === 1, 'confirmacao deveria ocupar vaga da anomalia.');
    assert(await countUsedSlots(db, 'magic', 'magia_de_corte') === 1, 'confirmacao deveria manter vaga da magia.');

    const fillerFamily = await occupySlot(db, 'profile_family_filler', 'family', 'vangeance', 'profile_family', 1);
    assert(fillerFamily.ok, 'segunda vaga de Vangeance deveria ser ocupada para teste de bloqueio.');

    const blockedId = 'profile_blocked';
    await db.run('INSERT INTO jogadores (id, ficha_status, magia) VALUES (?, ?, ?)', [blockedId, 'incompleta', '-']);
    const blockedPayload = createProfilePayload({
        playerId: blockedId,
        magicLabel: 'Magia de Algodao',
    });
    await insertRollForPayload(db, blockedId, blockedPayload);
    await savePendingMagicConfirmation(db, blockedId, blockedPayload.magic.label, blockedPayload.numeroRoll);
    await savePendingConfirmation(db, blockedId, blockedPayload);

    const blocked = await confirmPendingProfile(db, blockedId);
    assert(!blocked.ok && blocked.errors?.some((error) => error.includes('familia')), 'familia lotada deveria barrar confirmacao final.');

    await db.close();
}

async function main() {
    loadCloverConfigs({ forceReload: true });

    await validateBaseRoll();
    await validateRollGrimoireReservations();
    await validateRollRaceReservations();
    await validateMagicReservationRules();
    await validateTraitRules();
    await validateFamilyAndAnomalyOccupation();
    await validateProfileConfirmation();

    console.log('Fluxo Clover revisado validado com sucesso.');
}

main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
});
