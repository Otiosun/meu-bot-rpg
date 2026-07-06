const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const capacidadeCommand = require('../comandos/capacidade');
const {
    ensureCloverCharacterStatsSchema,
    ensureCloverManaHexagonSchema,
    ensureCloverPhLedgerSchema,
    ensureCloverSkillTreeSchema,
    ensureSlotReservationsSchema,
} = require('../database');
const {
    formatPlayerCapacity,
    formatTechnicalCapacity,
    getPlayerTechnicalCapacity,
} = require('../helpers/clover/capacityService');
const { addPh } = require('../helpers/clover/phService');
const { setHexagonSide } = require('../helpers/clover/hexagonService');
const { loadTrees } = require('../helpers/clover/treeLoader');
const { normalizeText } = require('../helpers/textUtils');

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
            const response = { key: { id: `capacity-${counter}`, remoteJid: idChat } };
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

async function insertReleasedPlayer(db, id, name = 'Aster') {
    await db.run(
        `INSERT INTO jogadores
         (id, nome, personagem_nome, ficha_status, personagem_aparencia_status, historia_status, jogo_status,
          magia, reino, classe, raca, grimorio, familia, mana)
         VALUES (?, ?, ?, 'aprovada', 'approved', 'aprovada', 'liberado', ?, ?, ?, ?, ?, ?, ?)`,
        [
            id,
            name,
            name,
            'Magia de Pintura',
            'Clover',
            'Nobreza',
            'Humano',
            'Grimorio de 3 Folhas',
            'Nenhuma',
            1200,
        ]
    );

    await db.run(
        `INSERT INTO clover_character_stats
         (player_id, stage_key, pb_total, pb_spent, poder_magico, forca, velocidade, agilidade, resistencia, distribution_status)
         VALUES (?, '8', 20, 10, 4, 2, 2, 2, 2, 'confirmed')`,
        [id]
    );
}

async function grantPh(db, playerId, amount) {
    await addPh(db, playerId, amount, 'smoke_capacity', 'setup smoke capacity', 'admin@s.whatsapp.net', {
        smoke: true,
    });
}

async function insertOwnedNode(db, playerId, treeId, nodeId) {
    await db.run(
        `INSERT OR IGNORE INTO clover_skill_nodes
         (player_id, tree_id, node_id, purchased_at, purchased_by, source, metadata_json)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP, 'smoke', 'smoke_setup', '{}')`,
        [playerId, treeId, nodeId]
    );
}

async function runCommand(command, { sock, db, playerId, body = '', matchedCommand = command.nome, m = null }) {
    await command.executar({
        sock,
        db,
        idChat: 'capacity-group@g.us',
        idJogador: playerId,
        nomeUsuario: 'Tester',
        body,
        args: body ? [matchedCommand, ...body.split(/\s+/)] : [matchedCommand],
        matchedCommand,
        m: m || {
            key: { id: 'capacity-message', remoteJid: 'capacity-group@g.us', participant: playerId },
            message: { conversation: `${matchedCommand} ${body}`.trim() },
        },
    });
}

function mentionMessage(senderId, targetId, text = '@target') {
    return {
        key: { id: 'capacity-mention', remoteJid: 'capacity-group@g.us', participant: senderId },
        message: {
            extendedTextMessage: {
                text,
                contextInfo: { mentionedJid: [targetId] },
            },
        },
    };
}

async function main() {
    loadTrees({ forceReload: true });

    const db = await createMemoryDb();
    const sock = createFakeSock();
    const playerId = 'capacity_player@s.whatsapp.net';
    const targetId = 'capacity_target@s.whatsapp.net';

    await insertReleasedPlayer(db, playerId, 'Aster');
    await insertReleasedPlayer(db, targetId, 'Killian');
    await grantPh(db, playerId, 200);
    await grantPh(db, targetId, 200);

    let capacity = await getPlayerTechnicalCapacity(db, playerId);
    assert(capacity.ok, 'Capacidade deveria carregar player.');
    assert(capacity.hexagonLine.includes('PER 1') && capacity.hexagonLine.includes('ALC 1'), 'Player sem hexagono setado deveria iniciar 1/5.');
    assert(capacity.limits.alcanceLabel === '3m', 'Hexagono 1/5 deveria mostrar 3m.');
    assert(capacity.limits.areaLabel === 'raio 2m-3m', 'Hexagono 1/5 deveria mostrar raio 2m-3m.');
    assert(capacity.limits.duracaoLabel === '1 ciclo', 'Hexagono 1/5 deveria mostrar 1 ciclo.');
    assert(capacity.limits.pressaoBonus === '+0%', 'Hexagono 1/5 deveria mostrar +0%.');
    let simple = normalizeText(formatPlayerCapacity(capacity));
    assert(simple.includes('capacidade') && simple.includes('teto natural'), 'Player sem nos deveria mostrar leitura simples e teto natural.');
    assert(simple.includes('sem progresso relevante em criacao'), 'Player sem nos deveria explicar ausencia de Criacao.');
    assert(simple.includes('fisico') && simple.includes('base fisica'), 'Player sem nos deveria mostrar leitura fisica.');
    assert(simple.includes('suporte') && simple.includes('parcialmente liberado'), 'Leitura simples deveria avisar Suporte parcialmente liberado.');

    await setHexagonSide(db, playerId, 'alcance', 3, 'admin@s.whatsapp.net', 'smoke');
    await setHexagonSide(db, playerId, 'retencao', 4, 'admin@s.whatsapp.net', 'smoke');
    await setHexagonSide(db, playerId, 'pressao', 5, 'admin@s.whatsapp.net', 'smoke');
    await setHexagonSide(db, playerId, 'controle', 2, 'admin@s.whatsapp.net', 'smoke');
    capacity = await getPlayerTechnicalCapacity(db, playerId);
    assert(capacity.limits.alcanceLabel === '15m', 'Hexagono setado deveria mostrar 15m.');
    assert(capacity.limits.duracaoLabel === 'cena curta', 'Hexagono setado deveria mostrar cena curta.');
    assert(capacity.limits.pressaoBonus === '+30%', 'Hexagono setado deveria mostrar +30%.');

    for (const nodeId of ['criacao', 'controle', 'forca_magica_i', 'densidade_i', 'juncao_de_forma', 'ambiente_i']) {
        await insertOwnedNode(db, playerId, 'criacao', nodeId);
    }
    for (const nodeId of ['reforco', 'invencivel', 'intensidade_i', 'estabilidade_i', 'foco_de_atributo', 'duplo_foco', 'forca_reforcada', 'velocidade_reforcada', 'reforco_coletivo']) {
        await insertOwnedNode(db, playerId, 'reforco', nodeId);
    }
    for (const nodeId of ['fluxo_de_mana_i', 'mana_bullet_i', 'mana_bullet_ii', 'mana_skin_i']) {
        await insertOwnedNode(db, playerId, 'mana', nodeId);
    }
    for (const nodeId of ['fisico', 'vigor', 'controle_corporal', 'barbaro', 'ki']) {
        await insertOwnedNode(db, playerId, 'fisico', nodeId);
    }
    await insertOwnedNode(db, playerId, 'suporte', 'magigramatica');
    for (const nodeId of ['criacao', 'juncao_de_forma']) {
        await insertOwnedNode(db, targetId, 'criacao', nodeId);
    }
    await insertOwnedNode(db, targetId, 'reforco', 'reforco_coletivo');

    capacity = await getPlayerTechnicalCapacity(db, playerId);
    let technical = normalizeText(formatTechnicalCapacity(capacity, { full: true }));
    assert(technical.includes('formas simples'), 'Capacidade deveria ler arvore criacao comprada.');
    assert(technical.includes('impacto da criacao +10%'), 'Capacidade deveria ler buff de criacao.');
    assert(technical.includes('autobuff'), 'Capacidade deveria ler arvore reforco comprada.');
    assert(technical.includes('bala de mana ii'), 'Capacidade deveria ler arvore mana comprada.');
    assert(technical.includes('fisico') && technical.includes('base fisica pura'), 'Capacidade deveria ler arvore fisica comprada.');
    assert(technical.includes('fisico nao usa custo de mana comum'), 'Capacidade deveria explicar que Fisico nao usa custo de Mana comum.');
    assert(technical.includes('uso basico sem feitico'), 'Capacidade deveria mostrar uso basico sem feitico.');
    assert(technical.includes('forma simples: peso 2 -> rank e -> 100 mana'), 'Custos comuns deveriam usar calculateRankCost para criacao.');
    assert(technical.includes('reforco basico de 1 acao (+5%): peso 2 -> rank e -> 100 mana'), 'Custos comuns deveriam mostrar reforco basico sem feitico.');
    assert(technical.includes('autobuff simples de 1 atributo + intensidade i: peso 4 -> rank d -> 320 mana'), 'Custos comuns deveriam usar calculateRankCost para reforco.');
    assert(technical.includes('bala de mana ii: peso 4 -> rank d -> 320 mana'), 'Custos comuns deveriam usar calculateRankCost para mana.');
    assert(technical.includes('leve 30%') && technical.includes('manutencao bruta sugerida'), 'Manutencao deveria aparecer sem reducao aplicada.');
    assert(!technical.includes('custo reduzido'), 'Capacidade nao deveria aplicar reducao.');
    assert(technical.includes('suporte') && (technical.includes('parcialmente liberado') || technical.includes('basicos entram')), 'Capacidade tecnica deveria mostrar Suporte parcialmente liberado.');
    assert(technical.includes('requiresapproval comprados') && technical.includes('juncao de forma'), 'Capacidade tecnica deveria listar requiresApproval comprado.');
    assert(technical.includes('risco alto/extremo') && technical.includes('reforco coletivo'), 'Capacidade tecnica deveria listar risco alto/extremo.');
    assert(!capacidadeCommand.aliases.some((alias) => normalizeText(alias).includes('avaliar')), 'Capacidade nao deveria criar alias .#avaliar.');

    await runCommand(capacidadeCommand, { sock, db, playerId });
    let text = normalizeText(latestText(sock));
    assert(text.includes('capacidade') && text.includes('teto natural') && text.includes('suporte'), '.#capacidade deveria renderizar leitura simples.');

    await runCommand(capacidadeCommand, { sock, db, playerId, matchedCommand: '.#capacidade tecnica' });
    text = normalizeText(latestText(sock));
    assert(text.includes('capacidade tecnica') && text.includes('hexagono') && text.includes('atencoes tecnicas'), '.#capacidade tecnica deveria renderizar leitura tecnica propria.');
    assert(text.includes('o bot nao aprova') && text.includes('nao avalia tecnica automaticamente'), '.#capacidade tecnica deveria deixar claro que nao avalia.');

    await runCommand(capacidadeCommand, {
        sock,
        db,
        playerId: 'member@s.whatsapp.net',
        matchedCommand: '.#capacidade tecnica',
        body: '@target',
        m: mentionMessage('member@s.whatsapp.net', targetId),
    });
    text = normalizeText(latestText(sock));
    assert(text.includes('apenas adm'), '.#capacidade tecnica @player deveria exigir permissao ADM.');

    await runCommand(capacidadeCommand, {
        sock,
        db,
        playerId: 'admin@s.whatsapp.net',
        matchedCommand: '.#capacidade tecnica',
        body: '@target',
        m: mentionMessage('admin@s.whatsapp.net', targetId),
    });
    text = normalizeText(latestText(sock));
    assert(text.includes('capacidade tecnica') && text.includes('adm') && text.includes('leitura para aprovacao manual'), 'ADM deveria ver leitura tecnica completa.');
    assert(text.includes('risco alto/extremo') && text.includes('reforco coletivo'), 'ADM deveria ver risco alto/extremo do alvo.');

    await db.close();
    console.log('Smoke Clover capacidade passou com sucesso.');
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exit(1);
});
