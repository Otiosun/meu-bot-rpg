'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { __test } = require('../helpers/clover/siteApiHandlerBoundaryProbes');

test('preferências visuais fazem roundtrip PUT → GET no handler HTTP real', async () => {
    const captures = await __test.runProfilePresentationPreferenceProbes();
    assert.equal(captures.length, 2);

    const [put, get] = captures;
    for (const capture of captures) {
        assert.equal(capture.recognized, true, capture.name);
        assert.equal(capture.outcome, 'MATCHED_SUCCESS', capture.name);
        assert.equal(capture.status, 200, capture.name);
        assert.equal(capture.payload?.ok, true, capture.name);
    }

    assert.deepEqual(put.payload.preferences, get.payload.preferences);
    assert.equal(get.payload.preferences.accent, 'violet');
    assert.equal(get.payload.preferences.heroStyle, 'cover');
    assert.equal(get.payload.preferences.sectionStyle, 'minimal');
    assert.equal(get.payload.preferences.showSectionIcons, false);
    assert.equal(get.payload.preferences.showActiveTitle, false);
    assert.equal('race' in get.payload.preferences, false);
    assert.ok(get.payload.updatedAt);
});
