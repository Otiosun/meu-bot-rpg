'use strict';

const fs = require('fs');
const path = require('path');
const { auditPreResetAuthoritySources } = require('../helpers/clover/preResetAuthorityAudit');

function read(root, name) {
    return fs.readFileSync(path.join(root, 'helpers', 'clover', name), 'utf8');
}

function auditPreResetAuthority(root = path.resolve(__dirname, '..')) {
    return auditPreResetAuthoritySources({
        character: read(root, 'preResetCharacterService.js'),
        shop: read(root, 'preResetShopService.js'),
        conversion: read(root, 'returnPointConversionService.js'),
        returnPoints: read(root, 'returnPointsService.js'),
        access: read(root, 'preResetAccessService.js'),
    });
}

if (require.main === module) {
    const result = auditPreResetAuthority();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.ok ? 0 : 1;
}

module.exports = { auditPreResetAuthority };
