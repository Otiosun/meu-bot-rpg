'use strict';

const {
    LIVE_SCHEMA_BASE_HISTORY_ATTESTATIONS,
} = require('./liveSchemaBaseHistoryAttestations');

// Read-only attestation captured from the canonical local Clover runtime on
// 2026-10-13. Rows 31-54 belong to the live lineage that continued after the
// reset-journal v30. Never regenerate or renumber these values from current code.
const LIVE_SCHEMA_EXTENSION_ATTESTATIONS = Object.freeze([
    Object.freeze({ version: 31, key: '0031_clover_script_journal_foundation', checksum: '29418f25571671ac832e95c6416bc4342d99c0b289d50e4aeb3948ab2d360af9' }),
    Object.freeze({ version: 32, key: '0032_global_reset_journal_freeze', checksum: '31531297fc47c5545f07cd0348db4e8426c90c39f46fd11baeb20f617f39c9d3' }),
    Object.freeze({ version: 33, key: '0033_global_reset_child_event_guard', checksum: '9879e3452c7dc1693ab15d8e8d1ff055ef781646e4564389f41ceeb33402ed75' }),
    Object.freeze({ version: 34, key: '0034_prereset_transition_decision', checksum: '8c437207c6a75d2e764c92d92042ce858dad99877c8345621ceee17cb02f45b6' }),
    Object.freeze({ version: 35, key: '0035_prereset_campaign_control', checksum: '48218c749614533a55de5af68f2a5b1abbc380cab45594323646abb6975774e7' }),
    Object.freeze({ version: 36, key: '0036_prereset_purge_hardening', checksum: 'cd1cf1c122867e662dd896448ca27ac3ab9bd58f4bf4500a33ee3ecac66446a3' }),
    Object.freeze({ version: 37, key: '0037_prereset_admin_roster_launch', checksum: 'cfc1cc967d97ca94b50ffa87c2a3e0a335c5d09deae39db8e4c8ec80aaaae280' }),
    Object.freeze({ version: 38, key: '0038_prereset_future_rolls', checksum: '7514b242e63ffa10b015855224972ae7312e23b4b85d5b7f8569035133867bc6' }),
    Object.freeze({ version: 39, key: '0039_prereset_future_slot_reservations', checksum: '9c9bc895ae4eb038c200908a31c749ccbe59d3f36d5c7ba2531f3fe54cc1daec' }),
    Object.freeze({ version: 40, key: '0040_return_point_shop_gate', checksum: 'ca6df6e11d7687fde72f13ac9567762b1e1024a489f34bc6e1174c9a4f3ea142' }),
    Object.freeze({ version: 41, key: '0041_return_point_shop_purchases', checksum: '2d473de35941035aa3f8a7a0497379102648225ee36f78c4ed38951b388b25da' }),
    Object.freeze({ version: 42, key: '0042_return_point_shop_eligibility_snapshot', checksum: '82ad1e4cf204c9590fca31571a18a6b1bdf7bdd6482d83e9276fcc9c16c2a333' }),
    Object.freeze({ version: 43, key: '0043_return_point_shop_scoped_auth', checksum: 'eb472ea201df03af8c881c9a94d2bfb3c4da11a554f8d2fc1c6338d54a9eb814' }),
    Object.freeze({ version: 44, key: '0044_return_shop_manual_obligations', checksum: '1d301c80c27ce0d6eb2653378de63482bd465ebc8ff084d5e33477c0fec9baf0' }),
    Object.freeze({ version: 45, key: '0045_return_shop_custom_item_requests', checksum: 'b763d07db42698dca283b140a408ef4463da921fb975c9cdf660b85305788b3c' }),
    Object.freeze({ version: 46, key: '0046_pr_pv_supplement_carry', checksum: '67f6b66c67ac8b2d3fb0ddfa70f33d391f00fed485e2164fa00bf56a2d906098' }),
    Object.freeze({ version: 47, key: '0047_core_v2_attribute_rebaseline_foundation', checksum: 'cd135a61d0a9f86a71dc18a2dc57cc409052257231f2c483b2d21125ccc62ea8' }),
    Object.freeze({ version: 48, key: '0048_core_v2_tree_migration_receipts', checksum: 'b3826548caeb4db473261c75b09f38a85217bae385d377b4adb27524e1f8ec2d' }),
    Object.freeze({ version: 49, key: '0049_core_v2_spell_mechanics', checksum: '76e838d041370f14e51fa9c0d8caa9e101f0b91fa8cf955ef1afaac92f2b8858' }),
    Object.freeze({ version: 50, key: '0050_core_v2_spell_approval_receipts', checksum: 'e8d4cd5b0e7f685b02f6ff3f50d41ef8a6af01f4ad066dea247efa9c558bd841' }),
    Object.freeze({ version: 51, key: '0051_profile_presentation_preferences', checksum: 'cfc92e139a53037b0e584e34ccdfb3b3d59be1f9bafc7b27d77d0234e29cb566' }),
    Object.freeze({ version: 52, key: '0052_profile_media', checksum: '403ac9570d370f7e7891172bd3ccaa2ca2e1c8df6286c3b246109d2bc5166537' }),
    Object.freeze({ version: 53, key: '0053_mana_hexagon_v4_axes', checksum: 'f86a1c6d6a651f97de36bf37f49696844fa626f29fab891a62cdcd764f7837a7' }),
    Object.freeze({ version: 54, key: '0054_admin_trait_profile_sync_v2', checksum: '9b29ea6ed99562432ffe6c801358e6f20433fc256282452b2a75dc5a8eaf1ace' }),
]);

const LIVE_SCHEMA_HISTORY_ATTESTATIONS = Object.freeze([
    ...LIVE_SCHEMA_BASE_HISTORY_ATTESTATIONS,
    ...LIVE_SCHEMA_EXTENSION_ATTESTATIONS,
]);

module.exports = {
    LIVE_SCHEMA_EXTENSION_ATTESTATIONS,
    LIVE_SCHEMA_HISTORY_ATTESTATIONS,
};
