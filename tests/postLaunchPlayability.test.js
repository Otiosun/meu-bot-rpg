'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { COMMAND_PREFIX } = require('../config/bot');
const { getPlayerPhase, canUseCommandInPhase, PHASES } = require('../helpers/clover/playerPhase');
const { getCanonicalPlayerPlayability } = require('../helpers/clover/playerPlayabilityService');
const { evaluateLifecyclePolicy, isPreResetLifecycle, runWithLifecycleContext } = require('../helpers/clover/lifecyclePolicy');
const { getPhSummary } = require('../helpers/clover/phService');
const { DEFAULT_PRE_RESET_CAMPAIGN_KEY: campaign } = require('../helpers/clover/preResetCampaignStateService');

const frozenEnv = { PRE_RESET:'ON', PRE_RESET_LAUNCH_ENABLED:'true', PRE_RESET_RETURN_ENABLED:'true' };

async function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-playability-'));
    const db = await require('../database').criarBanco({ filename:path.join(dir, 'fixture.sqlite') });
    t.after(async () => { await db.close(); fs.rmSync(dir, { recursive:true, force:true }); });
    await db.run(`INSERT INTO clover_prereset_launch_rosters (campaign_key,revision,status) VALUES (?,1,'completed')`, [campaign]);
    return db;
}

async function player(db, id, overrides = {}) {
    const row = {
        nome:id,
        personagem_nome:id,
        ficha_status:'aprovada',
        personagem_aparencia_status:'approved',
        historia_status:'aprovada',
        jogo_status:'liberado',
        magia:'Magia Fixture',
        ...overrides,
    };
    await db.run(
        `INSERT INTO jogadores
         (id,nome,personagem_nome,ficha_status,personagem_aparencia_status,historia_status,jogo_status,magia)
         VALUES (?,?,?,?,?,?,?,?)`,
        [id,row.nome,row.personagem_nome,row.ficha_status,row.personagem_aparencia_status,row.historia_status,row.jogo_status,row.magia]
    );
}

async function launch(db, id, overrides = {}) {
    const row = { outcome:'reset', status:'completed', error:null, ...overrides };
    await db.run(
        `INSERT INTO clover_prereset_launch_players
         (campaign_key,player_id,roster_revision,outcome,status,last_error_code,completed_at)
         VALUES (?,?,1,?,?,?,CURRENT_TIMESTAMP)`,
        [campaign,id,row.outcome,row.status,row.error]
    );
}

test('canonical launch completion wins over all legacy reception residues', async (t) => {
    const db = await fixture(t);
    for (const id of ['clean','profile','visual','onboarding']) await player(db,id);
    await db.run("UPDATE jogadores SET ficha_status='incompleta',jogo_status='bloqueado' WHERE id='profile'");
    await db.run("INSERT INTO pending_profile_confirmations(player_id,payload) VALUES ('profile','{}')");
    await db.run("UPDATE jogadores SET personagem_aparencia_status='pending',historia_status='pendente',jogo_status='bloqueado' WHERE id='visual'");
    await db.run("INSERT INTO player_onboarding(player_id,current_step) VALUES ('onboarding','rolls')");
    for (const id of ['clean','profile','visual','onboarding']) await launch(db,id);

    for (const id of ['clean','profile','visual','onboarding']) {
        const phase = await getPlayerPhase(db,id,{env:frozenEnv});
        assert.equal(phase.canPlay,true,id);
        assert.equal(phase.phase,PHASES.JOGO_LIBERADO,id);
        assert.equal(phase.reason,'launch_completed',id);
        assert.equal(phase.playability.source,'launch',id);
        assert.equal(phase.pendingProfile,false,id);
        assert.equal(phase.pendingMagic,false,id);
    }
});

test('deferred and archived remain blocked before launch completion precedence', async (t) => {
    const db = await fixture(t);
    await player(db,'deferred');
    await launch(db,'deferred',{status:'blocked',error:'reset_deferred'});
    const deferred = await getPlayerPhase(db,'deferred',{env:{}});
    assert.equal(deferred.canPlay,false);
    assert.equal(deferred.phase,PHASES.RESET_DEFERRED);
    assert.equal(deferred.reason,'future_character_pending');

    await player(db,'archived',{jogo_status:'arquivado'});
    await launch(db,'archived');
    const archived = await getPlayerPhase(db,'archived',{env:{}});
    assert.equal(archived.canPlay,false);
    assert.equal(archived.phase,PHASES.ARCHIVED);
    assert.equal(archived.reason,'archived');
});

test('players without canonical launch evidence retain the legacy reception machine', async (t) => {
    const db = await fixture(t);
    const newcomer = await getPlayerPhase(db,'new-player',{env:{}});
    assert.equal(newcomer.phase,PHASES.NOVO);
    assert.equal(newcomer.canPlay,false);
    assert.equal(newcomer.playability.source,'legacy_reception');

    await player(db,'legacy-player');
    const legacy = await getPlayerPhase(db,'legacy-player',{env:{}});
    assert.equal(legacy.phase,PHASES.JOGO_LIBERADO);
    assert.equal(legacy.canPlay,true);
    assert.equal(legacy.playability.source,'legacy_reception');
});

test('status renders the existing post-launch panel without reading stale pending rows', async (t) => {
    const db = await fixture(t);
    await player(db,'status-player',{ficha_status:'incompleta',jogo_status:'bloqueado'});
    await launch(db,'status-player');
    await db.run("INSERT INTO pending_profile_confirmations(player_id,payload) VALUES ('status-player','{}')");
    const sent=[];
    const sock={sendMessage:async(_chat,message)=>{sent.push(message);return {key:{id:'status-output'}}}};
    await require('../comandos/status').executar({sock,m:{key:{id:'status-input'}},idChat:'fixture@g.us',idJogador:'status-player',nomeUsuario:'Fixture',db});
    assert.equal(sent.length,1);
    assert.match(sent[0].text,/liberado/i);
    assert.doesNotMatch(sent[0].text,/bloqueado/i);
    assert.doesNotMatch(sent[0].text,/aguardando.*(ficha|hist[oó]ria|apar[eê]ncia)/i);
});

test('dispatcher command and lifecycle gates accept completed players without per-command bypasses', async (t) => {
    const db = await fixture(t);
    await player(db,'dispatch-player',{ficha_status:'incompleta',jogo_status:'bloqueado'});
    await launch(db,'dispatch-player');
    const phase = await getPlayerPhase(db,'dispatch-player',{env:frozenEnv});
    for (const name of ['perfil','status','ph','atributos','hexagono','evolucao','inventario','carteira','cavaleiro']) {
        assert.equal(canUseCommandInPhase(`${COMMAND_PREFIX}${name}`,phase.phase,{isGameCommand:true}),true,name);
    }
    const context={env:frozenEnv,lifecycle:phase.phase,canonicalWorldReady:true,surface:'command',operation:'fixture',mutationClass:'CURRENT_WORLD'};
    assert.equal(evaluateLifecyclePolicy(context).ok,true);
    await runWithLifecycleContext(context,async()=>{
        assert.equal(isPreResetLifecycle(),false);
        assert.equal((await getPhSummary(db,'dispatch-player')).playerId,'dispatch-player');
    });
    assert.equal(isPreResetLifecycle(frozenEnv,'pre_reset_build'),true);
});

test('launch status alone is insufficient while the canonical roster is unfinished', async (t) => {
    const db = await fixture(t);
    await db.run("UPDATE clover_prereset_launch_rosters SET status='applying' WHERE campaign_key=?",[campaign]);
    await player(db,'ambiguous');
    await launch(db,'ambiguous');
    const state=await getCanonicalPlayerPlayability(db,'ambiguous');
    assert.equal(state.playable,false);
    assert.equal(state.authoritative,false);
    assert.equal(state.reason,'legacy_fallback');
});
