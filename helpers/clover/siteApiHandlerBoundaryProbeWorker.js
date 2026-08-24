'use strict';

const { __test } = require('./siteApiHandlerBoundaryProbes');

async function main() {
    const name = process.argv[2];
    const group = __test.criticalProbeGroups().find((candidate) => candidate.name === name);
    if (!group) throw new Error(`unknown_critical_probe_group:${name}`);
    const captures = await group.run();
    if (typeof process.send === 'function') process.send({ ok: true, captures }, () => process.exit(0));
}

main().catch((error) => {
    if (typeof process.send === 'function') process.send({ ok: false, error: { message: error.message, stack: error.stack } }, () => process.exit(1));
    else process.exitCode = 1;
});
