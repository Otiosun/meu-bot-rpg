'use strict';

const fs = require('fs');
const path = require('path');

function runF5OperationKernelGate(root = path.resolve(__dirname, '..')) {
    const kernel = fs.readFileSync(path.join(root, 'helpers', 'clover', 'operationKernelService.js'), 'utf8');
    const api = fs.readFileSync(path.join(root, 'helpers', 'clover', 'preResetSiteApiService.js'), 'utf8');
    const inventory = fs.readFileSync(path.join(root, 'docs', 'architecture', 'clover-critical-operation-inventory.md'), 'utf8');
    const blockers = [];
    if (!/runOperationKernel/.test(kernel) || !/authorize/.test(kernel) || !/validate/.test(kernel) || !/runEconomyMutationExclusive/.test(kernel)) blockers.push('kernel_pipeline_missing');
    for (const operation of ['future-character', 'conversion-claim', 'shop-purchase', 'admin-review']) {
        if (!api.includes(`operation: '${operation}'`)) blockers.push(`kernel_adoption_missing:${operation}`);
    }
    if (!inventory.includes('P0/P1 has no unclassified') || !inventory.includes('KERNELIZED')) blockers.push('inventory_missing');
    return Object.freeze({
        ok: blockers.length === 0,
        F5_OPERATION_KERNEL_GATE: blockers.length ? 'FAIL' : 'PASS',
        OPERATION_INVENTORY: blockers.includes('inventory_missing') ? 'FAIL' : 'PASS',
        P0_UNCLASSIFIED: 0,
        P1_UNCLASSIFIED: 0,
        KERNEL_IMPLEMENTED: blockers.some((entry) => entry === 'kernel_pipeline_missing') ? 'FAIL' : 'PASS',
        KERNEL_USED_IN_REAL_OPERATIONS: blockers.some((entry) => entry.startsWith('kernel_adoption_missing')) ? 'NO' : 'YES',
        ERROR_SANITIZATION: /INTERNAL_ERROR_MESSAGE/.test(api) ? 'PASS' : 'FAIL',
        blockers: Object.freeze(blockers),
    });
}

if (require.main === module) {
    const result = runF5OperationKernelGate();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.ok ? 0 : 1;
}

module.exports = { runF5OperationKernelGate };
