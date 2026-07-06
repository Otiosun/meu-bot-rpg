const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const bonusCommand = require('../comandos/bonus');
const escalaCommand = require('../comandos/escala');
const perfilCommand = require('../comandos/perfil');
const evolutionCommand = require('../comandos/up');
const {
    ensureCloverCharacterStatsSchema,
    ensureCloverManaHexagonSchema,
    ensureCloverPhLedgerSchema,
    ensureCloverSkillTreeSchema,
    ensureSlotReservationsSchema,
} = require('../database');
const {
    formatBonusMessage,
    getCharacterBonusSummary,
} = require('../helpers/clover/characterBonusService');
const { renderPostFichaHelp } = require('../helpers/clover/playerMenuMessages');

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
            const response = { key: { id: `bonus-${counter}`, remoteJid: idChat } };
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
            gancho_narrativo TEXT DEFAULT '-',
            historias_extras TEXT DEFAULT '[]',
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

async function insertReleasedPlayer(db, id, patch = {}) {
    const data = {
        nome: 'Player',
        personagem_nome: 'Personagem',
        reino: 'Clover',
        classe: 'Plebeu',
        familia: 'Sem linhagem registrada',
        familia_key: 'sem_linhagem',
        raca: 'Humano',
        grimorio: 'Grimorio de 3 Folhas',
        magia: 'Magia de Pintura',
        mana: 0,
        aptidao_comum: 'Voz de Salão',
        aptidao_comum_key: 'voz_de_salao',
        marca_comum: 'Nome Pesado',
        marca_comum_key: 'nome_pesado',
        anomalia: '-',
        gancho_narrativo: '-',
        historias_extras: '[]',
        ...patch,
    };

    const columns = [
        'id',
        'nome',
        'personagem_nome',
        'ficha_status',
        'personagem_aparencia_status',
        'historia_status',
        'jogo_status',
        'reino',
        'classe',
        'familia',
        'familia_key',
        'raca',
        'grimorio',
        'magia',
        'mana',
        'aptidao_comum',
        'aptidao_comum_key',
        'aptidao_rara',
        'aptidao_rara_key',
        'marca_comum',
        'marca_comum_key',
        'marca_rara',
        'marca_rara_key',
        'anomalia',
        'anomalia_key',
        'gancho_narrativo',
        'historias_extras',
    ];

    const values = [
        id,
        data.nome,
        data.personagem_nome,
        'aprovada',
        'approved',
        'aprovada',
        'liberado',
        data.reino,
        data.classe,
        data.familia,
        data.familia_key,
        data.raca,
        data.grimorio,
        data.magia,
        data.mana,
        data.aptidao_comum || '-',
        data.aptidao_comum_key || null,
        data.aptidao_rara || '-',
        data.aptidao_rara_key || null,
        data.marca_comum || '-',
        data.marca_comum_key || null,
        data.marca_rara || '-',
        data.marca_rara_key || null,
        data.anomalia || '-',
        data.anomalia_key || null,
        data.gancho_narrativo || '-',
        data.historias_extras || '[]',
    ];

    await db.run(
        `INSERT INTO jogadores (${columns.join(', ')})
         VALUES (${Array(values.length).fill('?').join(', ')})`,
        values
    );

    await db.run(
        `INSERT INTO clover_character_stats
         (player_id, stage_key, pb_total, pb_spent, poder_magico, forca, velocidade, agilidade, resistencia, distribution_status)
         VALUES (?, '8', 20, 10, 4, 2, 2, 2, 2, 'confirmed')`,
        [id]
    );
}

async function run() {
    const db = await createMemoryDb();

    await insertReleasedPlayer(db, 'human@s.whatsapp.net', {
        personagem_nome: 'Humano Plebeu',
        raca: 'Humano',
        classe: 'Plebeu',
        grimorio: 'Grimorio de 3 Folhas',
    });

    await insertReleasedPlayer(db, 'elf@s.whatsapp.net', {
        personagem_nome: 'Elfo Sortudo',
        raca: 'Elfo',
        classe: 'Nobreza',
        grimorio: 'Grimorio de 4 Folhas',
    });

    await insertReleasedPlayer(db, 'witch@s.whatsapp.net', {
        personagem_nome: 'Bruxa Heart',
        raca: 'Bruxa',
        classe: 'Plebeu',
        grimorio: 'Grimorio de Coração',
    });

    await insertReleasedPlayer(db, 'dwarf@s.whatsapp.net', {
        personagem_nome: 'Anao Heart',
        raca: 'Anao',
        classe: 'Plebeu',
        grimorio: 'Grimorio de Coração Duplo',
    });

    await insertReleasedPlayer(db, 'family@s.whatsapp.net', {
        personagem_nome: 'Casa Vermillion',
        raca: 'Humano',
        classe: 'Realeza',
        familia: 'Vermillion',
        familia_key: 'vermillion',
        grimorio: 'Grimorio de 3 Folhas',
        aptidao_rara: 'Prodígio de Mana',
        aptidao_rara_key: 'prodigio_de_mana',
        marca_rara: 'Página que Responde',
        marca_rara_key: 'pagina_que_responde',
        anomalia: 'Mana Amaldiçoada',
        anomalia_key: 'mana_amaldicoada',
    });

    const human = await getCharacterBonusSummary(db, 'human@s.whatsapp.net');
    assert(human.mana.race === 1000, 'Humano deve somar +1000 de mana por raca.');
    assert(human.mana.socialClass === 1000, 'Plebeu humano deve somar +1000 por classe.');
    assert(human.mana.grimoire === 1000, '3 Folhas deve somar +1000 por grimorio.');
    assert(human.mana.total === 3000, 'Humano + Plebeu + 3F deve totalizar 3000 com base 0.');
    assert(human.treeDiscounts.fisico.percent === 10, 'Plebeu humano deve aplicar desconto automatico na arvore fisica.');

    const elf = await getCharacterBonusSummary(db, 'elf@s.whatsapp.net');
    assert(elf.mana.race === 7000, 'Elfo deve somar +7000.');
    assert(elf.mana.socialClass === 0, 'Classe deve ser ignorada para nao-humano.');
    assert(elf.mana.grimoire === 2000, '4 Folhas deve somar +2000.');
    assert(elf.mana.total === 9000, 'Elfo + 4F deve totalizar 9000 com base 0.');
    assert(normalize(formatBonusMessage(elf)).includes('+20% em poder magico'), 'Bonus PM de 4F deve aparecer como nao automatico.');
    assert(elf.treeDiscounts.mana.percent === 15, '4 Folhas deve aplicar 15% de desconto automatico em Mana.');

    const witch = await getCharacterBonusSummary(db, 'witch@s.whatsapp.net');
    assert(witch.mana.total === 6000, 'Bruxa + Heart deve totalizar 6000 com base 0.');
    assert(witch.reserve.percent === 10 && witch.reserve.amount === 600, 'Heart deve gerar reserva de 10%.');

    const dwarf = await getCharacterBonusSummary(db, 'dwarf@s.whatsapp.net');
    assert(dwarf.mana.total === 6000, 'Anao + Heart Duplo deve totalizar 6000 com base 0.');
    assert(dwarf.reserve.percent === 20 && dwarf.reserve.amount === 1200, 'Heart Duplo deve gerar reserva de 20%.');

    const family = await getCharacterBonusSummary(db, 'family@s.whatsapp.net');
    assert(family.notAutomatic.some((item) => normalize(item).includes('famil')), 'Familia deve aparecer como efeito nao automatico.');
    assert(family.traits.aptitude.label === 'Prodígio de Mana', 'Aptidao rara deve aparecer no bonus.');
    assert(family.traits.mark.label === 'Página que Responde', 'Marca rara deve aparecer no bonus.');
    assert(family.traits.anomaly.label === 'Mana Amaldiçoada', 'Anomalia deve aparecer no bonus.');
    assert(normalize(family.traits.hook).includes('nenhum gancho'), 'Gancho narrativo deve ter fallback.');

    await insertReleasedPlayer(db, 'narrative@s.whatsapp.net', {
        personagem_nome: 'Narrative Player',
        gancho_narrativo: 'Varinha de sua mae • Extase maligno',
        historias_extras: JSON.stringify([
            {
                type: 'gn',
                title: 'Varinha de sua mae',
                description: 'Junto da carta que lhe foi enviada, estava enrolada uma pequena varinha, heranca final de sua mae. Contudo, por sua inexperiencia, seus efeitos sao desconhecidos.',
            },
            {
                type: 'traco_novo',
                title: 'Extase maligno',
                description: 'Ganha +10% na acao quando tiver fazendo acoes ruins, escolhas pessimas.',
            },
        ]),
    });

    const narrative = await getCharacterBonusSummary(db, 'narrative@s.whatsapp.net');
    assert(narrative.traits.narrativeExtras.length === 2, 'Historias extras devem ser carregadas.');
    assert(normalize(narrative.traits.hook).includes('varinha') && normalize(narrative.traits.hook).includes('extase'), 'Resumo narrativo deve listar os titulos.');

    const narrativeText = formatBonusMessage(narrative);
    assert(normalize(narrativeText).includes('ganchos narrativos'), 'Bonus deve mostrar bloco narrativo.');
    assert(narrativeText.includes('Varinha de sua mae') && narrativeText.includes('Extase maligno'), 'Bonus deve mostrar os detalhes narrativos.');

    const sock = createFakeSock();
    await perfilCommand.executar({
        sock,
        m: {},
        idChat: 'human@s.whatsapp.net',
        idJogador: 'human@s.whatsapp.net',
        db,
    });
    const profileText = latestText(sock);
    assert(normalize(profileText).includes('*mana total:* 3.000'), 'Perfil deve mostrar Mana total.');
    assert(normalize(profileText).includes('*reserva:* -'), 'Perfil deve mostrar Reserva.');
    assert(normalize(profileText).includes('*aptidao:* voz de salao'), 'Perfil deve mostrar Aptidao.');
    assert(!profileText.includes('+20%'), 'Perfil nao deve aplicar bonus percentual de PM.');

    await bonusCommand.executar({
        sock,
        m: {},
        idChat: 'human@s.whatsapp.net',
        idJogador: 'human@s.whatsapp.net',
        db,
        body: '',
    });
    const bonusText = latestText(sock);
    assert(normalize(bonusText).includes('mana aplicada'), '.#bonus deve mostrar bloco de mana aplicada.');
    assert(normalize(bonusText).includes('nao automatico'), '.#bonus deve separar efeitos nao automaticos.');
    assert(normalize(bonusText).includes('tracos'), '.#bonus deve mostrar tracos.');
    assert(normalize(bonusText).includes('sabe ser ouvido'), '.#bonus deve mostrar descricao oficial da aptidao.');
    assert(normalize(bonusText).includes('desconto automatico'), '.#bonus deve mostrar desconto de arvore como automatico.');

    const before = await db.get(
        'SELECT ph_accumulated, ph_available FROM clover_character_stats WHERE player_id = ?',
        ['human@s.whatsapp.net']
    );
    await escalaCommand.executar({ sock, m: {}, idChat: 'human@s.whatsapp.net' });
    assert(normalize(latestText(sock)).includes('sistema de pb, ph e estagios'), '.#escala deve responder com o sistema completo.');
    await evolutionCommand.executar({ sock, m: {}, idChat: 'human@s.whatsapp.net' });
    assert(latestText(sock).length > 5000, '.#evolução deve responder com o sistema completo.');
    assert(latestText(sock).includes('Limite comum semanal'), '.#evolução deve conter o bloco final do sistema oficial.');
    const after = await db.get(
        'SELECT ph_accumulated, ph_available FROM clover_character_stats WHERE player_id = ?',
        ['human@s.whatsapp.net']
    );
    assert(before.ph_accumulated === after.ph_accumulated, '.#escala/.#evolucao nao devem alterar PH acumulado.');
    assert(before.ph_available === after.ph_available, '.#escala/.#evolucao nao devem alterar PH disponivel.');

    const help = renderPostFichaHelp();
    assert(help.includes('.#bonus'), 'Ajuda pos-ficha deve listar .#bonus.');
    assert(help.includes('.#escala'), 'Ajuda pos-ficha deve listar .#escala.');
    assert(normalize(help).includes('.#evolucao'), 'Ajuda pos-ficha deve listar .#evolucao.');

    await db.close();

    console.log('[smokeCloverBonuses] ok');
    console.log('- Humano/Plebeu/3F: total 3000');
    console.log('- Elfo/4F: total 9000, classe ignorada');
    console.log('- Bruxa/Heart: total 6000, reserva 10%');
    console.log('- Anao/Heart Duplo: total 6000, reserva 20%');
    console.log('- Familia/tracos/gancho/perfil/bonus/escala/up validados');
}

run().catch((error) => {
    console.error('[smokeCloverBonuses] falhou:', error);
    process.exit(1);
});
