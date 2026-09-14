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
const { purchaseSquadUpgrade } = require('../helpers/clover/squadUpgradeService');
const { getSiteSquadUpgradeCatalog } = require('../helpers/clover/siteSquadUpgradePayloadService');

const ARTIFACT_DIR = path.join(__dirname, '..', 'artifacts', 'site-squad-upgrades');
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
        (squad_key, name, historical_stars, current_stars, black_stars)
        VALUES ('touros_negros', 'Touros Negros', 37, 30, 0)
    `);
    await db.run(`
        INSERT INTO clover_squads
        (squad_key, name, historical_stars, current_stars, black_stars)
        VALUES ('aguias_prateadas', 'Águias Prateadas', 90, 40, 0)
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
    // Fixture memberships use the canonical authority; the legacy projection alone grants no access.
    await ensureSquadMembershipSchema(db);
    await db.run(`
        INSERT INTO clover_squad_memberships (player_id, squad_key, status, changed_by)
        SELECT player.id, squad.squad_key, 'active', 'fixture'
        FROM jogadores player JOIN clover_squads squad ON squad.name = player.esquadrao
    `);
    return db;
}

function assertSafeCatalog(result) {
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.totalCount, 41);
    assert.strictEqual(result.categories.length, 7);
    assert.strictEqual(result.categories.reduce((sum, category) => sum + category.items.length, 0), 41);
    const serialized = JSON.stringify(result);
    for (const forbidden of [
        '@s.whatsapp.net',
        '557998868223',
        'purchased_by',
        'metadata_json',
        'ownedRow',
        'player_id',
        'token_hash',
    ]) {
        assert(!serialized.includes(forbidden), `Dado privado exposto: ${forbidden}`);
    }
    for (const category of result.categories) {
        for (const item of category.items) {
            assert.deepStrictEqual(
                Object.keys(item).sort(),
                [
                    'activation',
                    'available',
                    'blockedReasons',
                    'categoryKey',
                    'categoryLabel',
                    'cost',
                    'effect',
                    'id',
                    'key',
                    'missingPrerequisites',
                    'name',
                    'owned',
                    'prerequisites',
                    'requiredGrade',
                    'requiredHistoricalStars',
                    'requiresApproval',
                ].sort()
            );
        }
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
    const memberSession = await createSession(db, MEMBER, MEMBER.replace(/\D/g, ''));
    const outsiderSession = await createSession(db, OUTSIDER, OUTSIDER.replace(/\D/g, ''));
    const server = startSiteApiServer({ getDb: () => db });
    try {
        if (!server.listening) {
            await new Promise((resolve, reject) => {
                server.once('listening', resolve);
                server.once('error', reject);
            });
        }
        const port = server.address().port;
        const unauthenticated = await requestJson({ port, pathName: '/squads/touros_negros/upgrades' });
        const member = await requestJson({
            port,
            pathName: '/squads/touros_negros/upgrades',
            token: memberSession.token,
        });
        const outsider = await requestJson({
            port,
            pathName: '/squads/touros_negros/upgrades',
            token: outsiderSession.token,
        });
        assert.strictEqual(unauthenticated.status, 401);
        assert.strictEqual(member.status, 200);
        assertSafeCatalog(member.body.catalog);
        assert.strictEqual(outsider.status, 403);
        return member.body.catalog;
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
        await purchaseSquadUpgrade(db, 'touros_negros', 'mural_meritos', { purchasedBy: CAPTAIN });
        await purchaseSquadUpgrade(db, 'touros_negros', 'posto_vigilancia', { purchasedBy: CAPTAIN });
        await purchaseSquadUpgrade(db, 'touros_negros', 'barreira_defensiva', { purchasedBy: CAPTAIN });

        const member = await getSiteSquadUpgradeCatalog(db, { actorId: MEMBER, squadInput: 'Touros Negros' });
        const captain = await getSiteSquadUpgradeCatalog(db, { actorId: CAPTAIN, squadInput: 'Touros Negros' });
        const captainOther = await getSiteSquadUpgradeCatalog(db, { actorId: CAPTAIN, squadInput: 'Águias Prateadas' });
        const narrator = await getSiteSquadUpgradeCatalog(db, { actorId: NARRATOR, squadInput: 'Águias Prateadas' });
        const evaluator = await getSiteSquadUpgradeCatalog(db, { actorId: EVALUATOR, squadInput: 'Touros Negros' });
        const outsider = await getSiteSquadUpgradeCatalog(db, { actorId: OUTSIDER, squadInput: 'Touros Negros' });
        const owner = await getSiteSquadUpgradeCatalog(db, { actorId: OWNER, squadInput: 'Águias Prateadas' });

        for (const result of [member, captain, narrator, owner]) assertSafeCatalog(result);
        assert.strictEqual(captainOther.code, 'forbidden');
        assert.strictEqual(evaluator.code, 'forbidden');
        assert.strictEqual(outsider.code, 'forbidden');
        assert.strictEqual(member.ownedCount, 3);
        assert.strictEqual(member.currentStars, 20);
        assert.strictEqual(member.historicalStars, 37);
        assert.strictEqual(member.renownGrade, 2);

        const mural = member.categories.flatMap((category) => category.items).find((item) => item.key === 'mural_meritos');
        const alarm = member.categories.flatMap((category) => category.items).find((item) => item.key === 'selo_alarme_territorial');
        const cell = member.categories.flatMap((category) => category.items).find((item) => item.key === 'cela_contencao_magica');
        assert.strictEqual(mural.owned, true);
        assert.strictEqual(mural.available, false);
        assert(mural.blockedReasons.includes('Já adquirida'));
        assert.deepStrictEqual(alarm.prerequisites, ['Posto de Vigilância do QG']);
        assert.strictEqual(alarm.available, true);
        assert.strictEqual(cell.requiresApproval, true);
        assert.strictEqual(cell.activation, 'Exige aprovação em uso relevante');
        assert(cell.blockedReasons.includes('Exige Grau 4'));

        const httpCatalog = await validateHttpRoute(db);

        fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
        fs.writeFileSync(path.join(ARTIFACT_DIR, 'member-catalog.json'), `${JSON.stringify(member, null, 2)}\n`, 'utf8');
        fs.writeFileSync(path.join(ARTIFACT_DIR, 'http-catalog.json'), `${JSON.stringify(httpCatalog, null, 2)}\n`, 'utf8');
        fs.writeFileSync(path.join(ARTIFACT_DIR, 'report.json'), `${JSON.stringify({
            allowed: {
                member: member.ok,
                captain: captain.ok,
                narrator: narrator.ok,
                owner: owner.ok,
            },
            blocked: {
                captainOther: captainOther.code,
                evaluator: evaluator.code,
                outsider: outsider.code,
            },
            totals: {
                categories: member.categories.length,
                upgrades: member.totalCount,
                owned: member.ownedCount,
                currentStars: member.currentStars,
            },
        }, null, 2)}\n`, 'utf8');

        console.log('✓ membro consulta o catálogo do próprio QG');
        console.log('✓ Capitão permanece isolado no próprio esquadrão');
        console.log('✓ Narrador e Owner possuem leitura global');
        console.log('✓ Avaliador e outsider não recebem estrutura');
        console.log('✓ 41 benfeitorias preservam custo, Grau e pré-requisitos oficiais');
        console.log('✓ GET /squads/:key/upgrades exige sessão e escopo');
        console.log('✓ payload não expõe compra, ator ou metadata interna');
    } finally {
        await db.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
