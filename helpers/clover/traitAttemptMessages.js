const { COMMAND_PREFIX } = require('../../config/bot');

const ATTEMPT_LABELS = {
    rare_aptitude: 'Aptidão Rara',
    rare_mark: 'Marca Rara',
    anomaly: 'Anomalia',
};

function getAttemptLabel(category, fallback = '-') {
    return ATTEMPT_LABELS[category] || fallback;
}

function getSuccessGuidance(category) {
    if (category === 'rare_mark') {
        return 'Você liberou a escolha de uma *Marca Rara* disponível no catálogo.';
    }
    if (category === 'rare_aptitude') {
        return 'Você liberou a escolha de uma *Aptidão Rara* disponível no catálogo.';
    }
    if (category === 'anomaly') {
        return 'Você liberou a escolha de uma *Anomalia* disponível no catálogo.';
    }
    return 'Você liberou a escolha de uma opção disponível nessa categoria.';
}

function renderAttemptSummaryLines(attempts = []) {
    if (!attempts.length) {
        return ['*Tentativas usadas:* 0/𝟤'];
    }

    return [
        `*Tentativas usadas:* ${attempts.length}/𝟤`,
        ...attempts.map((attempt) => {
            const number = Number(attempt.attempt_number || 0);
            const label = getAttemptLabel(attempt.category, attempt.category || '-');
            const result = attempt.result === 'success' ? 'PASSOU' : 'FALHOU';
            return `> Tentativa ${number}: ${label} - ${result}`;
        }),
    ];
}

function renderAttemptHelp(attempts = []) {
    const used = attempts.length;
    const remaining = Math.max(2 - used, 0);

    return [
        '*♧┃TENTATIVAS ESPECIAIS 𖥔 CLOVER MULTICOLOR*',
        '     ──  aptidões, marcas e anomalias  ──',
        '',
        'Você possui até *𝟤 tentativas especiais* durante a criação.',
        '',
        'Cada tentativa verifica se você libera a raridade escolhida. Ao passar, poderá selecionar uma opção livre no catálogo daquela categoria.',
        '',
        `> ⤷ *${COMMAND_PREFIX}tentativa aptidao*`,
        `> ⤷ *${COMMAND_PREFIX}tentativa marca*`,
        `> ⤷ *${COMMAND_PREFIX}tentativa anomalia*`,
        `> ⤷ *${COMMAND_PREFIX}tentativa resultado*`,
        '',
        ...renderAttemptSummaryLines(attempts),
        '',
        `*Tentativas restantes:* ${remaining}/𝟤`,
    ].join('\n');
}

function renderAttemptStatus(attempts = []) {
    const remaining = Math.max(2 - attempts.length, 0);
    return [
        '*♧┃RESULTADO DAS TENTATIVAS ESPECIAIS*',
        '',
        ...renderAttemptSummaryLines(attempts),
        '',
        `*Tentativas restantes:* ${remaining}/𝟤`,
    ].join('\n');
}

function renderAttemptResult({ category, categoryLabel, success, attempts, error = null }) {
    const used = attempts.length;
    const remaining = Math.max(2 - used, 0);
    const label = categoryLabel || getAttemptLabel(category);

    if (error) {
        const limitReached = used >= 2;
        return [
            `*♧┃TENTATIVA DE ${String(label).toUpperCase()}*`,
            '',
            `_\`─( ! )───── ${limitReached ? 'LIMITE ATINGIDO' : 'NÃO REALIZADA'}\`_`,
            '',
            error,
            '',
            `*Tentativas restantes:* ${remaining}/𝟤`,
        ].join('\n');
    }

    return [
        `*♧┃TENTATIVA DE ${String(label).toUpperCase()}*`,
        '',
        `_\`─( ${success ? '✓' : '×'} )───── ${success ? 'PASSOU' : 'FALHOU'}\`_`,
        '',
        success
            ? getSuccessGuidance(category)
            : 'A raridade não foi liberada nesta tentativa.',
        '',
        `*Tentativas restantes:* ${remaining}/𝟤`,
        success ? '' : 'A tentativa foi consumida mesmo com a falha.',
    ].filter(Boolean).join('\n');
}

module.exports = {
    ATTEMPT_LABELS,
    getAttemptLabel,
    renderAttemptHelp,
    renderAttemptResult,
    renderAttemptStatus,
};
