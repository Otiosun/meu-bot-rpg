const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const arvoresCommand = require('../comandos/arvores');
const {
    ensureCloverCharacterStatsSchema,
    ensureCloverPhLedgerSchema,
    ensureCloverSkillTreeSchema,
    ensureSlotReservationsSchema,
} = require('../database');
const { addPh, getPhSummary } = require('../helpers/clover/phService');
const { listTrees, loadTrees } = require('../helpers/clover/treeLoader');

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
            const response = { key: { id: `magic-tree-${counter}`, remoteJid: idChat } };
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

async function insertPlayer(db, id) {
    await db.run(
        `INSERT INTO jogadores
         (id, nome, personagem_nome, ficha_status, personagem_aparencia_status, historia_status, jogo_status,
          magia, reino, classe, raca, grimorio, familia)
         VALUES (?, ?, ?, 'aprovada', 'approved', 'aprovada', 'liberado', ?, ?, ?, ?, ?, ?)`,
        [
            id,
            'Smoke',
            'Aster',
            'Magia de Pintura',
            'Clover',
            'Nobreza',
            'Humano',
            'Grimorio de 3 Folhas',
            'Nenhuma',
        ]
    );
}

async function runCommand(command, { sock, db, playerId, body = '', matchedCommand = command.nome }) {
    await command.executar({
        sock,
        db,
        idChat: 'magic-tree-group@g.us',
        idJogador: playerId,
        nomeUsuario: 'Tester',
        body,
        args: body ? [matchedCommand, ...body.split(/\s+/)] : [matchedCommand],
        matchedCommand,
        m: {
            key: { id: 'magic-tree-message', remoteJid: 'magic-tree-group@g.us', participant: playerId },
            message: { conversation: `${matchedCommand} ${body}`.trim() },
        },
    });
}

async function grantPh(db, playerId, amount) {
    await addPh(db, playerId, amount, 'smoke_magic_tree', 'setup smoke magic tree', 'admin@s.whatsapp.net', {
        smoke: true,
    });
}

async function assertPending(db, playerId, treeId, nodeId) {
    const row = await db.get(
        `SELECT *
         FROM clover_pending_skill_purchases
         WHERE player_id = ? AND tree_id = ? AND node_id = ?`,
        [playerId, treeId, nodeId]
    );
    assert(row, `Compra pendente deveria existir para ${treeId}:${nodeId}.`);
}

async function assertOwned(db, playerId, treeId, nodeId) {
    const row = await db.get(
        `SELECT *
         FROM clover_skill_nodes
         WHERE player_id = ? AND tree_id = ? AND node_id = ?`,
        [playerId, treeId, nodeId]
    );
    assert(row, `No comprado deveria existir para ${treeId}:${nodeId}.`);
}

async function assertSpentLedger(db, playerId, treeId, nodeId) {
    const row = await db.get(
        `SELECT *
         FROM clover_ph_ledger
         WHERE player_id = ? AND kind = 'gasto' AND related_id = ?`,
        [playerId, `${treeId}:${nodeId}`]
    );
    assert(row, `Ledger de gasto deveria existir para ${treeId}:${nodeId}.`);
}

function assertTreeBalanceMetadata() {
    const byId = Object.fromEntries(listTrees().map((tree) => [tree.id, tree]));
    const expectedCounts = {
        mana: 57,
        suporte: 21,
        criacao: 28,
        reforco: 25,
    };

    for (const [treeId, expected] of Object.entries(expectedCounts)) {
        assert(byId[treeId]?.nodes.length === expected, `${treeId} deveria manter ${expected} nos.`);
    }

    const mana = byId.mana.nodesById;
    assert(mana.mana.cost === 15, 'MANA deveria custar 15 PH.');
    assert(mana.mana_bullet_i.cost === 25 && mana.mana_bullet_ii.cost === 40 && mana.mana_bullet_iii.cost === 60, 'Bala de Mana deveria custar 25/40/60.');
    assert(mana.mana_bullet_i.metadata?.technicalWeight === 2 && mana.mana_bullet_ii.metadata?.technicalWeight === 4 && mana.mana_bullet_iii.metadata?.technicalWeight === 6, 'Pesos de Bala de Mana deveriam continuar 2/4/6.');
    assert(mana.pulso_de_mana_i.metadata?.technicalWeight === 2 && mana.pulso_de_mana_ii.metadata?.technicalWeight === 4 && mana.pulso_de_mana_iii.metadata?.technicalWeight === 6, 'Pesos de Pulso de Mana deveriam continuar 2/4/6.');
    assert(mana.mana_zone_i.requiresApproval && mana.mana_zone_ii.requiresApproval && mana.mana_zone_iii.requiresApproval && mana.dominio_de_mana.requiresApproval, 'Zona/Dominio de Mana deveriam exigir aprovacao.');

    const criacao = byId.criacao.nodesById;
    assert(criacao.criacao.cost === 15 && criacao.controle.cost === 15 && criacao.estrutura.cost === 15, 'Base/Controle/Estrutura de Criacao deveriam custar 15.');
    assert(criacao.forca_magica_i.cost === 25 && criacao.forca_magica_ii.cost === 40 && criacao.forca_magica_iii.cost === 60, 'Forca Magica deveria custar 25/40/60.');
    assert(criacao.armas_iii.requiresApproval && criacao.formas_humanoides_ii.requiresApproval && criacao.ambiente_iii.requiresApproval, 'Nos sensiveis de Criacao deveriam exigir aprovacao.');

    const reforco = byId.reforco.nodesById;
    assert(reforco.reforco.cost === 15, 'Base de Reforco deveria custar 15.');
    assert(reforco.invicto.cost === 80 && reforco.reforco_coletivo.cost === 100 && reforco.reforco_avancado_ambiente.cost === 120, 'Reforco aliado/avancado deveria usar custos 80/100/120.');
    assert(reforco.reforco_coletivo.requiresApproval && reforco.reforco_avancado_ambiente.requiresApproval, 'Reforco Coletivo e Ambiente deveriam exigir aprovacao.');

    const suporte = byId.suporte.nodesById;
    assert(suporte.suporte.cost === 15, 'Base de Suporte deveria custar 15.');
    assert(suporte.magigramatica.metadata?.maxRank === 3 && suporte.magigramatica.metadata?.rankCosts?.join('/') === '25/40/60', 'Magigramatica deveria ter metadata de rank 25/40/60.');
    assert(suporte.praga.cost === 80 && suporte.praga.metadata?.rankCosts?.join('/') === '80/100/120', 'Praga deveria ter custo/ranks 80/100/120.');
    assert(suporte.absorcao.requiresApproval && suporte.restricao.requiresApproval && suporte.juncao_de_forma.requiresApproval, 'Nos perigosos de Suporte deveriam exigir aprovacao.');
    for (const nodeId of ['suporte', 'bencao', 'buff', 'comunicacao', 'selo', 'cura']) {
        assert(!suporte[nodeId].requiresApproval && suporte[nodeId].metadata?.purchaseStatus === 'available_basic', `${nodeId} deveria estar liberado como basico.`);
    }
    for (const nodeId of ['magigramatica', 'praga', 'juncao_de_forma', 'transformacao', 'armadilha', 'condicao', 'magia_proibida', 'maldicao', 'ilusao', 'absorcao', 'enfraquecimento', 'restricao', 'debuff', 'efeito', 'transmissao']) {
        assert(suporte[nodeId].requiresApproval && suporte[nodeId].metadata?.purchaseStatus === 'approval_required', `${nodeId} deveria exigir aprovacao.`);
    }
}

async function main() {
    loadTrees({ forceReload: true });
    const treeIds = listTrees().map((tree) => tree.id).sort();
    assert(treeIds.includes('mana'), 'Loader deveria carregar mana.');
    assert(treeIds.includes('suporte'), 'Loader deveria carregar suporte.');
    assert(treeIds.includes('criacao'), 'Loader deveria carregar criacao.');
    assert(treeIds.includes('reforco'), 'Loader deveria carregar reforco.');
    assertTreeBalanceMetadata();

    const db = await createMemoryDb();
    const sock = createFakeSock();
    const playerId = 'magic_tree_player@s.whatsapp.net';

    await insertPlayer(db, playerId);
    await grantPh(db, playerId, 200);

    await runCommand(arvoresCommand, { sock, db, playerId });
    let text = normalize(latestText(sock));
    assert(text.includes('mana') && text.includes('suporte') && text.includes('criacao') && text.includes('reforco'), '.#arvores deveria listar as quatro arvores.');

    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#arvore', body: 'suporte texto' });
    text = normalize(latestText(sock));
    assert(text.includes('arvore de suporte') && text.includes('magigramatica') && text.includes('bencao'), '.#arvore suporte texto deveria renderizar texto.');

    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#arvore', body: 'criacao texto' });
    text = normalize(latestText(sock));
    assert(text.includes('arvore de criacao') && text.includes('controle') && text.includes('estrutura'), '.#arvore criacao texto deveria renderizar texto.');

    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#arvore', body: 'reforco texto' });
    text = normalize(latestText(sock));
    assert(text.includes('arvore de reforco') && text.includes('intensidade') && text.includes('invencivel'), '.#arvore reforco texto deveria renderizar texto.');

    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#rota', body: 'criacao controle' });
    text = normalize(latestText(sock));
    assert(text.includes('rota da controle') && text.includes('defesa magica i'), '.#rota criacao controle deveria renderizar caminho.');

    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#rota', body: 'suporte magigramatica' });
    text = normalize(latestText(sock));
    assert(text.includes('rota da magigramatica') && text.includes('selo'), '.#rota suporte magigramatica deveria renderizar caminho.');

    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#rota', body: 'reforco invencivel' });
    text = normalize(latestText(sock));
    assert(text.includes('rota da invencivel') && text.includes('forca reforcada'), '.#rota reforco invencivel deveria renderizar caminho.');

    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#no', body: 'criacao forca-magica' });
    text = normalize(latestText(sock));
    assert(text.includes('forca magica i') && text.includes('+10% no impacto'), '.#no criacao forca-magica deveria mostrar descricao correta.');

    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#no', body: 'suporte cura' });
    text = normalize(latestText(sock));
    assert(text.includes('cura') && text.includes('efeitos de cura'), '.#no suporte cura deveria mostrar descricao correta.');

    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#no', body: 'suporte magigramatica' });
    text = normalize(latestText(sock));
    assert(text.includes('magigramatica') && text.includes('rank i') && text.includes('aprovacao narrativa'), '.#no suporte magigramatica deveria mostrar ranks e aprovacao.');

    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#no', body: 'suporte selo' });
    text = normalize(latestText(sock));
    assert(text.includes('selo') && text.includes('requisitos') && text.includes('nao exigida'), '.#no suporte selo deveria explicar compra basica sem aprovacao.');

    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#no', body: 'suporte praga' });
    text = normalize(latestText(sock));
    assert(text.includes('praga') && text.includes('risco') && text.includes('extremo'), '.#no suporte praga deveria mostrar risco extremo.');

    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#no', body: 'criacao juncao-de-forma' });
    text = normalize(latestText(sock));
    assert(text.includes('juncao de forma') && text.includes('aprovacao narrativa'), '.#no criacao juncao-de-forma deveria mostrar aprovacao.');

    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#no', body: 'reforco reforco-coletivo' });
    text = normalize(latestText(sock));
    assert(text.includes('reforco coletivo') && text.includes('risco') && text.includes('extremo'), '.#no reforco reforco-coletivo deveria mostrar risco extremo.');

    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#no', body: 'reforco intensidade' });
    text = normalize(latestText(sock));
    assert(text.includes('intensidade i') && text.includes('define o valor do buff'), '.#no reforco intensidade deveria mostrar descricao correta.');

    let before = await getPhSummary(db, playerId);
    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#comprar', body: 'suporte suporte' });
    text = normalize(latestText(sock));
    assert(text.includes('compra pendente'), 'Compra de suporte basico deveria criar pendencia.');
    await assertPending(db, playerId, 'suporte', 'suporte');

    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#confirmarcompra' });
    text = normalize(latestText(sock));
    assert(text.includes('no comprado'), 'Confirmar compra de suporte deveria comprar no.');
    await assertOwned(db, playerId, 'suporte', 'suporte');
    await assertSpentLedger(db, playerId, 'suporte', 'suporte');
    let after = await getPhSummary(db, playerId);
    assert(after.phAvailable === before.phAvailable - 15, 'Compra de suporte deveria gastar PH pelo custo do no.');

    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#comprar', body: 'suporte magigramatica' });
    text = normalize(latestText(sock));
    assert(text.includes('aprovacao narrativa'), 'Compra de magigramatica deveria exigir aprovacao narrativa.');
    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#comprar', body: 'suporte praga' });
    text = normalize(latestText(sock));
    assert(text.includes('aprovacao narrativa'), 'Compra de praga deveria exigir aprovacao narrativa.');
    const supportPending = await db.get(
        `SELECT *
         FROM clover_pending_skill_purchases
         WHERE player_id = ? AND tree_id = 'suporte'`,
        [playerId]
    );
    assert(!supportPending, 'Compras de suporte com aprovacao nao deveriam criar pendencia.');

    before = after;
    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#comprar', body: 'criacao criacao' });
    text = normalize(latestText(sock));
    assert(text.includes('compra pendente'), 'Compra simples de criacao deveria criar pendencia.');
    await assertPending(db, playerId, 'criacao', 'criacao');

    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#confirmarcompra' });
    text = normalize(latestText(sock));
    assert(text.includes('no comprado'), 'Confirmar compra de criacao deveria comprar no.');
    await assertOwned(db, playerId, 'criacao', 'criacao');
    await assertSpentLedger(db, playerId, 'criacao', 'criacao');
    after = await getPhSummary(db, playerId);
    assert(after.phAvailable === before.phAvailable - 15, 'Compra de criacao deveria gastar PH pelo custo do no.');

    before = after;
    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#comprar', body: 'reforco reforco' });
    text = normalize(latestText(sock));
    assert(text.includes('compra pendente'), 'Compra simples de reforco deveria criar pendencia.');
    await assertPending(db, playerId, 'reforco', 'reforco');

    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#confirmarcompra' });
    text = normalize(latestText(sock));
    assert(text.includes('no comprado'), 'Confirmar compra de reforco deveria comprar no.');
    await assertOwned(db, playerId, 'reforco', 'reforco');
    await assertSpentLedger(db, playerId, 'reforco', 'reforco');
    after = await getPhSummary(db, playerId);
    assert(after.phAvailable === before.phAvailable - 15, 'Compra de reforco deveria gastar PH pelo custo do no.');

    await db.close();
    console.log('Smoke Clover magic trees passou com sucesso.');
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});
