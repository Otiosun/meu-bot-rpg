const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const perfilCommand = require('../comandos/perfil');
const {
    ensureCloverCharacterStatsSchema,
    ensureCloverManaHexagonSchema,
    ensureCloverPhLedgerSchema,
    ensureCloverSkillTreeSchema,
    ensureSlotReservationsSchema,
} = require('../database');
const { addPh } = require('../helpers/clover/phService');
const { setHexagonSide } = require('../helpers/clover/hexagonService');
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
            const response = { key: { id: `profile-capacity-${counter}`, remoteJid: idChat } };
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
    await ensureCloverManaHexagonSchema(db);

    return db;
}

async function insertPlayer(db, id, patch = {}) {
    await db.run(
        `INSERT INTO jogadores
         (id, nome, personagem_nome, ficha_status, personagem_aparencia_status, historia_status, jogo_status,
          magia, reino, classe, raca, grimorio, familia, mana)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            patch.mana || 1200,
        ]
    );

    await db.run(
        `INSERT INTO clover_character_stats
         (player_id, stage_key, pb_total, pb_spent, forca, velocidade, agilidade, resistencia, poder_magico, distribution_status)
         VALUES (?, '9', 10, 10, 2, 2, 2, 2, 2, 'confirmed')`,
        [id]
    );
}

async function insertOwnedNode(db, playerId, treeId, nodeId) {
    await db.run(
        `INSERT OR IGNORE INTO clover_skill_nodes
         (player_id, tree_id, node_id, purchased_at, purchased_by, source, metadata_json)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP, 'smoke', 'smoke_profile_capacity', '{}')`,
        [playerId, treeId, nodeId]
    );
}

async function runCommand(command, { sock, db, playerId }) {
    await command.executar({
        sock,
        db,
        idChat: 'profile-capacity-group@g.us',
        idJogador: playerId,
        nomeUsuario: 'Tester',
        body: '',
        args: [command.nome],
        matchedCommand: command.nome,
        m: { key: { id: 'profile-capacity-message', remoteJid: 'profile-capacity-group@g.us', participant: playerId } },
    });
}

async function main() {
    loadTrees({ forceReload: true });

    const db = await createMemoryDb();
    const sock = createFakeSock();

    await insertPlayer(db, 'bloqueado@s.whatsapp.net', {
        historia_status: 'pendente',
        jogo_status: 'aguardando_historia',
    });
    await runCommand(perfilCommand, { sock, db, playerId: 'bloqueado@s.whatsapp.net' });
    assert(normalize(latestText(sock)).includes('acesso') || normalize(latestText(sock)).includes('liberado'), 'Perfil deveria manter gate de jogo liberado.');

    const playerId = 'perfil_capacity@s.whatsapp.net';
    await insertPlayer(db, playerId);
    await addPh(db, playerId, 80, 'smoke_profile_capacity', 'setup', 'admin@s.whatsapp.net');

    await runCommand(perfilCommand, { sock, db, playerId });
    let text = normalize(latestText(sock));
    assert(text.includes('perfil do mago'), '.#perfil deveria renderizar o perfil.');
    assert(text.includes('hexagono'), '.#perfil deveria mostrar bloco de Hexagono.');
    assert(text.includes('*per:* 1') && text.includes('*alc:* 1'), '.#perfil deveria mostrar Hexagono default 1/5.');
    assert(text.includes('alcance') && text.includes('3m'), '.#perfil deveria mostrar alcance derivado default.');
    assert(text.includes('duracao') && text.includes('1 ciclo'), '.#perfil deveria mostrar duracao derivada default.');
    assert(text.includes('impacto de mana pura') && text.includes('+0%'), '.#perfil deveria mostrar impacto derivado default.');
    assert(text.includes('.#capacidade'), '.#perfil deveria recomendar .#capacidade para detalhes.');
    assert(!text.includes('custos comuns') && !text.includes('peso ') && !text.includes('rank '), '.#perfil nao deveria mostrar custos comuns longos.');

    await setHexagonSide(db, playerId, 'alcance', 3, 'admin@s.whatsapp.net', 'smoke');
    await setHexagonSide(db, playerId, 'retencao', 2, 'admin@s.whatsapp.net', 'smoke');
    await setHexagonSide(db, playerId, 'pressao', 2, 'admin@s.whatsapp.net', 'smoke');
    await insertOwnedNode(db, playerId, 'criacao', 'criacao');
    await insertOwnedNode(db, playerId, 'criacao', 'controle');
    await insertOwnedNode(db, playerId, 'reforco', 'reforco');
    await insertOwnedNode(db, playerId, 'mana', 'fluxo_de_mana_i');
    await insertOwnedNode(db, playerId, 'mana', 'mana_bullet_i');

    await runCommand(perfilCommand, { sock, db, playerId });
    text = normalize(latestText(sock));
    assert(text.includes('*per:* 1') && text.includes('*alc:* 3'), '.#perfil deveria mostrar Hexagono atualizado.');
    assert(text.includes('15m') && text.includes('2 ciclos') && text.includes('+5%'), '.#perfil deveria mostrar derivados atualizados.');
    assert(text.includes('manifestacoes') && text.includes('melhoria basica'), '.#perfil deveria resumir Criacao comprada.');
    assert(text.includes('fortalecer o proprio corpo'), '.#perfil deveria resumir Reforco comprado.');
    assert(text.includes('mana pura ofensiva'), '.#perfil deveria resumir Mana comprada.');
    assert(text.includes('curta/media distancia'), '.#perfil deveria gerar resumo final curto.');
    assert(!text.includes('custos comuns') && !text.includes('peso ') && !text.includes('rank '), '.#perfil com nos nao deveria mostrar custos.');

    await db.close();
    console.log('Smoke Clover perfil capacidade passou com sucesso.');
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});
