'use strict';

// Strictly local, synthetic transport. No Baileys, auth state, network or files.
// Captures messages in the same shape consumed by messageContext and review
// handlers; unsupported capabilities fail rather than pretending to succeed.
const {EventEmitter}=require('node:events');
const {randomUUID}=require('node:crypto');
function playerJid(slug){
    if(typeof slug!=='string'||!/^[a-z][a-z0-9-]{0,39}$/.test(slug))throw Error('invalid_lab_player_slug');
    return 'lab-'+slug+'@s.whatsapp.net';
}
function groupJid(slug){
    if(typeof slug!=='string'||!/^[a-z][a-z0-9-]{0,39}$/.test(slug))throw Error('invalid_lab_group_slug');
    return 'lab-'+slug+'@g.us';
}
function createLabTransport({players=[],groups=[],clock=()=>Date.now(),maxMessages=5000}={}){
    if(!Number.isSafeInteger(maxMessages)||maxMessages<1||maxMessages>50000)throw Error('invalid_lab_transcript_limit');
    const bot=playerJid('bot'), run=randomUUID(), people=new Map([[bot,{id:bot,name:'Clover'}]]), chats=new Map();
    for(const p of players){
        const id=playerJid(p.slug);
        if(people.has(id))throw Error('duplicate_lab_player');
        people.set(id,{id,name:String(p.name||p.slug).slice(0,100)});
    }
    for(const g of groups){
        const id=groupJid(g.slug);
        if(chats.has(id))throw Error('duplicate_lab_group');
        const participants=[{id:bot,admin:'admin'}];
        const seen=new Set([bot]);
        for(const member of g.members||[]){
            const jid=playerJid(member.slug);
            if(!people.has(jid)||seen.has(jid))throw Error('invalid_lab_group_member');
            if(member.role!==undefined&&!['member','admin','superadmin'].includes(member.role))throw Error('invalid_lab_group_role');
            seen.add(jid);participants.push({id:jid,admin:member.role==='member'||!member.role?null:member.role});
        }
        chats.set(id,{id,subject:String(g.name||g.slug).slice(0,100),participants});
    }
    const ev=new EventEmitter(), transcript=[], byId=new Map(), failures=new Map();
    let counter=0,closed=false;
    const clone=x=>structuredClone(x);
    const assertOpen=()=>{if(closed)throw Error('lab_transport_closed');};
    function assertChat(id){
        if(!chats.has(id)&&(!people.has(id)||id===bot))throw Error('unknown_lab_chat');
    }
    function assertActor(actor,chat){
        if(!people.has(actor))throw Error('unknown_lab_actor');
        if(actor===bot)return;
        if(chats.has(chat)){
            if(!chats.get(chat).participants.some(p=>p.id===actor))throw Error('lab_actor_not_in_group');
        }else if(actor!==chat)throw Error('lab_private_chat_actor_mismatch');
    }
    function quoted(chat,id){
        const stored=byId.get(id);
        if(!stored||stored.key.remoteJid!==chat)throw Error('lab_quote_outside_chat');
        if(stored.message.reactionMessage)throw Error('lab_quote_is_reaction');
        return stored;
    }
    function append(chat,actor,message){
        assertOpen();assertChat(chat);assertActor(actor,chat);
        if(transcript.length>=maxMessages)throw Error('lab_transcript_full');
        const time=Number(clock());if(!Number.isFinite(time))throw Error('invalid_lab_clock');
        const key={id:run+':'+(++counter),remoteJid:chat,fromMe:actor===bot};
        if(chats.has(chat))key.participant=actor;
        const record={key,message:clone(message),pushName:people.get(actor).name,messageTimestamp:Math.floor(time/1000)};
        transcript.push(record);byId.set(key.id,record);
        return clone(record);
    }
    function validateText(text){
        if(typeof text!=='string'||text.length>32768)throw Error('invalid_lab_message_text');
        return text;
    }
    function contextFor(chat,quoteId,mentions=[]){
        if(!Array.isArray(mentions)||mentions.some(id=>!people.has(id)))throw Error('unknown_lab_mention');
        const context={};
        if(mentions.length)context.mentionedJid=[...new Set(mentions)];
        if(quoteId){
            const q=quoted(chat,quoteId);
            Object.assign(context,{stanzaId:q.key.id,participant:q.key.participant||(q.key.fromMe?bot:chat),quotedMessage:clone(q.message)});
        }
        return Object.keys(context).length?context:undefined;
    }
    function textContent(chat,text,quoteId,mentions){
        const context=contextFor(chat,quoteId,mentions);
        return context?{extendedTextMessage:{text:validateText(text),contextInfo:context}}:{conversation:validateText(text)};
    }
    const sock={
        ev,user:{id:bot,name:'Clover'},
        async groupMetadata(id){assertOpen();if(!chats.has(id))throw Error('unknown_lab_group');return clone(chats.get(id));},
        async groupFetchAllParticipating(){assertOpen();return Object.fromEntries([...chats].map(([k,v])=>[k,clone(v)]));},
        async sendMessage(chat,payload,options={}){
            assertOpen();assertChat(chat);
            const remain=failures.get(chat)||0;
            if(remain){failures.set(chat,remain-1);throw Error('lab_transport_injected_failure');}
            const quoteId=options?.quoted?.key?.id;
            if(payload?.react){
                const q=quoted(chat,payload.react.key?.id);
                return append(chat,bot,{reactionMessage:{key:q.key,text:validateText(payload.react.text)}});
            }
            if(typeof payload?.text==='string')return append(chat,bot,textContent(chat,payload.text,quoteId,payload.mentions));
            if(payload?.image instanceof Uint8Array){
                if(payload.image.byteLength>8*1024*1024)throw Error('lab_media_too_large');
                // Keep image bytes in memory; never follow filesystem paths or URLs.
                return append(chat,bot,{imageMessage:{caption:validateText(payload.caption||''),mimetype:'image/png',fileLength:payload.image.byteLength,labBytes:new Uint8Array(payload.image),contextInfo:contextFor(chat,quoteId,payload.mentions)}});
            }
            throw Error('unsupported_lab_payload');
        },
    };
    function receive({chat,actor,text,quoteId=null,reaction=null,mentions=[]}){
        assertOpen();assertChat(chat);assertActor(actor,chat);
        if(actor===bot)throw Error('lab_inbound_bot_forbidden');
        const message=reaction
            ?{reactionMessage:{key:quoted(chat,reaction.messageId).key,text:validateText(reaction.text)}}
            :textContent(chat,text,quoteId,mentions);
        return append(chat,actor,message);
    }
    return Object.freeze({
        sock,bot,playerJid,groupJid,
        receive,
        // Explicit emission allows a future dispatcher to subscribe to the
        // original events without starting an actual WhatsApp connection.
        emitIncoming(input){const m=receive(input);ev.emit('messages.upsert',{type:'notify',messages:[clone(m)]});return m;},
        failNext(chat,n=1){assertOpen();assertChat(chat);if(!Number.isSafeInteger(n)||n<1||n>100)throw Error('invalid_lab_failure_count');failures.set(chat,n);},
        history(chat){if(chat!==undefined)assertChat(chat);return clone(chat===undefined?transcript:transcript.filter(m=>m.key.remoteJid===chat));},
        close(){closed=true;ev.removeAllListeners();failures.clear();},
    });
}
module.exports={createLabTransport,playerJid,groupJid};
