const http = require('http');

const HOST = process.env.CLOVER_PUBLIC_PROXY_HOST || '0.0.0.0';
const PORT = Number(process.env.CLOVER_PUBLIC_PROXY_PORT || 8791);
const CLOVER_PREFIX = process.env.CLOVER_PUBLIC_PROXY_PREFIX || '/clover-api';
const CLOVER_TARGET_PORT = Number(process.env.CLOVER_SITE_API_PORT || 8787);
const FALLBACK_TARGET_PORT = Number(process.env.CLOVER_PUBLIC_PROXY_FALLBACK_PORT || 8790);

function stripPrefix(pathname) {
    if (pathname === CLOVER_PREFIX) return '/';
    if (pathname.startsWith(`${CLOVER_PREFIX}/`)) {
        return pathname.slice(CLOVER_PREFIX.length) || '/';
    }
    return pathname;
}

function pickTarget(reqUrl) {
    const parsed = new URL(reqUrl, 'http://localhost');
    const isClover = parsed.pathname === CLOVER_PREFIX || parsed.pathname.startsWith(`${CLOVER_PREFIX}/`);
    return {
        host: '127.0.0.1',
        port: isClover ? CLOVER_TARGET_PORT : FALLBACK_TARGET_PORT,
        path: isClover ? `${stripPrefix(parsed.pathname)}${parsed.search}` : `${parsed.pathname}${parsed.search}`,
        isClover,
    };
}

function proxyRequest(req, res) {
    const target = pickTarget(req.url || '/');
    const headers = {
        ...req.headers,
        host: `127.0.0.1:${target.port}`,
        'x-forwarded-host': req.headers.host || '',
        'x-forwarded-proto': 'https',
    };

    if (target.isClover) {
        headers['x-forwarded-prefix'] = CLOVER_PREFIX;
    }

    const upstream = http.request({
        host: target.host,
        port: target.port,
        path: target.path,
        method: req.method,
        headers,
    }, (upstreamRes) => {
        const responseHeaders = { ...upstreamRes.headers };
        if (target.isClover) {
            const current = String(responseHeaders['access-control-allow-headers'] || '');
            if (!current.toLowerCase().includes('ngrok-skip-browser-warning')) {
                responseHeaders['access-control-allow-headers'] = [
                    current,
                    'ngrok-skip-browser-warning',
                ].filter(Boolean).join(', ');
            }
        }
        res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
        upstreamRes.pipe(res);
    });

    upstream.on('error', (error) => {
        const body = JSON.stringify({
            ok: false,
            error: 'proxy_upstream_error',
            message: `Falha ao acessar servico local na porta ${target.port}.`,
            detail: error?.message || String(error),
        });
        res.writeHead(502, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(body),
        });
        res.end(body);
    });

    req.pipe(upstream);
}

if (!Number.isFinite(PORT) || PORT <= 0) {
    console.error('[clover-public-proxy] Porta invalida.');
    process.exit(1);
}

const server = http.createServer(proxyRequest);
server.listen(PORT, HOST, () => {
    console.log(`[clover-public-proxy] online em http://${HOST}:${PORT}`);
    console.log(`[clover-public-proxy] ${CLOVER_PREFIX} -> http://127.0.0.1:${CLOVER_TARGET_PORT}`);
    console.log(`[clover-public-proxy] fallback -> http://127.0.0.1:${FALLBACK_TARGET_PORT}`);
});
