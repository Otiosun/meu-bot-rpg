async function sendReply({ sock, idChat, m, text, mentions }) {
    return sock.sendMessage(
        idChat,
        { text, mentions: mentions || [] },
        m ? { quoted: m } : undefined
    );
}

module.exports = {
    sendReply,
};
