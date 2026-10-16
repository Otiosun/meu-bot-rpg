'use strict';

// Read-only rows 1-30 captured from the canonical local Clover database on
// 2026-10-13. Version 30 is intentionally the live reset-journal migration,
// not the newer skill-tree catalog migration that reused version 30 elsewhere.
const LIVE_SCHEMA_BASE_HISTORY_ATTESTATIONS = Object.freeze([
    Object.freeze({ version: 1, key: '0001_baseline_adoption', checksum: '6d1204018eb0e1fe60d58a4e589843c3a02f3d1e4f9f802f7cb13529b32b82be' }),
    Object.freeze({ version: 2, key: '0002_low_risk_legacy_columns', checksum: 'd768e082ea9de3ca0d48d1b650b2ab9c5e6b1d1953dedc51b67d06df1fbdb8ed' }),
    Object.freeze({ version: 3, key: '0003_bootstrap_metadata_columns', checksum: '3116514d8b663061eb56433b9d9b2c29ca9e5b21a3964c1e2a59a1f1afd56cde' }),
    Object.freeze({ version: 4, key: '0004_market_request_columns', checksum: '234d1c59c95042bfc39a695939bbb5bb8ca151742feb9f129be7a205cf34c0ae' }),
    Object.freeze({ version: 5, key: '0005_quick_evaluation_columns', checksum: '4794ae34c777f0d7543caef3a9cf5ac621020eb6921097596100e67aab9768bb' }),
    Object.freeze({ version: 6, key: '0006_player_roll_columns', checksum: 'f5ee7268bee426efb0327124be599dd9f5864d7c97da3f493f70d34acbee30b4' }),
    Object.freeze({ version: 7, key: '0007_item_template_columns', checksum: '7b46062493e446661e8a2cd92ce9e5f85972b08ed321f17fb68939eb3c27198d' }),
    Object.freeze({ version: 8, key: '0008_inventory_item_columns', checksum: '81fa1be052a65ed325ca835d8a615aa6f031b7432828dd9baaa0d56c33416223' }),
    Object.freeze({ version: 9, key: '0009_admin_service_columns', checksum: '39aa7fbbdd13eb593414db53b13d9f6df103a9b6319aaadd97f0bad27d8dfe48' }),
    Object.freeze({ version: 10, key: '0010_player_profile_columns', checksum: 'daca96dd0e89821fb8649b240df9db74fdd268e337adcad7362698767d38fb6b' }),
    Object.freeze({ version: 11, key: '0011_character_identity_columns', checksum: '734286a3b18577dcd948c842008b6290e4caa59771c7199bafa966a0d8823ca4' }),
    Object.freeze({ version: 12, key: '0012_appearance_moderation_columns', checksum: '5dc5b8d49267068c3e44652d0322e0de5e03d4e1622a6ceb023ac148983cc5ed' }),
    Object.freeze({ version: 13, key: '0013_site_profile_image_columns', checksum: '6f0e52e236263a766bf27ea3fd7d96244393be97282d4d73d836bc68deea527a' }),
    Object.freeze({ version: 14, key: '0014_character_trait_columns', checksum: '1ba0800acc531d4942d08a5567711de80e9ad736e2f99f75ef5b8f8d1dbe529e' }),
    Object.freeze({ version: 15, key: '0015_roll_attempt_state_columns', checksum: 'ada57636dd4f2f40eb9ea6c1ab9ccabac82a5a849a25d12831d3905b25417048' }),
    Object.freeze({ version: 16, key: '0016_story_state_columns', checksum: 'ff96de9eb87cd3ff498bd651d390b94bfc3e1c956570297d7c3cfbace3fcc04b' }),
    Object.freeze({ version: 17, key: '0017_game_state_columns', checksum: 'd138467839cad6c458ee65e3366c54138766e69167a68686230780d7c3eb0b77' }),
    Object.freeze({ version: 18, key: '0018_player_patent_column', checksum: 'ccc5bf2e577b3fa3cd5128060860719186a5ea340ef6a723ff3c2f75f96abea8' }),
    Object.freeze({ version: 19, key: '0019_squad_columns', checksum: '6c596299152e8d5613e1535c25d3d954c65300e1a37da997a7cea7544dea9e86' }),
    Object.freeze({ version: 20, key: '0020_raid_v1_bridge', checksum: 'dc1c52129ddf6764283b5157771564f27e7be4065584fb5956a801a8eace1946' }),
    Object.freeze({ version: 21, key: '0021_raid_v2_columns', checksum: '2f18c04546e1ce26aec670c44e4348589cafc00044358a2c4ab42dc5076ec05b' }),
    Object.freeze({ version: 22, key: '0022_raid_participant_finalization', checksum: '812479ffba91911fc6902c45cbb8ce62d54a33f5bf2f113ed7c1fbbafd2cb638' }),
    Object.freeze({ version: 23, key: '0023_raid_rewards_v2', checksum: '42ac511d0b83e69b8a3c9f79569c24568b1f5ad8e208df120605a62c4c7d5d40' }),
    Object.freeze({ version: 24, key: '0024_raid_monthly_progress', checksum: '33692dae96b9a0c08be308f8119da7454d6bcf167cc270d4c6d6688921dd8caa' }),
    Object.freeze({ version: 25, key: '0025_raid_support_tables', checksum: '88f2a990c9f23377f7a23b91a21bd8370ca2b5b6079f859049d9dcd47c5aa82d' }),
    Object.freeze({ version: 26, key: '0026_raid_idempotency_requests', checksum: 'eead933834f877ed1e4942f4246547f97b8b3f5500884ad497921c38cbf6d580' }),
    Object.freeze({ version: 27, key: '0027_raid_reward_proposal_history', checksum: 'a67687738a3c13dadcba941abc5c42e0f092c4d55d482d662279fd2b25ef6b5d' }),
    Object.freeze({ version: 28, key: '0028_raid_reward_proposal_idempotency', checksum: 'e099cea24c10c0ed7653afd6c0f6058d66446fd5cdae426c379b0d7cb4b9f5c4' }),
    Object.freeze({ version: 29, key: '0029_prereset_character_launch_foundation', checksum: 'a20ebb41b2af7bf0b81cea78916ba793ffea2acfefd7a4a7310339a10f730bda' }),
    Object.freeze({ version: 30, key: '0030_reset_journal_foundation', checksum: '67494c8c8ea4b98f58e3dd55c51baeeaf6852e5fc4b4ae76d3b4dbdb5bcf4cd9' }),
]);

module.exports = { LIVE_SCHEMA_BASE_HISTORY_ATTESTATIONS };
