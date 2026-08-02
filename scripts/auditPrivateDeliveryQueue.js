'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { auditPrivateDeliveryQueue } = require('../helpers/clover/privateDeliveryQueueAudit');

function readArg(name) {
    const prefix = `--${name}=`;
    const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
    return found ? found.slice(prefix.length) : null;
}

function main() {
    const root = path.resolve(readArg('root') || process.cwd());
    const outputArg = readArg('output');
    const output = outputArg ? path.resolve(outputArg) : null;
    const force = process.argv.includes('--force');
    const report = auditPrivateDeliveryQueue(root);
    const serialized = `${JSON.stringify(report, null, 2)}\n`;

    if (output) {
        if (fs.existsSync(output) && !force) {
            throw new Error(`O relatório já existe: ${output}. Use --force para substituir.`);
        }
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, serialized, 'utf8');
    } else {
        process.stdout.write(serialized);
    }

    const summary = report.summary;
    console.error('[pv-delivery-audit] concluído:', {
        scanned: summary.scannedFileCount,
        relevant: summary.productionRelevantFileCount,
        producers: summary.producerFileCount,
        management: summary.managementFileCount,
        lifecycleCandidates: summary.lifecycleCandidateCount,
        confirmedConsumers: summary.confirmedConsumerCount,
        policyConsumers: summary.policyPropagationConsumerCount,
        consumerMissing: summary.consumerMissing,
        output,
    });
}

try {
    main();
} catch (error) {
    console.error(`[pv-delivery-audit] falha: ${error?.message || error}`);
    process.exitCode = 1;
}
