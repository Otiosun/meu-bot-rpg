const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const atributosCommand = require('../comandos/atributos');
const perfilCommand = require('../comandos/perfil');
const statusCommand = require('../comandos/status');
const continuarCommand = require('../comandos/continuar');
const ajudaCommand = require('../comandos/ajuda');
const historiaJogoCommand = require('../comandos/historiaJogo');
const {
    ensureCloverArchiveCardsSchema,
    ensureCloverCharacterStatsSchema,
    ensureSlotReservationsSchema,
} = require('../database');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function normalize(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
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
            const response = { key: { id: `game-${counter}`, remoteJid: idChat } };
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
        idChat: 'game-group@g.us',
        idJogador,
        nomeUsuario: 'Tester',
        body,
        args: body ? [matchedCommand, ...body.split(/\s+/)] : [matchedCommand],
        matchedCommand,
        m: m || { key: { id: 'game-message', remoteJid: 'game-group@g.us', participant: idJogador } },
    });
}

function mentionMessage(targetId) {
    return {
        key: { id: 'game-admin', remoteJid: 'game-group@g.us', participant: 'admin@s.whatsapp.net' },
        message: {
            extendedTextMessage: {
                text: '@target',
                contextInfo: { mentionedJid: [targetId] },
            },
        },
    };
}

async function main() {
    const db = await createMemoryDb();
    const sock = createFakeSock();

    await insertPlayer(db, 'bloqueado@s.whatsapp.net', {
        ficha_status: 'aprovada',
        personagem_aparencia_status: 'approved',
        historia_status: 'pendente',
        jogo_status: 'aguardando_historia',
    });
    await runCommand(atributosCommand, { sock, db, playerId: 'bloqueado@s.whatsapp.net' });
    assert(normalize(latestText(sock)).includes('acesso') || normalize(latestText(sock)).includes('liberado'), 'Atributos deveriam bloquear jogador sem jogo liberado.');

    await insertPlayer(db, 'release@s.whatsapp.net', { jogo_status: 'historia_aprovada' });
    await runCommand(historiaJogoCommand, {
        sock,
        db,
        playerId: 'release@s.whatsapp.net',
        idJogador: 'admin@s.whatsapp.net',
        matchedCommand: '.#liberarjogo',
        m: mentionMessage('release@s.whatsapp.net'),
    });
    const createdStats = await db.get('SELECT * FROM clover_character_stats WHERE player_id = ?', ['release@s.whatsapp.net']);
    assert(createdStats, '.#liberarjogo deveria criar atributos iniciais.');
    assert(createdStats.stage_key === '9' && createdStats.pb_total === 10, 'Atributos iniciais deveriam ser estagio 9 com 10 PB.');

    await insertPlayer(db, 'jogo@s.whatsapp.net');

    await runCommand(perfilCommand, { sock, db, playerId: 'jogo@s.whatsapp.net' });
    let text = normalize(latestText(sock));
    assert(text.includes('perfil'), '.#perfil deveria mostrar perfil textual.');
    assert(text.includes('pb'), '.#perfil deveria mostrar PB.');
    assert(text.includes('atributos ainda'), '.#perfil deveria avisar atributos pendentes.');

    await runCommand(atributosCommand, { sock, db, playerId: 'jogo@s.whatsapp.net' });
    text = normalize(latestText(sock));
    assert(text.includes('pb total') && text.includes('10'), '.#atributos deveria mostrar painel com 10 PB.');
    assert(text.includes('pendente'), '.#atributos deveria mostrar status pendente.');

    await runCommand(atributosCommand, {
        sock,
        db,
        playerId: 'jogo@s.whatsapp.net',
        body: 'distribuir força 3 velocidade 3 agilidade 3 resistência 3 pm 3',
    });
    assert(normalize(latestText(sock)).includes('passou do pb total'), 'Distribuicao acima do PB deveria falhar.');

    await runCommand(atributosCommand, {
        sock,
        db,
        playerId: 'jogo@s.whatsapp.net',
        body: 'distribuir força 6 velocidade 1 agilidade 1 resistência 1 pm 1',
    });
    assert(normalize(latestText(sock)).includes('nao pode passar de 5'), 'Distribuicao acima de 50% por atributo deveria falhar.');

    await runCommand(atributosCommand, {
        sock,
        db,
        playerId: 'jogo@s.whatsapp.net',
        body: 'distribuir força 2 velocidade 2 agilidade 2 resistência 2 pm 0',
    });
    assert(normalize(latestText(sock)).includes('pelo menos 1'), 'Distribuicao com atributo zerado deveria falhar.');

    await runCommand(atributosCommand, {
        sock,
        db,
        playerId: 'jogo@s.whatsapp.net',
        body: 'distribuir força 2 velocidade 2 agilidade 2 resistência 2 pm 2',
    });
    text = normalize(latestText(sock));
    assert(text.includes('pendente') && text.includes('confirmaratributos'), 'Distribuicao valida deveria ficar pendente de confirmacao.');

    let stats = await db.get('SELECT * FROM clover_character_stats WHERE player_id = ?', ['jogo@s.whatsapp.net']);
    assert(stats.distribution_status === 'pending_confirmation', 'Distribuicao valida deveria salvar status pending_confirmation.');
    assert(stats.pb_spent === 0, 'Distribuicao pendente nao deveria gastar PB ainda.');

    await runCommand(atributosCommand, {
        sock,
        db,
        playerId: 'jogo@s.whatsapp.net',
        matchedCommand: '.#cancelaratributos',
    });
    stats = await db.get('SELECT * FROM clover_character_stats WHERE player_id = ?', ['jogo@s.whatsapp.net']);
    assert(stats.distribution_status === 'pending' && !stats.pending_distribution_json, '.#cancelaratributos deveria limpar pendencia.');

    await runCommand(atributosCommand, {
        sock,
        db,
        playerId: 'jogo@s.whatsapp.net',
        body: 'distribuir for 2 vel 2 agi 2 res 2 p.m 2',
    });
    await runCommand(atributosCommand, {
        sock,
        db,
        playerId: 'jogo@s.whatsapp.net',
        matchedCommand: '.#confirmaratributos',
    });
    stats = await db.get('SELECT * FROM clover_character_stats WHERE player_id = ?', ['jogo@s.whatsapp.net']);
    assert(stats.distribution_status === 'confirmed', '.#confirmaratributos deveria confirmar.');
    assert(stats.pb_spent === 10, 'Confirmacao deveria gastar os 10 PB.');
    assert(stats.forca === 2 && stats.poder_magico === 2, 'Confirmacao deveria copiar atributos pendentes.');

    await runCommand(atributosCommand, {
        sock,
        db,
        playerId: 'jogo@s.whatsapp.net',
        body: 'distribuir força 1 velocidade 1 agilidade 1 resistência 1 pm 1',
    });
    assert(normalize(latestText(sock)).includes('nao pode ser reduzido'), 'Atributos confirmados nao deveriam permitir reducao.');

    await runCommand(perfilCommand, { sock, db, playerId: 'jogo@s.whatsapp.net' });
    text = normalize(latestText(sock));
    assert(text.includes('0/10'), '.#perfil deveria mostrar PB distribuido apos confirmar atributos.');
    assert(!text.includes('atributos ainda'), '.#perfil confirmado nao deveria avisar pendencia.');

    await insertPlayer(db, 'pendente@s.whatsapp.net');
    await runCommand(continuarCommand, { sock, db, playerId: 'pendente@s.whatsapp.net' });
    assert(normalize(latestText(sock)).includes('atributos'), '.#continuar liberado deveria orientar atributos antes de confirmacao.');

    await runCommand(continuarCommand, { sock, db, playerId: 'jogo@s.whatsapp.net' });
    assert(normalize(latestText(sock)).includes('perfil'), '.#continuar confirmado deveria orientar perfil.');

    await runCommand(statusCommand, { sock, db, playerId: 'pendente@s.whatsapp.net' });
    text = normalize(latestText(sock));
    assert(text.includes('status do jogador'), '.#status liberado deveria mostrar status pos-ficha.');
    assert(text.includes('jogo') && text.includes('liberado'), '.#status liberado deveria mostrar jogo liberado.');

    await runCommand(ajudaCommand, { sock, db, playerId: 'jogo@s.whatsapp.net' });
    text = normalize(latestText(sock));
    assert(text.includes('ajuda do mago'), '.#ajuda liberado deveria mostrar Ajuda do Mago.');
    assert(text.includes('.#perfil') && text.includes('.#atributos'), '.#ajuda liberado deveria mostrar perfil e atributos.');
    assert(text.includes('.#reinos') && text.includes('.#tracos'), '.#ajuda liberado deveria manter sistemas consultaveis.');
    assert(!text.includes('.#sortear') && !text.includes('.#ficha'), '.#ajuda liberado nao deveria listar comandos de recepcao.');

    await db.close();
    console.log('Smoke Clover game basics passou com sucesso.');
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});
