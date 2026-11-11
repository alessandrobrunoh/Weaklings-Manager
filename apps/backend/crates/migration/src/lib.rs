//! Database migrations runner module.
//!
//! Registers and executes all `SeaORM` database schema updates.

// Items became `pub` when the backend was split into crates; documenting them is a follow-up.
#![allow(
    missing_docs,
    clippy::missing_errors_doc,
    clippy::must_use_candidate,
    clippy::missing_panics_doc
)]
#![recursion_limit = "256"]

pub use sea_orm_migration::prelude::*;

pub mod control;
pub mod m20260708_000001_create_users_table;
pub mod m20260708_000002_create_roles_table;
pub mod m20260709_000001_create_splits_table;
pub mod m20260709_000002_create_split_participants_table;
pub mod m20260709_000003_create_transactions_table;
pub mod m20260709_000004_create_albion_links_table;
pub mod m20260709_000005_add_requested_at_to_transactions;
pub mod m20260710_000001_create_role_permissions;
pub mod m20260710_000002_seed_comps_permissions;
pub mod m20260710_000003_create_build_categories_table;
pub mod m20260710_000004_create_comp_categories_table;
pub mod m20260710_000005_create_builds_table;
pub mod m20260710_000006_create_build_items_table;
pub mod m20260710_000007_create_comps_table;
pub mod m20260710_000008_create_comp_builds_table;
pub mod m20260711_000001_add_parent_id_to_comps;
pub mod m20260711_000002_create_events_table;
pub mod m20260711_000003_create_event_participations_table;
pub mod m20260711_000004_seed_events_permissions;
pub mod m20260712_000001_add_discord_id_to_users;
pub mod m20260713_000001_extend_events_with_session;
pub mod m20260713_000002_create_event_battles;
pub mod m20260811_000001_create_siphoned_energy_entries_table;
pub mod m20260811_000002_seed_siphoned_permissions;
pub mod m20260811_000003_enrich_event_battles;
pub mod m20260811_000004_link_splits_to_events;
pub mod m20260811_000005_create_guild_battle_snapshots;
pub mod m20260811_000006_create_audit_logs_table;
pub mod m20260812_000001_add_call_to_arms_to_events;
pub mod m20260812_000002_create_regear_tables;
pub mod m20260812_000003_seed_regear_permissions;
pub mod m20260823_000001_create_scouted_comps;
pub mod m20260823_000002_seed_intel_permissions;
pub mod m20260824_000001_widen_scouted_comp_fingerprint;
pub mod m20260825_000001_create_guild_settings;
pub mod m20260825_000002_seed_guild_settings_permission;
pub mod m20260826_000001_create_progression_tables;
pub mod m20260826_000002_seed_progression_permissions;
pub mod m20260826_000003_create_vod_and_warn_tables;
pub mod m20260829_000001_roles_discord_link;
pub mod m20260829_000002_add_auto_role_setting;
pub mod m20260829_000003_create_split_islands;
pub mod m20260829_000004_seed_split_islands_permission;
pub mod m20260829_000005_add_island_tab_id_to_splits;
pub mod m20260830_000001_create_notifications;
pub mod m20260830_000002_seed_notifications_broadcast_permission;
pub mod m20260831_000001_add_guild_bank_destination;
pub mod m20260831_000002_seed_officer_operations_permissions;
pub mod m20260831_000003_add_regear_to_events;
pub mod m20260831_000004_add_split_forum_channel;
pub mod m20260831_000005_add_split_discord_sync;
pub mod m20260831_000006_create_user_specializations;
pub mod m20260831_000007_seed_user_specialization_permission;
pub mod m20260831_000008_create_event_discord_roles;
pub mod m20260831_000009_decimal_split_participant_weights;
pub mod m20260831_000010_add_fee_to_splits;
pub mod m20260901_000001_add_version_and_identity_uniqueness;
pub mod m20260901_000002_add_loadout_to_build_items;
pub mod m20260901_000003_create_build_item_spells;
pub mod m20260901_000004_add_event_voice_category;
pub mod m20260901_000005_add_event_voice_channel;
pub mod m20260901_000006_create_fights;
pub mod m20260901_000007_create_event_roster_roles;
pub mod m20260901_000008_seed_fights_permissions;
pub mod m20260901_000009_allow_fill_event_participations;
pub mod m20260901_000010_create_event_roster_assignments;
pub mod m20260901_000011_add_player_cap_to_events;
pub mod m20260901_000012_enforce_roster_participation_fk;
pub mod m20260902_000001_seed_events_granular_permissions;
pub mod m20260902_000002_seed_comps_granular_permissions;
pub mod m20260902_000003_seed_fights_granular_permissions;
pub mod m20260902_000004_seed_splits_granular_permissions;
pub mod m20260902_000005_seed_intel_granular_permissions;
pub mod m20260902_000006_seed_progression_granular_permissions;
pub mod m20260902_000007_seed_bank_transactions_permissions;
pub mod m20260902_000008_add_scouted_comps_unique_index;
pub mod m20260902_000009_fix_fill_participation_nullability;
pub mod m20260902_000010_add_archived_at_to_builds_and_comps;
pub mod m20260902_000011_add_default_split_fee;
pub mod m20260902_000011_add_split_forum_tag_ids;
pub mod m20260902_000012_add_event_mass_start_times;
pub mod m20260903_000001_add_discord_application_settings;
pub mod m20260903_000002_create_discord_applications;
pub mod m20260903_000003_add_discord_application_welcome_copy;
pub mod m20260903_000004_add_discord_application_status_copy;
pub mod m20260903_000005_add_discord_application_panel_message;
pub mod m20260903_000006_add_discord_application_workflow_copy;
pub mod m20260903_000007_seed_applications_manage_permission;
pub mod m20260904_000001_add_quality_to_build_items;
pub mod m20260904_000002_add_giveaway_discord_settings;
pub mod m20260904_000003_create_giveaways;
pub mod m20260904_000004_seed_giveaways_permissions;
pub mod m20260904_000005_archive_events_and_splits;
pub mod m20260905_000001_add_enchantment_to_build_items;
pub mod m20260905_000002_seed_combat_permissions;
pub mod m20260906_000001_roles_staff_flags;
pub mod m20260906_000002_create_split_bags;
pub mod m20260906_000003_create_combat_scenarios;
pub mod m20260906_000004_create_combat_runs;
pub mod m20260906_000005_seed_combat_tests_permissions;
pub mod m20260907_000001_seed_combat_calibration_permission;
pub mod m20260907_000002_add_application_accepted_role;
pub mod m20260907_000003_add_brand_colors;
pub mod m20260907_000004_reopenable_applications;
pub mod m20260908_000001_regear_request_credits;
pub mod m20260908_000002_regear_self_service_source;
pub mod m20260908_000003_add_giveaway_regear_bonus;
pub mod m20260908_000004_create_battle_evidence_tables;
pub mod m20260908_000005_create_enemy_identity_tables;
pub mod m20260908_000006_seed_enemy_intel_permission;
pub mod m20260908_000007_create_fingerprint_tables;
pub mod m20260908_000008_create_battle_loss_estimates;
pub mod m20260908_000009_create_fight_stats;
pub mod m20260908_000010_create_attention_findings;
pub mod m20260909_000001_drop_event_battles_analytics_columns;
pub mod m20260910_000001_scope_build_comp_identity_to_creator;
pub mod m20260916_000001_add_discord_alliance_role;
pub mod m20260916_000002_seed_alliance_share_permission;
pub mod m20260916_000003_add_event_alliance_ping;
pub mod m20260917_000001_add_split_origin_read_only;
pub mod m20260918_000001_create_trials;
pub mod m20260918_000002_enforce_positive_transaction_amount;
pub mod m20260922_000004_create_discord_tickets;
pub mod m20260922_000005_add_discord_ticket_settings;
pub mod m20261026_000001_add_event_kind_to_events;
pub mod m20261026_000002_add_flash_mass_channel_setting;
pub mod m20261026_000003_add_event_timezone_setting;
pub mod m20261027_000001_add_event_vod_forum_posts;
pub mod m20261027_000002_add_progression_guild_ranks;
pub mod m20261028_000001_create_siphoned_settlement_quotes;
pub mod m20261028_000002_create_event_completion_xp_outbox;
pub mod m20261028_000003_add_event_discord_delivery;
pub mod m20261028_000004_guild_event_delivery;
pub mod m20261029_000001_add_event_source_identity;
pub mod m20261103_000001_add_alliance_distribution_key;
pub mod m20261105_000001_regear_self_report_unique;
pub mod m20261106_000001_add_split_needs_resync;
pub mod m20261106_000002_add_split_roster_locked;
pub mod m20261106_000003_index_event_battles_albionbb_battle_id;
pub mod m20261106_000003_users_member_lifecycle;
pub mod m20261106_000004_users_provisioned_via_data_fix;
pub mod m20261107_000001_create_discord_delivery;
pub mod m20261107_000001_create_sync_tables;
pub mod m20261107_000002_add_event_mass_notified_at;
pub mod m20261107_000002_create_action_log;
pub mod m20261107_000002_seed_sync_permissions;
pub mod m20261107_000003_add_event_reminder_notified_at;
pub mod m20261107_000004_backfill_event_discord_stamps;
pub mod m20261109_000001_grant_comp_build_manage_to_editors;
pub mod m20261109_000002_create_albion_link_requests;
pub mod m20261110_000001_restrict_manage_to_admins;
#[cfg(any(test, feature = "test-support"))]
pub mod testkit;

/// Main migrator coordinating the sequential execution of registered migration scripts.
pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            Box::new(m20260708_000001_create_users_table::Migration),
            Box::new(m20260708_000002_create_roles_table::Migration),
            Box::new(m20260709_000001_create_splits_table::Migration),
            Box::new(m20260709_000002_create_split_participants_table::Migration),
            Box::new(m20260709_000003_create_transactions_table::Migration),
            Box::new(m20260709_000004_create_albion_links_table::Migration),
            Box::new(m20260709_000005_add_requested_at_to_transactions::Migration),
            Box::new(m20260710_000001_create_role_permissions::Migration),
            Box::new(m20260710_000002_seed_comps_permissions::Migration),
            Box::new(m20260710_000003_create_build_categories_table::Migration),
            Box::new(m20260710_000004_create_comp_categories_table::Migration),
            Box::new(m20260710_000005_create_builds_table::Migration),
            Box::new(m20260710_000006_create_build_items_table::Migration),
            Box::new(m20260710_000007_create_comps_table::Migration),
            Box::new(m20260710_000008_create_comp_builds_table::Migration),
            Box::new(m20260711_000001_add_parent_id_to_comps::Migration),
            Box::new(m20260711_000002_create_events_table::Migration),
            Box::new(m20260711_000003_create_event_participations_table::Migration),
            Box::new(m20260711_000004_seed_events_permissions::Migration),
            Box::new(m20260712_000001_add_discord_id_to_users::Migration),
            Box::new(m20260713_000001_extend_events_with_session::Migration),
            Box::new(m20260713_000002_create_event_battles::Migration),
            Box::new(m20260811_000001_create_siphoned_energy_entries_table::Migration),
            Box::new(m20260811_000002_seed_siphoned_permissions::Migration),
            Box::new(m20260811_000003_enrich_event_battles::Migration),
            Box::new(m20260811_000004_link_splits_to_events::Migration),
            Box::new(m20260811_000005_create_guild_battle_snapshots::Migration),
            Box::new(m20260811_000006_create_audit_logs_table::Migration),
            Box::new(m20260812_000001_add_call_to_arms_to_events::Migration),
            Box::new(m20260812_000002_create_regear_tables::Migration),
            Box::new(m20260812_000003_seed_regear_permissions::Migration),
            Box::new(m20260823_000001_create_scouted_comps::Migration),
            Box::new(m20260823_000002_seed_intel_permissions::Migration),
            Box::new(m20260824_000001_widen_scouted_comp_fingerprint::Migration),
            Box::new(m20260825_000001_create_guild_settings::Migration),
            Box::new(m20260825_000002_seed_guild_settings_permission::Migration),
            Box::new(m20260826_000001_create_progression_tables::Migration),
            Box::new(m20260826_000002_seed_progression_permissions::Migration),
            Box::new(m20260826_000003_create_vod_and_warn_tables::Migration),
            Box::new(m20260829_000001_roles_discord_link::Migration),
            Box::new(m20260829_000002_add_auto_role_setting::Migration),
            Box::new(m20260829_000003_create_split_islands::Migration),
            Box::new(m20260829_000004_seed_split_islands_permission::Migration),
            Box::new(m20260829_000005_add_island_tab_id_to_splits::Migration),
            Box::new(m20260830_000001_create_notifications::Migration),
            Box::new(m20260830_000002_seed_notifications_broadcast_permission::Migration),
            Box::new(m20260831_000001_add_guild_bank_destination::Migration),
            Box::new(m20260831_000002_seed_officer_operations_permissions::Migration),
            Box::new(m20260831_000003_add_regear_to_events::Migration),
            Box::new(m20260831_000004_add_split_forum_channel::Migration),
            Box::new(m20260831_000005_add_split_discord_sync::Migration),
            Box::new(m20260831_000006_create_user_specializations::Migration),
            Box::new(m20260831_000007_seed_user_specialization_permission::Migration),
            Box::new(m20260831_000008_create_event_discord_roles::Migration),
            Box::new(m20260831_000009_decimal_split_participant_weights::Migration),
            Box::new(m20260831_000010_add_fee_to_splits::Migration),
            Box::new(m20260901_000001_add_version_and_identity_uniqueness::Migration),
            Box::new(m20260901_000002_add_loadout_to_build_items::Migration),
            Box::new(m20260901_000003_create_build_item_spells::Migration),
            Box::new(m20260901_000004_add_event_voice_category::Migration),
            Box::new(m20260901_000005_add_event_voice_channel::Migration),
            Box::new(m20260901_000006_create_fights::Migration),
            Box::new(m20260901_000007_create_event_roster_roles::Migration),
            Box::new(m20260901_000008_seed_fights_permissions::Migration),
            Box::new(m20260901_000009_allow_fill_event_participations::Migration),
            Box::new(m20260901_000010_create_event_roster_assignments::Migration),
            Box::new(m20260901_000011_add_player_cap_to_events::Migration),
            Box::new(m20260901_000012_enforce_roster_participation_fk::Migration),
            Box::new(m20260902_000001_seed_events_granular_permissions::Migration),
            Box::new(m20260902_000002_seed_comps_granular_permissions::Migration),
            Box::new(m20260902_000003_seed_fights_granular_permissions::Migration),
            Box::new(m20260902_000004_seed_splits_granular_permissions::Migration),
            Box::new(m20260902_000005_seed_intel_granular_permissions::Migration),
            Box::new(m20260902_000006_seed_progression_granular_permissions::Migration),
            Box::new(m20260902_000007_seed_bank_transactions_permissions::Migration),
            Box::new(m20260902_000008_add_scouted_comps_unique_index::Migration),
            Box::new(m20260902_000009_fix_fill_participation_nullability::Migration),
            Box::new(m20260902_000010_add_archived_at_to_builds_and_comps::Migration),
            Box::new(m20260902_000011_add_split_forum_tag_ids::Migration),
            Box::new(m20260902_000011_add_default_split_fee::Migration),
            Box::new(m20260902_000012_add_event_mass_start_times::Migration),
            Box::new(m20260903_000001_add_discord_application_settings::Migration),
            Box::new(m20260903_000002_create_discord_applications::Migration),
            Box::new(m20260903_000003_add_discord_application_welcome_copy::Migration),
            Box::new(m20260903_000004_add_discord_application_status_copy::Migration),
            Box::new(m20260903_000005_add_discord_application_panel_message::Migration),
            Box::new(m20260903_000006_add_discord_application_workflow_copy::Migration),
            Box::new(m20260903_000007_seed_applications_manage_permission::Migration),
            Box::new(m20260904_000001_add_quality_to_build_items::Migration),
            Box::new(m20260904_000002_add_giveaway_discord_settings::Migration),
            Box::new(m20260904_000003_create_giveaways::Migration),
            Box::new(m20260904_000004_seed_giveaways_permissions::Migration),
            Box::new(m20260904_000005_archive_events_and_splits::Migration),
            Box::new(m20260905_000001_add_enchantment_to_build_items::Migration),
            Box::new(m20260905_000002_seed_combat_permissions::Migration),
            Box::new(m20260906_000001_roles_staff_flags::Migration),
            Box::new(m20260906_000002_create_split_bags::Migration),
            Box::new(m20260906_000003_create_combat_scenarios::Migration),
            Box::new(m20260906_000004_create_combat_runs::Migration),
            Box::new(m20260906_000005_seed_combat_tests_permissions::Migration),
            Box::new(m20260907_000001_seed_combat_calibration_permission::Migration),
            Box::new(m20260907_000002_add_application_accepted_role::Migration),
            Box::new(m20260907_000003_add_brand_colors::Migration),
            Box::new(m20260907_000004_reopenable_applications::Migration),
            Box::new(m20260908_000001_regear_request_credits::Migration),
            Box::new(m20260908_000002_regear_self_service_source::Migration),
            Box::new(m20260908_000003_add_giveaway_regear_bonus::Migration),
            Box::new(m20260908_000004_create_battle_evidence_tables::Migration),
            Box::new(m20260908_000005_create_enemy_identity_tables::Migration),
            Box::new(m20260908_000006_seed_enemy_intel_permission::Migration),
            Box::new(m20260908_000007_create_fingerprint_tables::Migration),
            Box::new(m20260908_000008_create_battle_loss_estimates::Migration),
            Box::new(m20260908_000009_create_fight_stats::Migration),
            Box::new(m20260908_000010_create_attention_findings::Migration),
            Box::new(m20260909_000001_drop_event_battles_analytics_columns::Migration),
            Box::new(m20260910_000001_scope_build_comp_identity_to_creator::Migration),
            Box::new(m20260916_000001_add_discord_alliance_role::Migration),
            Box::new(m20260916_000002_seed_alliance_share_permission::Migration),
            Box::new(m20260916_000003_add_event_alliance_ping::Migration),
            Box::new(m20260917_000001_add_split_origin_read_only::Migration),
            Box::new(m20260918_000001_create_trials::Migration),
            Box::new(m20260918_000002_enforce_positive_transaction_amount::Migration),
            Box::new(m20260922_000004_create_discord_tickets::Migration),
            Box::new(m20260922_000005_add_discord_ticket_settings::Migration),
            Box::new(m20261026_000001_add_event_kind_to_events::Migration),
            Box::new(m20261026_000002_add_flash_mass_channel_setting::Migration),
            Box::new(m20261026_000003_add_event_timezone_setting::Migration),
            Box::new(m20261027_000001_add_event_vod_forum_posts::Migration),
            Box::new(m20261027_000002_add_progression_guild_ranks::Migration),
            Box::new(m20261028_000001_create_siphoned_settlement_quotes::Migration),
            Box::new(m20261028_000002_create_event_completion_xp_outbox::Migration),
            Box::new(m20261028_000003_add_event_discord_delivery::Migration),
            Box::new(m20261028_000004_guild_event_delivery::Migration),
            Box::new(m20261029_000001_add_event_source_identity::Migration),
            Box::new(m20261103_000001_add_alliance_distribution_key::Migration),
            Box::new(m20261105_000001_regear_self_report_unique::Migration),
            Box::new(m20261106_000001_add_split_needs_resync::Migration),
            Box::new(m20261106_000002_add_split_roster_locked::Migration),
            Box::new(m20261106_000003_users_member_lifecycle::Migration),
            Box::new(m20261106_000004_users_provisioned_via_data_fix::Migration),
            Box::new(m20261106_000003_index_event_battles_albionbb_battle_id::Migration),
            Box::new(m20261107_000001_create_discord_delivery::Migration),
            Box::new(m20261107_000001_create_sync_tables::Migration),
            Box::new(m20261107_000002_add_event_mass_notified_at::Migration),
            Box::new(m20261107_000002_create_action_log::Migration),
            Box::new(m20261107_000002_seed_sync_permissions::Migration),
            Box::new(m20261107_000003_add_event_reminder_notified_at::Migration),
            Box::new(m20261107_000004_backfill_event_discord_stamps::Migration),
            Box::new(m20261109_000001_grant_comp_build_manage_to_editors::Migration),
            Box::new(m20261109_000002_create_albion_link_requests::Migration),
            Box::new(m20261110_000001_restrict_manage_to_admins::Migration),
        ]
    }
}
