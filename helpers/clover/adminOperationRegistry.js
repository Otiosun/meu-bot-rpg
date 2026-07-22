'use strict';

const { createTraitExecutors } = require('./adminTraitService');

function getAdminOperationExecutors() {
    return {
        ...createTraitExecutors(),
    };
}

module.exports = {
    getAdminOperationExecutors,
};