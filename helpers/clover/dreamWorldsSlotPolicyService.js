'use strict';

const { DreamWorldsServiceError } = require('./dreamWorldsService');
const {
    assignDreamSlot,
    replaceDreamSlot,
} = require('./dreamWorldsOperationsService');

function normalize(value) {
    return String(value ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase();
}

async function findRun(db, runInput) {
    const raw = String(runInput ?? '').trim();
    if (!raw) throw new DreamWorldsServiceError('missing_run', 'Informe a incursão.');
    if (/^\d+$/.test(raw)) {
        return db.get('SELECT * FROM clover_dream_runs WHERE id = ?', [Number(raw)]);
    }
    return db.get('SELECT * FROM clover_dream_runs WHERE run_key = ? COLLATE NOCASE', [raw]);
}

async function resolveSquadAliases(db, squadInput) {
    const value = String(squadInput ?? '').trim();
    if (!value || value === '-') return new Set();
    const aliases = new Set([normalize(value)]);
    const squad = await db.get(
        `SELECT squad_key, name FROM clover_squads
         WHERE squad_key = ? COLLATE NOCASE OR name = ? COLLATE NOCASE`,
        [value, value]
    );
    if (squad) {
        aliases.add(normalize(squad.squad_key));
        aliases.add(normalize(squad.name));
    }
    return aliases;
}

async function resolveBuyerSquadAliases(db, run) {
    if (run.buyer_type === 'squad') return resolveSquadAliases(db, run.buyer_id);
    const buyer = await db.get('SELECT esquadrao FROM jogadores WHERE id = ?', [run.buyer_id]);
    return resolveSquadAliases(db, buyer?.esquadrao);
}

async function assertDreamSlotPlayerPolicy(db, runInput, slotId, playerId) {
    const run = await findRun(db, runInput);
    if (!run) throw new DreamWorldsServiceError('run_not_found', 'Incursão não encontrada.');
    const slot = await db.get(
        'SELECT * FROM clover_dream_slots WHERE id = ? AND run_id = ?',
        [Number(slotId), Number(run.id)]
    );
    if (!slot) throw new DreamWorldsServiceError('slot_not_found', 'Vaga não encontrada.');
    const player = await db.get('SELECT id, esquadrao FROM jogadores WHERE id = ?', [String(playerId || '')]);
    if (!player) throw new DreamWorldsServiceError('player_not_found', 'Personagem não encontrado.');

    if (slot.category !== 'squad') return { run, slot, player };

    const buyerAliases = await resolveBuyerSquadAliases(db, run);
    const playerAliases = await resolveSquadAliases(db, player.esquadrao);
    const sameSquad = [...playerAliases].some((alias) => buyerAliases.has(alias));
    if (!sameSquad) {
        throw new DreamWorldsServiceError(
            'squad_slot_forbidden',
            'Esta vaga é reservada ao esquadrão comprador.',
            {
                slotId: Number(slot.id),
                playerId: player.id,
                playerSquad: player.esquadrao || null,
                buyerType: run.buyer_type,
                buyerId: run.buyer_id,
            }
        );
    }
    return { run, slot, player };
}

async function assignDreamSlotWithPolicy(db, runInput, slotId, playerId, actorId, input = {}) {
    await assertDreamSlotPlayerPolicy(db, runInput, slotId, playerId);
    return assignDreamSlot(db, runInput, slotId, playerId, actorId, input);
}

async function replaceDreamSlotWithPolicy(db, runInput, slotId, playerId, actorId, input = {}) {
    await assertDreamSlotPlayerPolicy(db, runInput, slotId, playerId);
    return replaceDreamSlot(db, runInput, slotId, playerId, actorId, input);
}

module.exports = {
    assertDreamSlotPlayerPolicy,
    assignDreamSlotWithPolicy,
    replaceDreamSlotWithPolicy,
};