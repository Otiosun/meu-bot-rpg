const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const atributosCommand = require('../comandos/atributos');
const continuarCommand = require('../comandos/continuar');
const perfilCommand = require('../comandos/perfil');
const phAdminCommand = require('../comandos/phAdmin');
const phCommand = require('../comandos/ph');
const {
    ensureCloverCharacterStatsSchema,
    ensureCloverPhLedgerSchema,
    ensureSlotReservationsSchema,
} = require('../database');
const { getPhSummary } = require('../helpers/clover/phService');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function normalize(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/º/g, 'o')
        .toLowerCase();
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
            const response = { key: { id: `ph-${counter}`, remoteJid: idChat } };
            sent.push({ idChat, message, options, response });
            return response;
        },
    };
}

function latestText(sock) {
    const message = sock.sent[sock.sent.length - 1]?.message || {};
    return message.text || message.caption || '';
}

async function createMemoryDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });

    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT DEFAULT '-',
            display_name TEXT DEFAULT '-',
            idade TEXT DEFAULT '-',
            reino TEXT DEFAULT '-',
            classe TEXT DEFAULT '-',
            familia TEXT DEFAULT '-',
            raca TEXT DEFAULT '-',
            grimorio TEXT DEFAULT '-',
            magia TEXT DEFAULT '-',
            magia_key TEXT DEFAULT NULL,
            formas TEXT DEFAULT '-',
            historia TEXT DEFAULT '-',
            aparencia TEXT DEFAULT '-',
            dinheiro INTEGER DEFAULT 0,
            esquadrao TEXT DEFAULT '-',
            estrelas INTEGER DEFAULT 0,
            patente TEXT DEFAULT '-',
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

    await db.exec(`
        CREATE TABLE player_rolls (
            player_id TEXT NOT NULL,
            roll_number INTEGER NOT NULL,
            kingdom TEXT DEFAULT '-',
            social_class TEXT DEFAULT '-',
            family TEXT DEFAULT '-',
            race TEXT DEFAULT '-',
            grimoire TEXT DEFAULT '-',
            magic_rarity TEXT DEFAULT '-',
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
        CREATE TABLE clover_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await db.exec(`
        CREATE TABLE player_progress (
            player_id TEXT PRIMARY KEY,
            ph_total INTEGER DEFAULT 0,
            ph_bonus INTEGER DEFAULT 0,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await db.exec(`
        CREATE TABLE player_skill_trees (
            player_id TEXT NOT NULL,
            tree TEXT NOT NULL,
            ph_spent INTEGER DEFAULT 0,
            unlocked_node_ids TEXT DEFAULT '[]',
            narrative_flags TEXT DEFAULT '[]',
            last_purchase TEXT DEFAULT NULL,
            last_prox_options TEXT DEFAULT '[]',
            purchase_history TEXT DEFAULT '[]',
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (player_id, tree)
        )
    `);

    await ensureSlotReservationsSchema(db);
    await ensureCloverCharacterStatsSchema(db);
    await ensureCloverPhLedgerSchema(db);

    return db;
}

async function insertPlayer(db, id, patch = {}) {
    await db.run(
        `INSERT INTO jogadores
         (id, nome, personagem_nome, ficha_status, personagem_aparencia_status, historia_status, jogo_status,
          magia, reino, classe, raca, grimorio, familia, aptidao_comum, marca_comum, anomalia)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            id,
            patch.nome || 'Teste',
            patch.personagem_nome || 'Aster',
            patch.ficha_status || 'aprovada',
            patch.personagem_aparencia_status || 'approved',
            patch.historia_status || 'aprovada',
            patch.jogo_status || 'liberado',
            patch.magia || 'Magia de Pintura',
            patch.reino || 'Clover',
            patch.classe || 'Nobreza',
            patch.raca || 'Humano',
            patch.grimorio || 'Grimorio de 3 Folhas',
            patch.familia || 'Nenhuma',
            patch.aptidao_comum || 'Controle Respiratorio',
            patch.marca_comum || 'Marca do Foco',
            patch.anomalia || '-',
        ]
    );
}

async function runCommand(command, { sock, db, playerId, body = '', matchedCommand = command.nome, m = null, idJogador = playerId }) {
    await command.executar({
        sock,
        db,
        idChat: 'ph-group@g.us',
        idJogador,
        nomeUsuario: 'Tester',
        body,
        args: body ? [matchedCommand, ...body.split(/\s+/)] : [matchedCommand],
        matchedCommand,
        m: m || { key: { id: 'ph-message', remoteJid: 'ph-group@g.us', participant: idJogador } },
    });
}

function mentionMessage(targetId, text) {
    return {
        key: { id: 'ph-admin', remoteJid: 'ph-group@g.us', participant: 'admin@s.whatsapp.net' },
        message: {
            extendedTextMessage: {
                text,
                contextInfo: { mentionedJid: [targetId] },
            },
        },
    };
}

async function main() {
    const db = await createMemoryDb();
    const sock = createFakeSock();
    const playerId = 'ph_player@s.whatsapp.net';

    await insertPlayer(db, 'bloqueado@s.whatsapp.net', {
        historia_status: 'pendente',
        jogo_status: 'aguardando_historia',
    });
    await runCommand(phCommand, { sock, db, playerId: 'bloqueado@s.whatsapp.net' });
    assert(normalize(latestText(sock)).includes('acesso') || normalize(latestText(sock)).includes('liberado'), 'Player nao liberado nao deveria usar .#ph.');

    await insertPlayer(db, playerId);
    await runCommand(phCommand, { sock, db, playerId });
    let text = normalize(latestText(sock));
    assert(text.includes('ph acumulado') && text.includes('15'), 'Player liberado deveria comecar com PH acumulado 15.');
    assert(text.includes('ph disponivel') && text.includes('15'), 'Player liberado deveria comecar com PH disponivel 15.');

    await runCommand(atributosCommand, {
        sock,
        db,
        playerId,
        body: 'distribuir força 2 velocidade 2 agilidade 2 resistência 2 pm 2',
    });
    await runCommand(atributosCommand, {
        sock,
        db,
        playerId,
        matchedCommand: '.#confirmaratributos',
    });

    await runCommand(phAdminCommand, {
        sock,
        db,
        playerId,
        idJogador: 'admin@s.whatsapp.net',
        matchedCommand: '.#darph',
        body: '@target 65 cena aprovada',
        m: mentionMessage(playerId, '@target 65 cena aprovada'),
    });
    text = normalize(latestText(sock));
    assert(text.includes('ph atualizado'), '.#darph deveria responder saldo antes/depois.');
    assert(text.includes('9o estagio') && text.includes('8o estagio'), '.#darph deveria mostrar subida de estagio.');

    let summary = await getPhSummary(db, playerId);
    assert(summary.phAccumulated === 80, 'PH acumulado deveria subir para 80.');
    assert(summary.phAvailable === 80, 'PH disponivel deveria subir para 80.');
    assert(summary.stageKey === '8', '80 PH deveria recalcular para 8º Estagio.');
    assert(summary.pbTotal === 20, '8º Estagio deveria atualizar PB total para 20.');
    assert(summary.pbSpent === 10 && summary.pbFree === 10, 'PB antigo deveria permanecer gasto e liberar 10 PB.');

    await runCommand(atributosCommand, { sock, db, playerId });
    text = normalize(latestText(sock));
    assert(text.includes('pb total') && text.includes('20'), '.#atributos deveria mostrar PB total 20.');
    assert(text.includes('pb livre') && text.includes('10'), '.#atributos deveria mostrar PB livre apos subir estagio.');

    await runCommand(phAdminCommand, {
        sock,
        db,
        playerId,
        idJogador: 'admin@s.whatsapp.net',
        matchedCommand: '.#tirarph',
        body: '@target 10 ajuste de saldo',
        m: mentionMessage(playerId, '@target 10 ajuste de saldo'),
    });
    summary = await getPhSummary(db, playerId);
    assert(summary.phAccumulated === 80, '.#tirarph nao deveria reduzir PH acumulado.');
    assert(summary.phAvailable === 70, '.#tirarph deveria reduzir apenas PH disponivel.');

    await runCommand(phAdminCommand, {
        sock,
        db,
        playerId,
        idJogador: 'admin@s.whatsapp.net',
        matchedCommand: '.#tirarph',
        body: '@target 100 saldo insuficiente',
        m: mentionMessage(playerId, '@target 100 saldo insuficiente'),
    });
    assert(normalize(latestText(sock)).includes('insuficiente'), 'Nao deveria deixar tirar mais PH do que disponivel.');
    summary = await getPhSummary(db, playerId);
    assert(summary.phAvailable === 70, 'Falha ao tirar PH nao deveria alterar saldo.');

    await runCommand(phCommand, { sock, db, playerId, body: 'historico' });
    text = normalize(latestText(sock));
    assert(text.includes('historico') && text.includes('ganho') && text.includes('perda'), '.#ph historico deveria mostrar lancamentos.');

    await runCommand(phAdminCommand, {
        sock,
        db,
        playerId,
        idJogador: 'admin@s.whatsapp.net',
        matchedCommand: '.#historicoph',
        body: '@target',
        m: mentionMessage(playerId, '@target'),
    });
    assert(normalize(latestText(sock)).includes('historico de ph'), '.#historicoph deveria mostrar historico de outro jogador.');

    await runCommand(perfilCommand, { sock, db, playerId });
    text = normalize(latestText(sock));
    assert(text.includes('ph acumulado') && text.includes('80'), '.#perfil deveria mostrar PH acumulado real.');
    assert(text.includes('ph disponivel') && text.includes('70'), '.#perfil deveria mostrar PH disponivel real.');

    await runCommand(continuarCommand, { sock, db, playerId });
    text = normalize(latestText(sock));
    assert(text.includes('pb livre') && text.includes('.#ph'), '.#continuar deveria sugerir PB livre e .#ph.');

    await db.close();
    console.log('Smoke Clover PH passou com sucesso.');
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});
