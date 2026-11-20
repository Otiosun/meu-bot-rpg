'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {provisionSeasonLab}=require('../helpers/clover/seasonLabProvisioning');
const {criarBanco}=require('../database');
const {ensurePlayerRecord,getOnboardingState}=require('../helpers/playerRegistry');
const {createAndStoreRoll,listPlayerRolls,rollbackStoredRoll}=require('../helpers/rollManager');
const {loadCloverConfigs}=require('../helpers/clover/configLoader');
const {getAvailableMagicsForRoll}=require('../helpers/magicManager');
const {analyzeProfileSubmission,savePendingConfirmation,confirmPendingProfile}=require('../helpers/profileForms');
const {getPlayerPhase,PHASES,canUseCommandInPhase}=require('../helpers/clover/playerPhase');
const {reserveSlot}=require('../helpers/clover/slotManager');

test('cadastro em banco novo: quatro rolls, ficha válida, rollback integral e confirmação',async t=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'clover-profile-journey-'));
    t.after(()=>fs.rm(dir,{recursive:true,force:true}));
    const root=path.join(dir,'season');
    await provisionSeasonLab(root);
    const filename=path.join(root,'season.sqlite');
    let db=await criarBanco({filename});
    t.after(async()=>{if(db)await db.close();});
    const playerId='fictional-journey-player';
    const phase=async()=> (await getPlayerPhase(db,playerId)).phase;
    assert.equal(await phase(),PHASES.NOVO);
    await ensurePlayerRecord(db,playerId,'Jogador de laboratório');
    await getOnboardingState(db,playerId);
    assert.equal(await phase(),PHASES.PRE_ROLL);
    // Use the real engine with deterministic entropy only within this fixture.
    const originalRandom=Math.random;
    try{
        Math.random=()=>0;
        let first=await createAndStoreRoll(db,playerId);
        assert.equal(first.ok,true);
        await rollbackStoredRoll(db,playerId,first.roll.rollNumber);
        assert.equal((await listPlayerRolls(db,playerId)).length,0);
        for(let i=1;i<=4;i++){
            const result=await createAndStoreRoll(db,playerId);
            assert.equal(result.ok,true);
            assert.equal(result.roll.rollNumber,i);
            assert.equal(await phase(),i===4?PHASES.ROLLS_CONCLUIDOS:PHASES.ROLLS_EM_ANDAMENTO);
        }
    }finally{Math.random=originalRandom;}
    assert.equal((await createAndStoreRoll(db,playerId)).reason,'limit_reached');
    const roll=(await listPlayerRolls(db,playerId))[0];
    const configs=loadCloverConfigs();
    const magic=getAvailableMagicsForRoll(roll).find(x=>!x.capacity);
    assert.ok(magic,'must have a compatible unlimited magic');
    // An existing real hold from an unselected roll must survive rollback,
    // then be released by the successful confirmation of the selected roll.
    const otherRace=configs.lists.races.find(x=>x.capacity&&x.key!==roll.race_key);
    assert.ok(otherRace);
    const hold=await reserveSlot(db,playerId,'race',otherRace.key,'roll_race',2);
    assert.equal(hold.ok,true);
    const body=[
        '     -- dados do jogador --',
        'Nome: Jogador de laboratório','Idade pessoal: 21',
        'O que gosta de fazer: Leitura','Disponibilidade detalhada: Finais de semana',
        '     -- dados do personagem --','Nome: Elian Vesper','Idade do personagem: 19',
        'Aparência: Personagem fictício - Obra fictícia','Gênero: Masculino',
        'Número do Roll: 1','Família: Nenhuma','Magia: '+magic.label,
        'Aptidão: '+configs.lists.commonAptitudes[0].name,'Marca: '+configs.lists.commonMarks[0].name,
        'Anomalia: Nenhuma'
    ].join('\n');
    const invalid=await analyzeProfileSubmission(db,playerId,body.replace('Número do Roll: 1','Número do Roll: 99'));
    assert.equal(invalid.ok,false);
    const analysis=await analyzeProfileSubmission(db,playerId,body);
    assert.equal(analysis.ok,true,JSON.stringify(analysis.errors));
    await savePendingConfirmation(db,playerId,analysis.payload);
    assert.equal(await phase(),PHASES.FICHA_PENDENTE_CONFIRMACAO);
    const snapshot=async()=>({
        player:await db.get('SELECT * FROM jogadores WHERE id=?',[playerId]),
        reservations:await db.all('SELECT * FROM slot_reservations WHERE player_id=? ORDER BY id',[playerId]),
        pending:await db.get('SELECT * FROM pending_profile_confirmations WHERE player_id=?',[playerId])
    });
    const before=await snapshot();
    await db.exec("CREATE TEMP TRIGGER fail_profile_delete BEFORE DELETE ON pending_profile_confirmations WHEN OLD.player_id='fictional-journey-player' BEGIN SELECT RAISE(ABORT,'fixture rollback'); END;");
    await assert.rejects(()=>confirmPendingProfile(db,playerId),/fixture rollback/);
    assert.deepEqual(await snapshot(),before);
    assert.equal(await phase(),PHASES.FICHA_PENDENTE_CONFIRMACAO);
    await db.exec('DROP TRIGGER fail_profile_delete');
    const result=await confirmPendingProfile(db,playerId);
    assert.equal(result.ok,true,JSON.stringify(result.errors));
    assert.equal(result.player.personagem_nome,'Elian Vesper');
    assert.equal(result.player.magia,magic.label);
    assert.equal((await db.get('SELECT status FROM slot_reservations WHERE id=?',[hold.reservation.id])).status,'released');
    assert.equal(await phase(),PHASES.APARENCIA_PENDENTE);
    assert.equal(canUseCommandInPhase('.#missao',await phase()),false);
    assert.equal((await confirmPendingProfile(db,playerId)).reason,'missing_pending');
    assert.equal((await listPlayerRolls(db,playerId)).length,4);
    await db.close();db=null;
    db=await criarBanco({filename});
    assert.equal(await phase(),PHASES.APARENCIA_PENDENTE);
    assert.equal((await db.get('SELECT magia FROM jogadores WHERE id=?',[playerId])).magia,magic.label);
    assert.equal((await listPlayerRolls(db,playerId)).length,4);
    assert.equal((await confirmPendingProfile(db,playerId)).reason,'missing_pending');
});
