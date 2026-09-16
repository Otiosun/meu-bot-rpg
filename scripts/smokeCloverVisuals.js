const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const sharp = require('sharp');

const arvoresCommand = require('../comandos/arvores');
const hexagonoCommand = require('../comandos/hexagono');
const {
    ensureCloverCharacterStatsSchema,
    ensureCloverManaHexagonSchema,
    ensureCloverPhLedgerSchema,
    ensureCloverSkillTreeSchema,
    ensureSlotReservationsSchema,
} = require('../database');
const { addPh } = require('../helpers/clover/phService');
const { setHexagonSide } = require('../helpers/clover/hexagonService');
const { renderHexagonPngCached } = require('../helpers/clover/hexagonRenderer');
const { renderTreeVisualPngCached } = require('../helpers/clover/treeVisualRenderer');
const { loadTrees } = require('../helpers/clover/treeLoader');

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
            const response = { key: { id: `visual-${counter}`, remoteJid: idChat } };
            sent.push({ idChat, message, options, response });
            return response;
        },
        async groupMetadata() {
            return {
                participants: [
                    { id: 'admin@s.whatsapp.net', admin: 'admin' },
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

function assertImageMessage(message, label) {
    assert(Buffer.isBuffer(message.image), `${label} deveria enviar imagem em buffer.`);
    assert(String(message.caption || '').length > 0, `${label} deveria enviar caption.`);
}

function assertTextMessage(message, label) {
    assert(!message.image, `${label} nao deveria enviar imagem.`);
    assert(String(message.text || '').length > 0, `${label} deveria enviar texto.`);
}

function statIfExists(filePath) {
    return fs.existsSync(filePath) ? fs.statSync(filePath).mtimeMs : null;
}

async function describeTreeRender(treeId, rendered) {
    const png = await sharp(rendered.path).metadata();
    const width = png.width || rendered.dimensions?.width || 0;
    const height = png.height || rendered.dimensions?.height || 0;
    const info = {
        treeId,
        mode: rendered.mode,
        layoutSource: rendered.layoutSource || null,
        model: rendered.model || null,
        totalNodes: rendered.nodeCount?.total || 0,
        drawnNodes: rendered.nodeCount?.drawn || 0,
        path: rendered.path,
        width,
        height,
    };

    assert(info.mode === 'approved', `Arvore ${treeId} deveria usar modo visual aprovado, recebido: ${info.mode}`);
    const expectedSource = treeId === 'mana'
        ? 'approved:mana_tree_v7_3_html'
        : `approved:magic_split_html:${treeId}`;
    assert(info.layoutSource === expectedSource, `Arvore ${treeId} deveria usar ${expectedSource}.`);
    if (treeId === 'mana') {
        assert(info.totalNodes === 57, 'Arvore mana completa deveria ter 57 nos oficiais.');
    }
    assert(info.totalNodes > 0, `Arvore ${treeId} deveria ter nodeCount total maior que zero.`);
    assert(info.drawnNodes === info.totalNodes, `Arvore ${treeId} aprovada deveria desenhar todos os nos do modelo aprovado.`);
    assert(width === rendered.dimensions?.width, `Largura do PNG ${treeId} ${info.mode} deveria bater com metadata do renderer.`);
    assert(height === rendered.dimensions?.height, `Altura do PNG ${treeId} ${info.mode} deveria bater com metadata do renderer.`);

    console.log(
        `[clover-visual] treeId=${info.treeId} mode=${info.mode} model=${info.model || '-'} layoutSource=${info.layoutSource || '-'} nodeCountTotal=${info.totalNodes} `
        + `nodeCountDrawn=${info.drawnNodes} path=${info.path} width=${info.width} height=${info.height}`
    );

    return info;
}

async function createMemoryDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });

    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT DEFAULT '-',
            personagem_nome TEXT DEFAULT '-',
            ficha_status TEXT DEFAULT 'incompleta',
            personagem_aparencia_status TEXT DEFAULT 'pending',
            historia_status TEXT DEFAULT 'pendente',
            jogo_status TEXT DEFAULT 'bloqueado'
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
    await ensureCloverManaHexagonSchema(db);
    await ensureCloverPhLedgerSchema(db);
    await ensureCloverSkillTreeSchema(db);

    return db;
}

async function insertReleasedPlayer(db, playerId, name = 'Visual Clover') {
    await db.run(
        `INSERT INTO jogadores
         (id, nome, personagem_nome, ficha_status, personagem_aparencia_status, historia_status, jogo_status)
         VALUES (?, ?, ?, 'aprovada', 'approved', 'aprovada', 'liberado')`,
        [playerId, name, name]
    );
    await addPh(db, playerId, 240, 'smoke_visual', 'setup visual smoke', 'admin@s.whatsapp.net', {
        smoke: true,
    });
}

async function insertOwnedNode(db, playerId, treeId, nodeId) {
    await db.run(
        `INSERT OR IGNORE INTO clover_skill_nodes
         (player_id, tree_id, node_id, purchased_at, purchased_by, source, metadata_json)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP, 'smoke', 'smoke_visual', '{}')`,
        [playerId, treeId, nodeId]
    );
}

async function setupPlayer(db, playerId) {
    await insertReleasedPlayer(db, playerId);
    await insertOwnedNode(db, playerId, 'mana', 'sentir_mana_i');
    await insertOwnedNode(db, playerId, 'suporte', 'suporte');
    await insertOwnedNode(db, playerId, 'criacao', 'criacao');
    await insertOwnedNode(db, playerId, 'reforco', 'reforco');
    await setHexagonSide(db, playerId, 'controle', 3, 'admin@s.whatsapp.net', 'smoke visual');
    await setHexagonSide(db, playerId, 'alcance', 4, 'admin@s.whatsapp.net', 'smoke visual');
    await setHexagonSide(db, playerId, 'escala', 2, 'admin@s.whatsapp.net', 'smoke visual');
}

async function runCommand(command, { sock, db, playerId, body = '', matchedCommand = command.nome }) {
    await command.executar({
        sock,
        db,
        idChat: 'visual-group@g.us',
        idJogador: playerId,
        body,
        args: body ? [matchedCommand, ...body.split(/\s+/)] : [matchedCommand],
        matchedCommand,
        m: {
            key: {
                id: 'visual-message',
                remoteJid: 'visual-group@g.us',
                participant: playerId,
            },
            message: { conversation: `${matchedCommand} ${body}`.trim() },
        },
    });
}

async function main() {
    loadTrees({ forceReload: true });

    const physicalFiles = [
        path.join(process.cwd(), 'comandos', 'fisico.js'),
        path.join(process.cwd(), 'helpers', 'rpg', 'skillTreeEngine.js'),
    ];
    const physicalBefore = Object.fromEntries(physicalFiles.map((filePath) => [filePath, statIfExists(filePath)]));

    const db = await createMemoryDb();
    const sock = createFakeSock();
    const playerId = 'visual_player@s.whatsapp.net';

    await setupPlayer(db, playerId);

    const hexagon = await db.get('SELECT * FROM clover_mana_hexagon WHERE player_id = ?', [playerId]);
    const renderedHexagon = await renderHexagonPngCached(playerId, hexagon);
    assert(fs.existsSync(renderedHexagon.path), 'Hexagono visual deveria gerar arquivo em cache.');
    assert(fs.statSync(renderedHexagon.path).size > 0, 'Hexagono visual cacheado deveria ter tamanho maior que zero.');

    const comparisonRenders = {};
    for (const treeId of ['mana', 'suporte', 'criacao', 'reforco']) {
        const renderedTree = await renderTreeVisualPngCached(db, playerId, treeId, { mode: 'compact' });
        assert(fs.existsSync(renderedTree.path), `Arvore ${treeId} aprovada deveria gerar arquivo em cache.`);
        assert(fs.statSync(renderedTree.path).size > 0, `Arvore ${treeId} aprovada cacheada deveria ter tamanho maior que zero.`);
        const treeInfo = await describeTreeRender(treeId, renderedTree);

        const renderedAliasTree = await renderTreeVisualPngCached(db, playerId, treeId, { mode: 'complete' });
        assert(fs.existsSync(renderedAliasTree.path), `Alias completo de ${treeId} deveria gerar arquivo aprovado em cache.`);
        const aliasInfo = await describeTreeRender(treeId, renderedAliasTree);
        assert(aliasInfo.layoutSource === treeInfo.layoutSource, `Alias completo de ${treeId} deveria manter o mesmo modelo aprovado.`);
        assert(aliasInfo.drawnNodes === treeInfo.drawnNodes, `Alias completo de ${treeId} deveria manter nodeCount aprovado.`);
        if (treeId === 'mana') {
            assert(aliasInfo.path !== treeInfo.path, 'Mana compact e complete deveriam ter caches diferentes.');
        }

        comparisonRenders[treeId] = treeInfo;
    }

    await runCommand(hexagonoCommand, { sock, db, playerId, matchedCommand: '.#hexagono' });
    assertImageMessage(latestMessage(sock), '.#hexagono');
    assert(normalize(latestText(sock)).includes('hexagono de mana'), '.#hexagono deveria manter caption textual.');

    await runCommand(hexagonoCommand, { sock, db, playerId, matchedCommand: '.#hexagono', body: 'texto' });
    assertTextMessage(latestMessage(sock), '.#hexagono texto');
    assert(normalize(latestText(sock)).includes('limites derivados'), '.#hexagono texto deveria manter leitura textual.');

    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#arvores' });
    assertTextMessage(latestMessage(sock), '.#arvores');
    const treesMenuText = normalize(latestText(sock));
    assert(treesMenuText.includes('arvores de progresso'), '.#arvores deveria mostrar menu de progresso.');
    assert(treesMenuText.includes('.#arvore mana'), '.#arvores deveria listar mana.');
    assert(treesMenuText.includes('.#arvore suporte'), '.#arvores deveria listar suporte.');
    assert(!treesMenuText.includes('completa') && !treesMenuText.includes('compact'), '.#arvores nao deveria divulgar completa/compacto.');

    for (const treeId of ['mana', 'suporte', 'criacao', 'reforco']) {
        const captionNeedle = `arvore de ${treeId === 'criacao' ? 'criacao' : treeId}`;
        await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#arvore', body: treeId });
        assertImageMessage(latestMessage(sock), `.#arvore ${treeId}`);
        assert(normalize(latestText(sock)).includes(captionNeedle), `.#arvore ${treeId} deveria manter caption da arvore.`);

        await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#arvore', body: `${treeId} completa` });
        assertImageMessage(latestMessage(sock), `.#arvore ${treeId} completa`);
        assert(normalize(latestText(sock)).includes(captionNeedle), `.#arvore ${treeId} completa deveria manter caption da arvore.`);

        await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#arvore', body: `${treeId} resumo` });
        assertImageMessage(latestMessage(sock), `.#arvore ${treeId} resumo`);
        assert(normalize(latestText(sock)).includes(captionNeedle), `.#arvore ${treeId} resumo deveria manter caption da arvore.`);

        await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#arvore', body: `${treeId} texto` });
        assertTextMessage(latestMessage(sock), `.#arvore ${treeId} texto`);
        const textMode = normalize(latestText(sock));
        assert(textMode.includes('rotas principais') || textMode.includes('-- rotas --'), `.#arvore ${treeId} texto deveria cair no texto.`);
    }

    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#arvore', body: 'magia' });
    assertTextMessage(latestMessage(sock), '.#arvore magia');
    assert(normalize(latestText(sock)).includes('arvores separadas'), '.#arvore magia deveria orientar para arvores separadas.');

    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#arvore', body: 'magia texto' });
    assertTextMessage(latestMessage(sock), '.#arvore magia texto');
    assert(normalize(latestText(sock)).includes('arvores separadas'), '.#arvore magia texto deveria orientar para arvores separadas.');

    const fallbackPlayerId = 'visual_fallback@s.whatsapp.net';
    await setupPlayer(db, fallbackPlayerId);
    process.env.CLOVER_FORCE_VISUAL_FAIL = '1';
    try {
        await runCommand(hexagonoCommand, { sock, db, playerId: fallbackPlayerId, matchedCommand: '.#hexagono' });
        assertTextMessage(latestMessage(sock), 'fallback .#hexagono');
        assert(normalize(latestText(sock)).includes('hexagono de mana'), 'Fallback do hexagono deveria enviar texto.');

        await runCommand(arvoresCommand, { sock, db, playerId: fallbackPlayerId, matchedCommand: '.#arvore', body: 'mana' });
        assertTextMessage(latestMessage(sock), 'fallback .#arvore mana');
        assert(normalize(latestText(sock)).includes('rotas principais'), 'Fallback da arvore deveria enviar texto.');

        await runCommand(arvoresCommand, { sock, db, playerId: fallbackPlayerId, matchedCommand: '.#arvore', body: 'mana completa' });
        assertTextMessage(latestMessage(sock), 'fallback .#arvore mana completa');
        assert(normalize(latestText(sock)).includes('rotas principais'), 'Fallback da arvore completa deveria enviar texto.');

        await runCommand(arvoresCommand, { sock, db, playerId: fallbackPlayerId, matchedCommand: '.#arvore', body: 'magia' });
        assertTextMessage(latestMessage(sock), 'fallback .#arvore magia');
        assert(normalize(latestText(sock)).includes('arvores separadas'), 'Fallback da arvore de magia deveria enviar texto.');
    } finally {
        delete process.env.CLOVER_FORCE_VISUAL_FAIL;
    }

    const physicalAfter = Object.fromEntries(physicalFiles.map((filePath) => [filePath, statIfExists(filePath)]));
    for (const filePath of physicalFiles) {
        assert(
            physicalBefore[filePath] === physicalAfter[filePath],
            `Arquivo fisico legado nao deveria ser tocado: ${filePath}`
        );
    }

    await db.close();
    console.log('[clover-visual] PNGs de comparacao:');
    for (const treeId of ['mana', 'suporte', 'criacao', 'reforco']) {
        console.log(`[clover-visual] ${treeId} approved=${comparisonRenders[treeId].path}`);
    }
    console.log('Smoke Clover visuals passou com sucesso.');
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});
