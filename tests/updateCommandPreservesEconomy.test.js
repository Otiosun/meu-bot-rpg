'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const atualizarCommand = require('../comandos/atualizar');

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT DEFAULT '-',
            personagem_nome TEXT DEFAULT '-',
            idade TEXT DEFAULT '-',
            reino TEXT DEFAULT '-',
            classe TEXT DEFAULT '-',
            familia TEXT DEFAULT '-',
            raca TEXT DEFAULT '-',
            grimorio TEXT DEFAULT '-',
            magia TEXT DEFAULT '-',
            formas TEXT DEFAULT '-',
            historia TEXT DEFAULT '-',
            aparencia TEXT DEFAULT '-',
            dinheiro INTEGER DEFAULT 0,
            esquadrao TEXT DEFAULT '-',
            estrelas INTEGER DEFAULT 0,
            forca INTEGER DEFAULT 0,
            velocidade INTEGER DEFAULT 0,
            resistencia INTEGER DEFAULT 0,
            reflexos INTEGER DEFAULT 0,
            poder_magico INTEGER DEFAULT 0,
            mana INTEGER DEFAULT 0
        );
    `);
    await db.run(
        `INSERT INTO jogadores
         (id, nome, personagem_nome, dinheiro, esquadrao, estrelas, forca, velocidade)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ['killian@lid', 'Nilo', 'Killian', 44130, 'Coringas Magenta', 7, 3, 4]
    );
    return db;
}

function createSock() {
    return {
        sent: [],
        async sendMessage(idChat, payload) {
            this.sent.push({ idChat, payload });
        },
    };
}

test('atualizar modifica somente campos enviados e preserva economia', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    const sock = createSock();

    await atualizarCommand.executar({
        sock,
        idChat: 'grupo@g.us',
        idJogador: 'killian@lid',
        texto: 'Nome: Killian Atualizado\nForça: 8',
        db,
    });

    const player = await db.get('SELECT * FROM jogadores WHERE id = ?', ['killian@lid']);
    assert.equal(player.nome, 'Killian Atualizado');
    assert.equal(player.forca, 8);
    assert.equal(player.velocidade, 4);
    assert.equal(player.dinheiro, 44130);
    assert.equal(player.estrelas, 7);
    assert.equal(player.esquadrao, 'Coringas Magenta');
});

test('atualizar ignora linha de dinheiro mesmo quando enviada explicitamente', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    const sock = createSock();

    await atualizarCommand.executar({
        sock,
        idChat: 'grupo@g.us',
        idJogador: 'killian@lid',
        texto: 'Nome: Killian\nDinheiro: 0',
        db,
    });

    const player = await db.get('SELECT dinheiro, nome FROM jogadores WHERE id = ?', ['killian@lid']);
    assert.equal(player.nome, 'Killian');
    assert.equal(player.dinheiro, 44130);
    assert.match(sock.sent.at(-1).payload.text, /saldo de Yulls foi preservado/i);
});
