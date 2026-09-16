const { COMMAND_PREFIX, MAX_PLAYER_ROLLS } = require('../../config/bot');
const { normalizeCommandText, normalizeText } = require('../textUtils');
const { isPreResetTransitionEnabled } = require('./preResetTransitionService');
const { getAssignedPreResetState } = require('./preResetRosterStateService');

const { getCanonicalPlayerPlayability } = require('./playerPlayabilityService');

const PHASES = {
    NOVO: 'novo', PRE_ROLL: 'pre_roll', ROLLS_EM_ANDAMENTO: 'rolls_em_andamento', ROLLS_CONCLUIDOS: 'rolls_concluidos',
    ROLL_ESCOLHIDO: 'roll_escolhido', MAGIA_PENDENTE: 'magia_pendente', MAGIA_ESCOLHIDA: 'magia_escolhida',
    FICHA_PENDENTE_CONFIRMACAO: 'ficha_pendente_confirmacao', FICHA_CONFIRMADA: 'ficha_confirmada',
    APARENCIA_PENDENTE: 'aparencia_pendente', APARENCIA_REJEITADA: 'aparencia_rejeitada', APARENCIA_APROVADA: 'aparencia_aprovada',
    HISTORIA_PENDENTE: 'historia_pendente', HISTORIA_APROVADA: 'historia_aprovada', JOGO_LIBERADO: 'jogo_liberado',
    ARCHIVED: 'archived', RESET_DEFERRED: 'reset_deferred', PRE_RESET_DECISION: 'pre_reset_decision', PRE_RESET_BUILD: 'pre_reset_build', PRE_RESET_WAIT: 'pre_reset_wait',
};

const GAME_COMMANDS = new Set([
    `${COMMAND_PREFIX}perfil`, `${COMMAND_PREFIX}bonus`, `${COMMAND_PREFIX}bônus`, `${COMMAND_PREFIX}beneficios`, `${COMMAND_PREFIX}benefícios`,
    `${COMMAND_PREFIX}fisico`, `${COMMAND_PREFIX}físico`, `${COMMAND_PREFIX}atributos`, `${COMMAND_PREFIX}atributo`,
    `${COMMAND_PREFIX}confirmaratributos`, `${COMMAND_PREFIX}cancelaratributos`, `${COMMAND_PREFIX}ph`, `${COMMAND_PREFIX}pb`,
    `${COMMAND_PREFIX}hexagono`, `${COMMAND_PREFIX}hexágono`, `${COMMAND_PREFIX}confirmarhexagono`, `${COMMAND_PREFIX}confirmarhexágono`,
    `${COMMAND_PREFIX}cancelarhexagono`, `${COMMAND_PREFIX}cancelarhexágono`, `${COMMAND_PREFIX}arvore`, `${COMMAND_PREFIX}árvore`,
    `${COMMAND_PREFIX}arvores`, `${COMMAND_PREFIX}árvores`, `${COMMAND_PREFIX}rota`, `${COMMAND_PREFIX}no`, `${COMMAND_PREFIX}nó`,
    `${COMMAND_PREFIX}comprar`, `${COMMAND_PREFIX}confirmarcompra`, `${COMMAND_PREFIX}cancelarcompra`, `${COMMAND_PREFIX}missao`, `${COMMAND_PREFIX}missão`,
    `${COMMAND_PREFIX}missoes`, `${COMMAND_PREFIX}missões`, `${COMMAND_PREFIX}evolucao`, `${COMMAND_PREFIX}evolução`, `${COMMAND_PREFIX}escala`,
    `${COMMAND_PREFIX}esquadrao`, `${COMMAND_PREFIX}esquadrão`, `${COMMAND_PREFIX}estrelas`, `${COMMAND_PREFIX}inventario`, `${COMMAND_PREFIX}inventário`,
    `${COMMAND_PREFIX}inv`, `${COMMAND_PREFIX}carteira`, `${COMMAND_PREFIX}cavaleiro`, `${COMMAND_PREFIX}prestigio`, `${COMMAND_PREFIX}prestígio`,
    `${COMMAND_PREFIX}patente`, `${COMMAND_PREFIX}patentes`, `${COMMAND_PREFIX}mana`,
].map((value) => normalizeCommandText(value)));

const RECEPTION_COMMANDS = [
    `${COMMAND_PREFIX}start`, `${COMMAND_PREFIX}historia`, `${COMMAND_PREFIX}história`, `${COMMAND_PREFIX}sortear`, `${COMMAND_PREFIX}rolls`,
    `${COMMAND_PREFIX}sacrificar`, `${COMMAND_PREFIX}ficha`, `${COMMAND_PREFIX}magias`, `${COMMAND_PREFIX}cancelarmagia`, `${COMMAND_PREFIX}familias`,
    `${COMMAND_PREFIX}tracos`, `${COMMAND_PREFIX}reinos`, `${COMMAND_PREFIX}racas`, `${COMMAND_PREFIX}classes`, `${COMMAND_PREFIX}grimorios`,
    `${COMMAND_PREFIX}continuar`, `${COMMAND_PREFIX}status`, `${COMMAND_PREFIX}ajuda`, `${COMMAND_PREFIX}ping`,
];

const FICHA_PENDING_COMMANDS = [
    `${COMMAND_PREFIX}confirmarFicha`, `${COMMAND_PREFIX}cancelarFicha`, `${COMMAND_PREFIX}magias`, `${COMMAND_PREFIX}cancelarmagia`, `${COMMAND_PREFIX}aparencia`,
    `${COMMAND_PREFIX}historia`, `${COMMAND_PREFIX}história`, `${COMMAND_PREFIX}continuar`, `${COMMAND_PREFIX}status`, `${COMMAND_PREFIX}ajuda`, `${COMMAND_PREFIX}ping`,
];

const APPEARANCE_COMMANDS = [
    `${COMMAND_PREFIX}aparencia`, `${COMMAND_PREFIX}historia`, `${COMMAND_PREFIX}história`, `${COMMAND_PREFIX}status`, `${COMMAND_PREFIX}continuar`,
    `${COMMAND_PREFIX}ajuda`, `${COMMAND_PREFIX}ping`, `${COMMAND_PREFIX}grupooff`, `${COMMAND_PREFIX}linkoff`, `${COMMAND_PREFIX}reinos`, `${COMMAND_PREFIX}racas`,
    `${COMMAND_PREFIX}classes`, `${COMMAND_PREFIX}grimorios`, `${COMMAND_PREFIX}familias`, `${COMMAND_PREFIX}tracos`,
];

const STORY_PENDING_COMMANDS = [
    `${COMMAND_PREFIX}historia`, `${COMMAND_PREFIX}história`, `${COMMAND_PREFIX}status`, `${COMMAND_PREFIX}continuar`, `${COMMAND_PREFIX}ajuda`,
    `${COMMAND_PREFIX}ping`, `${COMMAND_PREFIX}grupooff`, `${COMMAND_PREFIX}linkoff`,
];

const GAME_ALLOWED_COMMANDS = [
    `${COMMAND_PREFIX}perfil`, `${COMMAND_PREFIX}bonus`, `${COMMAND_PREFIX}bônus`, `${COMMAND_PREFIX}beneficios`, `${COMMAND_PREFIX}benefícios`,
    `${COMMAND_PREFIX}atributos`, `${COMMAND_PREFIX}confirmaratributos`, `${COMMAND_PREFIX}cancelaratributos`, `${COMMAND_PREFIX}ph`,
    `${COMMAND_PREFIX}inventario`, `${COMMAND_PREFIX}inventário`, `${COMMAND_PREFIX}inv`, `${COMMAND_PREFIX}carteira`, `${COMMAND_PREFIX}cavaleiro`,
    `${COMMAND_PREFIX}hexagono`, `${COMMAND_PREFIX}hexágono`, `${COMMAND_PREFIX}confirmarhexagono`, `${COMMAND_PREFIX}confirmarhexágono`,
    `${COMMAND_PREFIX}cancelarhexagono`, `${COMMAND_PREFIX}cancelarhexágono`, `${COMMAND_PREFIX}escala`, `${COMMAND_PREFIX}evolucao`, `${COMMAND_PREFIX}evolução`,
    `${COMMAND_PREFIX}arvores`, `${COMMAND_PREFIX}árvores`, `${COMMAND_PREFIX}arvore`, `${COMMAND_PREFIX}árvore`, `${COMMAND_PREFIX}rota`, `${COMMAND_PREFIX}no`,
    `${COMMAND_PREFIX}nó`, `${COMMAND_PREFIX}comprar`, `${COMMAND_PREFIX}confirmarcompra`, `${COMMAND_PREFIX}cancelarcompra`, `${COMMAND_PREFIX}status`,
    `${COMMAND_PREFIX}continuar`, `${COMMAND_PREFIX}ajuda`, `${COMMAND_PREFIX}ping`, `${COMMAND_PREFIX}reinos`, `${COMMAND_PREFIX}racas`, `${COMMAND_PREFIX}raças`,
    `${COMMAND_PREFIX}classes`, `${COMMAND_PREFIX}classessociais`, `${COMMAND_PREFIX}classes sociais`, `${COMMAND_PREFIX}familias`, `${COMMAND_PREFIX}famílias`,
    `${COMMAND_PREFIX}grimorios`, `${COMMAND_PREFIX}grimórios`, `${COMMAND_PREFIX}tracos`, `${COMMAND_PREFIX}traços`,
];

const PRE_RESET_BASE_COMMANDS = [
    `${COMMAND_PREFIX}retorno`, `${COMMAND_PREFIX}return`, `${COMMAND_PREFIX}pr`, `${COMMAND_PREFIX}pontosretorno`, `${COMMAND_PREFIX}pontos retorno`,
    `${COMMAND_PREFIX}lojaretorno`, `${COMMAND_PREFIX}itemretorno`,
    `${COMMAND_PREFIX}status`, `${COMMAND_PREFIX}continuar`, `${COMMAND_PREFIX}ajuda`, `${COMMAND_PREFIX}ping`,
];
const PRE_RESET_BUILD_COMMANDS = [
    ...PRE_RESET_BASE_COMMANDS,
    `${COMMAND_PREFIX}sortear`, `${COMMAND_PREFIX}rolls`, `${COMMAND_PREFIX}sorteios`, `${COMMAND_PREFIX}sacrificar`,
    `${COMMAND_PREFIX}tentativa`,
    `${COMMAND_PREFIX}ficha`, `${COMMAND_PREFIX}ficha nova`,
    `${COMMAND_PREFIX}magia`, `${COMMAND_PREFIX}magias`, `${COMMAND_PREFIX}cancelarmagia`, `${COMMAND_PREFIX}cancelar magia`,
    `${COMMAND_PREFIX}familias`, `${COMMAND_PREFIX}famílias`,
    `${COMMAND_PREFIX}tracos`, `${COMMAND_PREFIX}traços`,
    `${COMMAND_PREFIX}reinos`,
    `${COMMAND_PREFIX}racas`, `${COMMAND_PREFIX}raças`,
    `${COMMAND_PREFIX}classes`, `${COMMAND_PREFIX}classessociais`, `${COMMAND_PREFIX}classes sociais`,
    `${COMMAND_PREFIX}grimorios`, `${COMMAND_PREFIX}grimórios`,
];
const RESET_DEFERRED_COMMANDS = PRE_RESET_BUILD_COMMANDS.filter(command => ![
    'sortear','sacrificar','retorno','return','pr','pontosretorno','pontos retorno','lojaretorno','itemretorno'
].some(name=>normalizeCommandText(command) === normalizeCommandText(COMMAND_PREFIX+name)));
const RESET_DEFERRED_COMMAND_SET = new Set(RESET_DEFERRED_COMMANDS.map(normalizeCommandText));
const PRE_RESET_WAIT_COMMANDS = [...PRE_RESET_BASE_COMMANDS];
const PRE_RESET_DECISION_COMMANDS = [...PRE_RESET_BASE_COMMANDS];
const PRE_RESET_ALLOWED_COMMANDS = [...new Set([...PRE_RESET_BUILD_COMMANDS, ...PRE_RESET_BASE_COMMANDS])];
const PRE_RESET_BUILD_COMMAND_SET = new Set(PRE_RESET_BUILD_COMMANDS.map((value) => normalizeCommandText(value)));
const PRE_RESET_WAIT_COMMAND_SET = new Set(PRE_RESET_WAIT_COMMANDS.map((value) => normalizeCommandText(value)));
const PRE_RESET_DECISION_COMMAND_SET = new Set(PRE_RESET_DECISION_COMMANDS.map((value) => normalizeCommandText(value)));
const PRE_RESET_PHASES = new Set([PHASES.PRE_RESET_DECISION, PHASES.PRE_RESET_BUILD, PHASES.PRE_RESET_WAIT]);

const POST_FICHA_RECEPTION_BLOCKED_COMMANDS = new Set([
    `${COMMAND_PREFIX}start`, `${COMMAND_PREFIX}iniciar`, `${COMMAND_PREFIX}comecar`, `${COMMAND_PREFIX}começar`, `${COMMAND_PREFIX}comeco`, `${COMMAND_PREFIX}começo`,
    `${COMMAND_PREFIX}sortear`, `${COMMAND_PREFIX}rolls`, `${COMMAND_PREFIX}sorteios`, `${COMMAND_PREFIX}sacrificar`, `${COMMAND_PREFIX}sacrificio`,
    `${COMMAND_PREFIX}sacrificarroll`, `${COMMAND_PREFIX}sacrificar roll`, `${COMMAND_PREFIX}ficha`, `${COMMAND_PREFIX}ficha pessoal`, `${COMMAND_PREFIX}fichapessoal`,
    `${COMMAND_PREFIX}magia`, `${COMMAND_PREFIX}magias`, `${COMMAND_PREFIX}escolher magia`, `${COMMAND_PREFIX}escolhermagia`, `${COMMAND_PREFIX}cancelarmagia`,
    `${COMMAND_PREFIX}cancelar magia`, `${COMMAND_PREFIX}confirmar`, `${COMMAND_PREFIX}confirmar ficha`, `${COMMAND_PREFIX}confirmarficha`, `${COMMAND_PREFIX}cancelar`,
    `${COMMAND_PREFIX}cancelar ficha`, `${COMMAND_PREFIX}cancelarficha`,
].map((value) => normalizeCommandText(value)));

function normalizeStatus(value) { return normalizeText(value || ''); }
function normalizeCommandName(value) { return normalizeCommandText(value || ''); }
function hasMagic(player) { return Boolean(player?.magia && player.magia !== '-'); }
function isFichaApproved(player) { return normalizeStatus(player?.ficha_status) === 'aprovada'; }
function isAppearanceApproved(player) { return ['approved', 'aprovada'].includes(normalizeStatus(player?.personagem_aparencia_status)); }
function isAppearanceRejected(player) { return ['rejected', 'negada', 'reprovada'].includes(normalizeStatus(player?.personagem_aparencia_status)); }
function isHistoriaApproved(player) { return ['aprovada', 'approved'].includes(normalizeStatus(player?.historia_status)); }
function isHistoriaRejected(player) { return ['negada', 'rejeitada', 'reprovada', 'rejected'].includes(normalizeStatus(player?.historia_status)); }
function isGameLiberated(player) { return isFichaApproved(player) && !isHistoriaRejected(player) && normalizeStatus(player?.jogo_status) === 'liberado'; }

async function countPlayerRolls(db, playerId) {
    const row = await db.get('SELECT COUNT(*) AS total FROM player_rolls WHERE player_id = ?', [playerId]);
    return Number(row?.total || 0);
}
async function countFutureRolls(db, playerId) {
    const row = await db.get('SELECT COUNT(*) AS total FROM clover_prereset_future_rolls WHERE player_id = ?', [String(playerId)]);
    return Number(row?.total || 0);
}
async function hasPendingProfile(db, playerId) {
    const row = await db.get('SELECT 1 AS pending FROM pending_profile_confirmations WHERE player_id = ? LIMIT 1', [playerId]);
    return Boolean(row);
}
async function hasPendingMagic(db, playerId) {
    const row = await db.get('SELECT 1 AS pending FROM pending_magic_confirmations WHERE player_id = ? LIMIT 1', [playerId]);
    return Boolean(row);
}

function resolveApprovedBasePhase(player) {
    if (isGameLiberated(player)) return PHASES.JOGO_LIBERADO;
    if (isAppearanceRejected(player)) return PHASES.APARENCIA_REJEITADA;
    if (!isAppearanceApproved(player)) return PHASES.APARENCIA_PENDENTE;
    if (isHistoriaApproved(player)) return PHASES.HISTORIA_APROVADA;
    return PHASES.HISTORIA_PENDENTE;
}

function resolvePreResetPhase(assignedState) {
    if (assignedState?.kind === 'keep') return PHASES.PRE_RESET_WAIT;
    if (assignedState?.kind === 'reset' || assignedState?.kind === 'new_player') return PHASES.PRE_RESET_BUILD;
    return PHASES.PRE_RESET_DECISION;
}

async function getPlayerPhase(db, playerId, { env = process.env } = {}) {
    const playability = await getCanonicalPlayerPlayability(db, playerId);
    const player = playability.player;
    const onboarding = await db.get('SELECT * FROM player_onboarding WHERE player_id = ?', [playerId]);

    if (playability.reason === 'archived') {
        return {phase:PHASES.ARCHIVED,player,onboarding,rollCount:0,pendingProfile:false,pendingMagic:false,
            transitionState:null,futureCharacter:null,canPlay:false,reason:'archived',playability,
            allowedCommands:getAllowedCommandsForPhase(PHASES.ARCHIVED)};
    }

    if (playability.reason === 'future_character_pending') {
        return {phase:PHASES.RESET_DEFERRED,player,onboarding,rollCount:await countFutureRolls(db,playerId),
            pendingProfile:false,pendingMagic:false,transitionState:{kind:'reset',deferred:true},
            futureCharacter:await db.get('SELECT status,revision,draft_json FROM clover_prereset_characters WHERE player_id=?',[String(playerId)]),
            canPlay:false,reason:'future_character_pending',playability,allowedCommands:getAllowedCommandsForPhase(PHASES.RESET_DEFERRED)};
    }

    if (playability.playable) {
        return {phase:PHASES.JOGO_LIBERADO,player,onboarding,rollCount:0,pendingProfile:false,pendingMagic:false,
            transitionState:null,futureCharacter:null,canPlay:true,reason:'launch_completed',playability,
            allowedCommands:getAllowedCommandsForPhase(PHASES.JOGO_LIBERADO)};
    }

    if (isPreResetTransitionEnabled(env)) {
        const transitionState = await getAssignedPreResetState(db, playerId);
        const phase = resolvePreResetPhase(transitionState);
        const rollCount = phase === PHASES.PRE_RESET_BUILD ? await countFutureRolls(db, playerId) : 0;
        const futureCharacter = phase === PHASES.PRE_RESET_BUILD
            ? await db.get('SELECT status,revision,draft_json FROM clover_prereset_characters WHERE player_id=?', [String(playerId)])
            : null;
        return {
            phase,
            player,
            onboarding,
            rollCount,
            pendingProfile:false,
            pendingMagic:false,
            transitionState,
            futureCharacter,
            canPlay:false,
            playability,
            allowedCommands:getAllowedCommandsForPhase(phase),
        };
    }

    const rollCount = player ? await countPlayerRolls(db, playerId) : 0;
    const pendingProfile = player ? await hasPendingProfile(db, playerId) : false;
    const pendingMagic = player ? await hasPendingMagic(db, playerId) : false;
    let phase = PHASES.NOVO;
    if (!player) phase = PHASES.NOVO;
    else if (isFichaApproved(player)) phase = resolveApprovedBasePhase(player);
    else if (pendingProfile) phase = PHASES.FICHA_PENDENTE_CONFIRMACAO;
    else if (pendingMagic) phase = PHASES.MAGIA_PENDENTE;
    else if (hasMagic(player)) phase = PHASES.MAGIA_ESCOLHIDA;
    else if (player.numero_roll_escolhido) phase = PHASES.ROLL_ESCOLHIDO;
    else if (rollCount >= MAX_PLAYER_ROLLS) phase = PHASES.ROLLS_CONCLUIDOS;
    else if (rollCount > 0) phase = PHASES.ROLLS_EM_ANDAMENTO;
    else if (onboarding) phase = PHASES.PRE_ROLL;

    return { phase, player, onboarding, rollCount, pendingProfile, pendingMagic, transitionState:null, futureCharacter:null,
        canPlay:phase === PHASES.JOGO_LIBERADO, playability, allowedCommands:getAllowedCommandsForPhase(phase) };
}

function isGameCommand(commandName) { return GAME_COMMANDS.has(normalizeCommandName(commandName)); }
function isPostFichaReceptionCommand(commandName) { return POST_FICHA_RECEPTION_BLOCKED_COMMANDS.has(normalizeCommandName(commandName)); }
function canUseCommandInPhase(commandName, phase, options = {}) {
    const lifecycleStatus = normalizeStatus(options.lifecycleStatus);
    const gameStatus = normalizeStatus(options.gameStatus);
    if (lifecycleStatus === 'archived' || gameStatus === 'arquivado') return false;
    const command = normalizeCommandName(commandName);
    if (phase === PHASES.RESET_DEFERRED) return RESET_DEFERRED_COMMAND_SET.has(command);
    if (phase === PHASES.PRE_RESET_BUILD) return PRE_RESET_BUILD_COMMAND_SET.has(command);
    if (phase === PHASES.PRE_RESET_WAIT) return PRE_RESET_WAIT_COMMAND_SET.has(command);
    if (phase === PHASES.PRE_RESET_DECISION) return PRE_RESET_DECISION_COMMAND_SET.has(command);
    if (!options.isGameCommand && !isGameCommand(commandName)) return true;
    return phase === PHASES.JOGO_LIBERADO;
}
function getAllowedCommandsForPhase(phase) {
    if (phase === PHASES.RESET_DEFERRED) return RESET_DEFERRED_COMMANDS;
    if (phase === PHASES.PRE_RESET_BUILD) return PRE_RESET_BUILD_COMMANDS;
    if (phase === PHASES.PRE_RESET_WAIT) return PRE_RESET_WAIT_COMMANDS;
    if (phase === PHASES.PRE_RESET_DECISION) return PRE_RESET_DECISION_COMMANDS;
    if (phase === PHASES.JOGO_LIBERADO) return GAME_ALLOWED_COMMANDS;
    if (phase === PHASES.HISTORIA_APROVADA || phase === PHASES.HISTORIA_PENDENTE) return STORY_PENDING_COMMANDS;
    if (phase === PHASES.APARENCIA_PENDENTE || phase === PHASES.APARENCIA_REJEITADA || phase === PHASES.APARENCIA_APROVADA) return APPEARANCE_COMMANDS;
    if (phase === PHASES.FICHA_PENDENTE_CONFIRMACAO || phase === PHASES.FICHA_CONFIRMADA) return FICHA_PENDING_COMMANDS;
    return RECEPTION_COMMANDS;
}
function renderGameBlockedMessage() {
    if (isPreResetTransitionEnabled(process.env)) {
        return ['♧┃𝐏𝐑𝐄_𝐑𝐄𝐒𝐄𝐓 ᛯ 𝐂𝐥𝐨𝐯𝐞𝐫', '', 'O jogo normal está congelado durante a transição para a nova fase.', '', `Use *${COMMAND_PREFIX}retorno* para ver sua situação e *${COMMAND_PREFIX}status* para ver o que já está liberado.`].join('\n');
    }
    return ['♧┃𝐀𝐂𝐄𝐒𝐒𝐎 𝐁𝐋𝐎𝐐𝐔𝐄𝐀𝐃𝐎 ᛯ 𝐂𝐥𝐨𝐯𝐞𝐫', '', 'Seu personagem ainda não foi liberado para o jogo.', '', `Use *${COMMAND_PREFIX}status* ou *${COMMAND_PREFIX}continuar* para ver o que falta.`].join('\n');
}

module.exports = {
    GAME_COMMANDS, PHASES, PRE_RESET_ALLOWED_COMMANDS, PRE_RESET_BUILD_COMMANDS, PRE_RESET_WAIT_COMMANDS,
    canUseCommandInPhase, getAllowedCommandsForPhase, getPlayerPhase,
    hasMagic, isAppearanceApproved, isAppearanceRejected, isFichaApproved, isGameCommand, isGameLiberated,
    isHistoriaApproved, isHistoriaRejected, isPostFichaReceptionCommand, renderGameBlockedMessage,
};
