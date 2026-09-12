function generateSixDigitCode(previousCode = null) {
    let nextCode = '';

    do {
        nextCode = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
    } while (nextCode === previousCode);

    return nextCode;
}

let currentActivationCode = generateSixDigitCode();

function logCurrentActivationCode(reason = 'Codigo atual de ativacao') {
    console.log(`[ativacao] ${reason}: ${currentActivationCode}`);
}

function extractActivationCode(value) {
    const match = String(value || '').match(/\b\d{6}\b/);
    return match ? match[0] : '';
}

function isActivationCodeValid(value) {
    return extractActivationCode(value) === currentActivationCode;
}

function rotateActivationCode(reason = 'Novo codigo de ativacao') {
    currentActivationCode = generateSixDigitCode(currentActivationCode);
    logCurrentActivationCode(reason);
    return currentActivationCode;
}

function consumeActivationCode(value, reason = 'Codigo usado com sucesso') {
    const providedCode = extractActivationCode(value);
    if (!providedCode || providedCode !== currentActivationCode) {
        return {
            ok: false,
            providedCode,
        };
    }

    const usedCode = currentActivationCode;
    const nextCode = rotateActivationCode(reason);

    return {
        ok: true,
        providedCode,
        usedCode,
        nextCode,
    };
}

module.exports = {
    consumeActivationCode,
    extractActivationCode,
    isActivationCodeValid,
    logCurrentActivationCode,
};
