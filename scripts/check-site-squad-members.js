'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const { ensureCloverSquadSchema } = require('../database');
const { ensureSquadMembershipSchema } = require('../helpers/clover/squadMembershipService');
const { assignAccessRole } = require('../helpers/clover/accessRoleAssignmentService');
const { createSession } = require('../helpers/clover/siteAuthService');
const { buildSiteAccessPayload } = require('../helpers/clover/siteAccessPayloadService');
const { getSquadMemberDirectory } = require('../helpers/clover/siteSquadMemberService');

const ARTIFACT_DIR = path.join(__dirname, '..', 'artifacts', 'site-squad-members');
const OWNER = '557998868223@s.whatsapp.net';
const NARRATOR = '5511000000001@s.whatsapp.net';
const EVALUATOR = '5511000000002@s.whatsapp.net';
const CAPTAIN = '5511000000003@s.whatsapp.net';
const VICE = '5511000000004@s.whatsapp.net';
const MEMBER = '5511000000005@s.whatsapp.net';
const OTHER = '5511000000006@s.whatsapp.net';

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
            magia TEXT DEFAULT '-',
            grimorio TEXT DEFAULT '-',
            raca TEXT DEFAULT '-',
            classe TEXT DEFAULT '-',
            jogo_status TEXT DEFAULT 'liberado',
            ficha_status TEXT DEFAULT 'aprovada',
            site_profile_image_data TEXT DEFAULT NULL,
            notas_adm TEXT DEFAULT 'SEGREDO'
        )
    `);
    await ensureCloverSquadSchema(db);
    await db.run(`
        INSERT INTO clover_squads
        (squad_key, name, historical_stars, current_stars, black_stars,
         captain_player_id, vice_captain_player_id)
        VALUES ('touros_negros', 'Touros Negros', 37, 20, 0, ?, ?)
    `, [CAPTAIN, VICE]);
    await db.run(`
        INSERT INTO clover_squads
        (squad_key, name, historical_stars, current_stars, black_stars)
        VALUES ('aguias_prateadas', 'Águias Prateadas', 60, 12, 1)
    `);

    const rows = [
        [NARRATOR, 'Narrador', '-', 0, '-', '-', '-', '-', null],
        [EVALUATOR, 'Avaliador', '-', 0, '-', '-', '-', '-', null],
        [CAPTAIN, 'Capitão', 'Touros Negros', 21, 'Capitão', 'Trevas', 'Três Folhas', 'Humano', 'data:image/jpeg;base64,abc'],
        [VICE, 'Vice', 'Touros Negros', 13, 'Cavaleiro Sênior', 'Água', 'Três Folhas', 'Humano', null],
        [MEMBER, 'Membro', 'Touros Negros', 8, 'Cavaleiro Júnior', 'Fogo', 'Três Folhas', 'Humano', null],
        [OTHER, 'Águia', 'Águias Prateadas', 10, 'Cavaleiro Júnior', 'Aço', 'Três Folhas', 'Humano', null],
    ];
    for (const [id, name, squad, stars, rank, magic, grimoire, race, image] of rows) {
        await db.run(
            `INSERT INTO jogadores
             (id, nome, display_name, personagem_nome, esquadrao, estrelas,
              patente, magia, grimorio, raca, classe, jogo_status, ficha_status,
              site_profile_image_data)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Mago', 'liberado', 'aprovada', ?)`,
            [id, name, name, name, squad, stars, rank, magic, grimoire, race, image]
        );
    }
    // A legacy character field is a projection, not membership authorization.
    await ensureSquadMembershipSchema(db);
    for (const [playerId, squadKey] of [[CAPTAIN,'touros_negros'],[VICE,'touros_negros'],[MEMBER,'touros_negros'],[OTHER,'aguias_prateadas']]) {
        await db.run(
            "INSERT INTO clover_squad_memberships (squad_key,player_id,status,changed_by,reason) VALUES (?,?,'active','fixture','canonical membership fixture')",
            [squadKey,playerId]
        );
    }
    return db;
}

function assertPublicDirectory(result) {
    assert.strictEqual(result.ok, true);
    const serialized = JSON.stringify(result);
    for (const forbidden of [
        '@s.whatsapp.net',
        '5511000000',
        'notas_adm',
        'SEGREDO',
        'metadata_json',
        'assigned_by',
        'player_id',
    ]) {
        assert(!serialized.includes(forbidden), `Dado privado exposto: ${forbidden}`);
    }
    for (const member of result.members) {
        assert.deepStrictEqual(
            Object.keys(member).sort(),
            ['availability', 'className', 'grimoire', 'image', 'leadership', 'magic', 'name', 'race', 'rank', 'stars'].sort()
        );
    }
}

function requestJson({ port, pathName, token = null }) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path: pathName,
            method: 'GET',
            headers: token ? { Authorization: `Bearer ${token}` } : {},
        }, (res) => {
            let raw = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { raw += chunk; });
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : {} });
                } catch (error) {
                    reject(error);
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

async function validateHttpRoute(db) {
    const previous = {
        enabled: process.env.CLOVER_SITE_API_ENABLED,
        host: process.env.CLOVER_SITE_API_HOST,
        port: process.env.CLOVER_SITE_API_PORT,
    };
    process.env.CLOVER_SITE_API_ENABLED = '1';
    process.env.CLOVER_SITE_API_HOST = '127.0.0.1';
    process.env.CLOVER_SITE_API_PORT = '0';
    const { startSiteApiServer, stopSiteApiServer } = require('../helpers/clover/siteApiServer');
    const captainSession = await createSession(db, CAPTAIN, CAPTAIN.replace(/\D/g, ''));
    const memberSession = await createSession(db, MEMBER, MEMBER.replace(/\D/g, ''));
    const server = startSiteApiServer({ getDb: () => db });
    try {
        if (!server.listening) {
            await new Promise((resolve, reject) => {
                server.once('listening', resolve);
                server.once('error', reject);
            });
        }
        const port = server.address().port;
        const unauthenticated = await requestJson({ port, pathName: '/squads/touros_negros/members' });
        const captain = await requestJson({
            port,
            pathName: '/squads/touros_negros/members',
            token: captainSession.token,
        });
        const member = await requestJson({
            port,
            pathName: '/squads/touros_negros/members',
            token: memberSession.token,
        });
        assert.strictEqual(unauthenticated.status, 401);
        assert.strictEqual(captain.status, 200);
        assertPublicDirectory(captain.body.directory);
        assert.strictEqual(member.status, 200);
        assertPublicDirectory(member.body.directory);
        assert.strictEqual(member.body.directory.access, 'own_squad');
        return captain.body.directory;
    } finally {
        await stopSiteApiServer();
        if (previous.enabled === undefined) delete process.env.CLOVER_SITE_API_ENABLED;
        else process.env.CLOVER_SITE_API_ENABLED = previous.enabled;
        if (previous.host === undefined) delete process.env.CLOVER_SITE_API_HOST;
        else process.env.CLOVER_SITE_API_HOST = previous.host;
        if (previous.port === undefined) delete process.env.CLOVER_SITE_API_PORT;
        else process.env.CLOVER_SITE_API_PORT = previous.port;
    }
}

async function main() {
    const db = await createDb();
    try {
        await assignAccessRole(db, { subjectId: NARRATOR, role: 'narrador', assignedBy: OWNER });
        await assignAccessRole(db, { subjectId: EVALUATOR, role: 'avaliador', assignedBy: OWNER });
        await assignAccessRole(db, {
            subjectId: CAPTAIN,
            role: 'capitao',
            scopeKey: 'Touros Negros',
            assignedBy: OWNER,
            metadata: { scope_label: 'Touros Negros' },
        });
        await assignAccessRole(db, {
            subjectId: VICE,
            role: 'vice',
            scopeKey: 'Touros Negros',
            assignedBy: OWNER,
            metadata: { scope_label: 'Touros Negros' },
        });

        const narrator = await getSquadMemberDirectory(db, { actorId: NARRATOR, squadInput: 'Touros Negros' });
        const narratorOther = await getSquadMemberDirectory(db, { actorId: NARRATOR, squadInput: 'Águias Prateadas' });
        const captain = await getSquadMemberDirectory(db, { actorId: CAPTAIN, squadInput: 'Touros Negros' });
        const captainOther = await getSquadMemberDirectory(db, { actorId: CAPTAIN, squadInput: 'Águias Prateadas' });
        const vice = await getSquadMemberDirectory(db, { actorId: VICE, squadInput: 'Touros Negros' });
        const evaluator = await getSquadMemberDirectory(db, { actorId: EVALUATOR, squadInput: 'Touros Negros' });
        const member = await getSquadMemberDirectory(db, { actorId: MEMBER, squadInput: 'Touros Negros' });
        const owner = await getSquadMemberDirectory(db, { actorId: OWNER, squadInput: 'Águias Prateadas' });

        for (const result of [narrator, narratorOther, captain, vice, member, owner]) assertPublicDirectory(result);
        assert.strictEqual(captainOther.code, 'forbidden');
        assert.strictEqual(evaluator.code, 'forbidden');
        assert.strictEqual(member.access, 'own_squad');
        assert.strictEqual(captain.memberCount, 3);
        assert.deepStrictEqual(captain.members.map((item) => item.name), ['Capitão', 'Vice', 'Membro']);
        assert.deepStrictEqual(captain.members.map((item) => item.leadership), ['Capitão', 'Vice-Capitão', null]);
        assert.deepStrictEqual(captain.members.map((item) => item.stars), [21, 13, 8]);
        assert.strictEqual(captain.members[0].magic, 'Trevas');
        assert.strictEqual(captain.members[0].availability, 'Liberado');
        assert.strictEqual(captain.members[0].image, 'data:image/jpeg;base64,abc');

        const captainAccess = await buildSiteAccessPayload(db, CAPTAIN);
        const narratorAccess = await buildSiteAccessPayload(db, NARRATOR);
        const evaluatorAccess = await buildSiteAccessPayload(db, EVALUATOR);
        const memberAccess = await buildSiteAccessPayload(db, MEMBER);
        assert.strictEqual(captainAccess.capabilities.readSquadMembers, true);
        assert.strictEqual(narratorAccess.capabilities.readSquadMembers, true);
        assert.strictEqual(evaluatorAccess.capabilities.readSquadMembers, false);
        assert.strictEqual(memberAccess.capabilities.readSquadMembers, false);

        const httpDirectory = await validateHttpRoute(db);

        fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
        fs.writeFileSync(path.join(ARTIFACT_DIR, 'captain-directory.json'), `${JSON.stringify(captain, null, 2)}\n`, 'utf8');
        fs.writeFileSync(path.join(ARTIFACT_DIR, 'member-directory.json'), `${JSON.stringify(member, null, 2)}\n`, 'utf8');
        fs.writeFileSync(path.join(ARTIFACT_DIR, 'narrator-directory.json'), `${JSON.stringify(narrator, null, 2)}\n`, 'utf8');
        fs.writeFileSync(path.join(ARTIFACT_DIR, 'http-directory.json'), `${JSON.stringify(httpDirectory, null, 2)}\n`, 'utf8');
        fs.writeFileSync(path.join(ARTIFACT_DIR, 'report.json'), `${JSON.stringify({
            allowed: {
                narrator: narrator.ok,
                captain: captain.ok,
                vice: vice.ok,
                member: member.ok,
                owner: owner.ok,
            },
            blocked: {
                captainOther: captainOther.code,
                evaluator: evaluator.code,
            },
            members: captain.members,
        }, null, 2)}\n`, 'utf8');

        console.log('✓ Narrador consulta membros globalmente');
        console.log('✓ Capitão e Vice consultam apenas o próprio esquadrão');
        console.log('✓ Membro comum consulta somente o próprio esquadrão');
        console.log('✓ Avaliador sem escopo não recebe o diretório');
        console.log('✓ Owner mantém acesso global');
        console.log('✓ GET /squads/:key/members exige sessão e escopo');
        console.log('✓ resposta não expõe telefone, JID, notas ou IDs internos');
    } finally {
        await db.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
