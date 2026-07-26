'use strict';

const http = require('http');
const net = require('net');
const { spawnSync } = require('child_process');
const { buildTunnelConfig, publicTunnelUrl } = require('./startCloverSiteTunnel');

function run(command, args) {
    const result = spawnSync(command, args, {
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
    });
    return {
        ok: !result.error && result.status === 0,
        status: result.status,
        stdout: String(result.stdout || '').trim(),
        stderr: String(result.stderr || '').trim(),
        error: result.error?.message || null,
    };
}

function commandExists(command) {
    const finder = process.platform === 'win32' ? 'where.exe' : 'which';
    return run(finder, [command]).ok;
}

function requestJson(url, timeoutMs = 2500) {
    return new Promise((resolve) => {
        const req = http.get(url, { timeout: timeoutMs }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                let json = null;
                try {
                    json = JSON.parse(body);
                } catch {}
                resolve({ ok: res.statusCode === 200, statusCode: res.statusCode, json, body });
            });
        });
        req.on('timeout', () => {
            req.destroy();
            resolve({ ok: false, error: 'timeout' });
        });
        req.on('error', (error) => resolve({ ok: false, error: error.message }));
    });
}

function canConnect(port, host = '127.0.0.1', timeoutMs = 800) {
    return new Promise((resolve) => {
        const socket = net.createConnection({ host, port });
        const finish = (open) => {
            socket.destroy();
            resolve(open);
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
    });
}

function summarizePm2() {
    const result = process.platform === 'win32'
        ? run('cmd.exe', ['/d', '/s', '/c', 'pm2 jlist'])
        : run('pm2', ['jlist']);
    if (!result.ok) return { ok: false, error: result.error || result.stderr || 'pm2 indisponivel' };
    try {
        const processes = JSON.parse(result.stdout || '[]');
        return {
            ok: true,
            processes: processes.map((processInfo) => ({
                id: processInfo.pm_id,
                name: processInfo.name,
                status: processInfo.pm2_env?.status,
                script: processInfo.pm2_env?.pm_exec_path,
                cwd: processInfo.pm2_env?.pm_cwd,
                restarts: processInfo.pm2_env?.restart_time,
            })),
        };
    } catch (error) {
        return { ok: false, error: error.message };
    }
}

async function diagnose(env = process.env) {
    const port = Number(env.CLOVER_SITE_API_PORT || 8787);
    const tunnel = buildTunnelConfig(env);
    return {
        generatedAt: new Date().toISOString(),
        node: process.version,
        pm2: summarizePm2(),
        binaries: {
            cloudflared: commandExists(env.CLOVER_CLOUDFLARED_BIN || 'cloudflared'),
            ngrok: commandExists(env.CLOVER_NGROK_BIN || 'ngrok'),
        },
        api: {
            port,
            tcpOpen: await canConnect(port),
            health: await requestJson(`http://127.0.0.1:${port}/health`),
        },
        tunnel: {
            provider: tunnel.provider,
            enabled: tunnel.enabled,
            valid: tunnel.valid,
            binary: tunnel.binary || null,
            publicUrl: publicTunnelUrl(tunnel, env) || null,
            quickTunnel: Boolean(tunnel.usesQuickTunnel),
        },
    };
}

async function runCli() {
    const report = await diagnose();
    console.log(JSON.stringify(report, null, 2));
    if (!report.api.health.ok || !report.pm2.ok) process.exitCode = 1;
}

if (require.main === module) void runCli();

module.exports = { diagnose };
