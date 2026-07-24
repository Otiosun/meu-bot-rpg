'use strict';

const { createRaidProgressExecutors } = require('./adminRaidProgressService');
const { createTraitExecutors } = require('./adminTraitService');

function getAdminOperationExecutors() {
    return {
        ...createTraitExecutors(),
        ...createRaidProgressExecutors(),
    };
}

module.exports = {
    getAdminOperationExecutors,
};