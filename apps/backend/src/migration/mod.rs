//! Database migrations runner module.
//!
//! Registers and executes all `SeaORM` database schema updates.

pub use sea_orm_migration::prelude::*;

mod m20260708_000001_create_users_table;
mod m20260708_000002_create_roles_table;
mod m20260709_000001_create_splits_table;
mod m20260709_000002_create_split_participants_table;
mod m20260709_000003_create_transactions_table;
mod m20260709_000004_create_albion_links_table;
mod m20260709_000005_add_requested_at_to_transactions;
mod m20260710_000001_create_role_permissions;
mod m20260710_000002_seed_comps_permissions;
mod m20260710_000003_create_build_categories_table;
mod m20260710_000004_create_comp_categories_table;
mod m20260710_000005_create_builds_table;
mod m20260710_000006_create_build_items_table;
mod m20260710_000007_create_comps_table;
mod m20260710_000008_create_comp_builds_table;
mod m20260711_000001_add_parent_id_to_comps;
mod m20260711_000002_create_events_table;
mod m20260711_000003_create_event_participations_table;
mod m20260711_000004_seed_events_permissions;
mod m20260712_000001_add_discord_id_to_users;
mod m20260713_000001_extend_events_with_session;
mod m20260713_000002_create_event_battles;
mod m20260811_000001_create_siphoned_energy_entries_table;
mod m20260811_000002_seed_siphoned_permissions;
mod m20260811_000003_enrich_event_battles;
mod m20260811_000004_link_splits_to_events;
mod m20260811_000005_create_guild_battle_snapshots;
mod m20260811_000006_create_audit_logs_table;
mod m20260812_000001_add_call_to_arms_to_events;
mod m20260812_000002_create_regear_tables;
mod m20260812_000003_seed_regear_permissions;
mod m20260823_000001_create_scouted_comps;
mod m20260823_000002_seed_intel_permissions;
mod m20260824_000001_widen_scouted_comp_fingerprint;
mod m20260825_000001_create_guild_settings;
mod m20260825_000002_seed_guild_settings_permission;
mod m20260826_000001_create_progression_tables;
mod m20260826_000002_seed_progression_permissions;
mod m20260826_000003_create_vod_and_warn_tables;
mod m20260829_000001_roles_discord_link;
mod m20260829_000002_add_auto_role_setting;
mod m20260829_000003_create_split_islands;
mod m20260829_000004_seed_split_islands_permission;
mod m20260829_000005_add_island_tab_id_to_splits;
mod m20260830_000001_create_notifications;
mod m20260830_000002_seed_notifications_broadcast_permission;
mod m20260831_000001_add_guild_bank_destination;
mod m20260831_000002_seed_officer_operations_permissions;
mod m20260831_000003_add_regear_to_events;
mod m20260831_000004_add_split_forum_channel;
mod m20260831_000005_add_split_discord_sync;
mod m20260831_000006_create_user_specializations;
mod m20260831_000007_seed_user_specialization_permission;

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
        ]
    }
}
