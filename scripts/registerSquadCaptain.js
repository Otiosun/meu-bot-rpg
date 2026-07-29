'use strict';

const fs = require('fs');
const path = require('path');

const { criarBanco } = require('../database');
const {
    registerSquadCaptainSafely,
} = require('../helpers/clover/captainRegistrationGuardService');
const { backupSqliteDatabase } = require('../helpers/clover/sqliteBackupService');

function parseArgs(argv) {
    const result = { apply: false, profile: {} };
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === '--apply') {
            result.apply = true;
            continue;
        }
        if (!token.startsWith('--')) continue;
        const key = token.slice(2);
        const next = argv[index + 1];
        if (next === undefined || next.startsWith('--')) {
            result[key] = true;
            continue;
        }
        result[key] = next;
        index += 1;
    }
    result.profile = {
        magic: result.magic,
        grimoire: result.grimoire,
        race: result.race,
        className: result.class || result.className,
        kingdom: result.kingdom,
        age: result.age,
        gender: result.gender,
        appearance: result.appearance,
        image: result.image,
        biography: result.biography,
        personality: result.personality,
    };
    return result;
}

function required(args, key, label) {
    const value = String(args[key] || '').trim();
    if (!value) throw new Error(`Informe ${label} com --${key}.`);
    return value;
}

function timestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function usage() {
    return [
        'Uso:',
        '  node scripts/registerSquadCaptain.js \\',
        '    --phone 55DDDNUMERO \\',
        '    --squad trevos_da_esperanca \\',
        '    --captain-name "Outis Vermilion" \\',
        '    --mode main_plus_captain \\',
        '    --assigned-by SEU_JID',
        '',
        'O comando acima apenas mostra o plano. Para aplicar, acrescente --apply.',
        '',
        'Aizen, sem personagem principal:',
        '  node scripts/registerSquadCaptain.js --phone 55DDDNUMERO --squad veu_negro \\',
        '    --captain-name "Sousoke Aizen" --mode captain_only --assigned-by SEU_JID --apply',
        '',
        'Números brasileiros aceitos:',
        '  55 + DDD + telefone, totalizando 12 ou 13 dígitos.',
        '',
        'Campos opcionais:',
        '  --magic --grimoire --race --class --kingdom --age --gender',
        '  --appearance --image --biography --personality --reason',
    ].join('\n');
}

(async () => {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || args.h) {
        console.log(usage());
        return;
    }

    const phone = required(args, 'phone', 'o número com DDI + DDD');
    const squad = required(args, 'squad', 'a chave do esquadrão');
    const captainName = required(args, 'captain-name', 'o nome do Capitão');
    const assignedBy = required(args, 'assigned-by', 'o JID de quem autoriza');
    const mode = String(args.mode || 'main_plus_captain');
    const databasePath = path.resolve(args.database || 'banco.sqlite');
    if (path.basename(databasePath) !== 'banco.sqlite') {
        throw new Error('Este comando aceita apenas um arquivo chamado banco.sqlite para evitar abrir o banco errado.');
    }

    let backup = null;
    if (args.apply) {
        if (!fs.existsSync(databasePath)) throw new Error(`Banco não encontrado: ${databasePath}`);
        const backupPath = path.resolve(
            args.backup || path.join('backups', `before-captain-registration-${timestamp()}.sqlite`)
        );
        backup = await backupSqliteDatabase(databasePath, backupPath);
        console.log(`[backup] ${backup.destinationPath} (${backup.integrity})`);
    }

    const previousCwd = process.cwd();
    let db;
    try {
        process.chdir(path.dirname(databasePath));
        db = await criarBanco();
    } finally {
        process.chdir(previousCwd);
    }
    try {
        const result = await registerSquadCaptainSafely(db, {
            phone,
            squad,
            captainName,
            mode,
            assignedBy,
            profile: args.profile,
            reason: args.reason || 'Cadastro operacional de Capitão',
            apply: Boolean(args.apply),
        });
        console.log(JSON.stringify({ ...result, backup }, null, 2));
        if (!args.apply) {
            console.log('\n[preview] Nada foi alterado. Revise o plano e repita com --apply.');
        }
    } finally {
        if (db) await db.close();
    }
})().catch((error) => {
    console.error(JSON.stringify({
        ok: false,
        error: error?.code || 'captain_registration_failed',
        message: error?.message || String(error),
        details: error?.details || null,
    }, null, 2));
    process.exitCode = 1;
});
