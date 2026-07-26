'use strict';

module.exports = {
    apps: [
        {
            name: 'clover-rpg',
            cwd: __dirname,
            script: 'scripts/startCloverSiteStack.js',
            interpreter: process.execPath,
            autorestart: true,
            max_restarts: 10,
            min_uptime: '10s',
            restart_delay: 5000,
            kill_timeout: 5000,
            env: {
                NODE_ENV: process.env.NODE_ENV || 'production',
                CLOVER_SITE_API_ENABLED: process.env.CLOVER_SITE_API_ENABLED || '1',
                CLOVER_SITE_API_HOST: process.env.CLOVER_SITE_API_HOST || '0.0.0.0',
                CLOVER_SITE_API_PORT: process.env.CLOVER_SITE_API_PORT || '8787',
                CLOVER_TUNNEL_PROVIDER: process.env.CLOVER_TUNNEL_PROVIDER || 'none',
                CLOVER_CLOUDFLARED_PUBLIC_URL: process.env.CLOVER_CLOUDFLARED_PUBLIC_URL || '',
                CLOVER_CLOUDFLARED_TUNNEL: process.env.CLOVER_CLOUDFLARED_TUNNEL || '',
                CLOVER_CLOUDFLARED_CONFIG: process.env.CLOVER_CLOUDFLARED_CONFIG || '',
                CLOVER_NGROK_ENABLED: process.env.CLOVER_NGROK_ENABLED || '0',
                CLOVER_NGROK_URL: process.env.CLOVER_NGROK_URL || '',
            },
        },
    ],
};
