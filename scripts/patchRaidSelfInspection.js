'use strict';

const fs = require('fs');

const serviceFile = 'helpers/clover/raidService.js';
let service = fs.readFileSync(serviceFile, 'utf8');

const before = `async function getRaidParticipantDetail(db, raidKey, actorId, targetPlayerId) {
    const raid = await getRaidRow(db, raidKey);
    const host = await requireHost(db, raid, actorId);
    const participant = await db.get(
        \`SELECT * FROM clover_raid_participants
         WHERE raid_id = ? AND player_id = ? AND status IN ('joined', 'active', 'completed')\`,
        [raid.id, normalizeJid(targetPlayerId)]
    );`;

const after = `async function getRaidParticipantDetail(db, raidKey, actorId, targetPlayerId) {
    const raid = await getRaidRow(db, raidKey);
    const actor = normalizeJid(actorId);
    const target = normalizeJid(targetPlayerId);
    const host = await getHostAccess(db, raid, actor);
    const isSelf = isSameUser(actor, target);
    if (!host.ok && !isSelf) {
        throw new RaidServiceError(
            'raid_participant_detail_forbidden',
            'Você só pode abrir sua própria ficha nesta raid.'
        );
    }
    const participant = await db.get(
        \`SELECT * FROM clover_raid_participants
         WHERE raid_id = ? AND player_id = ? AND status IN ('joined', 'active', 'completed')\`,
        [raid.id, target]
    );`;

const count = service.split(before).length - 1;
if (count !== 1) throw new Error(`Bloco de permissão encontrado ${count} vez(es).`);
service = service.replace(before, after);

const returnBefore = `        hostRole: host.role,
        participant: serializeParticipant(participant),`;
const returnAfter = `        hostRole: host.ok ? host.role : null,
        access: {
            isHost: host.ok,
            isSelf,
        },
        participant: serializeParticipant(participant),`;
const returnCount = service.split(returnBefore).length - 1;
if (returnCount !== 1) throw new Error(`Retorno da ficha encontrado ${returnCount} vez(es).`);
service = service.replace(returnBefore, returnAfter);
fs.writeFileSync(serviceFile, service, 'utf8');

const testFile = 'tests/raidFoundation.test.js';
let tests = fs.readFileSync(testFile, 'utf8');
const testName = 'participante abre a própria ficha sem acessar a ficha detalhada de outro jogador';
if (!tests.includes(testName)) {
    tests += `\n\ntest('${testName}', async (t) => {
    const db = await createTestDb();
    t.after(() => db.close());

    const created = await createRaid(db, IDS.narrator, {
        name: 'Registro individual da raid',
        maxPlayers: 4,
    });
    await joinRaid(db, created.raid.key, IDS.player1);
    await joinRaid(db, created.raid.key, IDS.player2);

    const own = await getRaidParticipantDetail(
        db,
        created.raid.key,
        IDS.player1,
        IDS.player1
    );

    assert.equal(own.participant.playerId, IDS.player1);
    assert.equal(own.access.isSelf, true);
    assert.equal(own.access.isHost, false);
    assert.equal(own.hostRole, null);

    await assert.rejects(
        () => getRaidParticipantDetail(
            db,
            created.raid.key,
            IDS.player1,
            IDS.player2
        ),
        (error) => error instanceof RaidServiceError &&
            error.code === 'raid_participant_detail_forbidden'
    );
});\n`;
}
fs.writeFileSync(testFile, tests, 'utf8');
console.log('Leitura da própria ficha liberada com isolamento entre participantes.');
