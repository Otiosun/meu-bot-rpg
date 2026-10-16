const { normalizeCommandText, unique } = require('./textUtils');

function getPatterns(command) {
    return unique([command.nome, ...(command.aliases || [])])
        .map((raw) => String(raw || '').trim())
        .filter(Boolean)
        .map((raw) => ({
            raw,
            normalized: normalizeCommandText(raw),
        }))
        .filter((pattern) => pattern.normalized)
        .sort((a, b) => b.normalized.length - a.normalized.length);
}

function matchesCommand(normalizedText, normalizedCommand) {
    return normalizedText === normalizedCommand
        || normalizedText.startsWith(`${normalizedCommand} `)
        || normalizedText.startsWith(`${normalizedCommand}\n`);
}

function commandOwnerLabel(command, ownerHint = null) {
    return String(
        ownerHint
        || command?.__sourceFile
        || command?.nome
        || '<comando-sem-owner>'
    ).trim();
}

function normalizeCommandEntries(commands) {
    if (!commands) return [];

    if (commands instanceof Map) {
        return [...commands.entries()].map(([owner, command]) => ({ command, owner }));
    }

    if (!Array.isArray(commands)) {
        throw new TypeError('Comandos precisam ser Map ou array.');
    }

    return commands.map((entry, index) => {
        if (entry?.command) {
            return {
                command: entry.command,
                owner: commandOwnerLabel(entry.command, entry.owner),
            };
        }

        return {
            command: entry,
            owner: commandOwnerLabel(entry, `command#${index + 1}`),
        };
    });
}

function collectCommandOwnership(commands) {
    const ownership = new Map();

    for (const { command, owner } of normalizeCommandEntries(commands)) {
        if (!command || typeof command !== 'object') continue;
        const seenForOwner = new Set();

        for (const pattern of getPatterns(command)) {
            if (seenForOwner.has(pattern.normalized)) continue;
            seenForOwner.add(pattern.normalized);

            if (!ownership.has(pattern.normalized)) {
                ownership.set(pattern.normalized, []);
            }

            ownership.get(pattern.normalized).push({
                owner: commandOwnerLabel(command, owner),
                raw: pattern.raw,
                command,
            });
        }
    }

    return ownership;
}

function findCommandOwnershipConflicts(commands) {
    const conflicts = [];

    for (const [alias, owners] of collectCommandOwnership(commands)) {
        const distinctOwners = new Map();
        for (const item of owners) {
            if (!distinctOwners.has(item.owner)) distinctOwners.set(item.owner, item);
        }

        if (distinctOwners.size <= 1) continue;
        conflicts.push({
            alias,
            owners: [...distinctOwners.values()].map((item) => ({
                owner: item.owner,
                raw: item.raw,
            })),
        });
    }

    return conflicts.sort((a, b) => a.alias.localeCompare(b.alias));
}

function renderCommandOwnershipConflicts(conflicts) {
    return conflicts.map((conflict) => {
        const owners = conflict.owners
            .map((item) => `${item.owner} (${item.raw})`)
            .join(' <> ');
        return `- ${conflict.alias}: ${owners}`;
    }).join('\n');
}

function assertUniqueCommandOwnership(commands) {
    const conflicts = findCommandOwnershipConflicts(commands);
    if (!conflicts.length) return { ok: true, conflicts: [] };

    const error = new Error([
        'Aliases de comando colidentes foram encontrados.',
        renderCommandOwnershipConflicts(conflicts),
    ].join('\n'));
    error.code = 'COMMAND_ALIAS_COLLISION';
    error.conflicts = conflicts;
    throw error;
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
    assertUniqueCommandOwnership,
    collectCommandOwnership,
    findCommandOwnershipConflicts,
    getPatterns,
    renderCommandOwnershipConflicts,
    resolveCommand,
};