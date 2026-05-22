const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    downloadMediaMessage,
} = require('@whiskeysockets/baileys');
const P = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const { criarBanco } = require('./database');
const { COMMAND_PREFIX } = require('./config/bot');
const { resolveCommand } = require('./helpers/commandRegistry');

const regrasRPG = fs.readFileSync('./regras.txt', 'utf8');

const genAI = new GoogleGenerativeAI('AIzaSyCZTSK7FSsMQokPboeXALVxmL7jgNdtacQ');
const model = genAI.getGenerativeModel({
    model: 'gemini-3.1-flash-lite-preview',
    systemInstruction: regrasRPG,
});

const comandos = new Map();
const pastaComandos = path.join(__dirname, 'comandos');

if (!fs.existsSync(pastaComandos)) {
    fs.mkdirSync(pastaComandos);
}

const arquivosComando = fs.readdirSync(pastaComandos).filter((file) => file.endsWith('.js'));
for (const file of arquivosComando) {
    const comando = require(path.join(pastaComandos, file));
    comandos.set(comando.nome, comando);
}

console.log(`Carregados ${comandos.size} comandos.`);

async function iniciarBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();
    const logger = P({ level: 'silent' });
    const db = await criarBanco();

    const sock = makeWASocket({
        version,
        logger,
        auth: state,
        browser: ['Windows', 'Chrome', '130.0.0.0'],
        printQRInTerminal: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) qrcode.generate(qr, { small: true });

        if (connection === 'close') {
            const errorCode = lastDisconnect?.error?.output?.statusCode;
            if (errorCode === DisconnectReason.loggedOut) {
                console.log('Sessao encerrada. Apague a pasta "auth_info" e inicie novamente.');
            } else {
                setTimeout(() => iniciarBot(), 5000);
            }
        } else if (connection === 'open') {
            console.log('Bot online.');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m?.message || m.key.fromMe) return;

        const idChat = m.key.remoteJid;
        const isGroup = idChat.endsWith('@g.us');
        const idJogador = isGroup ? m.key.participant : idChat;
        const texto =
            m.message.conversation
            || m.message.extendedTextMessage?.text
            || m.message.imageMessage?.caption
            || '';

        if (texto.startsWith(COMMAND_PREFIX)) {
            console.log(`Comando recebido de [${m.pushName}]:\n${texto}`);
        }

        if (!texto.startsWith(COMMAND_PREFIX)) return;

        const resolvedCommand = resolveCommand(texto, comandos);
        if (!resolvedCommand) return;

        const nomeUsuario = m.pushName || 'Cacador';

        try {
            await resolvedCommand.command.executar({
                sock,
                m,
                idChat,
                idJogador,
                texto,
                body: resolvedCommand.body,
                args: resolvedCommand.args,
                matchedCommand: resolvedCommand.matchedName,
                nomeUsuario,
                db,
                model,
                P,
                downloadMediaMessage,
                comandos,
            });
        } catch (err) {
            console.log(`Erro no comando ${resolvedCommand.matchedName}:`, err);
            await sock.sendMessage(idChat, { text: 'Erro ao executar o comando.' });
        }
    });
}

iniciarBot();
