function isUndeliveredCommandReply(sendResult) {
    return Boolean(
        sendResult?.skipped
        && sendResult.reason === 'pv_command_reply_not_queued'
    );
}

async function rollbackUndeliveredAttempt({ db, playerId, attemptNumber, rollbackSpecialAttempt, sendResult, source }) {
    if (!isUndeliveredCommandReply(sendResult)) {
        return { rolledBack: false, reason: 'delivered_or_deferred' };
    }

    const rollback = await rollbackSpecialAttempt(db, playerId, attemptNumber);
    console.warn(`[${source || 'trait-attempt'}] Tentativa especial revertida porque a resposta PV nao foi entregue.`, {
        playerId,
        attemptNumber,
        reason: sendResult.reason,
        removed: rollback.removed || 0,
    });
    return { rolledBack: true, rollback };
}

module.exports = {
    isUndeliveredCommandReply,
    rollbackUndeliveredAttempt,
};
