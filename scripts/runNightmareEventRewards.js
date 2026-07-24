'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SOURCE_PATH = path.join(__dirname, 'applyNightmareEventRewards.js');

function replaceOnce(source, search, replacement, label) {
    const index = source.indexOf(search);
    if (index < 0) throw new Error(`Transformação não encontrou: ${label}.`);
    if (source.indexOf(search, index + search.length) >= 0) {
        throw new Error(`Transformação encontrou mais de um bloco para: ${label}.`);
    }
    return `${source.slice(0, index)}${replacement}${source.slice(index + search.length)}`;
}

function transformSource(source) {
    let next = String(source || '');

    next = replaceOnce(
        next,
        "characterName: 'Kame', phone: '+55 21 96587-0936'",
        "characterName: 'Kame Van Rothtaylor', phone: '+55 21 96587-0936'",
        'nome canônico de Kame'
    );

    const oldCharacterHelper = `function playerHasExactCharacter(player, expectedCharacter) {
    return [player?.personagem_nome, player?.display_name, player?.nome]
        .map(normalizeName)
        .filter(Boolean)
        .includes(expectedCharacter);
}`;

    const newCharacterHelper = `function playerCharacterNames(player) {
    return [player?.personagem_nome, player?.display_name, player?.nome]
        .map(normalizeName)
        .filter(Boolean);
}

function playerHasExactCharacter(player, expectedCharacter) {
    return playerCharacterNames(player).includes(expectedCharacter);
}

function playerHasPhoneConfirmedCharacter(player, expectedCharacter) {
    return playerCharacterNames(player).some((name) =>
        name === expectedCharacter || name.startsWith(\`${'${expectedCharacter}'} \`)
    );
}

function playerHasMeaningfulCharacter(player) {
    return playerCharacterNames(player).some((name) => name && name !== '-');
}`;

    next = replaceOnce(next, oldCharacterHelper, newCharacterHelper, 'validadores de personagem');

    const resolverStart = '    const phoneCanonical = await canonicalizeCandidates(db, candidateSources);';
    const resolverEnd = `    } else {
        const characterCanonical = new Map();`;
    const startIndex = next.indexOf(resolverStart);
    const endIndex = next.indexOf(resolverEnd, startIndex);
    if (startIndex < 0 || endIndex < 0) {
        throw new Error('Transformação não encontrou o bloco de resolução telefônica.');
    }

    const hardenedResolver = `    const phoneCanonical = await canonicalizeCandidates(db, candidateSources);
    const meaningfulPhoneCandidates = [...phoneCanonical.values()]
        .filter((candidate) => playerHasMeaningfulCharacter(candidate.player));
    const matchingPhoneCandidates = meaningfulPhoneCandidates
        .filter((candidate) => playerHasPhoneConfirmedCharacter(candidate.player, expectedCharacter));

    let selected;
    let resolutionSource;
    if (matchingPhoneCandidates.length === 1 && meaningfulPhoneCandidates.length === 1) {
        selected = matchingPhoneCandidates[0].player;
        resolutionSource = [...matchingPhoneCandidates[0].sources].sort().join('+');
    } else if (matchingPhoneCandidates.length > 1) {
        throw new Error(
            \`Telefone de ${'${entry.playerName}'}/${'${entry.characterName}'} resolveu para \`
            + \`${'${matchingPhoneCandidates.length}'} cadastros canônicos compatíveis.\`
        );
    } else if (matchingPhoneCandidates.length === 1 && meaningfulPhoneCandidates.length > 1) {
        const names = meaningfulPhoneCandidates
            .map((candidate) => candidate.player.personagem_nome || candidate.player.display_name || candidate.player.nome || candidate.player.id)
            .join(', ');
        throw new Error(
            \`Telefone de ${'${entry.playerName}'}/${'${entry.characterName}'} também está ligado a outro personagem real: ${'${names}'}.\`
        );
    } else if (meaningfulPhoneCandidates.length > 0) {
        const names = meaningfulPhoneCandidates
            .map((candidate) => candidate.player.personagem_nome || candidate.player.display_name || candidate.player.nome || candidate.player.id)
            .join(', ');
        throw new Error(
            \`Telefone de ${'${entry.playerName}'}/${'${entry.characterName}'} resolveu para outro(s) personagem(ns): ${'${names}'}.\`
        );
    } else {
        const characterCanonical = new Map();`;

    next = `${next.slice(0, startIndex)}${hardenedResolver}${next.slice(endIndex + resolverEnd.length)}`;

    if (!next.includes("characterName: 'Kame Van Rothtaylor'")) {
        throw new Error('Transformação não consolidou o nome canônico de Kame.');
    }
    if (!next.includes('playerHasPhoneConfirmedCharacter')) {
        throw new Error('Transformação não ativou a validação de nome abreviado por telefone.');
    }
    if (!next.includes('meaningfulPhoneCandidates')) {
        throw new Error('Transformação não ativou o descarte de cadastros vazios.');
    }
    return next;
}

function run() {
    const original = fs.readFileSync(SOURCE_PATH, 'utf8');
    const transformed = transformSource(original);
    const generatedPath = path.join(__dirname, `.nightmareEventRewards.generated-${process.pid}.js`);

    fs.writeFileSync(generatedPath, transformed, 'utf8');
    try {
        const child = spawnSync(process.execPath, [generatedPath, ...process.argv.slice(2)], {
            cwd: path.resolve(__dirname, '..'),
            env: process.env,
            stdio: 'inherit',
        });
        if (child.error) throw child.error;
        if (child.signal) {
            console.error(`Processo de premiação encerrado por sinal ${child.signal}.`);
            process.exitCode = 1;
            return;
        }
        process.exitCode = Number(child.status || 0);
    } finally {
        fs.rmSync(generatedPath, { force: true });
    }
}

if (require.main === module) {
    try {
        run();
    } catch (error) {
        console.error('\nFALHA NO RUNNER DA PREMIAÇÃO:');
        console.error(error.stack || error.message || error);
        process.exitCode = 1;
    }
}

module.exports = { transformSource };
