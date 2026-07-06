const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const hexagonCommand = require('../comandos/hexagono');
const setHexagonCommand = require('../comandos/sethexagono');
const confirmarHexagonoCommand = require('../comandos/confirmarHexagono');
const cancelarHexagonoCommand = require('../comandos/cancelarHexagono');
const aprovarHexagonoCommand = require('../comandos/aprovarHexagono');
const guideCommand = require('../comandos/guiaRapido');
const {
    getHexagonDerivedLimits,
    getOrCreateHexagon,
    setHexagonSide,
} = require('../helpers/clover/hexagonService');
const { addPh, getPhSummary } = require('../helpers/clover/phService');
const { calculateRankCost } = require('../helpers/clover/balanceGuide');
const { normalizeText } = require('../helpers/textUtils');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function createSock() {
    return {
        sent: [],
        async sendMessage(idChat, message) {
            this.sent.push({ idChat, message });
            return { key: { id: `hexagon-${this.sent.length}`, remoteJid: idChat } };
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

function latestText(sock) {
    const message = sock.sent[sock.sent.length - 1]?.message || {};
    return message.text || message.caption || '';
}

function mentionMessage(playerId) {
    return {
        key: {
            id: 'hexagon-test-message',
            remoteJid: 'hexagon-group@g.us',
            participant: 'admin@s.whatsapp.net',
        },
        message: {
            extendedTextMessage: {
                text: '',
                contextInfo: {
                    mentionedJid: [playerId],
                },
            },
        },
    };
}

async function setupDb() {
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

    return db;
}

async function insertReleasedPlayer(db, playerId, name = 'Smoke Clover') {
    await db.run(
        `INSERT INTO jogadores
         (id, nome, personagem_nome, ficha_status, personagem_aparencia_status, historia_status, jogo_status)
         VALUES (?, ?, ?, 'aprovada', 'approved', 'aprovada', 'liberado')`,
        [playerId, name, name]
    );
}

async function runCommand(command, { sock, db, playerId, body = '', matchedCommand = command.nome, m = null, idChat = 'hexagon-group@g.us' }) {
    await command.executar({
        sock,
        m: m || {
            key: {
                id: 'hexagon-message',
                remoteJid: idChat,
                participant: playerId,
            },
            message: { conversation: `${matchedCommand} ${body}`.trim() },
        },
        idChat,
        idJogador: playerId,
        db,
        body,
        matchedCommand,
    });
}

async function main() {
    const db = await setupDb();
    const sock = createSock();
    const playerId = 'player@s.whatsapp.net';
    const adminId = 'admin@s.whatsapp.net';

    await insertReleasedPlayer(db, playerId);

    const created = await getOrCreateHexagon(db, playerId);
    assert(created.percepcao === 1, 'Hexagono default deveria iniciar percepcao 1.');
    assert(created.retencao === 1, 'Hexagono default deveria iniciar retencao 1.');
    assert(created.emissao === 1, 'Hexagono default deveria iniciar emissao 1.');
    assert(created.controle === 1, 'Hexagono default deveria iniciar controle 1.');
    assert(created.pressao === 1, 'Hexagono default deveria iniciar pressao 1.');
    assert(created.alcance === 1, 'Hexagono default deveria iniciar alcance 1.');

    const updated = await setHexagonSide(db, playerId, 'controle', 2, adminId, 'treino aprovado');
    assert(updated.oldValue === 1 && updated.newValue === 2, 'Set direto deveria mudar controle 1 -> 2.');

    let failedInvalid = false;
    try {
        await setHexagonSide(db, playerId, 'controle', 6, adminId, 'valor invalido');
    } catch {
        failedInvalid = true;
    }
    assert(failedInvalid, 'Valor invalido deveria ser bloqueado pelo helper.');

    const ledgerRows = await db.all('SELECT * FROM clover_mana_hexagon_ledger WHERE player_id = ?', [playerId]);
    assert(ledgerRows.length === 1, 'Ledger deveria registrar apenas o set valido.');
    assert(ledgerRows[0].side === 'controle', 'Ledger deveria registrar o lado alterado.');
    assert(ledgerRows[0].old_value === 1 && ledgerRows[0].new_value === 2, 'Ledger deveria registrar valor antigo e novo.');

    const limits = getHexagonDerivedLimits({
        percepcao: 1,
        retencao: 4,
        emissao: 3,
        controle: 2,
        pressao: 5,
        alcance: 3,
    });
    assert(limits.alcanceLabel === '15m', 'Alcance 3 deveria derivar 15m.');
    assert(limits.areaLabel === '8m-10m', 'Alcance 3 deveria derivar area 8m-10m.');
    assert(limits.duracaoLabel === 'cena curta', 'Retencao 4 deveria derivar cena curta.');
    assert(limits.pressaoBonus === '+30%', 'Pressao 5 deveria derivar +30%.');
    assert(limits.controleLabel === 'básico', 'Controle 2 deveria derivar basico.');
    assert(limits.emissaoLabel === 'moldável', 'Emissao 3 deveria derivar moldavel.');
    assert(limits.percepcaoLabel === 'presença evidente', 'Percepcao 1 deveria derivar presenca evidente.');

    const rank = calculateRankCost(8);
    assert(rank.rank === 'B' && rank.totalMana === 1440, 'Peso 8 deveria ser Rank B com 1440 mana total.');
    assert(calculateRankCost(13).special, 'Peso 13 deveria ser Rank S especial.');

    await runCommand(guideCommand, { sock, db, playerId });
    let text = normalizeText(latestText(sock));
    assert(text.includes('guia rapido tecnico clover'), '.#guia rapido deveria renderizar titulo.');
    assert(text.includes('rank e') && text.includes('manutencao'), '.#guia rapido deveria renderizar rank e manutencao.');
    assert(text.includes('bot nao aprova tecnica'), '.#guia rapido deveria avisar que o bot nao aprova tecnica.');

    await runCommand(hexagonCommand, { sock, db, playerId });
    text = normalizeText(latestText(sock));
    assert(text.includes('hexagono de mana'), '.#hexagono deveria renderizar titulo.');
    assert(text.includes('con') && text.includes('2'), '.#hexagono deveria mostrar lado atualizado.');
    assert(text.includes('limites'), '.#hexagono deveria mostrar limites.');

    await runCommand(setHexagonCommand, {
        sock,
        db,
        playerId: adminId,
        body: '@player alcance 3 recompensa de missao',
        m: mentionMessage(playerId),
    });
    text = normalizeText(latestText(sock));
    assert(text.includes('hexagono atualizado'), '.#sethexagono deveria responder sucesso.');
    assert(text.includes('alcance'), '.#sethexagono deveria informar lado.');
    assert(text.includes('1') && text.includes('3'), '.#sethexagono deveria informar valor antigo e novo.');

    await runCommand(setHexagonCommand, {
        sock,
        db,
        playerId: adminId,
        body: '@player pressao 9 ajuste invalido',
        m: mentionMessage(playerId),
    });
    text = normalizeText(latestText(sock));
    assert(text.includes('sethexagono') && text.includes('lados validos'), 'Valor invalido no comando deveria mostrar uso.');

    const ledgersAfterCommand = await db.all('SELECT * FROM clover_mana_hexagon_ledger WHERE player_id = ?', [playerId]);
    assert(ledgersAfterCommand.length === 2, 'Comando invalido nao deveria gravar ledger.');

    await addPh(db, playerId, 300, 'smoke', 'PH para teste de Hexagono', adminId);
    let ph = await getPhSummary(db, playerId);
    assert(ph.phAvailable === 315, 'Player deveria iniciar teste de up com 315 PH disponivel, incluindo PH inicial.');

    await runCommand(hexagonCommand, {
        sock,
        db,
        playerId,
        matchedCommand: '.#hexagono',
        body: 'upar emissao',
    });
    text = normalizeText(latestText(sock));
    assert(text.includes('up de hexagono'), '.#hexagono upar deveria abrir preview.');
    assert(text.includes('emissao') && text.includes('40 ph'), 'Preview deveria mostrar Emissao e custo 40 PH.');
    assert(text.includes('confirmarhexagono'), 'Preview 1 -> 2 deveria permitir confirmar.');

    await runCommand(confirmarHexagonoCommand, { sock, db, playerId });
    text = normalizeText(latestText(sock));
    assert(text.includes('hexagono atualizado'), '.#confirmarhexagono deveria aplicar up livre.');
    let upgraded = await getOrCreateHexagon(db, playerId);
    assert(upgraded.emissao === 2, 'Confirmacao deveria subir Emissao para 2.');
    ph = await getPhSummary(db, playerId);
    assert(ph.phAvailable === 275, 'Confirmacao deveria gastar 40 PH.');

    await runCommand(hexagonCommand, {
        sock,
        db,
        playerId,
        matchedCommand: '.#hexagono',
        body: 'upar pressao',
    });
    await runCommand(cancelarHexagonoCommand, { sock, db, playerId });
    text = normalizeText(latestText(sock));
    assert(text.includes('up cancelado'), '.#cancelarhexagono deveria cancelar pedido pendente.');
    upgraded = await getOrCreateHexagon(db, playerId);
    assert(upgraded.pressao === 1, 'Cancelamento nao deveria subir Pressao.');

    await runCommand(hexagonCommand, {
        sock,
        db,
        playerId,
        matchedCommand: '.#hexagono',
        body: 'upar emissao',
    });
    await runCommand(confirmarHexagonoCommand, { sock, db, playerId });
    upgraded = await getOrCreateHexagon(db, playerId);
    assert(upgraded.emissao === 3, 'Segundo up livre deveria subir Emissao para 3.');
    ph = await getPhSummary(db, playerId);
    assert(ph.phAvailable === 205, 'Segundo up deveria gastar 70 PH.');

    await runCommand(hexagonCommand, {
        sock,
        db,
        playerId,
        matchedCommand: '.#hexagono',
        body: 'upar emissao',
    });
    text = normalizeText(latestText(sock));
    assert(text.includes('aprovacao') && text.includes('aprovarhexagono'), 'Up 3 -> 4 deveria pedir aprovacao ADM.');

    await runCommand(confirmarHexagonoCommand, { sock, db, playerId });
    text = normalizeText(latestText(sock));
    assert(text.includes('aprovacao necessaria'), 'Player nao deveria confirmar up 3 -> 4 sozinho.');
    upgraded = await getOrCreateHexagon(db, playerId);
    assert(upgraded.emissao === 3, 'Pedido com aprovacao nao deveria aplicar sem ADM.');

    await runCommand(aprovarHexagonoCommand, {
        sock,
        db,
        playerId: adminId,
        body: '@player treino narrativo aprovado',
        m: mentionMessage(playerId),
    });
    text = normalizeText(latestText(sock));
    assert(text.includes('hexagono aprovado'), '.#aprovarhexagono deveria aplicar pedido alto.');
    upgraded = await getOrCreateHexagon(db, playerId);
    assert(upgraded.emissao === 4, 'Aprovacao ADM deveria subir Emissao para 4.');
    ph = await getPhSummary(db, playerId);
    assert(ph.phAvailable === 95, 'Aprovacao ADM deveria gastar 110 PH.');

    await db.close();
    console.log('Smoke Clover Hexagono passou com sucesso.');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
