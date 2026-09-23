const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    createOrResetGhostTestPlayer,
    ensureGhostTestSchema,
    isGhostTestPlayer,
} = require('../helpers/clover/ghostTestPlayerService');
const ghostCommand = require('../comandos/fantasma');

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT,
            display_name TEXT DEFAULT '-',
            personagem_nome TEXT DEFAULT '-',
            personagem_idade INTEGER DEFAULT NULL,
            personagem_genero TEXT DEFAULT '-',
            personagem_aparencia TEXT DEFAULT '-',
            personagem_aparencia_status TEXT DEFAULT 'pending',
            ficha_status TEXT DEFAULT 'incompleta',
            historia_status TEXT DEFAULT 'pendente',
            jogo_status TEXT DEFAULT 'bloqueado',
            reino TEXT DEFAULT '-',
            classe TEXT DEFAULT '-',
            familia TEXT DEFAULT '-',
            raca TEXT DEFAULT '-',
            grimorio TEXT DEFAULT '-',
            magia TEXT DEFAULT '-',
            formas TEXT DEFAULT '-',
            historia TEXT DEFAULT '-',
            aparencia TEXT DEFAULT '-',
            gancho_narrativo TEXT DEFAULT '-',
            numero_roll_escolhido INTEGER DEFAULT NULL,
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
            agilidade INTEGER DEFAULT 0
        );

        CREATE TABLE player_onboarding (
            player_id TEXT PRIMARY KEY,
            current_step TEXT DEFAULT 'inicio',
            step_payload TEXT DEFAULT '{}',
            started_at TEXT DEFAULT CURRENT_TIMESTAMP,
            welcome_sent_at TEXT DEFAULT CURRENT_TIMESTAMP,
            last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE player_rolls (
            player_id TEXT NOT NULL,
            roll_number INTEGER NOT NULL,
            kingdom TEXT,
            social_class TEXT,
            race TEXT,
            grimoire TEXT,
            magic_rarity TEXT,
            magic TEXT,
            roll_payload TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (player_id, roll_number)
        );

        CREATE TABLE player_progress (
            player_id TEXT PRIMARY KEY,
            ph_total INTEGER DEFAULT 0,
            ph_bonus INTEGER DEFAULT 0,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE clover_character_stats (
            player_id TEXT PRIMARY KEY,
            stage_key TEXT DEFAULT '9',
            pb_total INTEGER DEFAULT 10,
            pb_spent INTEGER DEFAULT 0,
            ph_accumulated INTEGER DEFAULT 0,
            ph_available INTEGER DEFAULT 0,
            forca INTEGER DEFAULT 0,
            velocidade INTEGER DEFAULT 0,
            agilidade INTEGER DEFAULT 0,
            resistencia INTEGER DEFAULT 0,
            poder_magico INTEGER DEFAULT 0,
            distribution_status TEXT DEFAULT 'pending',
            confirmed_at TEXT DEFAULT NULL,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
    `);
    return db;
}

test('cria personagem fantasma pronto e marcado como nao canonico', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const result = await createOrResetGhostTestPlayer(db, {
        playerId: 'tester@lid',
        displayName: 'Tester',
    });

    assert.equal(result.ok, true);
    assert.equal(result.mode, 'created');
    assert.equal(result.player.is_test_user, 1);
    assert.equal(result.player.character_kind, 'ghost');
    assert.equal(result.player.is_canonical, 0);
    assert.equal(result.player.ficha_status, 'aprovada');
    assert.equal(result.player.historia_status, 'aprovada');
    assert.equal(result.player.jogo_status, 'liberado');
    assert.equal(result.player.numero_roll_escolhido, 1);

    const stats = await db.get('SELECT * FROM clover_character_stats WHERE player_id = ?', ['tester@lid']);
    assert.equal(result.player.personagem_nome, 'Whatever');
    assert.equal(stats.stage_key, '2');
    assert.equal(stats.distribution_status, 'confirmed');
    assert.equal(stats.pb_total, 1280);
    assert.equal(stats.pb_spent, 1280);

    const roll = await db.get('SELECT * FROM player_rolls WHERE player_id = ? AND roll_number = 1', ['tester@lid']);
    assert.equal(roll.kingdom, 'Clover');
    assert.equal(roll.magic_rarity, 'Rara');

    assert.equal(await isGhostTestPlayer(db, 'tester@lid'), true);
});

test('nao sobrescreve personagem real com modo fantasma', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await ensureGhostTestSchema(db);
    await db.run(
        `INSERT INTO jogadores
         (id, nome, display_name, personagem_nome, ficha_status, jogo_status, is_test_user, character_kind, is_canonical)
         VALUES ('real@lid', 'Real', 'Real', 'Asta', 'aprovada', 'liberado', 0, 'player', 1)`
    );

    const result = await createOrResetGhostTestPlayer(db, {
        playerId: 'real@lid',
        displayName: 'Real',
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'real_player_exists');

    const player = await db.get('SELECT personagem_nome, is_test_user, character_kind, is_canonical FROM jogadores WHERE id = ?', ['real@lid']);
    assert.equal(player.personagem_nome, 'Asta');
    assert.equal(player.is_test_user, 0);
    assert.equal(player.character_kind, 'player');
    assert.equal(player.is_canonical, 1);
});

test('nao cria fantasma quando telefone alternativo tem personagem real', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await ensureGhostTestSchema(db);
    await db.run(
        `INSERT INTO jogadores
         (id, nome, display_name, personagem_nome, ficha_status, jogo_status, is_test_user, character_kind, is_canonical)
         VALUES ('5511999999999@s.whatsapp.net', 'Real', 'Real', 'Noelle', 'aprovada', 'liberado', 0, 'player', 1)`
    );

    const result = await createOrResetGhostTestPlayer(db, {
        playerId: 'tester@lid',
        alternateIds: ['5511999999999@s.whatsapp.net'],
        displayName: 'Tester',
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'real_player_exists');
    assert.equal(await db.get('SELECT * FROM jogadores WHERE id = ?', ['tester@lid']), undefined);
});

test('limpa pre-cadastro vazio do telefone alternativo antes de criar fantasma', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await ensureGhostTestSchema(db);
    await db.run(
        `INSERT INTO jogadores
         (id, nome, display_name, personagem_nome, ficha_status, jogo_status, is_test_user, character_kind, is_canonical)
         VALUES ('5511888888888@s.whatsapp.net', 'Cacador', 'Cacador', '-', 'incompleta', 'bloqueado', 0, 'player', 1)`
    );
    await db.run(
        `INSERT INTO player_onboarding (player_id, current_step)
         VALUES ('5511888888888@s.whatsapp.net', 'recepcao')`
    );

    const result = await createOrResetGhostTestPlayer(db, {
        playerId: 'tester@lid',
        alternateIds: ['5511888888888@s.whatsapp.net'],
        displayName: 'Tester',
    });

    assert.equal(result.ok, true);
    assert.equal(await db.get('SELECT * FROM jogadores WHERE id = ?', ['5511888888888@s.whatsapp.net']), undefined);
    assert.equal(await db.get('SELECT * FROM player_onboarding WHERE player_id = ?', ['5511888888888@s.whatsapp.net']), undefined);
    assert.equal(await isGhostTestPlayer(db, 'tester@lid'), true);
});

test('converte pre-cadastro vazio em personagem fantasma', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await ensureGhostTestSchema(db);
    await db.run(
        `INSERT INTO jogadores
         (id, nome, display_name, personagem_nome, ficha_status, jogo_status, is_test_user, character_kind, is_canonical)
         VALUES ('empty@lid', 'Cacador', 'Cacador', '-', 'incompleta', 'bloqueado', 0, 'player', 1)`
    );

    const result = await createOrResetGhostTestPlayer(db, {
        playerId: 'empty@lid',
        displayName: 'Tester',
    });

    assert.equal(result.ok, true);
    assert.equal(result.mode, 'converted');
    assert.equal(result.player.personagem_nome, 'Whatever');
    assert.equal(result.player.is_test_user, 1);
    assert.equal(result.player.character_kind, 'ghost');
    assert.equal(result.player.is_canonical, 0);
});

test('reseta somente registros fantasma ja marcados', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await createOrResetGhostTestPlayer(db, {
        playerId: 'tester@lid',
        displayName: 'Tester',
    });
    await db.run("UPDATE jogadores SET personagem_nome = 'Fantasma Mexido', dinheiro = 9999 WHERE id = 'tester@lid'");

    const result = await createOrResetGhostTestPlayer(db, {
        playerId: 'tester@lid',
        displayName: 'Tester',
    });

    assert.equal(result.ok, true);
    assert.equal(result.mode, 'reset');
    assert.equal(result.player.personagem_nome, 'Whatever');
    assert.equal(result.player.dinheiro, 500);
});

test('comando fantasma pode ser usado em grupos nao oficiais', () => {
    assert.equal(ghostCommand.groupBypass, true);
});

test('comando fantasma responde no PV mesmo com politica privada ativa', async (t) => {
    const previousPolicy = process.env.CLOVER_PV_POLICY_MODE;
    const previousThrottle = process.env.CLOVER_PRIVATE_SEND_THROTTLE;
    const previousTyping = process.env.CLOVER_HUMAN_TYPING_ENABLED;
    process.env.CLOVER_PV_POLICY_MODE = 'enforce';
    process.env.CLOVER_PRIVATE_SEND_THROTTLE = '0';
    process.env.CLOVER_HUMAN_TYPING_ENABLED = '0';
    t.after(() => {
        if (previousPolicy === undefined) delete process.env.CLOVER_PV_POLICY_MODE;
        else process.env.CLOVER_PV_POLICY_MODE = previousPolicy;
        if (previousThrottle === undefined) delete process.env.CLOVER_PRIVATE_SEND_THROTTLE;
        else process.env.CLOVER_PRIVATE_SEND_THROTTLE = previousThrottle;
        if (previousTyping === undefined) delete process.env.CLOVER_HUMAN_TYPING_ENABLED;
        else process.env.CLOVER_HUMAN_TYPING_ENABLED = previousTyping;
    });

    const db = await createDb();
    t.after(() => db.close());
    const calls = [];
    const sock = {
        sendMessage: async (jid, message) => {
            calls.push({ jid, message });
            return { key: { id: `message-${calls.length}`, remoteJid: jid } };
        },
    };

    await ghostCommand.executar({
        sock,
        m: { message: { conversation: '.#fantasma' } },
        idChat: 'tester@lid',
        idJogador: 'tester@lid',
        nomeUsuario: 'Tester',
        db,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].jid, 'tester@lid');
    assert.match(calls[0].message.text, /Whatever/);
});
