'use strict';

const SCENE_EVALUATION_ACCOUNTING_VERSION = 32;
const SCENE_EVALUATION_ACCOUNTING_KEY = '0032_scene_evaluation_void_accounting';

const VOID_ACCOUNTING_TRIGGER_SQL = `
CREATE TRIGGER IF NOT EXISTS trg_quick_eval_void_accounting_bridge
AFTER UPDATE OF status ON clover_quick_evaluations
WHEN OLD.status <> 'voided' AND NEW.status = 'voided'
BEGIN
    UPDATE clover_quick_evaluations
    SET bypass_weekly_limit = 1,
        metadata_json = json_set(
            CASE
                WHEN json_valid(COALESCE(metadata_json, '{}')) THEN COALESCE(metadata_json, '{}')
                ELSE '{}'
            END,
            '$.voided_by_correction', 1,
            '$.original_bypass_weekly_limit', OLD.bypass_weekly_limit
        )
    WHERE id = NEW.id;
END`;

const SCENE_EVALUATION_ACCOUNTING_MIGRATION = Object.freeze({
    version: SCENE_EVALUATION_ACCOUNTING_VERSION,
    key: SCENE_EVALUATION_ACCOUNTING_KEY,
    description: 'Faz o fluxo semanal legado ignorar avaliacoes anuladas sem apagar valores historicos.',
    checksumMaterial: Object.freeze({
        trigger: VOID_ACCOUNTING_TRIGGER_SQL.replace(/\s+/g, ' ').trim(),
        invariant: 'voided-evaluation-does-not-consume-weekly-ph-or-modality-use',
        revision: 'scene-evaluation-void-accounting-v1',
    }),
    async up(db) {
        await db.exec(VOID_ACCOUNTING_TRIGGER_SQL);
    },
});

module.exports = {
    SCENE_EVALUATION_ACCOUNTING_KEY,
    SCENE_EVALUATION_ACCOUNTING_MIGRATION,
    SCENE_EVALUATION_ACCOUNTING_VERSION,
    VOID_ACCOUNTING_TRIGGER_SQL,
};
