const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const hexagonCommand = require('../comandos/hexagono');
const setHexagonCommand = require('../comandos/sethexagono');
const confirmarHexagonoCommand = require('../comandos/confirmarHexagono');
const cancelarHexagonoCommand = require('../comandos/cancelarHexagono');
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
    assert(created.precisao === 1, 'Hexagono default deveria iniciar precisao 1.');
    assert(created.retencao === 1, 'Hexagono default deveria iniciar retencao 1.');
    assert(created.estabilidade === 1, 'Hexagono default deveria iniciar estabilidade 1.');
    assert(created.controle === 1, 'Hexagono default deveria iniciar controle 1.');
    assert(created.escala === 1, 'Hexagono default deveria iniciar escala 1.');
    assert(created.alcance === 1, 'Hexagono default deveria iniciar alcance 1.');

    const updated = await setHexagonSide(db, playerId, 'controle', 2, adminId, 'treino aprovado');
    assert(updated.oldValue === 1 && updated.newValue === 2, 'Set direto deveria mudar controle 1 -> 2.');

    let failedInvalid = false;
    try {
        await setHexagonSide(db, playerId, 'controle', 8, adminId, 'valor invalido');
    } catch {
        failedInvalid = true;
    }
    assert(failedInvalid, 'Valor invalido deveria ser bloqueado pelo helper.');

    const ledgerRows = await db.all('SELECT * FROM clover_mana_hexagon_ledger WHERE player_id = ?', [playerId]);
    assert(ledgerRows.length === 1, 'Ledger deveria registrar apenas o set valido.');
    assert(ledgerRows[0].side === 'controle', 'Ledger deveria registrar o lado alterado.');
    assert(ledgerRows[0].old_value === 1 && ledgerRows[0].new_value === 2, 'Ledger deveria registrar valor antigo e novo.');

    const limits = getHexagonDerivedLimits({
        precisao: 6, retencao: 4, estabilidade: 5, controle: 2, escala: 3, alcance: 7,
    });
    assert(limits.alcanceLabel === '250 m+ conforme técnica e contexto', 'Alcance 7 deveria derivar 250 m+.');
    assert(limits.duracaoLabel === 'até 5 ciclos', 'Retencao 4 deveria derivar 5 ciclos.');
    assert(limits.controleLabel === 'pequeno ajuste', 'Controle 2 deveria derivar pequeno ajuste.');
    assert(limits.estabilidadeLabel.includes('alta resistência'), 'Estabilidade 5 deveria derivar resistencia alta.');
    assert(limits.precisaoLabel === 'finesse extrema', 'Precisao 6 deveria derivar finesse extrema.');
    assert(limits.escalaLabel.includes('sala pequena'), 'Escala 3 deveria derivar sala pequena.');

    const rank = calculateRankCost(8);
    assert(rank.rank === 'B' && rank.totalMana === 1440, 'Peso 8 deveria ser Rank B com 1440 mana total.');
    assert(calculateRankCost(13).totalMana === 3500, 'Peso 13 deveria custar 3500 mana.');
    assert(calculateRankCost(14).special, 'Peso 14 deveria ser especial.');

    await runCommand(hexagonCommand, { sock, db, playerId });
    let text = normalizeText(latestText(sock));
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
        body: '@player escala 9 ajuste invalido',
        m: mentionMessage(playerId),
    });
    text = normalizeText(latestText(sock));
    assert(text.includes('sethexagono') && text.includes('lados validos'), 'Valor invalido no comando deveria mostrar uso.');

    const ledgersAfterCommand = await db.all('SELECT * FROM clover_mana_hexagon_ledger WHERE player_id = ?', [playerId]);
    assert(ledgersAfterCommand.length === 2, 'Comando invalido nao deveria gravar ledger.');

    await addPh(db, playerId, 2000, 'smoke', 'PH para teste de Hexagono', adminId);
    let ph = await getPhSummary(db, playerId);
    assert(ph.phAvailable === 2015, 'Player deveria iniciar teste de up com 315 PH disponivel, incluindo PH inicial.');

    await runCommand(hexagonCommand, {
        sock,
        db,
        playerId,
        matchedCommand: '.#hexagono',
        body: 'upar estabilidade',
    });
    text = normalizeText(latestText(sock));
    assert(text.includes('up de hexagono'), '.#hexagono upar deveria abrir preview.');
    assert(text.includes('estabilidade') && text.includes('50 ph'), 'Preview deveria mostrar Estabilidade e custo 50 PH.');
    assert(text.includes('confirmarhexagono'), 'Preview 1 -> 2 deveria permitir confirmar.');

    await runCommand(confirmarHexagonoCommand, { sock, db, playerId });
    text = normalizeText(latestText(sock));
    assert(text.includes('hexagono atualizado'), '.#confirmarhexagono deveria aplicar up livre.');
    let upgraded = await getOrCreateHexagon(db, playerId);
    assert(upgraded.estabilidade === 2, 'Confirmacao deveria subir Estabilidade para 2.');
    ph = await getPhSummary(db, playerId);
    assert(ph.phAvailable === 1965, 'Confirmacao deveria gastar 50 PH.');

    await runCommand(hexagonCommand, {
        sock,
        db,
        playerId,
        matchedCommand: '.#hexagono',
        body: 'upar escala',
    });
    await runCommand(cancelarHexagonoCommand, { sock, db, playerId });
    text = normalizeText(latestText(sock));
    assert(text.includes('up cancelado'), '.#cancelarhexagono deveria cancelar pedido pendente.');
    upgraded = await getOrCreateHexagon(db, playerId);
    assert(upgraded.escala === 1, 'Cancelamento nao deveria subir Escala.');

    await runCommand(hexagonCommand, {
        sock,
        db,
        playerId,
        matchedCommand: '.#hexagono',
        body: 'upar estabilidade',
    });
    await runCommand(confirmarHexagonoCommand, { sock, db, playerId });
    upgraded = await getOrCreateHexagon(db, playerId);
    assert(upgraded.estabilidade === 3, 'Segundo up livre deveria subir Estabilidade para 3.');
    ph = await getPhSummary(db, playerId);
    assert(ph.phAvailable === 1865, 'Segundo up deveria gastar 100 PH.');

    await runCommand(hexagonCommand, {
        sock, db, playerId, matchedCommand: '.#hexagono', body: 'upar estabilidade',
    });
    text = normalizeText(latestText(sock));
    assert(text.includes('200 ph'), 'Up 3 -> 4 deveria custar 200 PH.');
    assert(text.includes('confirmarhexagono'), 'Up 3 -> 4 nao deveria exigir gate generico de ADM.');
    await runCommand(confirmarHexagonoCommand, { sock, db, playerId });
    upgraded = await getOrCreateHexagon(db, playerId);
    assert(upgraded.estabilidade === 4, 'Confirmacao deveria subir Estabilidade para 4.');
    ph = await getPhSummary(db, playerId);
    assert(ph.phAvailable === 1665, 'Terceiro up deveria gastar 200 PH.');

    await db.close();
    console.log('Smoke Clover Hexagono passou com sucesso.');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
