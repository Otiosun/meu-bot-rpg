const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const perfilCommand = require('../comandos/perfil');
const fisicoCommand = require('../comandos/fisico');
const statusCommand = require('../comandos/status');
const continuarCommand = require('../comandos/continuar');
const ajudaCommand = require('../comandos/ajuda');
const historiaJogoCommand = require('../comandos/historiaJogo');
const {
    ensureCloverArchiveCardsSchema,
    ensureCloverCharacterStatsSchema,
    ensureCloverManaHexagonSchema,
    ensureCloverPhLedgerSchema,
    ensureCloverSkillTreeSchema,
    ensureSlotReservationsSchema,
} = require('../database');
const {
    canUseCommandInPhase,
    getPlayerPhase,
    isPostFichaReceptionCommand,
} = require('../helpers/clover/playerPhase');
const {
    maybeSendPostFichaPrivateInstructions,
} = require('../helpers/clover/registrationManager');

function assert(condition, message) {
    if (!condition) throw new Error(message);
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
            const response = { key: { id: `phase-${counter}`, remoteJid: idChat } };
            sent.push({ idChat, message, options, response });
            return response;
        },
    };
}

function latestText(sock) {
    const message = sock.sent[sock.sent.length - 1]?.message || {};
    return message.text || message.caption || '';
}

function normalize(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
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
            patente TEXT DEFAULT NULL,
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
    await ensureCloverArchiveCardsSchema(db);
    await ensureCloverCharacterStatsSchema(db);
    await ensureCloverPhLedgerSchema(db);
    await ensureCloverSkillTreeSchema(db);
    await ensureCloverManaHexagonSchema(db);

    return db;
}

async function insertPlayer(db, id, patch = {}) {
    await db.run(
        `INSERT INTO jogadores
         (id, nome, personagem_nome, ficha_status, personagem_aparencia_status, historia_status, jogo_status, magia, reino, classe)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            id,
            patch.nome || 'Teste',
            patch.personagem_nome || 'Personagem Teste',
            patch.ficha_status || 'incompleta',
            patch.personagem_aparencia_status || 'pending',
            patch.historia_status || 'pendente',
            patch.jogo_status || 'bloqueado',
            patch.magia || '-',
            patch.reino || 'Clover',
            patch.classe || 'Plebeu',
        ]
    );
}

async function runCommand(command, { sock, db, playerId, body = '', matchedCommand = command.nome, m = null, idJogador = playerId }) {
    await command.executar({
        sock,
        db,
        idChat: 'phase-group@g.us',
        idJogador,
        nomeUsuario: 'Tester',
        body,
        args: body ? [matchedCommand, ...body.split(/\s+/)] : [matchedCommand],
        matchedCommand,
        m: m || { key: { id: 'phase-message', remoteJid: 'phase-group@g.us', participant: idJogador } },
    });
}

function mentionMessage(targetId) {
    return {
        key: { id: 'phase-admin', remoteJid: 'phase-group@g.us', participant: 'admin@s.whatsapp.net' },
        message: {
            extendedTextMessage: {
                text: '@target',
                contextInfo: { mentionedJid: [targetId] },
            },
        },
    };
}

async function assertGameBlocked(command, context, label) {
    const before = context.sock.sent.length;
    await runCommand(command, context);
    assert(context.sock.sent.length === before + 1, `${label} deveria responder uma mensagem.`);
    assert(normalize(latestText(context.sock)).includes('acesso') || normalize(latestText(context.sock)).includes('liberado'), `${label} deveria avisar bloqueio de acesso.`);
}

async function main() {
    const db = await createMemoryDb();
    const sock = createFakeSock();

    await assertGameBlocked(perfilCommand, { sock, db, playerId: 'novo@s.whatsapp.net' }, 'perfil de player novo');
    await assertGameBlocked(fisicoCommand, { sock, db, playerId: 'novo@s.whatsapp.net' }, 'fisico de player novo');

    await insertPlayer(db, 'aparencia_pendente@s.whatsapp.net', {
        ficha_status: 'aprovada',
        personagem_aparencia_status: 'pending',
        magia: 'Magia de Fogo',
    });
    let phase = await getPlayerPhase(db, 'aparencia_pendente@s.whatsapp.net');
    assert(phase.phase === 'aparencia_pendente', 'Ficha aprovada com aparencia pending deveria ficar em aparencia_pendente.');
    assert(!canUseCommandInPhase('.#perfil', phase.phase), 'Perfil deveria bloquear aparencia pendente.');
    await assertGameBlocked(perfilCommand, { sock, db, playerId: 'aparencia_pendente@s.whatsapp.net' }, 'perfil com aparencia pendente');

    await insertPlayer(db, 'historia_pendente@s.whatsapp.net', {
        ficha_status: 'aprovada',
        personagem_aparencia_status: 'approved',
        historia_status: 'pendente',
        jogo_status: 'liberado',
        magia: 'Magia de Fogo',
    });
    phase = await getPlayerPhase(db, 'historia_pendente@s.whatsapp.net');
    assert(phase.phase === 'jogo_liberado' && phase.canPlay, 'Aparencia aprovada com historia pendente deveria liberar jogo.');
    const beforeFisicoPendente = sock.sent.length;
    await runCommand(fisicoCommand, { sock, db, playerId: 'historia_pendente@s.whatsapp.net' });
    assert(sock.sent.length === beforeFisicoPendente + 1, 'Fisico com historia pendente liberada deveria executar.');

    await insertPlayer(db, 'historia_aprovada@s.whatsapp.net', {
        ficha_status: 'aprovada',
        personagem_aparencia_status: 'approved',
        historia_status: 'aprovada',
        jogo_status: 'historia_aprovada',
        magia: 'Magia de Fogo',
    });
    phase = await getPlayerPhase(db, 'historia_aprovada@s.whatsapp.net');
    assert(phase.phase === 'historia_aprovada', 'Historia aprovada sem liberacao final deveria ficar bloqueada.');
    await assertGameBlocked(perfilCommand, { sock, db, playerId: 'historia_aprovada@s.whatsapp.net' }, 'perfil sem liberacao final');

    await insertPlayer(db, 'jogo_liberado@s.whatsapp.net', {
        ficha_status: 'aprovada',
        personagem_aparencia_status: 'approved',
        historia_status: 'aprovada',
        jogo_status: 'liberado',
        magia: 'Magia de Fogo',
    });
    phase = await getPlayerPhase(db, 'jogo_liberado@s.whatsapp.net');
    assert(phase.phase === 'jogo_liberado' && phase.canPlay, 'Jogo liberado deveria passar pela fase final.');

    ['.#sortear', '.#rolls', '.#sacrificar', '.#Ficha', '.#Ficha Pessoal', '.#magia', '.#cancelarmagia', '.#confirmar', '.#cancelar'].forEach((command) => {
        assert(isPostFichaReceptionCommand(command), `${command} deveria ser bloqueado no pos-ficha.`);
    });
    assert(!isPostFichaReceptionCommand('.#aparencia'), '.#aparencia deveria continuar liberado no pos-ficha.');
    ['.#reinos', '.#racas', '.#classes', '.#familias', '.#grimorios', '.#tracos'].forEach((command) => {
        assert(!isPostFichaReceptionCommand(command), `${command} deveria continuar consultavel no pos-ficha.`);
    });

    await runCommand(ajudaCommand, { sock, db, playerId: 'jogo_liberado@s.whatsapp.net' });
    const gameHelp = normalize(latestText(sock));
    assert(gameHelp.includes('ajuda do mago'), '.#ajuda de jogo liberado deveria mostrar Ajuda do Mago.');
    assert(gameHelp.includes('.#perfil'), '.#ajuda pos-ficha deveria mostrar perfil.');
    assert(gameHelp.includes('.#reinos') && gameHelp.includes('.#tracos'), '.#ajuda pos-ficha deveria manter sistemas consultaveis.');
    assert(!gameHelp.includes('.#sortear') && !gameHelp.includes('.#ficha'), '.#ajuda pos-ficha nao deveria listar comandos de recepcao.');

    await runCommand(statusCommand, { sock, db, playerId: 'jogo_liberado@s.whatsapp.net' });
    const gameStatus = normalize(latestText(sock));
    assert(gameStatus.includes('status do jogador'), '.#status pos-ficha deveria mostrar status do jogador.');
    assert(gameStatus.includes('jogo') && gameStatus.includes('liberado'), '.#status pos-ficha deveria mostrar jogo liberado.');

    const beforePerfil = sock.sent.length;
    await runCommand(perfilCommand, { sock, db, playerId: 'jogo_liberado@s.whatsapp.net' });
    assert(sock.sent.length === beforePerfil + 1, 'Perfil liberado deveria executar.');
    assert(normalize(latestText(sock)).includes('perfil'), 'Perfil liberado deveria enviar texto do perfil.');

    const beforeFisico = sock.sent.length;
    await runCommand(fisicoCommand, { sock, db, playerId: 'jogo_liberado@s.whatsapp.net' });
    assert(sock.sent.length === beforeFisico + 1, 'Fisico liberado deveria executar.');
    assert(normalize(latestText(sock)).includes('fisica') || normalize(latestText(sock)).includes('arvore'), 'Fisico liberado deveria mostrar arvore.');

    await insertPlayer(db, 'pv_player@s.whatsapp.net', {
        ficha_status: 'aprovada',
        personagem_aparencia_status: 'pending',
        magia: 'Magia de Fogo',
    });
    let pv = await maybeSendPostFichaPrivateInstructions(sock, db, 'pv_player@s.whatsapp.net');
    assert(pv.skipped && pv.reason === 'appearance_not_approved', 'PV de historia nao deveria sair antes da aparencia aprovada.');

    await db.run(
        `UPDATE jogadores
         SET personagem_aparencia_status = 'approved'
         WHERE id = 'pv_player@s.whatsapp.net'`
    );
    const beforePv = sock.sent.length;
    pv = await maybeSendPostFichaPrivateInstructions(sock, db, 'pv_player@s.whatsapp.net');
    assert(pv.ok && !pv.skipped, 'PV de historia deveria sair apos ficha + magia + aparencia aprovada.');
    assert(sock.sent.length === beforePv + 1, 'PV de historia deveria enviar uma mensagem.');
    let pvPlayer = await db.get('SELECT historia_pv_sent_at, jogo_status FROM jogadores WHERE id = ?', ['pv_player@s.whatsapp.net']);
    assert(pvPlayer.historia_pv_sent_at, 'PV de historia deveria marcar historia_pv_sent_at.');
    assert(pvPlayer.jogo_status === 'liberado', 'PV de historia deveria liberar jogo com historia pendente.');

    pv = await maybeSendPostFichaPrivateInstructions(sock, db, 'pv_player@s.whatsapp.net');
    assert(pv.skipped && pv.reason === 'already_sent', 'PV de historia nao deveria duplicar.');

    await runCommand(statusCommand, { sock, db, playerId: 'pv_player@s.whatsapp.net' });
    assert(normalize(latestText(sock)).includes('historia'), '.#status deveria mostrar historia/persona.');

    await runCommand(continuarCommand, { sock, db, playerId: 'aparencia_pendente@s.whatsapp.net' });
    assert(normalize(latestText(sock)).includes('aparencia'), '.#continuar deveria orientar aparencia pendente.');

    await runCommand(ajudaCommand, { sock, db, playerId: 'historia_pendente@s.whatsapp.net' });
    const storyHelp = normalize(latestText(sock));
    assert(storyHelp.includes('ajuda do mago'), '.#ajuda em historia pendente liberada deveria mostrar Ajuda do Mago.');
    assert(storyHelp.includes('.#perfil'), '.#ajuda em historia pendente liberada deveria mostrar comandos de jogo.');

    const adminTarget = 'admin_target@s.whatsapp.net';
    await insertPlayer(db, adminTarget, {
        ficha_status: 'aprovada',
        personagem_aparencia_status: 'approved',
        historia_status: 'pendente',
        jogo_status: 'bloqueado',
        magia: 'Magia de Fogo',
    });

    await runCommand(historiaJogoCommand, {
        sock,
        db,
        playerId: adminTarget,
        idJogador: 'admin@s.whatsapp.net',
        matchedCommand: '.#liberarjogo',
        m: mentionMessage(adminTarget),
    });
    let adminRow = await db.get('SELECT historia_status, jogo_status, jogo_liberado_by FROM jogadores WHERE id = ?', [adminTarget]);
    assert(adminRow.historia_status === 'pendente', '.#liberarjogo deveria manter historia pendente.');
    assert(adminRow.jogo_status === 'liberado', '.#liberarjogo deveria liberar jogo sem exigir historia aprovada.');
    assert(adminRow.jogo_liberado_by === 'admin@s.whatsapp.net', '.#liberarjogo deveria salvar ADM.');

    const adminStoryTarget = 'admin_story_target@s.whatsapp.net';
    await insertPlayer(db, adminStoryTarget, {
        ficha_status: 'aprovada',
        personagem_aparencia_status: 'approved',
        historia_status: 'pendente',
        jogo_status: 'bloqueado',
        magia: 'Magia de Fogo',
    });

    await runCommand(historiaJogoCommand, {
        sock,
        db,
        playerId: adminStoryTarget,
        idJogador: 'admin@s.whatsapp.net',
        matchedCommand: '.#aprovarhistoria',
        m: mentionMessage(adminStoryTarget),
    });
    adminRow = await db.get('SELECT historia_status, jogo_status FROM jogadores WHERE id = ?', [adminStoryTarget]);
    assert(adminRow.historia_status === 'aprovada', '.#aprovarhistoria deveria aprovar historia.');
    assert(adminRow.jogo_status === 'liberado', '.#aprovarhistoria deveria manter/liberar jogo se ficha e aparencia estiverem aprovadas.');

    await runCommand(historiaJogoCommand, {
        sock,
        db,
        playerId: adminTarget,
        idJogador: 'admin@s.whatsapp.net',
        matchedCommand: '.#bloquearjogo',
        body: 'ajuste administrativo',
        m: mentionMessage(adminTarget),
    });
    adminRow = await db.get('SELECT jogo_status, jogo_bloqueio_motivo FROM jogadores WHERE id = ?', [adminTarget]);
    assert(adminRow.jogo_status === 'bloqueado', '.#bloquearjogo deveria bloquear jogo.');

    await db.close();
    console.log('Smoke Clover phase gate passou com sucesso.');
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});
