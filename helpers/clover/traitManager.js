const { getConfigOption, loadCloverConfigs } = require('./configLoader');
const { getClosestTextMatches, normalizeText } = require('../textUtils');

const ATTEMPT_CATEGORIES = {
    rare_aptitude: {
        label: 'Aptidao Rara',
        listName: 'rareAptitudes',
        fieldName: 'aptidao_rara',
    },
    rare_mark: {
        label: 'Marca Rara',
        listName: 'rareMarks',
        fieldName: 'marca_rara',
    },
    anomaly: {
        label: 'Anomalia',
        listName: 'anomalies',
        fieldName: 'anomalia',
    },
};

const DEFAULT_ATTEMPT_SUCCESS_CHANCES = {
    rare_aptitude: 0.15,
    rare_mark: 0.15,
    anomaly: 0.05,
};

const ATTEMPT_OVERRIDE_KEY_PREFIX = 'trait_attempt_override';

function buildAttemptOverrideKey(playerId, attemptNumber) {
    return `${ATTEMPT_OVERRIDE_KEY_PREFIX}:${playerId}:${attemptNumber}`;
}

function parseAttemptOverrideValue(rawValue) {
    if (!rawValue) return null;

    let payload = rawValue;
    if (typeof rawValue === 'string') {
        try {
            payload = JSON.parse(rawValue);
        } catch (_) {
            payload = { result: rawValue };
        }
    }

    const result = String(payload?.result || '').toLowerCase();
    if (!['success', 'failure'].includes(result)) {
        return { invalid: true };
    }

    if (payload?.expiresAt) {
        const expiresAt = Date.parse(payload.expiresAt);
        if (Number.isFinite(expiresAt) && Date.now() > expiresAt) {
            return { expired: true };
        }
    }

    return {
        result,
        category: payload?.category || null,
    };
}

async function deleteAttemptOverrideSetting(db, key) {
    try {
        await db.run('DELETE FROM clover_settings WHERE key = ?', [key]);
    } catch (error) {
        if (!String(error?.message || '').includes('no such table: clover_settings')) {
            throw error;
        }
    }
}

async function consumeAttemptOverride(db, playerId, attemptNumber, category) {
    const key = buildAttemptOverrideKey(playerId, attemptNumber);

    let row = null;
    try {
        row = await db.get(
            'SELECT value FROM clover_settings WHERE key = ?',
            [key]
        );
    } catch (error) {
        if (String(error?.message || '').includes('no such table: clover_settings')) {
            return null;
        }
        throw error;
    }

    if (!row) return null;

    const parsed = parseAttemptOverrideValue(row.value);
    if (!parsed || parsed.invalid || parsed.expired) {
        await deleteAttemptOverrideSetting(db, key);
        return null;
    }

    if (parsed.category && parsed.category !== category) {
        return null;
    }

    await deleteAttemptOverrideSetting(db, key);
    return parsed.result === 'success';
}

function normalizeLookup(value) {
    return normalizeText(value)
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function isBlankChoice(value) {
    const normalized = normalizeLookup(value);
    return !normalized
        || normalized === '-'
        || normalized === 'nenhuma'
        || normalized === 'nenhum'
        || normalized === 'nao'
        || normalized === 'não';
}

function resolveOption(listName, input) {
    if (isBlankChoice(input)) return null;

    const config = loadCloverConfigs();
    const list = config.lists[listName] || [];
    const normalizedInput = normalizeLookup(input);

    const exact = list.find((item) => {
        const keyAsText = normalizeLookup(String(item.key || '').replace(/_/g, ' '));
        return keyAsText === normalizedInput || normalizeLookup(item.name) === normalizedInput;
    });
    if (exact) return exact;

    const startsWith = list.filter((item) => {
        const keyAsText = normalizeLookup(String(item.key || '').replace(/_/g, ' '));
        const nameText = normalizeLookup(item.name);
        return keyAsText.startsWith(normalizedInput) || nameText.startsWith(normalizedInput);
    });
    if (startsWith.length === 1) return startsWith[0];

    const contains = list.filter((item) => {
        const keyAsText = normalizeLookup(String(item.key || '').replace(/_/g, ' '));
        const nameText = normalizeLookup(item.name);
        return keyAsText.includes(normalizedInput) || nameText.includes(normalizedInput);
    });
    if (contains.length === 1) return contains[0];

    return null;
}

function suggestOptions(listName, input) {
    const config = loadCloverConfigs();
    return getClosestTextMatches(input, config.lists[listName] || []);
}

function resolveAttemptCategory(input) {
    if (isBlankChoice(input)) return { ok: true, category: null };

    const normalized = normalizeLookup(input);
    if (normalized.includes('aptidao') || normalized.includes('aptidao rara')) {
        return { ok: true, category: 'rare_aptitude' };
    }
    if (normalized.includes('marca') || normalized.includes('marca rara')) {
        return { ok: true, category: 'rare_mark' };
    }
    if (normalized.includes('anomalia')) {
        return { ok: true, category: 'anomaly' };
    }

    return {
        ok: false,
        category: null,
        error: 'Tentativa especial precisa ser Aptidao Rara, Marca Rara ou Anomalia.',
    };
}

function rollAttempt(category, attemptNumber, options = {}) {
    const forced = options.forceResults?.[attemptNumber] ?? options.forceResults?.[category];
    if (typeof forced === 'boolean') return forced;
    const categoryChance = DEFAULT_ATTEMPT_SUCCESS_CHANCES[category] ?? 0;
    return Math.random() < Number(options.successChance ?? categoryChance);
}

async function getAttemptByNumber(db, playerId, attemptNumber) {
    return db.get(
        `SELECT *
         FROM clover_trait_attempts
         WHERE player_id = ? AND attempt_number = ?`,
        [playerId, attemptNumber]
    );
}

async function getAttemptsForPlayer(db, playerId) {
    return db.all(
        `SELECT *
         FROM clover_trait_attempts
         WHERE player_id = ?
         ORDER BY attempt_number ASC`,
        [playerId]
    );
}

async function rollbackSpecialAttempt(db, playerId, attemptNumber) {
    const number = Number(attemptNumber || 0);
    if (!playerId || !number) {
        return { removed: 0 };
    }

    const removed = await db.run(
        `DELETE FROM clover_trait_attempts
         WHERE player_id = ?
           AND attempt_number = ?
           AND chosen_key IS NULL`,
        [playerId, number]
    );

    return { removed: Number(removed?.changes || 0) };
}

async function getSuccessfulAttemptByCategory(db, playerId, category) {
    return db.get(
        `SELECT *
         FROM clover_trait_attempts
         WHERE player_id = ?
           AND category = ?
           AND result = 'success'
         ORDER BY attempt_number ASC
         LIMIT 1`,
        [playerId, category]
    );
}

async function saveAttempt(db, playerId, attemptNumber, category, result, chosenKey) {
    await db.run(
        `INSERT INTO clover_trait_attempts
         (player_id, attempt_number, category, status, result, chosen_key, created_at)
         VALUES (?, ?, ?, 'completed', ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(player_id, attempt_number) DO UPDATE SET
             chosen_key = excluded.chosen_key`,
        [playerId, attemptNumber, category, result, chosenKey || null]
    );

    return getAttemptByNumber(db, playerId, attemptNumber);
}

async function bindAttemptChoice(db, playerId, category, option) {
    if (!option?.key) return { ok: false, reason: 'missing_option' };

    const attempt = await getSuccessfulAttemptByCategory(db, playerId, category);
    if (!attempt) return { ok: false, reason: 'missing_success' };

    if (attempt.chosen_key && attempt.chosen_key !== option.key) {
        return { ok: false, reason: 'choice_locked', attempt };
    }

    if (!attempt.chosen_key) {
        await saveAttempt(db, playerId, attempt.attempt_number, category, attempt.result, option.key);
        attempt.chosen_key = option.key;
    }

    return { ok: true, attempt };
}

async function runSpecialAttempt(db, playerId, rawCategory, options = {}) {
    const categoryResult = resolveAttemptCategory(rawCategory);
    if (!categoryResult.ok || !categoryResult.category) {
        return {
            ok: false,
            reason: 'invalid_category',
            error: categoryResult.error || 'Use aptidao, marca ou anomalia.',
        };
    }

    const category = categoryResult.category;

    await db.exec('BEGIN IMMEDIATE');
    try {
        const attempts = await getAttemptsForPlayer(db, playerId);
        if (attempts.length >= 2) {
            await db.exec('COMMIT');
            return {
                ok: false,
                reason: 'limit_reached',
                attempts,
            };
        }

        const usedNumbers = new Set(attempts.map((attempt) => Number(attempt.attempt_number)));
        const attemptNumber = [1, 2].find((number) => !usedNumbers.has(number));
        const override = await consumeAttemptOverride(db, playerId, attemptNumber, category);
        const result = (override ?? rollAttempt(category, attemptNumber, options)) ? 'success' : 'failure';
        const attempt = await saveAttempt(db, playerId, attemptNumber, category, result, null);

        await db.exec('COMMIT');
        return {
            ok: true,
            category,
            attempt,
            success: result === 'success',
        };
    } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
    }
}

async function processSpecialAttempt(db, playerId, attemptNumber, rawCategory, selectedValue, options = {}) {
    const errors = [];
    const categoryResult = resolveAttemptCategory(rawCategory);
    if (!categoryResult.ok) {
        errors.push(`Tentativa Especial ${attemptNumber}: ${categoryResult.error}`);
        return { errors, attempt: null, option: null };
    }

    const category = categoryResult.category;
    const selectedIsBlank = isBlankChoice(selectedValue);

    if (!category && selectedIsBlank) {
        return { errors, attempt: null, option: null };
    }

    if (!category && !selectedIsBlank) {
        errors.push(`Tentativa Especial ${attemptNumber}: escolha uma categoria antes de preencher opcao rara/anomalia.`);
        return { errors, attempt: null, option: null };
    }

    const meta = ATTEMPT_CATEGORIES[category];
    const option = resolveOption(meta.listName, selectedValue);
    if (!option) {
        const suggestions = suggestOptions(meta.listName, selectedValue);
        errors.push(`Tentativa Especial ${attemptNumber}: ${meta.label} informada nao existe na lista.${suggestions.length ? ` Opcoes proximas: ${suggestions.join(', ')}.` : ''}`);
        return { errors, attempt: null, option: null };
    }

    const existing = await getAttemptByNumber(db, playerId, attemptNumber);
    if (existing && existing.category !== category) {
        errors.push(`Tentativa Especial ${attemptNumber}: ja foi usada em ${ATTEMPT_CATEGORIES[existing.category]?.label || existing.category}.`);
        return { errors, attempt: existing, option: null };
    }

    const override = existing
        ? null
        : await consumeAttemptOverride(db, playerId, attemptNumber, category);
    const attempt = existing || await saveAttempt(
        db,
        playerId,
        attemptNumber,
        category,
        (override ?? rollAttempt(category, attemptNumber, options)) ? 'success' : 'failure',
        option.key
    );

    if (attempt.result !== 'success') {
        errors.push(`Tentativa Especial ${attemptNumber}: o sorteio de ${meta.label} falhou. Remova essa escolha da ficha.`);
        return { errors, attempt, option: null };
    }

    if (attempt.chosen_key !== option.key) {
        await saveAttempt(db, playerId, attemptNumber, category, attempt.result, option.key);
        attempt.chosen_key = option.key;
    }

    return { errors, attempt, option };
}

async function validateTraitSubmission(db, playerId, fields, options = {}) {
    const errors = [];
    const attempts = await getAttemptsForPlayer(db, playerId);
    const successfulByCategory = {
        rare_aptitude: attempts.find((attempt) => attempt.category === 'rare_aptitude' && attempt.result === 'success') || null,
        rare_mark: attempts.find((attempt) => attempt.category === 'rare_mark' && attempt.result === 'success') || null,
        anomaly: attempts.find((attempt) => attempt.category === 'anomaly' && attempt.result === 'success') || null,
    };

    for (const attemptNumber of [1, 2]) {
        const rawCategory = fields[`tentativa_especial_${attemptNumber}`];
        const directCategory = resolveAttemptCategory(rawCategory);
        const selectedValue = directCategory.category
            ? fields[ATTEMPT_CATEGORIES[directCategory.category].fieldName]
            : null;

        const result = await processSpecialAttempt(
            db,
            playerId,
            attemptNumber,
            rawCategory,
            selectedValue,
            options
        );

        errors.push(...result.errors);
        if (result.attempt && !attempts.some((attempt) => Number(attempt.attempt_number) === Number(result.attempt.attempt_number))) {
            attempts.push(result.attempt);
        }
        if (directCategory.category && result.attempt?.result === 'success') {
            successfulByCategory[directCategory.category] = result.attempt;
        }
    }

    let commonAptitude = resolveOption('commonAptitudes', fields.aptidao_comum);
    let rareAptitude = null;
    const aptitudeAsRare = resolveOption('rareAptitudes', fields.aptidao_comum);
    const explicitRareAptitude = resolveOption('rareAptitudes', fields.aptidao_rara);

    if (!commonAptitude && aptitudeAsRare) {
        const bound = await bindAttemptChoice(db, playerId, 'rare_aptitude', aptitudeAsRare);
        if (bound.ok) {
            rareAptitude = aptitudeAsRare;
        } else if (bound.reason === 'choice_locked') {
            errors.push('Aptidao rara ja foi vinculada a outra escolha de tentativa especial.');
        } else {
            errors.push('Aptidao rara so pode ser usada se uma tentativa especial de Aptidao passou.');
        }
    } else if (!commonAptitude) {
        const suggestions = suggestOptions('commonAptitudes', fields.aptidao_comum);
        errors.push(`Aptidao invalida ou nao informada.${suggestions.length ? ` Opcoes proximas: ${suggestions.join(', ')}.` : ''}`);
    }

    if (!isBlankChoice(fields.aptidao_rara)) {
        if (!explicitRareAptitude) {
            const suggestions = suggestOptions('rareAptitudes', fields.aptidao_rara);
            errors.push(`Aptidao rara informada nao existe na lista.${suggestions.length ? ` Opcoes proximas: ${suggestions.join(', ')}.` : ''}`);
        } else {
            const bound = await bindAttemptChoice(db, playerId, 'rare_aptitude', explicitRareAptitude);
            if (bound.ok) {
                rareAptitude = explicitRareAptitude;
            } else if (bound.reason === 'choice_locked') {
                errors.push('Aptidao rara ja foi vinculada a outra escolha de tentativa especial.');
            } else {
                errors.push('Aptidao rara so pode ficar na ficha se uma tentativa especial de Aptidao Rara passou.');
            }
        }
    }

    let commonMark = resolveOption('commonMarks', fields.marca_comum);
    let rareMark = null;
    const markAsRare = resolveOption('rareMarks', fields.marca_comum);
    const explicitRareMark = resolveOption('rareMarks', fields.marca_rara);

    if (!commonMark && markAsRare) {
        const bound = await bindAttemptChoice(db, playerId, 'rare_mark', markAsRare);
        if (bound.ok) {
            rareMark = markAsRare;
        } else if (bound.reason === 'choice_locked') {
            errors.push('Marca rara ja foi vinculada a outra escolha de tentativa especial.');
        } else {
            errors.push('Marca rara so pode ser usada se uma tentativa especial de Marca passou.');
        }
    } else if (!commonMark) {
        const suggestions = suggestOptions('commonMarks', fields.marca_comum);
        errors.push(`Marca invalida ou nao informada.${suggestions.length ? ` Opcoes proximas: ${suggestions.join(', ')}.` : ''}`);
    }

    if (!isBlankChoice(fields.marca_rara)) {
        if (!explicitRareMark) {
            const suggestions = suggestOptions('rareMarks', fields.marca_rara);
            errors.push(`Marca rara informada nao existe na lista.${suggestions.length ? ` Opcoes proximas: ${suggestions.join(', ')}.` : ''}`);
        } else {
            const bound = await bindAttemptChoice(db, playerId, 'rare_mark', explicitRareMark);
            if (bound.ok) {
                rareMark = explicitRareMark;
            } else if (bound.reason === 'choice_locked') {
                errors.push('Marca rara ja foi vinculada a outra escolha de tentativa especial.');
            } else {
                errors.push('Marca rara so pode ficar na ficha se uma tentativa especial de Marca Rara passou.');
            }
        }
    }

    let anomaly = null;
    if (!isBlankChoice(fields.anomalia)) {
        const anomalyOption = resolveOption('anomalies', fields.anomalia);
        if (!anomalyOption) {
            const suggestions = suggestOptions('anomalies', fields.anomalia);
            errors.push(`Anomalia informada nao existe na lista.${suggestions.length ? ` Opcoes proximas: ${suggestions.join(', ')}.` : ''}`);
        } else {
            const bound = await bindAttemptChoice(db, playerId, 'anomaly', anomalyOption);
            if (bound.ok) {
                anomaly = anomalyOption;
            } else if (bound.reason === 'choice_locked') {
                errors.push('Anomalia ja foi vinculada a outra escolha de tentativa especial.');
            } else {
                errors.push('Anomalia so pode ficar na ficha se uma tentativa especial de Anomalia passou.');
            }
        }
    }

    return {
        ok: errors.length === 0,
        errors,
        payload: {
            commonAptitude,
            commonMark,
            rareAptitude,
            rareMark,
            anomaly,
            attempts,
        },
    };
}

function getTraitOptionByKey(listName, optionKey) {
    if (!optionKey) return null;
    return getConfigOption(listName, optionKey);
}

module.exports = {
    ATTEMPT_CATEGORIES,
    getAttemptsForPlayer,
    getTraitOptionByKey,
    isBlankChoice,
    resolveOption,
    rollbackSpecialAttempt,
    runSpecialAttempt,
    validateTraitSubmission,
};
