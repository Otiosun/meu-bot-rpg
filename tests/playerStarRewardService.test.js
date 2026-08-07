'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    PlayerStarRewardError,
    getPlayerStarRewardTransaction,
    grantPlayerStarsInTransaction,
    reversePlayerStarsInTransaction,
} = require('../helpers/clover/playerStarRewardService');

const TEST_DEPENDENCIES = {
    ensureSchema: async () => {},
    readSquadStars: async (db) => ({
        balance: db.squad.current_stars,
        lifetime: db.squad.historical_stars,
        season: db.seasonStars,
        seasonId: 'season-2026',
        seasonName: 'Temporada 2026',
        black: 0,
    }),
};

class StarGrantDb {
    constructor() {
        this.playerStars = 10;
        this.reward = null;
        this.squadGrantCalls = 0;
        this.squad = {
            squad_key: 'corvos',
            current_stars: 35,
            historical_stars: 65,
        };
        this.seasonStars = 20;
    }

    async exec() {}

    async get(sql, params = []) {
        if (sql.includes('FROM clover_player_star_reward_transactions WHERE transaction_key')) {
            return this.reward && params[0] === this.reward.transaction_key ? { ...this.reward } : null;
        }
        if (sql.includes('FROM jogadores WHERE id = ?')) {
            return {
                id: 'player@test',
                personagem_nome: 'Teste',
                nome: 'Teste',
                esquadrao: 'Corvos',
                estrelas: this.playerStars,
            };
        }
        return null;
    }

    async run(sql, params = []) {
        if (sql.includes('UPDATE jogadores SET estrelas = COALESCE(estrelas, 0) +')) {
            this.playerStars += Number(params[0]);
            return { changes: 1 };
        }
        if (sql.includes('INSERT INTO clover_squads')) {
            return { changes: 1 };
        }
        if (sql.includes('INSERT INTO clover_player_star_reward_transactions')) {
            this.reward = {
                id: 9,
                transaction_key: params[0],
                player_id: params[1],
                amount: Number(params[2]),
                player_stars_before: Number(params[3]),
                player_stars_after: Number(params[4]),
                squad_key: params[5],
                squad_transaction_id: Number(params[6]),
                season_id: params[7],
                status: 'active',
            };
            return { changes: 1, lastID: 9 };
        }
        throw new Error(`Unexpected SQL in grant fake: ${sql}`);
    }
}

class StarUndoDb {
    constructor() {
        this.playerStars = 15;
        this.squad = {
            squad_key: 'corvos',
            current_stars: 40,
            historical_stars: 70,
        };
        this.seasonStars = 25;
        this.reward = {
            id: 9,
            transaction_key: 'reward:stars:1',
            player_id: 'player@test',
            amount: 5,
            player_stars_before: 10,
            player_stars_after: 15,
            squad_key: 'corvos',
            squad_transaction_id: 31,
            season_id: 'season-2026',
            status: 'active',
            related_id: 'OP-1',
        };
        this.latestPlayerRewardId = 9;
        this.latestSquadTransactionId = 31;
        this.nextTransactionId = 40;
        this.rewardStatus = 'active';
        this.writes = [];
    }

    async exec() {}

    async get(sql, params = []) {
        if (sql.includes('FROM clover_player_star_reward_transactions WHERE transaction_key')) {
            if (params[0] !== this.reward.transaction_key) return null;
            return { ...this.reward, status: this.rewardStatus };
        }
        if (sql.includes('FROM clover_player_star_reward_transactions') && sql.includes("status = 'active'")) {
            return this.latestPlayerRewardId ? { ...this.reward, id: this.latestPlayerRewardId, status: 'active' } : null;
        }
        if (sql.includes('SELECT COALESCE(estrelas, 0) AS estrelas FROM jogadores')) {
            return { estrelas: this.playerStars };
        }
        if (sql.includes('SELECT id FROM clover_squad_star_transactions')) {
            return { id: this.latestSquadTransactionId };
        }
        if (sql.includes('SELECT * FROM clover_squads')) {
            return { ...this.squad };
        }
        if (sql.includes('SELECT season_stars FROM clover_squad_season_stars')) {
            return { season_stars: this.seasonStars };
        }
        return null;
    }

    async all() {
        return [];
    }

    async run(sql, params = []) {
        this.writes.push({ sql, params });

        if (sql.includes('UPDATE clover_squads') && sql.includes('current_stars = current_stars -')) {
            const amount = Number(params[0]);
            this.squad.current_stars -= amount;
            this.squad.historical_stars -= amount;
            return { changes: 1 };
        }
        if (sql.includes('UPDATE clover_squad_season_stars') && sql.includes('season_stars = season_stars -')) {
            this.seasonStars -= Number(params[0]);
            return { changes: 1 };
        }
        if (sql.includes('INSERT INTO clover_squad_star_transactions')) {
            this.latestSquadTransactionId = this.nextTransactionId;
            return { changes: 1, lastID: this.nextTransactionId++ };
        }
        if (sql.includes('INSERT INTO clover_squad_star_ledger')) {
            return { changes: 1, lastID: this.nextTransactionId++ };
        }
        if (sql.includes('UPDATE jogadores SET estrelas = estrelas -')) {
            this.playerStars -= Number(params[0]);
            return { changes: 1 };
        }
        if (sql.includes('UPDATE clover_player_star_reward_transactions') && sql.includes("status = 'reversed'")) {
            this.rewardStatus = 'reversed';
            return { changes: 1 };
        }
        throw new Error(`Unexpected SQL in test fake: ${sql}`);
    }
}

test('star reward grant is idempotent and does not credit player or squad twice', async () => {
    const db = new StarGrantDb();
    const dependencies = {
        ensureSchema: async () => {},
        grantSquadStars: async (_db, input) => {
            db.squadGrantCalls += 1;
            db.squad.current_stars += input.amount;
            db.squad.historical_stars += input.amount;
            db.seasonStars += input.amount;
            return {
                ok: true,
                duplicate: false,
                transactionId: 31,
                stars: {
                    balance: db.squad.current_stars,
                    lifetime: db.squad.historical_stars,
                    season: db.seasonStars,
                    seasonId: 'season-2026',
                },
            };
        },
        readSquadStars: TEST_DEPENDENCIES.readSquadStars,
    };

    const input = {
        transactionKey: 'reward:stars:1',
        playerId: 'player@test',
        amount: 5,
        source: 'admin_reward',
        reason: 'Pacote de teste',
        relatedId: 'OP-1',
        createdBy: 'admin@test',
    };

    const first = await grantPlayerStarsInTransaction(db, input, dependencies);
    const second = await grantPlayerStarsInTransaction(db, input, dependencies);

    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(db.playerStars, 15);
    assert.equal(db.squad.current_stars, 40);
    assert.equal(db.squad.historical_stars, 70);
    assert.equal(db.seasonStars, 25);
    assert.equal(db.squadGrantCalls, 1);
});

test('star reward transaction lookup is keyed and stable', async () => {
    const db = new StarUndoDb();
    const row = await getPlayerStarRewardTransaction(db, 'reward:stars:1', TEST_DEPENDENCIES);
    assert.equal(row.player_id, 'player@test');
    assert.equal(Number(row.amount), 5);
});

test('undo restores player, squad current, squad lifetime and season together', async () => {
    const db = new StarUndoDb();
    const result = await reversePlayerStarsInTransaction(
        db,
        'reward:stars:1',
        {
            createdBy: 'admin@test',
            reason: 'Desfazer pacote de teste',
        },
        TEST_DEPENDENCIES
    );

    assert.equal(result.ok, true);
    assert.equal(result.duplicate, false);
    assert.equal(db.playerStars, 10);
    assert.equal(db.squad.current_stars, 35);
    assert.equal(db.squad.historical_stars, 65);
    assert.equal(db.seasonStars, 20);
    assert.equal(db.rewardStatus, 'reversed');
    assert.deepEqual(result.squadStars, {
        balance: 35,
        lifetime: 65,
        season: 20,
        seasonId: 'season-2026',
        seasonName: 'Temporada 2026',
        black: 0,
    });
});

test('undo is idempotent after the reward is already reversed', async () => {
    const db = new StarUndoDb();
    db.rewardStatus = 'reversed';

    const result = await reversePlayerStarsInTransaction(
        db,
        'reward:stars:1',
        { createdBy: 'admin@test' },
        TEST_DEPENDENCIES
    );

    assert.equal(result.ok, true);
    assert.equal(result.duplicate, true);
    assert.equal(db.playerStars, 15);
    assert.equal(db.squad.current_stars, 40);
    assert.equal(db.seasonStars, 25);
});

test('undo fails closed when player stars changed after reward', async () => {
    const db = new StarUndoDb();
    db.playerStars = 16;

    await assert.rejects(
        () => reversePlayerStarsInTransaction(
            db,
            'reward:stars:1',
            { createdBy: 'admin@test' },
            TEST_DEPENDENCIES
        ),
        (error) => error instanceof PlayerStarRewardError && error.code === 'player_star_state_changed'
    );
});

test('undo fails closed when another player-star reward exists after it', async () => {
    const db = new StarUndoDb();
    db.latestPlayerRewardId = 10;

    await assert.rejects(
        () => reversePlayerStarsInTransaction(
            db,
            'reward:stars:1',
            { createdBy: 'admin@test' },
            TEST_DEPENDENCIES
        ),
        (error) => error instanceof PlayerStarRewardError && error.code === 'player_stars_changed_since_reward'
    );
});

test('undo fails closed when squad stars moved after this reward', async () => {
    const db = new StarUndoDb();
    db.latestSquadTransactionId = 32;

    await assert.rejects(
        () => reversePlayerStarsInTransaction(
            db,
            'reward:stars:1',
            { createdBy: 'admin@test' },
            TEST_DEPENDENCIES
        ),
        (error) => error instanceof PlayerStarRewardError && error.code === 'squad_stars_changed_since_reward'
    );
});

test('undo fails closed before mutating when active season lacks enough stars', async () => {
    const db = new StarUndoDb();
    db.seasonStars = 4;

    await assert.rejects(
        () => reversePlayerStarsInTransaction(
            db,
            'reward:stars:1',
            { createdBy: 'admin@test' },
            TEST_DEPENDENCIES
        ),
        (error) => error instanceof PlayerStarRewardError && error.code === 'season_stars_changed_since_reward'
    );

    assert.equal(db.playerStars, 15);
    assert.equal(db.squad.current_stars, 40);
    assert.equal(db.squad.historical_stars, 70);
    assert.equal(db.seasonStars, 4);
    assert.equal(db.rewardStatus, 'active');
});
