'use strict';

const DEFAULT_RECRUITMENT_MODE = process.env.NODE_ENV === 'test' ? 'active' : 'dormant';
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
