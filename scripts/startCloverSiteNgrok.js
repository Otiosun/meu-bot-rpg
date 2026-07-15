const { spawn } = require('child_process');

const DEFAULT_PORT = 8787;

function envFlag(value = '', fallback = false) {
    const text = String(value ?? '').trim().toLowerCase();
    if (!text) return fallback;
    return ['1', 'true', 'yes', 'on', 'sim', 'ligado'].includes(text);
}

function normalizeUrl(value = '') {
    const text = String(value || '').trim();
    if (!text) return '';
    return /^https?:\/\//i.test(text) ? text : `https://${text}`;
}

function main() {
    if (!envFlag(process.env.CLOVER_NGROK_ENABLED, true)) {
        console.log('[clover-ngrok] Tunel desativado por CLOVER_NGROK_ENABLED.');
        process.exit(0);
    }

    const binary = String(process.env.CLOVER_NGROK_BIN || process.env.NGROK_BIN || 'ngrok').trim();
    const port = Number(process.env.CLOVER_NGROK_TARGET_PORT || process.env.CLOVER_SITE_API_PORT || DEFAULT_PORT);
    if (!Number.isFinite(port) || port <= 0) {
        console.error('[clover-ngrok] Porta invalida.');
        process.exit(1);
    }

    const url = normalizeUrl(process.env.CLOVER_NGROK_URL || process.env.CLOVER_API_NGROK_URL || '');
    const args = ['http', String(port), '--log=stdout'];
    if (url) args.push(`--url=${url}`);

    console.log(`[clover-ngrok] Subindo tunel ${url || '(URL da conta ngrok)'} -> http://127.0.0.1:${port}`);
    const child = spawn(binary, args, {
        cwd: process.cwd(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (chunk) => process.stdout.write(`[clover-ngrok] ${chunk}`));
    child.stderr.on('data', (chunk) => process.stderr.write(`[clover-ngrok] ${chunk}`));

    child.on('error', (error) => {
        if (error?.code === 'ENOENT') {
            console.error(`[clover-ngrok] Nao achei o binario "${binary}". Configure CLOVER_NGROK_BIN.`);
        } else {
            console.error('[clover-ngrok] Falha ao iniciar:', error?.message || error);
        }
        process.exit(1);
    });

    child.on('exit', (code, signal) => {
        if (code === 0) {
            console.log('[clover-ngrok] Tunel encerrado.');
            process.exit(0);
        }
        console.error(`[clover-ngrok] Processo encerrou com code=${code ?? 'null'} signal=${signal || 'null'}.`);
        process.exit(code || 1);
    });

    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.on(signal, () => {
            if (!child.killed) child.kill(signal);
            setTimeout(() => process.exit(0), 1500).unref();
        });
    }
}

main();
