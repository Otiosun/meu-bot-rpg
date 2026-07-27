'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

function argument(name, argv = process.argv.slice(2)) {
    const prefix = `--${name}=`;
    const item = argv.find((value) => value.startsWith(prefix));
    return item ? item.slice(prefix.length) : null;
}

function hasFlag(name, argv = process.argv.slice(2)) {
    return argv.includes(`--${name}`);
}

function assertPreviewPath(filename, options = {}) {
    if (!options.allowWrite) {
        throw new Error('Preview bloqueado. Use --allow-preview-write somente em uma cópia descartável.');
    }
    const normalized = path.resolve(filename).toLowerCase();
    const allowed = ['backup', 'preview', 'staging', 'sandbox', 'test', 'copy', 'copia'];
    if (!allowed.some((token) => normalized.includes(token))) {
        throw new Error('Caminho recusado: use apenas backup, preview, staging, sandbox, test ou cópia.');
    }
    return path.resolve(filename);
}

async function selectPreviewPlayer(db, requestedPlayerId = null) {
    if (requestedPlayerId) {
        const player = await db.get(
            `SELECT * FROM jogadores WHERE id = ?`,
            [String(requestedPlayerId).trim()]
        );
        if (!player) throw new Error(`Personagem de preview não encontrado: ${requestedPlayerId}`);
        return player;
    }

    const player = await db.get(`
        SELECT *
        FROM jogadores
        ORDER BY
            CASE WHEN lower(trim(COALESCE(jogo_status, ''))) = 'liberado' THEN 0 ELSE 1 END,
            CASE WHEN trim(COALESCE(personagem_nome, '-')) NOT IN ('', '-') THEN 0 ELSE 1 END,
            id
        LIMIT 1
    `);
    if (!player) throw new Error('A cópia não possui nenhum personagem para autenticação de preview.');
    return player;
}

async function startPreviewApi(options = {}) {
    const filename = assertPreviewPath(options.databasePath, { allowWrite: options.allowWrite });
    if (!fs.existsSync(filename)) throw new Error(`Cópia não encontrada: ${filename}`);

    const port = Number(options.port || 8790);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        throw new Error('Porta de preview inválida.');
    }
    const host = String(options.host || '127.0.0.1').trim() || '127.0.0.1';

    process.env.CLOVER_SITE_API_ENABLED = '1';
    process.env.CLOVER_SITE_API_PORT = String(port);
    process.env.CLOVER_SITE_API_HOST = host;
    process.env.CLOVER_SITE_API_ORIGIN = options.origin || '*';

    const { ensureDreamWorldsSchema } = require('../helpers/clover/dreamWorldsService');
    const { ensureDreamOperationsSchema } = require('../helpers/clover/dreamWorldsOperationsService');
    const { createSession } = require('../helpers/clover/siteAuthService');
    const { startSiteApiServer, stopSiteApiServer } = require('../helpers/clover/siteApiServer');

    const db = await open({ filename, driver: sqlite3.Database });
    await db.exec('PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    await ensureDreamWorldsSchema(db);
    await ensureDreamOperationsSchema(db);

    const player = await selectPreviewPlayer(db, options.playerId || null);
    const session = await createSession(db, player.id, null, {
        ttlMs: Number(options.sessionTtlMs || 4 * 60 * 60 * 1000),
    });
    const server = startSiteApiServer({ getDb: () => db });
    if (!server) {
        await db.close();
        throw new Error('A API de preview não foi iniciada.');
    }

    let closed = false;
    const close = async () => {
        if (closed) return;
        closed = true;
        await stopSiteApiServer().catch(() => null);
        await db.close().catch(() => null);
    };

    await new Promise((resolve, reject) => {
        if (server.listening) {
            resolve();
            return;
        }
        server.once('listening', resolve);
        server.once('error', reject);
    });

    return {
        close,
        database: filename,
        host,
        port,
        baseUrl: `http://${host}:${port}`,
        player: {
            id: player.id,
            name: player.personagem_nome || player.display_name || player.nome || player.id,
        },
        token: session.token,
        expiresAt: session.expiresAt,
    };
}

async function main() {
    const databaseInput = argument('db');
    if (!databaseInput) throw new Error('Informe --db=CAMINHO_DA_COPIA.sqlite.');

    const runtime = await startPreviewApi({
        databasePath: databaseInput,
        allowWrite: hasFlag('allow-preview-write'),
        port: argument('port') || 8790,
        host: argument('host') || '127.0.0.1',
        origin: argument('origin') || '*',
        playerId: argument('player'),
    });

    console.log('\n=== API DE PREVIEW — MUNDOS DOS SONHOS ===');
    console.log(`Banco isolado: ${runtime.database}`);
    console.log(`API: ${runtime.baseUrl}`);
    console.log(`Personagem: ${runtime.player.name} (${runtime.player.id})`);
    console.log(`Token temporário: ${runtime.token}`);
    console.log(`Expira em: ${runtime.expiresAt}`);
    console.log('WhatsApp/bot: não iniciado');
    console.log('Encerrar: Ctrl+C');

    const shutdown = async (signal) => {
        console.log(`\nEncerrando preview por ${signal}...`);
        await runtime.close();
        process.exit(0);
    };
    process.once('SIGINT', () => void shutdown('SIGINT'));
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

if (require.main === module) {
    main().catch((error) => {
        console.error('API de preview interrompida:', error?.stack || error?.message || error);
        process.exitCode = 1;
    });
}

module.exports = {
    argument,
    assertPreviewPath,
    hasFlag,
    selectPreviewPlayer,
    startPreviewApi,
};
