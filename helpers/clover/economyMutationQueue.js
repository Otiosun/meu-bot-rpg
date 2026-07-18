'use strict';

let mutationTail = Promise.resolve();

async function runEconomyMutationExclusive(action) {
    if (typeof action !== 'function') throw new TypeError('A fila econômica exige uma função.');
    const previous = mutationTail.catch(() => {});
    let releaseCurrent;
    mutationTail = new Promise((resolve) => {
        releaseCurrent = resolve;
    });
    await previous;
    try {
        return await action();
    } finally {
        releaseCurrent();
    }
}

module.exports = { runEconomyMutationExclusive };
