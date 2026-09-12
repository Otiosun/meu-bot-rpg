'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const { spawnSync } = require('child_process');
const { loadF10CiContract } = require('../helpers/ci/f10CiContract');

const ROOT = path.resolve(__dirname, '..');
const contract = loadF10CiContract();
const scope = contract.syntaxScope;
const extensions = new Set(scope.extensions);
const excluded = new Set(scope.excludeDirectories);
const files = [];

function walk(target) {
    const absolute = path.resolve(ROOT, target);
    if (!fs.existsSync(absolute)) throw new Error(`syntax_scope_missing:${target}`);
    const stat = fs.statSync(absolute);
    if (stat.isFile()) {
        if (extensions.has(path.extname(absolute))) files.push(absolute);
        return;
    }
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
        if (entry.isDirectory() && excluded.has(entry.name)) continue;
        const child = path.join(absolute, entry.name);
        if (entry.isDirectory()) walk(path.relative(ROOT, child));
        else if (entry.isFile() && extensions.has(path.extname(entry.name))) files.push(child);
    }
}

for (const target of scope.roots) walk(target);
files.sort();

const failures = [];
for (const filename of files) {
    const relative = path.relative(ROOT, filename).replaceAll('\\', '/');
    try {
        if (path.extname(filename) === '.mjs') {
            const run = spawnSync(process.execPath, ['--check', filename], { encoding: 'utf8' });
            if (run.status !== 0) throw new Error((run.stderr || run.stdout || `exit_${run.status}`).trim());
        } else {
            const source = fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '');
            new vm.Script(Module.wrap(source), { filename: relative, displayErrors: true });
        }
    } catch (error) {
        failures.push({ file: relative, error: String(error?.message || error).split('\n')[0] });
    }
}

console.log(`F10_SYNTAX_FILES=${files.length}`);
console.log(`F10_SYNTAX_FAILURES=${failures.length}`);
if (failures.length) {
    for (const failure of failures.slice(0, 50)) console.error(`${failure.file}: ${failure.error}`);
    console.error('F10_SYNTAX_GATE=FAIL');
    process.exit(1);
}
console.log('F10_SYNTAX_GATE=PASS');
