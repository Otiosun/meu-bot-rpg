const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const { ensureSlotReservationsSchema } = require('../database');
const { loadCloverConfigs } = require('../helpers/clover/configLoader');
const {
    confirmReservation,
    countUsedSlots,
    expireOldReservations,
    getCapacity,
    releaseReservation,
    reserveSlot,
} = require('../helpers/clover/slotManager');

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

async function main() {
    const configs = loadCloverConfigs({ forceReload: true });
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });

    await ensureSlotReservationsSchema(db);

    assert(configs.lists.families.length > 0, 'familias.json deveria carregar familias.');
    assert(getCapacity('family', 'vangeance') === 2, 'vangeance deveria ter 2 vagas.');
    assert(getCapacity('family', 'lolopechka') === 2, 'lolopechka deveria ter 2 vagas.');
    assert(getCapacity('anomaly', 'mana_amaldicoada') === 2, 'mana_amaldicoada deveria ter 2 vagas.');
    assert(getCapacity('anomaly', 'corpo_amaldicoado') === 1, 'corpo_amaldicoado deveria ter 1 vaga.');
    assert(getCapacity('magic', 'qualquer_magia') === null, 'magic deve ficar sem capacidade configurada nesta etapa.');

    const first = await reserveSlot(db, 'player_a', 'family', 'lolopechka', 'test_roll', 1);
    assert(first.ok && first.reason === 'reserved', 'deveria reservar uma vaga livre.');

    const secondInitial = await reserveSlot(db, 'player_b', 'family', 'lolopechka', 'test_roll', 1);
    assert(secondInitial.ok, 'deveria reservar a segunda vaga livre.');

    const blocked = await reserveSlot(db, 'player_c', 'family', 'lolopechka', 'test_roll', 1);
    assert(!blocked.ok && blocked.reason === 'capacity_full', 'deveria bloquear vaga cheia.');

    const released = await releaseReservation(db, 'player_a', 'family', 'lolopechka');
    assert(released.ok && released.releasedCount === 1, 'deveria liberar uma reserva pendente.');
    assert(await countUsedSlots(db, 'family', 'lolopechka') === 1, 'vaga liberada nao deveria contar como usada.');

    const second = await reserveSlot(db, 'player_c', 'family', 'lolopechka', 'test_roll', 1);
    assert(second.ok, 'deveria reservar depois de liberar.');

    const confirmed = await confirmReservation(db, 'player_c', 'family', 'lolopechka');
    assert(confirmed.ok && confirmed.reservation.status === 'confirmed', 'deveria confirmar reserva pendente.');
    assert(await countUsedSlots(db, 'family', 'lolopechka') === 2, 'reserva confirmada deveria contar como usada.');

    const blockedAfterConfirm = await reserveSlot(db, 'player_d', 'family', 'lolopechka', 'test_roll', 1);
    assert(!blockedAfterConfirm.ok && blockedAfterConfirm.reason === 'capacity_full', 'confirmada cheia deveria bloquear novas reservas.');

    const oldReservation = await reserveSlot(db, 'player_old_anomaly', 'anomaly', 'mana_amaldicoada', 'test_anomaly', null, {
        expiresAt: new Date(Date.now() - 60 * 1000),
    });
    assert(oldReservation.ok, 'deveria criar reserva antiga para teste de expiracao.');

    const expiredCount = await expireOldReservations(db);
    assert(expiredCount >= 1, 'deveria expirar reserva antiga.');

    const expiredRow = await db.get('SELECT status FROM slot_reservations WHERE id = ?', [oldReservation.reservation.id]);
    assert(expiredRow.status === 'expired', 'reserva antiga deveria ficar com status expired.');

    const one = await reserveSlot(db, 'player_e', 'family', 'grinberryall', 'test_race', 1);
    const two = await reserveSlot(db, 'player_f', 'family', 'grinberryall', 'test_race', 1);
    const three = await reserveSlot(db, 'player_g', 'family', 'grinberryall', 'test_race', 1);
    const four = await reserveSlot(db, 'player_h', 'family', 'grinberryall', 'test_race', 1);
    assert(one.ok && two.ok && three.ok && !four.ok && four.reason === 'capacity_full', 'quatro reservas nao podem passar do limite 3.');

    await db.close();

    console.log('Base Clover validada com sucesso.');
}

main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
});
