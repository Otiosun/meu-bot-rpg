'use strict';

const path = require('path');
const { loadConfig, parseArgs } = require('../helpers/clover/phase0EvidenceCollectorConfig');
const { run } = require('../helpers/clover/phase0EvidenceCollectorRunner');

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const config = loadConfig(path.resolve(options.config));
    const result = await run(config, options);
    if (options.jsonOnly) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else if (result.dryRun) console.log(`[phase0-evidence] preflight aprovado; ${result.plan.steps.length} etapas planejadas.`);
    else {
        console.log(`[phase0-evidence] manifesto: ${result.manifestPath}`);
        console.log(`[phase0-evidence] status: ${result.manifest.status}`);
    }
    if (!result.dryRun) process.exitCode = result.exitCode;
}

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(`${JSON.stringify({
            ok: false,
            error: error.code || 'phase0_evidence_failed',
            message: error.message,
            details: error.details || null,
        }, null, 2)}\n`);
        process.exitCode = 1;
    });
}

module.exports = {
    ...require('../helpers/clover/phase0EvidenceCollectorConfig'),
    ...require('../helpers/clover/phase0EvidenceCollectorRunner'),
};
