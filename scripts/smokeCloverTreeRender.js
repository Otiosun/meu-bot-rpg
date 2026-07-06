const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const arvoresCommand = require('../comandos/arvores');
const {
    ensureCloverCharacterStatsSchema,
    ensureCloverPhLedgerSchema,
    ensureCloverSkillTreeSchema,
    ensureSlotReservationsSchema,
} = require('../database');
const { getTreeState } = require('../helpers/clover/skillTreeService');
const { loadTrees } = require('../helpers/clover/treeLoader');
const {
    buildPayloadFromState,
    renderTreePng,
    renderTreePngCached,
    renderTreeSvg,
} = require('../helpers/clover/treeRenderer');
const { addPh } = require('../helpers/clover/phService');

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
        async sendMessage(idChat, message, options) {
            counter += 1;
            const response = { key: { id: `tree-render-${counter}`, remoteJid: idChat } };
            sent.push({ idChat, message, options, response });
            return response;
        },
    };
}

function latestMessage(sock) {
    return sock.sent[sock.sent.length - 1]?.message || {};
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

    await ensureSlotReservationsSchema(db);
    await ensureCloverCharacterStatsSchema(db);
    await ensureCloverPhLedgerSchema(db);
    await ensureCloverSkillTreeSchema(db);

    return db;
}

async function insertPlayer(db, id, patch = {}) {
    await db.run(
        `INSERT INTO jogadores
         (id, nome, personagem_nome, ficha_status, personagem_aparencia_status, historia_status, jogo_status,
          magia, reino, classe, raca, grimorio, familia)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        ]
    );
}

async function grantPh(db, playerId, amount) {
    await addPh(db, playerId, amount, 'smoke_tree_render', 'setup render tree', 'admin@s.whatsapp.net', {
        smoke: true,
    });
}

async function insertOwnedNode(db, playerId, nodeId) {
    await db.run(
        `INSERT OR IGNORE INTO clover_skill_nodes
         (player_id, tree_id, node_id, purchased_at, purchased_by, source, metadata_json)
         VALUES (?, 'mana', ?, CURRENT_TIMESTAMP, 'smoke', 'smoke_setup', '{}')`,
        [playerId, nodeId]
    );
}

async function runCommand(command, { sock, db, playerId, body = '', matchedCommand = command.nome }) {
    await command.executar({
        sock,
        db,
        idChat: 'tree-render-group@g.us',
        idJogador: playerId,
        nomeUsuario: 'Tester',
        body,
        args: body ? [matchedCommand, ...body.split(/\s+/)] : [matchedCommand],
        matchedCommand,
        m: { key: { id: 'tree-render-message', remoteJid: 'tree-render-group@g.us', participant: playerId } },
    });
}

async function main() {
    const db = await createMemoryDb();
    const playerId = 'tree_render_player@s.whatsapp.net';

    const trees = loadTrees({ forceReload: true });
    const mana = trees.find((tree) => tree.id === 'mana');
    assert(mana, 'mana.json deveria carregar.');

    await insertPlayer(db, playerId);
    await grantPh(db, playerId, 500);
    await insertOwnedNode(db, playerId, 'sentir_mana_i');
    await insertOwnedNode(db, playerId, 'fluxo_de_mana_i');
    await insertOwnedNode(db, playerId, 'retencao_de_mana_i');
    await insertOwnedNode(db, playerId, 'economia_de_mana_i');
    await insertOwnedNode(db, playerId, 'campo_de_mana_i');
    await insertOwnedNode(db, playerId, 'ambiente_de_mana_i');

    const state = await getTreeState(db, playerId, 'mana');
    const player = await db.get('SELECT id, nome, personagem_nome FROM jogadores WHERE id = ?', [playerId]);
    const payload = buildPayloadFromState(player, state);

    const statuses = new Set(payload.nodeStatuses.map((item) => item.status));
    assert(statuses.has('owned'), 'Renderer deveria receber nos owned.');
    assert(statuses.has('available'), 'Renderer deveria receber nos available.');
    assert(statuses.has('locked'), 'Renderer deveria receber nos locked.');
    assert(statuses.has('approval'), 'Renderer deveria receber no approval.');

    const svg = renderTreeSvg(payload);
    assert(svg.includes('<svg') && svg.includes('ÁRVORE DE MANA'), 'SVG deveria ser gerado com titulo.');

    const png = await renderTreePng(payload);
    assert(Buffer.isBuffer(png) && png.length > 0, 'PNG em buffer deveria ser gerado.');

    const cached = await renderTreePngCached(db, playerId, 'mana');
    assert(fs.existsSync(cached.path), 'PNG cacheado deveria existir no disco.');
    const stat = fs.statSync(cached.path);
    assert(stat.size > 0, 'PNG cacheado deveria ter tamanho maior que zero.');

    const cachedAgain = await renderTreePngCached(db, playerId, 'mana');
    assert(cachedAgain.cacheHit, 'Segunda renderizacao deveria usar cache.');
    assert(cachedAgain.path === cached.path, 'Cache deveria reaproveitar o mesmo caminho.');

    await insertPlayer(db, 'tree_render_low_ph@s.whatsapp.net');
    await grantPh(db, 'tree_render_low_ph@s.whatsapp.net', 5);
    const lowPhState = await getTreeState(db, 'tree_render_low_ph@s.whatsapp.net', 'mana');
    assert(lowPhState.nodeStates.some((item) => item.status === 'no_ph'), 'Renderer deveria lidar com status no_ph.');
    const lowPhPayload = buildPayloadFromState(
        await db.get('SELECT id, nome, personagem_nome FROM jogadores WHERE id = ?', ['tree_render_low_ph@s.whatsapp.net']),
        lowPhState
    );
    assert((await renderTreePng(lowPhPayload)).length > 0, 'Renderer nao deveria explodir com no_ph.');

    const sock = createFakeSock();
    await runCommand(arvoresCommand, {
        sock,
        db,
        playerId,
        matchedCommand: '.#arvore',
        body: 'mana',
    });
    let message = latestMessage(sock);
    assert(message.image && message.caption, '.#arvore mana deveria enviar imagem com caption.');

    await runCommand(arvoresCommand, {
        sock,
        db,
        playerId,
        matchedCommand: '.#arvore',
        body: 'mana texto',
    });
    message = latestMessage(sock);
    assert(!message.image && normalize(message.text).includes('rotas principais'), '.#arvore mana texto deveria manter fallback textual.');

    await db.close();
    console.log(`Smoke Clover tree render passou com sucesso. PNG: ${cached.path}`);
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});
