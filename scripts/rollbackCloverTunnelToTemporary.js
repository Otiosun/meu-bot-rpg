'use strict';

const fs = require('fs');
const path = require('path');

function buildRollbackEnv(env = process.env) {
    const temporaryUrl = String(env.CLOVER_TEMPORARY_TUNNEL_URL || '').trim();
    if (!temporaryUrl) {
        throw new Error('Defina CLOVER_TEMPORARY_TUNNEL_URL com a URL temporaria aprovada antes de gerar rollback.');
    }
    return {
        CLOVER_TUNNEL_PROVIDER: 'cloudflare',
        CLOVER_CLOUDFLARED_PUBLIC_URL: temporaryUrl,
        CLOVER_API_UPSTREAM: temporaryUrl,
    };
}

function runCli() {
    const outputPath = path.resolve(process.argv[2] || 'artifacts/clover-tunnel-rollback-env.json');
    const rollbackEnv = buildRollbackEnv();
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify({
        generatedAt: new Date().toISOString(),
        warning: 'Arquivo local de rollback. Nao versionar. Aplicar somente com autorizacao operacional.',
        env: rollbackEnv,
    }, null, 2));
    console.log(`[clover-tunnel] Rollback local preparado em ${outputPath}`);
}

if (require.main === module) {
    try {
        runCli();
    } catch (error) {
        console.error(`[clover-tunnel] ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = { buildRollbackEnv };
