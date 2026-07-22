'use strict';

const fs = require('node:fs');
const path = require('node:path');

const indexPath = path.resolve(__dirname, '..', 'index.js');
let source = fs.readFileSync(indexPath, 'utf8');

function replaceOnce(search, replacement, label) {
    const first = source.indexOf(search);
    if (first < 0) throw new Error(`Anchor not found: ${label}`);
    if (source.indexOf(search, first + search.length) >= 0) {
        throw new Error(`Anchor is not unique: ${label}`);
    }
    source = source.slice(0, first) + replacement + source.slice(first + search.length);
}

replaceOnce(
    "const { runEconomyMutationExclusive } = require('./helpers/clover/economyMutationQueue');\n",
    "const { runEconomyMutationExclusive } = require('./helpers/clover/economyMutationQueue');\nconst {\n    closeDatabaseOnce,\n    registerDatabase,\n    retireDatabase,\n    withDatabaseLease,\n} = require('./helpers/clover/databaseLifecycleGuard');\n",
    'database lifecycle import'
);

replaceOnce(
`async function fecharDbSeguro(db) {
    if (!db || typeof db.close !== 'function') return;
    try {
        await db.close();
    } catch (error) {
        console.log('[boot] Nao consegui fechar DB antigo:', error?.message || error);
    }
}`,
`async function fecharDbSeguro(db) {
    if (!db || typeof db.close !== 'function') return;
    try {
        await closeDatabaseOnce(db);
    } catch (error) {
        console.log('[boot] Nao consegui fechar DB antigo:', error?.message || error);
    }
}

async function aposentarDbSeguro(db, contexto = 'substituido', timeoutMs = 30000) {
    if (!db || typeof db.close !== 'function') return;
    try {
        const result = await retireDatabase(db, { timeoutMs });
        if (result?.forced) {
            console.log(`[boot] DB ${contexto} fechado por timeout com operacoes pendentes.`);
        }
    } catch (error) {
        console.log(`[boot] Nao consegui aposentar DB ${contexto}:`, error?.message || error);
    }
}`,
    'safe database close'
);

replaceOnce(
`function fecharDbComAtraso(db, delayMs = 30000) {
    if (!db || typeof db.close !== 'function') return;
    setTimeout(() => {
        if (runtimeClover.dbAtivo === db) return;
        fecharDbSeguro(db);
    }, delayMs).unref?.();
}`,
`function fecharDbComAtraso(db, delayMs = 30000) {
    if (!db || typeof db.close !== 'function') return;
    setTimeout(() => {
        if (runtimeClover.dbAtivo === db) return;
        aposentarDbSeguro(db, 'reconexao', 30000);
    }, delayMs).unref?.();
}`,
    'delayed database close'
);

replaceOnce(
`    const db = runtimeClover.dbAtivo;
    runtimeClover.dbAtivo = null;
    await fecharDbSeguro(db);`,
`    const db = runtimeClover.dbAtivo;
    runtimeClover.dbAtivo = null;
    await aposentarDbSeguro(db, 'encerramento', 6500);`,
    'shutdown database close'
);

replaceOnce(
`    const db = await criarBanco();
    global.__cloverDeliveryDb = db;`,
`    const db = registerDatabase(await criarBanco());
    global.__cloverDeliveryDb = db;`,
    'database registration'
);

replaceOnce(
`    if (dbAnterior && dbAnterior !== db) {
        fecharDbComAtraso(dbAnterior);
    }`,
`    if (dbAnterior && dbAnterior !== db) {
        aposentarDbSeguro(dbAnterior, 'substituido', 30000);
    }`,
    'database replacement'
);

replaceOnce(
`    sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
        if (!isCurrentRuntime()) return;`,
`    sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
        if (!isCurrentRuntime()) return;
        try {
            await withDatabaseLease(db, 'group-participants.update', async () => {`,
    'group participant lease start'
);

const groupLeaseEndAnchor = `        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {`;
replaceOnce(
    groupLeaseEndAnchor,
`        }
            });
        } catch (error) {
            if (error?.code !== 'database_retired') {
                console.log('[boot] Falha no evento de participantes:', error?.message || error);
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {`,
    'group participant lease end'
);

replaceOnce(
`    sock.ev.on('messages.upsert', async ({ messages }) => {
        if (!isCurrentRuntime()) return;`,
`    sock.ev.on('messages.upsert', async ({ messages }) => {
        if (!isCurrentRuntime()) return;
        try {
            await withDatabaseLease(db, 'messages.upsert', async () => {`,
    'message lease start'
);

replaceOnce(
`        } catch (err) {
            console.log(\`Erro no comando \${resolvedCommand.matchedName}:\`, err);
            await sock.sendMessage(idChat, { text: 'Erro ao executar o comando.' }).catch((sendError) => {
                console.log('[comando] Nao consegui enviar aviso de erro:', sendError?.message || sendError);
            });
        }
    });
}`,
`        } catch (err) {
            console.log(\`Erro no comando \${resolvedCommand.matchedName}:\`, err);
            await sock.sendMessage(idChat, { text: 'Erro ao executar o comando.' }).catch((sendError) => {
                console.log('[comando] Nao consegui enviar aviso de erro:', sendError?.message || sendError);
            });
        }
            });
        } catch (error) {
            if (error?.code !== 'database_retired') {
                console.log('[boot] Falha no processamento de mensagem:', error?.message || error);
            }
        }
    });
}`,
    'message lease end'
);

fs.writeFileSync(indexPath, source, 'utf8');
console.log('Database lifecycle guard integrated into index.js.');
