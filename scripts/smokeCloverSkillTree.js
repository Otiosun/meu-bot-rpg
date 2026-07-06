const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const arvoresCommand = require('../comandos/arvores');
const {
    ensureCloverCharacterStatsSchema,
    ensureCloverPhLedgerSchema,
    ensureCloverSkillTreeSchema,
    ensureSlotReservationsSchema,
} = require('../database');
const { addPh, getPhSummary, removeAvailablePh } = require('../helpers/clover/phService');
const { applyTreeDiscountCost } = require('../helpers/clover/characterBonusService');
const { getTree } = require('../helpers/clover/treeLoader');

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
            const response = { key: { id: `tree-${counter}`, remoteJid: idChat } };
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

async function runCommand(command, { sock, db, playerId, body = '', matchedCommand = command.nome, m = null, idJogador = playerId }) {
    await command.executar({
        sock,
        db,
        idChat: 'tree-group@g.us',
        idJogador,
        nomeUsuario: 'Tester',
        body,
        args: body ? [matchedCommand, ...body.split(/\s+/)] : [matchedCommand],
        matchedCommand,
        m: m || { key: { id: 'tree-message', remoteJid: 'tree-group@g.us', participant: idJogador } },
    });
}

async function grantPh(db, playerId, amount) {
    await addPh(db, playerId, amount, 'smoke_tree', 'setup smoke tree', 'admin@s.whatsapp.net', {
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

async function main() {
    const db = await createMemoryDb();
    const sock = createFakeSock();
    const playerId = 'tree_player@s.whatsapp.net';

    await insertPlayer(db, 'bloqueado@s.whatsapp.net', {
        historia_status: 'pendente',
        jogo_status: 'aguardando_historia',
    });
    await runCommand(arvoresCommand, { sock, db, playerId: 'bloqueado@s.whatsapp.net' });
    assert(normalize(latestText(sock)).includes('acesso') || normalize(latestText(sock)).includes('liberado'), 'Player nao liberado nao deveria usar .#arvores.');

    await insertPlayer(db, playerId);
    await runCommand(arvoresCommand, { sock, db, playerId });
    let text = normalize(latestText(sock));
    assert(text.includes('arvores') && text.includes('mana'), 'Player liberado deveria usar .#arvores.');

  await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#arvore', body: 'mana texto' });
  text = normalize(latestText(sock));
  assert(text.includes('rotas principais') && text.includes('rota da percepcao'), '.#arvore mana texto deveria mostrar rotas.');

    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#rota', body: 'mana percepção' });
    text = normalize(latestText(sock));
    assert(text.includes('sentir mana i') && text.includes('convergencias'), '.#rota mana percepcao deveria mostrar caminho.');

    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#no', body: 'mana skin' });
    text = normalize(latestText(sock));
    assert(text.includes('pele de mana') && text.includes('fluxo de mana') && text.includes('retencao de mana'), '.#no mana skin deveria mostrar requisitos oficiais.');

    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#no', body: 'mana bala-de-mana-i' });
    text = normalize(latestText(sock));
    assert(text.includes('bala de mana i') && text.includes('ranks') && text.includes('custo'), '.#no mana bala-de-mana-i deveria mostrar ranks e custo.');

    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#no', body: 'suporte magigramatica' });
    text = normalize(latestText(sock));
    assert(text.includes('magigramatica') && text.includes('rank i') && text.includes('aprovacao narrativa'), '.#no suporte magigramatica deveria explicar ranks e aprovacao de suporte.');

    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#no', body: 'criacao juncao-de-forma' });
    text = normalize(latestText(sock));
    assert(text.includes('juncao de forma') && text.includes('aprovacao narrativa'), '.#no criacao juncao-de-forma deveria mostrar aprovacao narrativa.');

    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#no', body: 'reforco reforco-coletivo' });
    text = normalize(latestText(sock));
    assert(text.includes('reforco coletivo') && text.includes('risco') && text.includes('extremo'), '.#no reforco reforco-coletivo deveria mostrar risco extremo.');

    await removeAvailablePh(db, playerId, 15, 'smoke_tree', 'zerar ph inicial para teste sem saldo', 'admin@s.whatsapp.net');
    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#comprar', body: 'fluxo 1' });
    text = normalize(latestText(sock));
    assert(text.includes('ph insuficiente') || text.includes('sem ph'), 'Player sem PH suficiente nao deveria comprar.');

    await grantPh(db, playerId, 200);

    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#comprar', body: 'mana mana' });
    text = normalize(latestText(sock));
    assert(text.includes('compra pendente') && text.includes('ph apos compra'), '.#comprar deveria mostrar PH antes/depois.');

    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#cancelarcompra' });
    text = normalize(latestText(sock));
    assert(text.includes('compra cancelada') && text.includes('nenhum ph'), '.#cancelarcompra deveria explicar cancelamento sem gasto.');

    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#confirmarcompra' });
    text = normalize(latestText(sock));
    assert(text.includes('nenhuma compra pendente'), '.#confirmarcompra sem pendencia deveria explicar ausencia de compra.');

    const expiredCreatedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const expiredAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await db.run(
        `INSERT INTO clover_pending_skill_purchases
         (player_id, tree_id, node_id, created_by, source, created_at, expires_at, metadata_json)
         VALUES (?, 'mana', 'mana', 'smoke', 'smoke_expired', ?, ?, '{}')
         ON CONFLICT(player_id) DO UPDATE SET
             tree_id = excluded.tree_id,
             node_id = excluded.node_id,
             created_by = excluded.created_by,
             source = excluded.source,
             created_at = excluded.created_at,
             expires_at = excluded.expires_at,
             metadata_json = excluded.metadata_json`,
        [playerId, expiredCreatedAt, expiredAt]
    );
    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#confirmarcompra' });
    text = normalize(latestText(sock));
    assert(text.includes('compra expirada') && text.includes('nenhum ph'), '.#confirmarcompra expirado deveria explicar expiracao sem gasto.');
    const expiredPending = await db.get(
        `SELECT * FROM clover_pending_skill_purchases WHERE player_id = ?`,
        [playerId]
    );
    assert(!expiredPending, 'Compra expirada deveria limpar pendencia.');

    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#comprar', body: 'mana skin' });
    text = normalize(latestText(sock));
    assert(text.includes('bloqueado') && text.includes('fluxo de mana'), 'Player com PH mas sem requisitos nao deveria comprar Pele de Mana.');

    await insertOwnedNode(db, playerId, 'fluxo_de_mana_i');
    await insertOwnedNode(db, playerId, 'retencao_de_mana_i');
    const before = await getPhSummary(db, playerId);
    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#comprar', body: 'mana skin' });
    text = normalize(latestText(sock));
    assert(text.includes('compra pendente') && text.includes('confirmarcompra'), 'Player com requisitos e PH deveria iniciar compra pendente.');

    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#confirmarcompra' });
    text = normalize(latestText(sock));
    assert(text.includes('no comprado') || text.includes('comprado com sucesso'), '.#confirmarcompra deveria comprar no.');

    const ownedSkin = await db.get(
        `SELECT * FROM clover_skill_nodes WHERE player_id = ? AND tree_id = 'mana' AND node_id = 'mana_skin_i'`,
        [playerId]
    );
    assert(ownedSkin, 'Confirmar compra deveria registrar no comprado.');

    const after = await getPhSummary(db, playerId);
    const manaSkinCost = Number(getTree('mana').nodesById.mana_skin_i.cost || 0);
    const discountedManaSkinCost = applyTreeDiscountCost(manaSkinCost, 10);
    assert(after.phAvailable === before.phAvailable - discountedManaSkinCost, 'Compra deveria reduzir PH disponivel pelo custo com desconto automatico.');
    assert(after.phAccumulated === before.phAccumulated, 'Compra nao deveria reduzir PH acumulado.');

    const spentLedger = await db.get(
        `SELECT * FROM clover_ph_ledger WHERE player_id = ? AND kind = 'gasto' AND related_id = 'mana:mana_skin_i'`,
        [playerId]
    );
    assert(spentLedger, 'Compra deveria registrar gasto no ledger de PH.');

    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#no', body: 'mana skin' });
    assert(normalize(latestText(sock)).includes('comprado'), 'No comprado deveria aparecer como comprado.');

    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#no', body: 'sentir' });
    text = normalize(latestText(sock));
    assert(text.includes('use um') && text.includes('exemplo'), 'No ambiguo deveria pedir esclarecimento.');

    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#no', body: 'inexistente' });
    text = normalize(latestText(sock));
    assert(text.includes('no nao encontrado') || text.includes('arvore mana texto'), 'No inexistente deveria mostrar feedback de no nao encontrado.');

    await insertOwnedNode(db, playerId, 'ambiente_de_mana_i');
    await runCommand(arvoresCommand, { sock, db, playerId, matchedCommand: '.#comprar', body: 'mana zone' });
    text = normalize(latestText(sock));
    assert(text.includes('aprovacao narrativa') && text.includes('adm'), 'Mana Zone deveria exigir aprovacao e nao comprar direto.');

    await db.close();
    console.log('Smoke Clover skill tree passou com sucesso.');
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});
