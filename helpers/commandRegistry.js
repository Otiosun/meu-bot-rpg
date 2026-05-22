const { normalizeCommandText, unique } = require('./textUtils');

function getPatterns(command) {
    return unique([command.nome, ...(command.aliases || [])])
        .map((raw) => String(raw || '').trim())
        .filter(Boolean)
        .map((raw) => ({
            raw,
            normalized: normalizeCommandText(raw),
        }))
        .sort((a, b) => b.normalized.length - a.normalized.length);
}

function matchesCommand(normalizedText, normalizedCommand) {
    return normalizedText === normalizedCommand
        || normalizedText.startsWith(`${normalizedCommand} `)
        || normalizedText.startsWith(`${normalizedCommand}\n`);
}

function resolveCommand(text, commandsMap) {
    const rawText = String(text || '').trim();
    const normalizedText = normalizeCommandText(rawText);
    let bestMatch = null;

    commandsMap.forEach((command) => {
        for (const pattern of getPatterns(command)) {
            if (!matchesCommand(normalizedText, pattern.normalized)) continue;
            if (!bestMatch || pattern.normalized.length > bestMatch.pattern.normalized.length) {
                bestMatch = { command, pattern };
            }
            break;
        }
    });

    if (!bestMatch) return null;

    const body = rawText.slice(bestMatch.pattern.raw.length).trim();
    const args = body ? [bestMatch.pattern.raw, ...body.split(/\s+/)] : [bestMatch.pattern.raw];

    return {
        command: bestMatch.command,
        matchedName: bestMatch.pattern.raw,
        body,
        args,
    };
}

module.exports = {
    resolveCommand,
};
