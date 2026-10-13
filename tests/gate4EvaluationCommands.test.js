'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

const { criarBanco } = require('../database');
const {
    collectCommandOwnership,
    findCommandOwnershipConflicts,
} = require('../helpers/commandRegistry');
const {
    claimEvaluationSubmission,
    createEvaluationSubmission,
} = require('../helpers/clover/universalEvaluationService');
const modeloAvaliacao = require('../comandos/modeloAvaliacao');
const fichaPrototipo = require('../comandos/fichaPrototipo');
const enviarAvaliacao = require('../comandos/enviarAvaliacao');
const avaliacoes = require('../comandos/avaliacoes');

const PLAYER = '5511000000001@s.whatsapp.net';
const OTHER = '5511000000002@s.whatsapp.net';
const ADMIN = '5511000000999@s.whatsapp.net';

async function makeDb() {
    const filename = path.join(
        os.tmpdir(),
        `clover-gate4-commands-${process.pid}-${crypto.randomUUID()}.sqlite`
    );
    const db = await criarBanco({ filename });
    return { db, filename };
}

function spellSheet(name = 'Mão de Lama') {
    return [
        '♧┃FICHA DE FEITIÇO 𖥔 CLOVER MULTICOLOR',
        '',
        '*Nome do feitiço:*',
        `> ${name}`,
        '*Tipo:*',
        '> Criação',
        '*Versão:*',
        '> v1',
        '*Custo:*',
        '> 🔒',
        '*Alcance:*',
        '> 🔒',
        '*Duração:*',
        '> 🔒',
        '*Descrição:*',
        '> Cria lama.',
        '*Limites:*',
        '> 🔒',
        '*Notas ADM:*',
        '> 🔒',
    ].join('\n');
}

function prototypeSheet(name = 'Passo Quebrado') {
    return [
        '*♧┃𝐅𝐈𝐂𝐇𝐀 · 𝐏𝐑𝐎𝐓𝐎́𝐓𝐈𝐏𝐎 𖥔 𝐇𝐮𝐦𝐚𝐧𝐨*',
        '',
        '*𝐍𝐨𝐦𝐞:*',
        `> ${name}`,
        '*𝐈𝐝𝐞𝐢𝐚:*',
        '> Desenvolver uma mudança curta de cadência.',
        '*𝐃𝐞𝐟𝐞𝐢𝐭𝐨:*',
        '> 🔒 ADM',
    ].join('\n');
}

function replyMessage({
    sender = PLAYER,
    quotedSender = PLAYER,
    quotedText = spellSheet(),
    stanzaId = 'sheet-1',
    command = '.#enviarfeitico',
} = {}) {
    return {
        key: {
            id: 'command-1',
            participant: sender,
            remoteJid: 'on@g.us',
        },
        message: {
            extendedTextMessage: {
                text: command,
                contextInfo: {
                    stanzaId,
                    participant: quotedSender,
                    quotedMessage: { conversation: quotedText },
                },
            },
        },
    };
}

async function createSubmission(db, index, category = 'spell') {
    const result = await createEvaluationSubmission(db, {
        category,
        playerId: PLAYER,
        whatsappJid: PLAYER,
        characterId: 'char-1',
        characterName: 'Aster',
        originalPayload: `payload ${index}`,
        submissionKey: `gate4-command:${index}`,
    });
    assert.equal(result.ok, true);
    return result.submission;
}

test('ownership final separa ficha de cena, fila universal e ficha de Protótipo', () => {
    const entries = [
        { owner: 'modeloAvaliacao.js', command: modeloAvaliacao },
        { owner: 'fichaPrototipo.js', command: fichaPrototipo },
        { owner: 'enviarAvaliacao.js', command: enviarAvaliacao },
        { owner: 'avaliacoes.js', command: avaliacoes },
    ];
    assert.deepEqual(findCommandOwnershipConflicts(entries), []);

    const ownership = collectCommandOwnership(entries);
    assert.equal(ownership.get('.#avaliacao')[0].owner, 'avaliacoes.js');
    assert.equal(ownership.get('.#fichaavaliacao')[0].owner, 'modeloAvaliacao.js');
    assert.equal(ownership.get('.#fichaprototipo')[0].owner, 'fichaPrototipo.js');
    assert.equal(ownership.get('.#enviarfeitico')[0].owner, 'enviarAvaliacao.js');
    assert.equal(ownership.get('.#enviarprototipo')[0].owner, 'enviarAvaliacao.js');
});

test('envio inline de Feitiço vence reply e usa a mensagem do comando como fonte', () => {
    const inline = spellSheet('Inline');
    const m = replyMessage({ quotedText: spellSheet('Quoted') });
    const result = enviarAvaliacao._test.resolveSubmissionInput({
        matchedCommand: '.#enviarfeitico',
        body: inline,
        m,
        playerId: PLAYER,
    });
    assert.equal(result.ok, true);
    assert.equal(result.category, 'spell');
    assert.equal(result.source, 'inline');
    assert.match(result.rawSheet, /Inline/);
    assert.doesNotMatch(result.rawSheet, /Quoted/);
    assert.equal(result.sourceMessageId, 'command-1');
});

test('reply da própria ficha de Feitiço é aceita e preserva stanzaId como fonte', () => {
    const m = replyMessage({ stanzaId: 'sheet-own' });
    const result = enviarAvaliacao._test.resolveSubmissionInput({
        matchedCommand: '.#enviarfeitico',
        body: '',
        m,
        playerId: PLAYER,
    });
    assert.equal(result.ok, true);
    assert.equal(result.source, 'quote');
    assert.equal(result.sourceMessageId, 'sheet-own');
    assert.equal(result.sourceQuotedMessageId, 'sheet-own');
});

test('reply de ficha de outra pessoa é recusada sem tentar adivinhar', () => {
    const m = replyMessage({ quotedSender: OTHER });
    const result = enviarAvaliacao._test.resolveSubmissionInput({
        matchedCommand: '.#enviarfeitico',
        body: '',
        m,
        playerId: PLAYER,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'evaluation_quoted_sheet_not_owned');
});

test('comando genérico separa Feitiço da ficha sem fundir mensagens', () => {
    const body = `feitico\n${spellSheet('Genérico')}`;
    const result = enviarAvaliacao._test.resolveSubmissionInput({
        matchedCommand: '.#enviaravaliacao',
        body,
        m: { key: { id: 'generic-1' }, message: { conversation: '.#enviaravaliacao' } },
        playerId: PLAYER,
    });
    assert.equal(result.ok, true);
    assert.equal(result.category, 'spell');
    assert.match(result.rawSheet, /Genérico/);
});

test('comando específico de Protótipo reconhece inline e nunca confunde com Feitiço', () => {
    const result = enviarAvaliacao._test.resolveSubmissionInput({
        matchedCommand: '.#enviarprotótipo',
        body: prototypeSheet('Ritmo Partido'),
        m: { key: { id: 'prototype-inline' }, message: { conversation: '.#enviarprotótipo' } },
        playerId: PLAYER,
    });
    assert.equal(result.ok, true);
    assert.equal(result.category, 'prototype');
    assert.equal(result.source, 'inline');
    assert.match(result.rawSheet, /Ritmo Partido/);
    assert.equal(enviarAvaliacao._test.looksLikeSpellSheet(result.rawSheet), false);
});

test('Protótipo também aceita reply da própria ficha', () => {
    const m = replyMessage({
        command: '.#enviarprototipo',
        quotedText: prototypeSheet('Resposta Racial'),
        stanzaId: 'prototype-sheet-own',
    });
    const result = enviarAvaliacao._test.resolveSubmissionInput({
        matchedCommand: '.#enviarprototipo',
        body: '',
        m,
        playerId: PLAYER,
    });
    assert.equal(result.ok, true);
    assert.equal(result.category, 'prototype');
    assert.equal(result.source, 'quote');
    assert.equal(result.sourceMessageId, 'prototype-sheet-own');
});

test('comando genérico roteia Protótipo pela mesma fila universal', () => {
    const body = `prototipo\n${prototypeSheet('Genérico Racial')}`;
    const result = enviarAvaliacao._test.resolveSubmissionInput({
        matchedCommand: '.#enviaravaliacao',
        body,
        m: { key: { id: 'generic-prototype' }, message: { conversation: '.#enviaravaliacao' } },
        playerId: PLAYER,
    });
    assert.equal(result.ok, true);
    assert.equal(result.category, 'prototype');
    assert.match(result.rawSheet, /Genérico Racial/);
});

test('idempotência do comando usa a mensagem-fonte e não o texto aproximado', () => {
    const args = {
        category: 'spell',
        playerId: PLAYER,
        chatId: 'on@g.us',
        sourceMessageId: 'sheet-stable',
        rawSheet: spellSheet(),
        m: { key: { id: 'command-a' } },
    };
    const first = enviarAvaliacao._test.stableSubmissionKey(args);
    const second = enviarAvaliacao._test.stableSubmissionKey({
        ...args,
        m: { key: { id: 'command-b' } },
    });
    assert.equal(first, second);
    assert.match(first, /sheet-stable$/);
});

test('posição de approve é convertida para protocolo permanente antes da mutação', async (t) => {
    const { db } = await makeDb();
    t.after(() => db.close());
    const first = await createSubmission(db, 1);
    const second = await createSubmission(db, 2);

    const stable = await avaliacoes._test.stableSubmissionForAction(db, ADMIN, '2');
    assert.equal(stable.ok, true);
    assert.equal(stable.submission.id, second.id);
    assert.equal(stable.selector, `#${second.protocol}`);

    await claimEvaluationSubmission(db, { selector: `#${first.protocol}`, reviewerId: 'other-admin' });
    assert.equal(stable.selector, `#${second.protocol}`);
});

test('sem protocolo só infere review quando existe exatamente um para o ADM', async (t) => {
    const { db } = await makeDb();
    t.after(() => db.close());
    const first = await createSubmission(db, 1);
    const second = await createSubmission(db, 2);

    await claimEvaluationSubmission(db, { selector: `#${first.protocol}`, reviewerId: ADMIN });
    const unique = await avaliacoes._test.stableSubmissionForAction(db, ADMIN, null);
    assert.equal(unique.ok, true);
    assert.equal(unique.selector, `#${first.protocol}`);

    await claimEvaluationSubmission(db, { selector: `#${second.protocol}`, reviewerId: ADMIN });
    const ambiguous = await avaliacoes._test.stableSubmissionForAction(db, ADMIN, null);
    assert.equal(ambiguous.ok, false);
    assert.equal(ambiguous.code, 'evaluation_review_ambiguous');
});

test('detector de ficha final respeita a categoria assumida', () => {
    assert.equal(avaliacoes._test.looksLikeFinalSheet('spell', spellSheet()), true);
    assert.equal(avaliacoes._test.looksLikeFinalSheet('spell', prototypeSheet()), false);
    assert.equal(avaliacoes._test.looksLikeFinalSheet('prototype', prototypeSheet()), true);
    assert.equal(avaliacoes._test.looksLikeFinalSheet('prototype', spellSheet()), false);
});

test('parser do comando separa selector da ficha/motivo sem consumir conteúdo', () => {
    assert.deepEqual(
        avaliacoes._test.splitLeadingSelector('#A104\nFICHA'),
        { selector: '#A104', rest: 'FICHA' }
    );
    assert.deepEqual(
        avaliacoes._test.splitLeadingSelector('3 motivo qualquer'),
        { selector: '3', rest: 'motivo qualquer' }
    );
    assert.deepEqual(
        avaliacoes._test.splitLeadingSelector('FICHA SEM SELECTOR'),
        { selector: null, rest: 'FICHA SEM SELECTOR' }
    );
});
