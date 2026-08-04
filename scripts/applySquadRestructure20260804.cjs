'use strict';

const CONFIRMATION = 'APLICAR-REESTRUTURACAO-ESQUADROES-2026-08-04';

function parseArgs(argv) {
    const options = {
        apply: false,
        confirm: '',
        db: '',
        actor: '',
        output: null,
    };
    for (const arg of argv) {
        if (arg === '--apply') options.apply = true;
        if (arg.startsWith('--confirm=')) options.confirm = arg.slice('--confirm='.length);
        if (arg.startsWith('--db=')) options.db = arg.slice('--db='.length).replace(/^"|"$/g, '');
        if (arg.startsWith('--actor=')) options.actor = arg.slice('--actor='.length);
        if (arg.startsWith('--output=')) options.output = arg.slice('--output='.length).replace(/^"|"$/g, '');
    }
    return options;
}

function unavailableApplyError() {
    const error = new Error(
        'Apply indisponivel nesta PR: falta backup obrigatorio, WAL checkpoint, integrity_check, rollback global, controle PM2 e health check.'
    );
    error.code = 'apply_unavailable';
    return error;
}

function assertApplyAuthorized() {
    throw unavailableApplyError();
}

async function applySquadRestructure() {
    throw unavailableApplyError();
}

async function main() {
    throw unavailableApplyError();
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.message || error);
        process.exitCode = 1;
    });
}

module.exports = {
    CONFIRMATION,
    applySquadRestructure,
    assertApplyAuthorized,
    parseArgs,
};
