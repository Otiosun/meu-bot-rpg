'use strict';

const RECRUITMENT_MODE = String(process.env.CLOVER_RECRUITMENT_MODE || 'dormant')
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
