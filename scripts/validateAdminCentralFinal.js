'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sqliteFallback = '--require=./scripts/registerSqliteTestFallback.js';
const nodeOptions = [process.env.NODE_OPTIONS, sqliteFallback].filter(Boolean).join(' ');

const checks = [
    {
        label: 'Sintaxe dos serviços e APIs administrativas',
        command: process.execPath,
        args: [
            '--check',
            'helpers/clover/adminHookService.js',
        ],
    },
    {
        label: 'Sintaxe do roteador administrativo principal',
        command: process.execPath,
        args: [
            '--check',
            'helpers/clover/adminApiSupport.js',
        ],
    },
    {
        label: 'Sintaxe da API de Ganchos',
        command: process.execPath,
        args: [
            '--check',
            'helpers/clover/adminHooksReadApi.js',
        ],
    },
    {
        label: 'Sintaxe do serviço de Recompensas',
        command: process.execPath,
        args: [
            '--check',
            'helpers/clover/adminRewardService.js',
        ],
    },
    {
        label: 'Sintaxe da API de Recompensas',
        command: process.execPath,
        args: [
            '--check',
            'helpers/clover/adminRewardsReadApi.js',
        ],
    },
    {
        label: 'Sintaxe do registro operacional',
        command: process.execPath,
        args: [
            '--check',
            'helpers/clover/adminOperationRegistry.js',
        ],
    },
    {
        label: 'Testes isolados de Ganchos e Recompensas',
        command: process.execPath,
        args: [
            '--test',
            'tests/cloverAdminHookService.test.js',
            'tests/cloverAdminHooksReadApi.test.js',
            'tests/cloverAdminRewardService.test.js',
            'tests/cloverAdminRewardsReadApi.test.js',
            'tests/cloverAdminSupplementaryRouting.test.js',
        ],
    },
    {
        label: 'Contrato e motor OP- compartilhados',
        command: process.execPath,
        args: [
            '--test',
            'tests/cloverAdminOperationContract.test.js',
            'tests/cloverAdminOperationService.test.js',
            'tests/cloverAdminOperationApi.test.js',
            'tests/cloverAdminApiSupport.test.js',
            'tests/cloverAdminAccessService.test.js',
            'tests/cloverAdminPlayerTraitOverviewService.test.js',
        ],
    },
    {
        label: 'Diferenças sem whitespace inválido',
        command: 'git',
        args: ['diff', '--check', 'refs/remotes/origin/feature/mundos-dos-sonhos-v1...HEAD'],
    },
];

console.log('Validação final da Central ADM');
console.log('Modo: não destrutivo — apenas sintaxe, testes com bancos em memória e diff.');

for (const check of checks) {
    console.log(`\n[INÍCIO] ${check.label}`);
    const result = spawnSync(check.command, check.args, {
        cwd: root,
        stdio: 'inherit',
        shell: process.platform === 'win32' && check.command === 'git',
        env: {
            ...process.env,
            NODE_ENV: 'test',
            NODE_OPTIONS: nodeOptions,
        },
    });

    if (result.error) {
        console.error(`[FALHA] ${check.label}: ${result.error.message}`);
        process.exit(1);
    }
    if (result.status !== 0) {
        console.error(`[FALHA] ${check.label}: processo terminou com código ${result.status}.`);
        process.exit(result.status || 1);
    }
    console.log(`[OK] ${check.label}`);
}

console.log('\nCentral ADM validada sem acessar ou modificar o banco de produção.');
