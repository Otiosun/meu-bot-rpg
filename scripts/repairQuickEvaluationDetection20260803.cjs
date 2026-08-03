'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'helpers', 'clover', 'quickEvaluationService.js');
const BACKUP_DIR = path.join(ROOT, 'backups');
const CONFIRMATION = 'CORRIGIR-DETECCAO-AVALIACAO-2026-08-03';
const DETECTION_MARKER = 'const structuralFieldHits = [';
const TRACE_MARKER = "console.log('[quick-eval] ficha detectada:'";
const MODULE_MARKER = "console.log('[quick-eval] modulo ativo:'";

function parseArgs(argv) {
    const apply = argv.includes('--apply');
    const confirmation = argv.find((arg) => arg.startsWith('--confirm='))?.slice('--confirm='.length) || '';
    if (apply && confirmation !== CONFIRMATION) {
        throw new Error(`Aplicacao bloqueada. Use --apply --confirm=${CONFIRMATION}`);
    }
    return { apply };
}

function stamp() {
    return new Date().toISOString().replace(/[-:T]/g, '').replace(/\.\d{3}Z$/, '');
}

function normalizeLf(text) {
    return String(text || '').replace(/\r\n/g, '\n');
}

function restoreEol(text, crlf) {
    return crlf ? text.replace(/\n/g, '\r\n') : text;
}

function replaceFunction(text, functionName, nextFunctionName, replacement) {
    const startNeedle = `function ${functionName}(`;
    const start = text.indexOf(startNeedle);
    if (start < 0) throw new Error(`Nao encontrei ${functionName}.`);
    const nextNeedle = `\nfunction ${nextFunctionName}(`;
    const end = text.indexOf(nextNeedle, start);
    if (end < 0) throw new Error(`Nao encontrei o fim de ${functionName}.`);
    return text.slice(0, start) + replacement + text.slice(end);
}

function replaceAsyncFunctionBeforeExports(text, functionName, replacement) {
    const startNeedle = `async function ${functionName}(`;
    const start = text.indexOf(startNeedle);
    if (start < 0) throw new Error(`Nao encontrei ${functionName}.`);
    const end = text.indexOf('\nmodule.exports = {', start);
    if (end < 0) throw new Error(`Nao encontrei o fim de ${functionName}.`);
    return text.slice(0, start) + replacement + text.slice(end);
}

function buildDetectionFunction() {
    return `function looksLikeQuickEvaluation(text) {
    const normalized = compactNormalized(text);
    if (!normalized) return false;

    const padded = \` \${normalized} \`;
    const hasTerm = (term) => padded.includes(\` \${term} \`);
    const hasTitle = normalized.includes('ficha de avaliacao')
        || normalized.includes('ficha de avalia');
    const structuralFieldHits = [
        hasTerm('pessoa'),
        hasTerm('ph'),
        hasTerm('yulls') || hasTerm('yull') || hasTerm('dinheiro'),
        hasTerm('estrelas') || hasTerm('estrela'),
        hasTerm('inventario') || hasTerm('itens') || hasTerm('item'),
        normalized.includes('tipo de treino') || hasTerm('modalidade'),
        normalized.includes('conta para salario'),
        normalized.includes('data da cena') || normalized.includes('cena enviada em'),
    ].filter(Boolean).length;
    const hasModality = MODALITIES.some((modality) => (
        modality.aliases.some((alias) => normalized.includes(compactNormalized(alias)))
    ));
    const hasRewardField = hasTerm('ph')
        || hasTerm('yulls')
        || hasTerm('yull')
        || hasTerm('dinheiro')
        || hasTerm('estrelas')
        || hasTerm('estrela')
        || hasTerm('inventario')
        || hasTerm('itens')
        || hasTerm('item');

    return (hasTitle && structuralFieldHits >= 3)
        || (structuralFieldHits >= 4 && hasModality && hasRewardField);
}`;
}

function buildHandlerFunction() {
    return `async function tryHandleQuickEvaluation({ sock, db, m, idChat, evaluatorId, text }) {
    if (!looksLikeQuickEvaluation(text)) return false;

    const trace = {
        chatId: idChat,
        evaluatorId,
        messageId: m?.key?.id || null,
        length: String(text || '').length,
    };
    console.log('[quick-eval] ficha detectada:', trace);

    if (!idChat?.endsWith('@g.us')) {
        console.log('[quick-eval] ignorada: fora de grupo', trace);
        return false;
    }
    if (!await isConfiguredCloverGroup(db, 'on', idChat)) {
        console.log('[quick-eval] ignorada: grupo nao configurado como ON', trace);
        return false;
    }

    const permission = await canUseQuickEvaluation({ sock, db, idChat, evaluatorId });
    if (!permission.ok) {
        console.log('[quick-eval] rejeitada por permissao:', { ...trace, error: permission.error });
        await sendReply({ sock, idChat, m, text: renderQuickEvaluationError(permission.error) });
        return true;
    }

    const parsed = parseEvaluation(text);
    if (!parsed.ok) {
        console.log('[quick-eval] rejeitada pelo parser:', { ...trace, error: parsed.error });
        await sendReply({ sock, idChat, m, text: renderQuickEvaluationError(parsed.error) });
        return true;
    }

    const target = await resolveTargetPlayer(db, m, parsed.data.person);
    if (!target.ok) {
        console.log('[quick-eval] rejeitada por alvo:', { ...trace, error: target.error });
        await sendReply({ sock, idChat, m, text: renderQuickEvaluationError(target.error) });
        return true;
    }

    try {
        const dataWithBonuses = applyAutomaticEvaluationBonuses(target.player, parsed.data);
        const result = await applyQuickEvaluation({
            db,
            m,
            idChat,
            evaluatorId,
            data: dataWithBonuses,
            player: target.player,
        });

        if (!result.ok) {
            console.log('[quick-eval] rejeitada na aplicacao:', { ...trace, error: result.error });
            await sendReply({ sock, idChat, m, text: renderQuickEvaluationError(result.error) });
            return true;
        }

        if (result.squadAfter?.squad_key) {
            result.squadSync = await syncSquadGroupDescription({
                sock,
                db,
                squadKey: result.squadAfter.squad_key,
            });
        }

        console.log('[quick-eval] aplicada no banco:', {
            ...trace,
            playerId: result.player?.id || null,
            playerName: getPlayerName(result.player),
            modality: result.data?.modality?.key || null,
            ph: Number(result.data?.ph || 0),
            weeklyAfter: Number(result.weeklyAfter || 0),
        });

        const receipt = await sendReply({
            sock,
            idChat,
            m,
            text: renderQuickEvaluationSuccess(result),
            mentions: [result.player.id],
        });
        console.log('[quick-eval] recibo processado:', {
            ...trace,
            playerId: result.player?.id || null,
            messageId: receipt?.key?.id || null,
            skipped: receipt?.skipped === true,
            reason: receipt?.reason || null,
        });

        await sendReaction({ sock, idChat, m, emoji: '✅' }).catch(() => null);
        const quotedKey = getQuotedMessageKey(m, idChat);
        if (quotedKey) {
            await sendReactionToKey({ sock, idChat, key: quotedKey, emoji: '✅' }).catch(() => null);
        }
        const returnBonusText = renderReturnBonusResult(result.returnBonus);
        if (returnBonusText) {
            await sendReply({ sock, idChat, m, text: returnBonusText });
        }
        const adjustmentText = renderQuickEvaluationAdjustmentNotice(result);
        if (adjustmentText) {
            await sendReply({ sock, idChat, m, text: adjustmentText });
        }
        const recruitmentText = renderRecruitmentValidation(result.recruitmentResult, result.player);
        if (recruitmentText) {
            await sendReply({
                sock,
                idChat,
                m,
                text: recruitmentText,
                mentions: [
                    result.player.id,
                    result.recruitmentResult.referral?.recruiter_player_id,
                ].filter(Boolean),
            });
        }
        return true;
    } catch (error) {
        console.error('[quick-eval] erro apos deteccao:', {
            ...trace,
            error: error?.stack || error?.message || error,
        });
        await sendReply({
            sock,
            idChat,
            m,
            text: renderQuickEvaluationError('Não consegui aplicar a avaliação agora. Nenhuma recompensa foi lançada.'),
        });
        return true;
    }
}`;
}

function patchSource(original) {
    const usesCrLf = original.includes('\r\n');
    let text = normalizeLf(original);
    let changed = false;

    if (!text.includes(DETECTION_MARKER)) {
        text = replaceFunction(text, 'looksLikeQuickEvaluation', 'getCleanText', buildDetectionFunction());
        changed = true;
    }

    if (!text.includes(TRACE_MARKER)) {
        text = replaceAsyncFunctionBeforeExports(text, 'tryHandleQuickEvaluation', buildHandlerFunction());
        changed = true;
    }

    if (!text.includes(MODULE_MARKER)) {
        const insertionPoint = text.indexOf('const WEEKLY_COMMON_PH_LIMIT');
        if (insertionPoint < 0) throw new Error('Nao encontrei o ponto de log do modulo.');
        text = text.slice(0, insertionPoint)
            + "console.log('[quick-eval] modulo ativo:', __filename);\n\n"
            + text.slice(insertionPoint);
        changed = true;
    }

    if (!text.includes('text: renderQuickEvaluationSuccess(result),')) {
        throw new Error('O recibo de avaliacao nao esta instalado. Rode o reparo anterior primeiro.');
    }

    return { text: restoreEol(text, usesCrLf), changed };
}

function syntaxCheck(filePath) {
    const result = spawnSync(process.execPath, ['--check', filePath], {
        cwd: ROOT,
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
    });
    if (result.error || result.status !== 0) {
        throw new Error(result.error?.message || result.stderr || result.stdout || 'Erro de sintaxe desconhecido.');
    }
}

function main() {
    const { apply } = parseArgs(process.argv.slice(2));
    if (!fs.existsSync(TARGET)) throw new Error(`Arquivo nao encontrado: ${TARGET}`);

    const original = fs.readFileSync(TARGET, 'utf8');
    const patched = patchSource(original);

    console.log('='.repeat(72));
    console.log('CORRECAO DA DETECCAO DE AVALIACOES');
    console.log('='.repeat(72));
    console.log(`Detector estrutural: ${patched.changed ? 'sera instalado' : 'ja instalado'}`);
    console.log('Logs adicionados: modulo ativo, detectada, rejeitada, aplicada e recibo.');
    console.log('Recibo completo existente: sim');

    if (!apply) {
        console.log('PREVIEW CONCLUIDO. Nenhuma alteracao foi realizada.');
        console.log('='.repeat(72));
        return;
    }

    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const backup = path.join(BACKUP_DIR, `quickEvaluationService.before-detection-${stamp()}.js`);
    fs.copyFileSync(TARGET, backup);
    fs.writeFileSync(TARGET, patched.text, 'utf8');

    try {
        syntaxCheck(TARGET);
    } catch (error) {
        fs.copyFileSync(backup, TARGET);
        throw error;
    }

    console.log(`Backup: ${backup}`);
    console.log('APLICACAO CONCLUIDA. Reinicie clover-rpg.');
    console.log('='.repeat(72));
}

try {
    main();
} catch (error) {
    console.error('\nFALHA NA CORRECAO DA DETECCAO:');
    console.error(error?.stack || error);
    process.exitCode = 1;
}
