const base = require('./cloverScriptSelectorService');

function findProtectedResetLine(scriptText) {
    const lines = String(scriptText || '').replace(/\r\n/g, '\n').split('\n');
    let selectorOpen = false;
    for (let index = 0; index < lines.length; index += 1) {
        const text = String(lines[index] || '').trim();
        if (/^(ALVOS\s+ONDE\b|TODOS\b)/i.test(text)) {
            selectorOpen = true;
            continue;
        }
        if (!selectorOpen) continue;
        if (/^FIM$/i.test(text)) {
            selectorOpen = false;
            continue;
        }
        if (/^(PLAYER|JOGADOR)\s+(resetar|reset)\b/i.test(text) || /^(DESFAZER_RESET|RESTAURAR_RESET|UNDO_RESET)\b/i.test(text)) {
            return index + 1;
        }
    }
    return null;
}

async function expandSelectorScript(db, scriptText, options = {}) {
    const line = findProtectedResetLine(scriptText);
    if (line) {
        throw new base.CloverScriptSelectorError(
            'Seletores em massa não aceitam PLAYER resetar nem DESFAZER_RESET.',
            line,
            'protected_action_selector_forbidden'
        );
    }
    return base.expandSelectorScript(db, scriptText, options);
}

module.exports = {
    ...base,
    expandSelectorScript,
    findProtectedResetLine,
};
