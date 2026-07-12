const servicePath = require.resolve('../helpers/clover/cloverAdminViewService');
const facade = require('../helpers/clover/cloverAdminViewFacade');

require.cache[servicePath] = {
    id: servicePath,
    filename: servicePath,
    loaded: true,
    exports: facade,
    children: [],
    paths: [],
};

require('./cloverAdminViewService.test');
