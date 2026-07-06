const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const sharp = require('sharp');

const arvoresCommand = require('../comandos/arvores');
const fisicoCommand = require('../comandos/fisico');
const {
    ensureCloverCharacterStatsSchema,
    ensureCloverPhLedgerSchema,
    ensureCloverSkillTreeSchema,
    ensureSlotReservationsSchema,
} = require('../database');
const { addPh } = require('../helpers/clover/phService');
const { applyTreeDiscountCost } = require('../helpers/clover/characterBonusService');
const { getTreeState } = require('../helpers/clover/skillTreeService');
const { renderTreeVisualPngCached } = require('../helpers/clover/treeVisualRenderer');
const { getTree, loadTrees } = require('../helpers/clover/treeLoader');

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
            const response = { key: { id: `physical-${counter}`, remoteJid: idChat } };
            sent.push({ idChat, message, options, response });
            return response;
        },
        async groupMetadata(id) {
            return {
                id,
                participants: [
                    { id: 'admin@s.whatsapp.net', admin: 'admin' },
                    { id: 'player@s.whatsapp.net', admin: null },
                ],
            };
        },
    };
}

function latestMessage(sock) {
    return sock.sent[sock.sent.length - 1]?.message || {};
}

function latestText(sock) {
    const message = latestMessage(sock);
    return message.text || message.caption || '';
}

function assertImage(message, label) {
    assert(Buffer.isBuffer(message.image), `${label} deveria enviar imagem.`);
    assert(String(message.caption || '').length > 0, `${label} deveria ter caption.`);
}

function assertText(message, label) {
    assert(!message.image, `${label} nao deveria enviar imagem.`);
    assert(String(message.text || '').length > 0, `${label} deveria enviar texto.`);
}

async function createMemoryDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });

    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT DEFAULT '-',
            personagem_nome TEXT DEFAULT '-',
            raca TEXT DEFAULT '-',
            classe TEXT DEFAULT '-',
            grimorio TEXT DEFAULT '-',
            ficha_status TEXT DEFAULT 'incompleta',
            personagem_aparencia_status TEXT DEFAULT 'pending',
            historia_status TEXT DEFAULT 'pendente',
            jogo_status TEXT DEFAULT 'bloqueado',
            numero_roll_escolhido INTEGER DEFAULT NULL
        );

        CREATE TABLE player_onboarding (
            player_id TEXT PRIMARY KEY,
            current_step TEXT DEFAULT 'inicio',
            step_payload TEXT DEFAULT '{}'
        );

        CREATE TABLE player_rolls (
            player_id TEXT NOT NULL,
            roll_number INTEGER NOT NULL,
            kingdom TEXT DEFAULT '-',
            social_class TEXT DEFAULT '-',
            race TEXT DEFAULT '-',
            grimoire TEXT DEFAULT '-',
            magic_rarity TEXT DEFAULT '-',
            PRIMARY KEY (player_id, roll_number)
        );

        CREATE TABLE pending_profile_confirmations (
            player_id TEXT PRIMARY KEY,
            payload TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE pending_magic_confirmations (
            player_id TEXT PRIMARY KEY,
            magic_label TEXT NOT NULL,
            roll_number INTEGER DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
    `);

    await ensureSlotReservationsSchema(db);
    await ensureCloverCharacterStatsSchema(db);
    await ensureCloverPhLedgerSchema(db);
    await ensureCloverSkillTreeSchema(db);

    return db;
}

async function insertReleasedPlayer(db, playerId) {
    await db.run(
        `INSERT INTO jogadores
         (id, nome, personagem_nome, raca, classe, grimorio, ficha_status, personagem_aparencia_status, historia_status, jogo_status)
         VALUES (?, 'Smoke', 'Smoke Fisico', 'Humano', 'Burguesia', 'Grimório de 3 Folhas', 'aprovada', 'approved', 'aprovada', 'liberado')`,
        [playerId]
    );
    await addPh(db, playerId, 240, 'smoke_physical', 'setup arvore fisica', 'admin@s.whatsapp.net', {
        smoke: true,
    });
}

async function runCommand(command, { sock, db, playerId, body = '', matchedCommand = command.nome }) {
    await command.executar({
        sock,
        db,
        idChat: 'physical-group@g.us',
        idJogador: playerId,
        body,
        args: body ? [matchedCommand, ...body.split(/\s+/)] : [matchedCommand],
        matchedCommand,
        m: {
            key: {
                id: 'physical-message',
                remoteJid: 'physical-group@g.us',
                participant: playerId,
            },
            message: { conversation: `${matchedCommand} ${body}`.trim() },
        },
    });
}

async function describeRender(db, playerId, treeId) {
    const rendered = await renderTreeVisualPngCached(db, playerId, treeId, { mode: 'compact' });
    assert(fs.existsSync(rendered.path), `${treeId} deveria gerar PNG em cache.`);
    const metadata = await sharp(rendered.path).metadata();
    assert(rendered.layoutSource === 'approved:fisico_tree_rework_v1_html', 'Fisico deveria usar o layout aprovado do rework v1.');
    assert(rendered.nodeCount.total === 76, 'Fisico deveria ter 76 nos oficiais.');
    assert(rendered.nodeCount.drawn === rendered.nodeCount.total, 'Fisico deveria desenhar todos os nos.');
    assert(metadata.width === rendered.dimensions.width, 'Largura do PNG deveria bater com metadata.');
    assert(metadata.height === rendered.dimensions.height, 'Altura do PNG deveria bater com metadata.');

    console.log(
        `[clover-physical] treeId=${treeId} mode=${rendered.mode} layoutSource=${rendered.layoutSource} `
        + `nodeCountTotal=${rendered.nodeCount.total} nodeCountDrawn=${rendered.nodeCount.drawn} `
        + `path=${rendered.path} width=${metadata.width} height=${metadata.height}`
    );

    return rendered;
}

async function main() {
    loadTrees({ forceReload: true });
    const tree = getTree('fisico');
    assert(tree, 'Arvore fisica deveria estar carregada.');
    assert(tree.nodes.length === 76, 'Arvore fisica deveria ter 76 nos no JSON.');
    assert(tree.edges.length > 0, 'Arvore fisica deveria ter ligacoes reais.');
    assert(tree.nodesById.fisico, 'Arvore fisica deveria ter no base fisico.');
    assert(tree.nodesById.apice_fisico, 'Arvore fisica deveria ter Apice Fisico.');
    assert(tree.nodesById.visao_i.cost === 35, 'Visao I deveria custar 35 PH no rework.');
    assert(tree.nodesById.paladar_i.cost === 35, 'Paladar I deveria custar 35 PH no rework.');
    assert(tree.nodesById.intuicao_corporal_v.cost === 140, 'Intuicao Corporal V deveria custar 140 PH no rework.');

    const db = await createMemoryDb();
    const sock = createFakeSock();
    const playerId = 'physical_player@s.whatsapp.net';
    await insertReleasedPlayer(db, playerId);

    const initialState = await getTreeState(db, playerId, 'fisico');
    const baseNodeState = initialState.nodeStates.find((item) => item.node.id === 'fisico');
    assert(initialState.discount.percent === 5, 'Burguesia deve aplicar 5% de desconto automatico na arvore fisica.');
    assert(applyTreeDiscountCost(15, 5) === 14, 'Desconto de 5% em no de 15 PH deve reduzir o custo para 14 PH.');
    assert(baseNodeState.effectiveCost === 14, 'No base fisico deveria usar custo com desconto.');

    await describeRender(db, playerId, 'fisico');

    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#arvores' });
    assertText(latestMessage(sock), '.#arvores');
    assert(normalize(latestText(sock)).includes('fisico'), '.#arvores deveria listar fisico.');

    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#arvore', body: 'fisico' });
    assertImage(latestMessage(sock), '.#arvore fisico');
    assert(normalize(latestText(sock)).includes('arvore fisica'), '.#arvore fisico deveria ter caption da arvore fisica.');

    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#arvore', body: 'fisico texto' });
    assertText(latestMessage(sock), '.#arvore fisico texto');
    assert(normalize(latestText(sock)).includes('apice fisico'), '.#arvore fisico texto deveria mostrar o mapa textual.');

    await runCommand(fisicoCommand, { sock, db, playerId, matchedCommand: '.#fisico' });
    assertImage(latestMessage(sock), '.#fisico');
    assert(normalize(latestText(sock)).includes('arvore fisica'), '.#fisico deveria funcionar como alias visual.');

    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#no', body: 'fisico vigor' });
    assertText(latestMessage(sock), '.#no fisico vigor');
    assert(normalize(latestText(sock)).includes('vigor'), '.#no fisico vigor deveria mostrar detalhes do no.');

    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#comprar', body: 'fisico fisico' });
    assertText(latestMessage(sock), '.#comprar fisico fisico');
    assert(normalize(latestText(sock)).includes('confirmarcompra'), '.#comprar fisico fisico deveria abrir confirmacao.');

    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#confirmarcompra' });
    assertText(latestMessage(sock), '.#confirmarcompra');
    assert(normalize(latestText(sock)).includes('compr'), '.#confirmarcompra deveria confirmar compra.');

    const bought = await db.get(
        `SELECT * FROM clover_skill_nodes WHERE player_id = ? AND tree_id = 'fisico' AND node_id = 'fisico'`,
        [playerId]
    );
    assert(bought, 'Compra do no base fisico deveria ser registrada.');

    const spend = await db.get(
        `SELECT * FROM clover_ph_ledger
         WHERE player_id = ? AND source = 'skill_tree:fisico' AND related_id = 'fisico:fisico'`,
        [playerId]
    );
    assert(spend && spend.amount === -14, 'Compra fisica deveria gastar o custo com desconto aplicado.');

    await db.close();
    console.log('Smoke Clover physical tree passou com sucesso.');
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});
