'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('protected interceptor never reflects an unexpected 5xx message', () => {
    const source = fs.readFileSync(path.join(__dirname, '../helpers/clover/siteApiServer.js'), 'utf8');
    assert.match(source, /site_interceptor_internal_error/);
    assert.match(source, /publicClientError && error\?\.message/);
    assert.doesNotMatch(source, /message:\s*error\?\.message\s*\|\|/);
});
