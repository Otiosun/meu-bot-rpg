'use strict';

const {
    auditRecruitmentFlow: auditRecruitmentFlowBase,
    tableExists,
} = require('./recruitmentFlowAudit');

function recomputeIssueSummary(report) {
    report.summary.issues = report.issues.length;
    report.summary.critical = report.issues.filter((item) => item.severity === 'critical').length;
    report.summary.warning = report.issues.filter((item) => item.severity === 'warning').length;
}

async function ledgerAcceptsFractionalValues(db) {
    const row = await db.get(
        `SELECT sql FROM sqlite_master
         WHERE type = 'table' AND name = 'clover_pr_ledger'`
    );
    if (!row?.sql) return false;
    return !/\bSTRICT\b/i.test(String(row.sql));
}

async function groupSubmissionSummary(db) {
    if (!await tableExists(db, 'clover_recruitment_group_submissions')) return null;
    const row = await db.get(
        `SELECT
            COUNT(*) AS submissions,
            COALESCE(SUM(groups_reported), 0) AS groups_reported,
            COALESCE(SUM(groups_credited), 0) AS groups_credited,
            COALESCE(SUM(groups_excess), 0) AS groups_excess,
            COALESCE(SUM(pr_awarded), 0) AS pr_awarded,
            COALESCE(SUM(CASE WHEN ledger_id IS NULL AND pr_awarded > 0 THEN 1 ELSE 0 END), 0) AS missing_ledger
         FROM clover_recruitment_group_submissions`
    );
    return {
        submissions: Number(row?.submissions || 0),
        groupsReported: Number(row?.groups_reported || 0),
        groupsCredited: Number(row?.groups_credited || 0),
        groupsExcess: Number(row?.groups_excess || 0),
        prAwarded: Number(row?.pr_awarded || 0),
        missingLedger: Number(row?.missing_ledger || 0),
    };
}

async function auditRecruitmentFlow(db, options = {}) {
    const report = await auditRecruitmentFlowBase(db, options);
    const fractionalSupported = await ledgerAcceptsFractionalValues(db);
    const groupSubmissions = await groupSubmissionSummary(db);

    if (fractionalSupported) {
        report.issues = report.issues.filter((item) => item.code !== 'fractional_pr_unsupported');
    }
    if (groupSubmissions) {
        report.issues = report.issues.filter((item) => item.code !== 'group_count_not_persisted');
        if (groupSubmissions.missingLedger > 0) {
            report.issues.push({
                severity: 'critical',
                code: 'group_submission_missing_ledger',
                message: 'Existem lançamentos remunerados de grupos sem o respectivo crédito de PR.',
                total: groupSubmissions.missingLedger,
            });
        }
    }

    report.capabilities.fractionalPrStoredNatively = fractionalSupported;
    report.capabilities.groupCountStoredSeparately = Boolean(groupSubmissions);
    report.capabilities.excessGroupCountPreserved = Boolean(groupSubmissions);
    report.summary.groupSubmissions = groupSubmissions?.submissions || 0;
    report.summary.groupsReported = groupSubmissions?.groupsReported || 0;
    report.summary.groupsCredited = groupSubmissions?.groupsCredited || 0;
    report.summary.groupsExcess = groupSubmissions?.groupsExcess || 0;
    report.summary.groupPrAwarded = groupSubmissions?.prAwarded || 0;
    report.groupSubmissions = groupSubmissions;
    recomputeIssueSummary(report);
    return report;
}

module.exports = {
    auditRecruitmentFlow,
    groupSubmissionSummary,
    ledgerAcceptsFractionalValues,
};
