'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const { ensureCloverSquadSchema } = require('../database');
const { assignAccessRole } = require('../helpers/clover/accessRoleAssignmentService');
const { purchaseSquadUpgrade } = require('../helpers/clover/squadUpgradeService');
const { buildSiteAccessPayload } = require('../helpers/clover/siteAccessPayloadService');
const { createSession } = require('../helpers/clover/siteAuthService');

const ARTIFACT_DIR = path.join(__dirname, '..', 'artifacts', 'site-access');
const OWNER = '557998868223@s.whatsapp.net';
const NARRATOR = '5511000000001@s.whatsapp.net';
const EVALUATOR = '5511000000002@s.whatsapp.net';
const CAPTAIN = '5511000000003@s.whatsapp.net';
const MEMBER = '5511000000004@s.whatsapp.net';
const OUTSIDER = '5511000000005@s.whatsapp.net';

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
    await db.run(`
        INSERT INTO clover_squads
        (squad_key, name, phrase, historical_stars, current_stars, black_stars)
        VALUES ('touros_negros', 'Touros Negros', 'Superar limites.', 37, 20, 0)
    `);
    await db.run(`
        INSERT INTO clover_squads
        (squad_key, name, historical_stars, current_stars, black_stars)
        VALUES ('aguias_prateadas', 'Águias Prateadas', 60, 12, 1)
    `);

    for (const [id, name, squad] of [
        [NARRATOR, 'Narrador', '-'],
        [EVALUATOR, 'Avaliador', '-'],
        [CAPTAIN, 'Capitão', 'Touros Negros'],
        [MEMBER, 'Membro', 'Touros Negros'],
        [OUTSIDER, 'Sem Cargo', '-'],
    ]) {
        await db.run(
            `INSERT INTO jogadores
             (id, nome, display_name, personagem_nome, esquadrao, patente)
             VALUES (?, ?, ?, ?, ?, 'Cavaleiro Mágico')`,
            [id, name, name, name, squad]
        );
    }
    return db;
}

function assertNoPrivateFields(payload) {
    const serialized = JSON.stringify(payload);
    for (const forbidden of [
        'metadata_json',
        'assigned_by',
        'revoked_by',
        'private_notes',
        'notas_adm',
        'code_hash',
        'token_hash',
    ]) {
        assert(!serialized.includes(forbidden), `Campo privado exposto: ${forbidden}`);
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

    const {
        startSiteApiServer,
        stopSiteApiServer,
    } = require('../helpers/clover/siteApiServer');

    const session = await createSession(db, CAPTAIN, CAPTAIN.replace(/\D/g, ''));
    const server = startSiteApiServer({ getDb: () => db });
    try {
        if (!server.listening) {
            await new Promise((resolve, reject) => {
                server.once('listening', resolve);
                server.once('error', reject);
            });
        }
        const address = server.address();
        const unauthenticated = await requestJson({ port: address.port, pathName: '/access' });
        const authenticated = await requestJson({
            port: address.port,
            pathName: '/access',
            token: session.token,
        });

        assert.strictEqual(unauthenticated.status, 401);
        assert.strictEqual(unauthenticated.body.ok, false);
        assert.strictEqual(authenticated.status, 200);
        assert.strictEqual(authenticated.body.ok, true);
        assert.strictEqual(authenticated.body.access.actorId, CAPTAIN);
        assert.strictEqual(authenticated.body.access.ownSquad.key, 'touros_negros');
        assert.strictEqual(authenticated.body.access.capabilities.manageSquadUpgrades, true);
        assertNoPrivateFields(authenticated.body);
        return authenticated.body.access;
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
        await assignAccessRole(db, {
            subjectId: NARRATOR,
            role: 'narrador',
            assignedBy: OWNER,
        });
        await assignAccessRole(db, {
            subjectId: EVALUATOR,
            role: 'avaliador',
            assignedBy: OWNER,
        });
        await assignAccessRole(db, {
            subjectId: CAPTAIN,
            role: 'capitao',
            scopeKey: 'Touros Negros',
            assignedBy: OWNER,
            metadata: { scope_label: 'Touros Negros' },
        });
        await purchaseSquadUpgrade(db, 'touros_negros', 'mural_meritos', { purchasedBy: CAPTAIN });
        await purchaseSquadUpgrade(db, 'touros_negros', 'posto_vigilancia', { purchasedBy: CAPTAIN });

        const narrator = await buildSiteAccessPayload(db, NARRATOR);
        const evaluator = await buildSiteAccessPayload(db, EVALUATOR);
        const captain = await buildSiteAccessPayload(db, CAPTAIN);
        const member = await buildSiteAccessPayload(db, MEMBER);
        const outsider = await buildSiteAccessPayload(db, OUTSIDER);
        const owner = await buildSiteAccessPayload(db, OWNER);

        assert.deepStrictEqual(narrator.roleKeys, ['narrator']);
        assert.strictEqual(narrator.capabilities.readProfiles, true);
        assert.strictEqual(narrator.capabilities.readGrimoires, true);
        assert.strictEqual(narrator.capabilities.readTechnicalGrimoires, false);
        assert.strictEqual(narrator.accessibleSquads.length, 2);
        assert(narrator.accessibleSquads.every((squad) => squad.canManageUpgrades === false));

        assert.deepStrictEqual(evaluator.roleKeys, ['evaluator']);
        assert.strictEqual(evaluator.capabilities.readTechnicalCapabilities, true);
        assert.strictEqual(evaluator.capabilities.readTechnicalGrimoires, true);
        assert.strictEqual(evaluator.capabilities.manageSquadUpgrades, false);
        assert.strictEqual(evaluator.accessibleSquads.length, 0);

        assert.deepStrictEqual(captain.roleKeys, ['captain']);
        assert.strictEqual(captain.roles[0].scopeKey, 'touros_negros');
        assert.strictEqual(captain.roles[0].scopeLabel, 'Touros Negros');
        assert.strictEqual(captain.capabilities.manageSquadUpgrades, true);
        assert.strictEqual(captain.accessibleSquads.length, 1);
        assert.strictEqual(captain.accessibleSquads[0].key, 'touros_negros');
        assert.strictEqual(captain.accessibleSquads[0].canManageUpgrades, true);
        assert.strictEqual(captain.ownSquad.key, 'touros_negros');
        assert.strictEqual(captain.ownSquad.structure.count, 2);
        assert.strictEqual(captain.ownSquad.structure.sectorCount, 1);
        assert(captain.ownSquad.structure.upgrades.includes('Posto de Vigilância do QG'));

        assert.deepStrictEqual(member.roleKeys, []);
        assert.strictEqual(member.capabilities.readProfiles, false);
        assert.strictEqual(member.accessibleSquads.length, 1);
        assert.strictEqual(member.accessibleSquads[0].scope, 'own_squad');
        assert.strictEqual(member.accessibleSquads[0].canManageUpgrades, false);
        assert.strictEqual(member.ownSquad.name, 'Touros Negros');

        assert.deepStrictEqual(outsider.roleKeys, []);
        assert.strictEqual(outsider.ownSquad, null);
        assert.deepStrictEqual(outsider.accessibleSquads, []);

        assert.strictEqual(owner.owner, true);
        assert.strictEqual(owner.capabilities.globalAdministration, true);
        assert.strictEqual(owner.capabilities.manageSquadUpgrades, true);
        assert.strictEqual(owner.accessibleSquads.length, 2);
        assert(owner.accessibleSquads.every((squad) => squad.canManageUpgrades));

        for (const payload of [narrator, evaluator, captain, member, outsider, owner]) {
            assertNoPrivateFields(payload);
        }

        const httpAccess = await validateHttpRoute(db);

        fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
        fs.writeFileSync(path.join(ARTIFACT_DIR, 'captain.json'), `${JSON.stringify(captain, null, 2)}\n`, 'utf8');
        fs.writeFileSync(path.join(ARTIFACT_DIR, 'narrator.json'), `${JSON.stringify(narrator, null, 2)}\n`, 'utf8');
        fs.writeFileSync(path.join(ARTIFACT_DIR, 'evaluator.json'), `${JSON.stringify(evaluator, null, 2)}\n`, 'utf8');
        fs.writeFileSync(path.join(ARTIFACT_DIR, 'http-access.json'), `${JSON.stringify(httpAccess, null, 2)}\n`, 'utf8');
        fs.writeFileSync(path.join(ARTIFACT_DIR, 'report.json'), `${JSON.stringify({
            narrator: narrator.capabilities,
            evaluator: evaluator.capabilities,
            captain: captain.capabilities,
            member: member.capabilities,
            owner: owner.capabilities,
            httpRoute: {
                actorId: httpAccess.actorId,
                roleKeys: httpAccess.roleKeys,
                ownSquad: httpAccess.ownSquad?.key || null,
            },
            accessibleSquads: {
                narrator: narrator.accessibleSquads.map((squad) => squad.key),
                evaluator: evaluator.accessibleSquads.map((squad) => squad.key),
                captain: captain.accessibleSquads.map((squad) => squad.key),
                member: member.accessibleSquads.map((squad) => squad.key),
                outsider: outsider.accessibleSquads.map((squad) => squad.key),
            },
        }, null, 2)}\n`, 'utf8');

        console.log('✓ Narrador recebe leitura geral sem técnica');
        console.log('✓ Avaliador recebe técnica sem gestão de QG');
        console.log('✓ Capitão recebe apenas o próprio esquadrão e suas benfeitorias');
        console.log('✓ membro comum recebe somente o próprio esquadrão');
        console.log('✓ outsider não recebe esquadrões');
        console.log('✓ Owner recebe contexto global');
        console.log('✓ GET /access exige sessão e retorna o ator correto');
        console.log('✓ payload não expõe metadados, notas ou hashes de autenticação');
    } finally {
        await db.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
