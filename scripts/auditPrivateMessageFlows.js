'use strict';

const path = require('node:path');

const {
    scanPrivateMessageFlows,
    writeAuditReport,
} = require('../helpers/clover/privateMessageFlowAudit');

function parseArgs(argv = process.argv.slice(2)) {
    const options = {
        root: process.cwd(),
        output: null,
        includeTests: false,
        failOnUnknown: false,
        failOnProactive: false,
        failOnDirectSocket: false,
    };

    for (const argument of argv) {
        if (argument === '--include-tests') {
            options.includeTests = true;
            continue;
        }
        if (argument === '--fail-on-unknown') {
            options.failOnUnknown = true;
            continue;
        }
        if (argument === '--fail-on-proactive') {
            options.failOnProactive = true;
            continue;
        }
        if (argument === '--fail-on-direct-socket') {
            options.failOnDirectSocket = true;
            continue;
        }
        if (argument.startsWith('--root=')) {
            options.root = argument.slice('--root='.length);
            continue;
        }
        if (argument.startsWith('--output=')) {
            options.output = argument.slice('--output='.length);
            continue;
        }
        throw new Error(`Argumento desconhecido: ${argument}`);
    }

    if (!options.output) {
        throw new Error('Informe --output=<arquivo.json>.');
    }

    return {
        ...options,
        root: path.resolve(options.root),
        output: path.resolve(options.output),
    };
}

function decideExitCode(report, options) {
    if (options.failOnUnknown && report.summary.unknownCount > 0) return 2;
    if (options.failOnProactive && report.summary.proactiveCount > 0) return 2;
    if (options.failOnDirectSocket && report.summary.directSocketCount > 0) return 2;
    return 0;
}

function run(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    const report = scanPrivateMessageFlows(options.root, {
        includeTests: options.includeTests,
    });
    const output = writeAuditReport(report, options.output);

    console.log(`[pv-audit] arquivos: ${report.summary.scannedFileCount}`);
    console.log(`[pv-audit] chamadas encontradas: ${report.summary.findingCount}`);
    console.log(`[pv-audit] relevantes para PV: ${report.summary.pvRelevantCount}`);
    console.log(`[pv-audit] reativas: ${report.summary.byCategory.reactive || 0}`);
    console.log(`[pv-audit] transacionais: ${report.summary.byCategory.transactional || 0}`);
    console.log(`[pv-audit] proativas: ${report.summary.proactiveCount}`);
    console.log(`[pv-audit] desconhecidas: ${report.summary.unknownCount}`);
    console.log(`[pv-audit] não privadas/grupo provável: ${report.summary.nonPrivateCount}`);
    console.log(`[pv-audit] infraestrutura de transporte: ${report.summary.infrastructureCount}`);
    console.log(`[pv-audit] bypass socket privado: ${report.summary.directPrivateSocketCount}`);
    console.log(`[pv-audit] socket contextual: ${report.summary.directContextualSocketCount}`);
    console.log(`[pv-audit] relatório: ${output}`);

    return decideExitCode(report, options);
}

if (require.main === module) {
    try {
        process.exitCode = run();
    } catch (error) {
        console.error(`[pv-audit] falha: ${error?.message || error}`);
        process.exitCode = 1;
    }
}

module.exports = {
    decideExitCode,
    parseArgs,
    run,
};