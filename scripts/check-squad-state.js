'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const { ensureCloverSquadSchema } = require('../database');
const {
    getRenownGrade,
    getResourceBand,
    getSquadState,
    renderSquadState,
    resolveSquad,
} = require('../helpers/clover/squadStateService');
const command = require('../comandos/estadoEsquadrao');

const ARTIFACT_DIR = path.join(__dirname, '..', 'artifacts', 'squad-state');
const GROUP_ID = '120363000000000000@g.us';

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT DEFAULT '-',
            display_name TEXT DEFAULT '-',
            personagem_nome TEXT DEFAULT '-',
            esquadrao TEXT DEFAULT '-',
            estrelas INTEGER DEFAULT 0,
            patente TEXT DEFAULT '-',
            jogo_status TEXT DEFAULT 'liberado',
            ficha_status TEXT DEFAULT 'aprovada'
        )
    `);
    await ensureCloverSquadSchema(db);
    return db;
}

async function insertPlayer(db, id, name, squad, stars) {
    await db.run(
        `INSERT INTO jogadores
         (id, nome, display_name, personagem_nome, esquadrao, estrelas, patente)
         VALUES (?, ?, ?, ?, ?, ?, 'Cavaleiro Mágico')`,
        [id, name, name, name, squad, stars]
    );
}

function assertClean(text, label) {
    assert.strictEqual(typeof text, 'string', `${label} não retornou texto.`);
    assert(!text.includes('undefined'), `${label} contém undefined.`);
    assert(!text.includes('[object Object]'), `${label} contém objeto cru.`);
    assert(text.length < 4096, `${label} ultrapassou 4096 caracteres: ${text.length}.`);
}

function testGradeBoundaries() {
    const cases = [
        [0, 0], [9, 0],
        [10, 1], [24, 1],
        [25, 2], [49, 2],
        [50, 3], [84, 3],
        [85, 4], [129, 4],
        [130, 5], [199, 5],
        [200, 6], [500, 6],
    ];
    for (const [stars, expected] of cases) {
        assert.strictEqual(getRenownGrade(stars).grade, expected, `Grau incorreto para ${stars} estrelas.`);
    }
}

function testResourceBoundaries() {
    const cases = [
        [0, 'empty'],
        [1, 'basic'],
        [2, 'useful'],
        [3, 'prepared'],
        [4, 'relevant'],
        [5, 'relevant'],
        [6, 'exceptional'],
        [20, 'exceptional'],
    ];
    for (const [stars, expected] of cases) {
        assert.strictEqual(getResourceBand(stars).key, expected, `Faixa de recursos incorreta para ${stars}.`);
    }
}

async function main() {
    testGradeBoundaries();
    testResourceBoundaries();

    const db = await createDb();
    try {
        await db.run(
            `INSERT INTO clover_squads
             (squad_key, name, group_id, phrase, captain_name, captain_player_id,
              vice_captain_player_id, historical_stars, current_stars, black_stars)
             VALUES ('touros_negros', 'Touros Negros', ?, 'Superar limites.', 'Yami',
                     '5511000000001@s.whatsapp.net', '5511000000002@s.whatsapp.net', 37, 7, 1)`,
            [GROUP_ID]
        );
        await db.run(
            `INSERT INTO clover_squads
             (squad_key, name, historical_stars, current_stars, black_stars)
             VALUES ('orcas_roxas', 'Orcas Roxas', 8, 0, 4)`
        );

        const members = [
            ['5511000000010@s.whatsapp.net', 'Magna Swing', 18],
            ['5511000000011@s.whatsapp.net', 'Luck Voltia', 10],
            ['5511000000012@s.whatsapp.net', 'Vanessa Enoteca', 6],
            ['5511000000013@s.whatsapp.net', 'Gordon Agrippa', 3],
        ];
        for (const [id, name, stars] of members) await insertPlayer(db, id, name, 'Touros Negros', stars);
        await insertPlayer(db, '5511000000020@s.whatsapp.net', 'Gueldre', 'Orcas Roxas', 1);

        await db.run(
            `INSERT INTO clover_squad_star_ledger
             (squad_key, player_id, amount, kind, source, reason, created_by, created_at)
             VALUES ('touros_negros', ?, 2, 'ganho', 'missao', 'Missão recente', 'test', CURRENT_TIMESTAMP)`,
            [members[0][0]]
        );
        await db.run(
            `INSERT INTO clover_squad_star_ledger
             (squad_key, player_id, amount, kind, source, reason, created_by, created_at)
             VALUES ('touros_negros', ?, 1, 'ganho', 'missao', 'Missão recente', 'test', CURRENT_TIMESTAMP)`,
            [members[1][0]]
        );
        await db.run(
            `INSERT INTO clover_squad_star_ledger
             (squad_key, player_id, amount, kind, source, reason, created_by, created_at)
             VALUES ('touros_negros', ?, 1, 'ganho', 'evento', 'Evento recente', 'test', CURRENT_TIMESTAMP)`,
            [members[2][0]]
        );
        await db.run(
            `INSERT INTO clover_squad_star_ledger
             (squad_key, player_id, amount, kind, source, reason, created_by, created_at)
             VALUES ('touros_negros', ?, 5, 'ganho', 'arquivo', 'Registro antigo', 'test', datetime('now', '-60 days'))`,
            [members[3][0]]
        );

        const byGroup = await resolveSquad(db, { groupId: GROUP_ID });
        const byName = await resolveSquad(db, { squadName: 'Touros Negros' });
        const byPlayer = await resolveSquad(db, { playerId: members[0][0] });
        assert.strictEqual(byGroup.squad_key, 'touros_negros');
        assert.strictEqual(byName.squad_key, 'touros_negros');
        assert.strictEqual(byPlayer.squad_key, 'touros_negros');

        const state = await getSquadState(db, byGroup);
        assert.strictEqual(state.ok, true);
        assert.strictEqual(state.renown.grade, 2);
        assert.strictEqual(state.renown.name, 'Confiável');
        assert.strictEqual(state.resources.key, 'exceptional');
        assert.strictEqual(state.reputation.key, 'watched');
        assert.strictEqual(state.command.key, 'complete');
        assert.strictEqual(state.activity.key, 'distributed');
        assert.strictEqual(state.structure.registered, false);
        assert.strictEqual(state.structure.label, 'Não registrada');
        assert.strictEqual(state.memberCount, 4);
        assert.strictEqual(state.recent.entries, 3);
        assert.strictEqual(state.recent.contributors, 3);
        assert.strictEqual(state.recent.netStars, 4);
        assert.strictEqual(state.topContributors[0].displayName, 'Magna Swing');
        assert.strictEqual(state.topContributors[0].stars, 18);

        const quiet = await getSquadState(db, 'orcas_roxas');
        assert.strictEqual(quiet.renown.grade, 0);
        assert.strictEqual(quiet.resources.key, 'empty');
        assert.strictEqual(quiet.reputation.key, 'compromised');
        assert.strictEqual(quiet.command.key, 'missing');
        assert.strictEqual(quiet.activity.key, 'quiet');
        assert.strictEqual(quiet.memberCount, 1);

        const mainText = renderSquadState(state);
        const quietText = renderSquadState(quiet);
        const missingText = renderSquadState({ ok: false });
        for (const [label, text] of Object.entries({ mainText, quietText, missingText })) assertClean(text, label);

        for (const expected of ['𝗥𝗲𝗻𝗼𝗺𝗲', '𝗥𝗲𝗰𝘂𝗿𝘀𝗼𝘀', '𝗥𝗲𝗽𝘂𝘁𝗮𝗰̧𝗮̃𝗼', '𝗢𝗿𝗴𝗮𝗻𝗶𝘇𝗮𝗰̧𝗮̃𝗼', '𝗘𝘀𝘁𝗿𝘂𝘁𝘂𝗿𝗮', '𝗟𝗲𝗶𝘁𝘂𝗿𝗮 𝗚𝗲𝗿𝗮𝗹']) {
            assert(mainText.includes(expected), `Eixo ausente: ${expected}`);
        }
        assert(mainText.includes('Grau 2 · Confiável'));
        assert(mainText.includes('7 Estrelas Atuais · Excepcional'));
        assert(mainText.includes('1 Estrela(s) Negra(s) · Sob observação'));
        assert(mainText.includes('Capitão e Vice estão registrados'));
        assert(mainText.includes('3 de 4 membros contribuíram'));
        assert(mainText.includes('Benfeitorias e setores do QG ainda não possuem registro operacional no bot'));
        assert(!mainText.includes('/100'), 'Não deve existir nota única escondida de qualidade.');
        assert(!mainText.includes('Score'));
        assert(quietText.includes('Grau 0 · Recém-Registrado'));
        assert(quietText.includes('Sem comando'));
        assert(quietText.includes('Sem movimento recente'));

        assert(command.nome.endsWith('estadoesquadrao'));
        assert(command.aliases.some((alias) => alias.endsWith('qualidadeesquadrao')));

        fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
        fs.writeFileSync(path.join(ARTIFACT_DIR, 'estado-touros-negros.txt'), `${mainText}\n`, 'utf8');
        fs.writeFileSync(path.join(ARTIFACT_DIR, 'estado-orcas-roxas.txt'), `${quietText}\n`, 'utf8');
        fs.writeFileSync(path.join(ARTIFACT_DIR, 'report.json'), `${JSON.stringify({
            squad: state.name,
            axes: {
                renown: state.renown,
                resources: state.resources,
                reputation: state.reputation,
                command: state.command,
                activity: state.activity,
                structure: state.structure,
            },
            members: state.members.map((member) => ({ name: member.displayName, stars: member.stars })),
            recent: state.recent,
            outputLength: mainText.length,
            boundaries: {
                renown: [0, 10, 25, 50, 85, 130, 200].map((stars) => ({ stars, grade: getRenownGrade(stars).grade })),
                resources: [0, 1, 2, 3, 4, 5, 6].map((stars) => ({ stars, band: getResourceBand(stars).key })),
            },
        }, null, 2)}\n`, 'utf8');

        console.log('✓ Graus de Renome respeitam as faixas oficiais do site');
        console.log('✓ recursos seguem as faixas de requisição por Estrelas Atuais');
        console.log('✓ reputação traduz Estrelas Negras sem nota artificial');
        console.log('✓ comando, atividade e membros interpretados');
        console.log('✓ estrutura declara honestamente ausência de benfeitorias no bot');
        console.log('✓ resolução por grupo, nome e personagem');
        console.log('✓ mensagens abaixo de 4096 caracteres');
    } finally {
        await db.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
