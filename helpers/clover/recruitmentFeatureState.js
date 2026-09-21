'use strict';

const RUNNING_TESTS = process.env.NODE_ENV === 'test'
    || Boolean(process.env.NODE_TEST_CONTEXT)
    || process.argv.includes('--test');
const DEFAULT_RECRUITMENT_MODE = RUNNING_TESTS ? 'active' : 'dormant';
const RECRUITMENT_MODE = String(process.env.CLOVER_RECRUITMENT_MODE || DEFAULT_RECRUITMENT_MODE)
    .trim()
    .toLowerCase();

function isRecruitmentFeatureEnabled() {
    return RECRUITMENT_MODE === 'active';
}

function getRecruitmentFeatureMode() {
    return isRecruitmentFeatureEnabled() ? 'active' : 'dormant';
}

module.exports = {
    RECRUITMENT_MODE,
    getRecruitmentFeatureMode,
    isRecruitmentFeatureEnabled,
};
