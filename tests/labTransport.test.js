'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createLabTransport}=require('../helpers/clover/labTransport');
const {getMessageText,getQuotedText,getMessageContextInfo}=require('../helpers/messageContext');

function lab(){
    return createLabTransport({players:[{slug:'mage',name:'Mago'},{slug:'admin',name:'ADM'},{slug:'outside',name:'Visitante'}],
        groups:[{slug:'on',members:[{slug:'mage'},{slug:'admin',role:'admin'}]},{slug:'staff',members:[{slug:'admin',role:'admin'}]}],clock:()=>1700000000000});
}
test('transportador de laboratório oferece grupos, PV, citações, reações e eventos no formato nativo',async()=>{
    const l=lab(),mage=l.playerJid('mage'),admin=l.playerJid('admin'),on=l.groupJid('on');
    const seen=[];l.sock.ev.on('messages.upsert',e=>seen.push(e));
    const m=l.emitIncoming({chat:on,actor:mage,text:'.#status'});
    assert.equal(getMessageText(m),'.#status');
    assert.equal(seen[0].messages[0].key.id,m.key.id);
    assert.equal(m.messageTimestamp,1700000000);
    const reply=await l.sock.sendMessage(on,{text:'Magias disponíveis',mentions:[mage]},{quoted:m});
    const quoted=l.receive({chat:on,actor:mage,text:'Magia de Fogo',quoteId:reply.key.id});
    assert.equal(getQuotedText(quoted),'Magias disponíveis');
    assert.equal(getMessageContextInfo(quoted).stanzaId,reply.key.id);
    const reaction=l.receive({chat:on,actor:admin,reaction:{messageId:reply.key.id,text:'✅'}});
    assert.equal(reaction.message.reactionMessage.key.id,reply.key.id);
    await l.sock.sendMessage(mage,{text:'Mensagem privada'});
    assert.equal(l.history(mage).length,1);
    assert.equal(l.history(on).length,4);
    assert.equal((await l.sock.groupMetadata(on)).participants.find(x=>x.id===admin).admin,'admin');
    const copy=l.history(on);copy.pop();assert.equal(l.history(on).length,4);
    l.close();await assert.rejects(()=>l.sock.sendMessage(on,{text:'x'}),/closed/);
});
test('transportador recusa destinatários reais, acesso cruzado e conteúdo não suportado',async()=>{
    const l=lab(),mage=l.playerJid('mage'),outside=l.playerJid('outside'),on=l.groupJid('on'),staff=l.groupJid('staff');
    const m=await l.sock.sendMessage(on,{text:'teste'});
    await assert.rejects(()=>l.sock.sendMessage('external@s.whatsapp.net',{text:'x'}),/unknown_lab_chat/);
    assert.throws(()=>l.receive({chat:on,actor:outside,text:'x'}),/not_in_group/);
    assert.throws(()=>l.receive({chat:mage,actor:outside,text:'x'}),/actor_mismatch/);
    assert.throws(()=>l.receive({chat:staff,actor:l.playerJid('admin'),text:'x',quoteId:m.key.id}),/outside_chat/);
    await assert.rejects(()=>l.sock.sendMessage(on,{image:{url:'https://example.invalid/image.png'}}),/unsupported_lab_payload/);
    await assert.rejects(()=>l.sock.sendMessage(on,{text:'x',mentions:['external@s.whatsapp.net']}),/unknown_lab_mention/);
    l.failNext(on);await assert.rejects(()=>l.sock.sendMessage(on,{text:'x'}),/injected_failure/);
    assert.equal(l.history(on).length,1);
    await l.sock.sendMessage(on,{text:'retry'});
    assert.equal(l.history(on).length,2);
});
