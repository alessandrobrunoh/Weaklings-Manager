//! `OpenAPI` generation module.
//!
//! Exposes the `OpenApi` specification for all modular endpoints in the backend.

use axum::{Json, response::IntoResponse};
use utoipa::OpenApi;

/// `OpenAPI` documentation structure containing API metadata, paths, and components.
#[derive(OpenApi)]
#[openapi(
    paths(
        backend_identity::capabilities::router::me_capabilities,
        backend_identity::capabilities::router::tenant_capabilities,
        backend_events::actions::router::get_action_catalog,
        backend_events::actions::router::list_event_actions,
        backend_events::actions::router::list_event_collection_actions,
        backend_events::actions::router::run_event_action,
        backend_events::actions::router::run_event_collection_action,
        backend_identity::audit::router::list_audit_logs,
        backend_identity::users::router::get_my_profile,
        backend_identity::members::router::ensure_member,
        backend_identity::users::router::get_my_metrics,
        backend_identity::users::router::list_users,
        backend_identity::users::router::get_user,
        backend_identity::users::router::get_user_roles,
        backend_identity::users::router::post_user_role,
        backend_identity::users::router::delete_user_role,
        backend_identity::users::router::block_user,
        backend_identity::users::router::unblock_user,
        backend_identity::users::router::create_user,
        backend_combat::user_weapons::get_my_weapons,
        backend_combat::user_weapons::update_my_weapons,
        backend_combat::user_weapons::get_user_weapons,
        backend_combat::user_weapons::update_user_weapons,
        backend_identity::auth::router::discord_login,
        backend_identity::auth::router::discord_callback,
        backend_identity::auth::router::pending_tenants,
        backend_identity::auth::router::select_tenant,
        backend_identity::auth::router::list_session_tenants,
        backend_identity::auth::router::list_registerable_guilds,
        backend_identity::auth::router::bot_invite,
        backend_identity::admin::router::get_branding,
        backend_identity::admin::router::update_branding,
        backend_identity::auth::router::switch_tenant,
        backend_identity::auth::router::get_me,
        backend_identity::auth::router::logout,
        backend_identity::auth::router::logout_all,
        backend_bank::router::get_balance,
        backend_bank::router::get_guild_summary,
        backend_bank::router::get_admin_summary,
        backend_bank::router::list_transactions,
        backend_bank::router::withdraw,
        backend_bank::router::accept_withdrawal,
        backend_bank::router::create_transaction,
        backend_bank::router::update_transaction,
        backend_bank::router::delete_transaction,
        backend_splits::router::create_split,
        backend_splits::router::list_splits,
        backend_splits::router::split_kpi_summary,
        backend_splits::router::get_split,
        backend_splits::router::list_islands,
        backend_splits::router::create_island,
        backend_splits::router::update_island,
        backend_splits::router::delete_island,
        backend_splits::router::add_island_tab,
        backend_splits::router::update_island_tab,
        backend_splits::router::delete_island_tab,
        backend_splits::router::add_or_update_participant,
        backend_splits::router::remove_participant,
        backend_splits::router::complete_split,
        backend_splits::router::alliance_distribution_status,
        backend_splits::router::archive_split,
        backend_splits::router::unarchive_split,
        backend_splits::router::donate_split_share,
        backend_splits::router::not_completed_split,
        backend_splits::router::lost_split,
        backend_identity::albion::router::get_guild_roster,
        backend_identity::albion::router::search,
        backend_identity::albion::router::get_player,
        backend_identity::albion::router::get_guild,
        backend_identity::albion::router::get_link_status,
        backend_identity::albion::router::link_player,
        backend_identity::albion::router::register_by_ign,
        backend_identity::albion::router::unlink_player,
        backend_identity::albion::router::get_user_link_status,
        backend_identity::albion::router::admin_link_user_handler,
        backend_identity::albion::router::admin_unlink_user_handler,
        backend_albion_data::openalbion::router::list_weapons,
        backend_albion_data::openalbion::router::get_weapon_stats,
        backend_albion_data::openalbion::router::list_categories,
        backend_albion_data::openalbion::router::list_items,
        backend_albion_data::openalbion::router::get_catalog,
        backend_albion_data::openalbion::router::get_abilities,
        backend_comps::router::set_build_item_spells,
        backend_comps::router::create_build_version,
        backend_comps::router::create_comp_version,
        backend_events::events::comp_routes::get_build_performance,
        backend_combat::comp_routes::get_build_item_power,
        backend_comps::router::get_build_price,
        backend_comps::router::get_comp_price,
        backend_combat::router::get_dataset,
        backend_combat::router::post_simulate,
        backend_combat::router::post_item_power,
        backend_combat::router::list_scenarios,
        backend_combat::router::create_scenario,
        backend_combat::router::get_scenario,
        backend_combat::router::update_scenario,
        backend_combat::router::create_scenario_version,
        backend_combat::router::archive_scenario,
        backend_combat::router::unarchive_scenario,
        backend_combat::router::run_scenario,
        backend_combat::router::list_runs,
        backend_combat::router::get_run,
        backend_albion_data::albiondata::router::get_prices,
        backend_albion_data::albiondata::router::get_item_icon,
        backend_identity::admin::router::reload_permissions,
        backend_comps::router::list_build_categories,
        backend_comps::router::create_build_category,
        backend_comps::router::update_build_category,
        backend_comps::router::delete_build_category,
        backend_comps::router::list_comp_categories,
        backend_comps::router::create_comp_category,
        backend_comps::router::update_comp_category,
        backend_comps::router::delete_comp_category,
        backend_comps::router::list_builds,
        backend_comps::router::create_build,
        backend_comps::router::get_build,
        backend_comps::router::update_build,
        backend_comps::router::delete_build,
        backend_comps::router::upsert_build_item,
        backend_comps::router::remove_build_item,
        backend_comps::router::list_comps,
        backend_comps::router::create_comp,
        backend_comps::router::get_comp,
        backend_events::events::comp_routes::get_comp_performance,
        backend_comps::router::update_comp,
        backend_comps::router::delete_comp,
        backend_comps::router::add_comp_build,
        backend_comps::router::update_comp_build_quantity,
        backend_comps::router::remove_comp_build,
        backend_events::events::router::list_events,
        backend_events::events::router::list_event_calendar,
        backend_events::events::router::get_events_summary,
        backend_events::events::router::list_event_revisions,
        backend_events::events::router::get_event,
        backend_events::events::router::get_roster_suggestions,
        backend_events::events::router::list_event_roster_roles,
        backend_events::events::router::create_event_roster_role,
        backend_events::events::router::delete_event_roster_role,
        backend_events::events::router::create_event_party,
        backend_events::events::router::update_event_party,
        backend_events::events::router::delete_event_party,
        backend_events::events::router::reorder_event_parties,
        backend_events::events::router::create_event,
        backend_events::events::router::get_event_fanout_status,
        backend_events::events::router::get_event_mirror_status,
        backend_events::events::router::retry_event_mirror,
        backend_events::events::router::list_event_discord_roles,
        backend_events::events::router::update_event,
        backend_events::events::router::delete_event,
        backend_events::events::router::archive_event,
        backend_events::events::router::unarchive_event,
        backend_events::events::router::participate,
        backend_events::events::router::get_participation_guilds,
        backend_events::events::router::add_event_member,
        backend_events::events::router::cancel_participation,
        backend_events::events::router::remind_event,
        backend_events::events::router::get_event_management_authority,
        backend_events::events::router::set_event_voice_channel,
        backend_events::events::router::clear_event_voice_channel,
        backend_events::events::router::start_event,
        backend_events::events::router::cancel_event,
        backend_events::events::router::uncancel_event,
        backend_events::events::router::stop_event,
        backend_events::events::router::list_event_battles,
        backend_events::events::router::replace_event_battles,
        backend_splits::router::match_participants,
        crate::modules::utils::router::ocr_image,
        backend_albion_data::albionbb::router::list_battles,
        backend_albion_data::albionbb::router::get_battle,
        backend_albion_data::albionbb::router::get_battle_kills,
        backend_albion_data::albionbb::router::get_guild,
        backend_albion_data::albionbb::router::get_player_stats,
        backend_battles::battles::router::list_battles,
        backend_battles::battles::router::get_battle,
        backend_battles::battles::router::list_my_battles,
        backend_rewards::siphoned::router::ingest,
        backend_rewards::siphoned::router::list_entries,
        backend_rewards::siphoned::router::create_entry,
        backend_rewards::siphoned::router::update_entry,
        backend_rewards::siphoned::router::delete_entry,
        backend_rewards::siphoned::router::list_balances,
        backend_rewards::siphoned::router::get_balance,
        backend_rewards::siphoned::router::list_batches,
        backend_rewards::siphoned::router::delete_batch,
        backend_rewards::siphoned::router::create_settlement_quote,
        backend_rewards::siphoned::router::confirm_settlement_quote,
        backend_regear::router::list_deaths,
        backend_regear::router::get_death,
        backend_regear::router::request_regear,
        backend_regear::router::list_pending_requests,
        backend_regear::router::accept_request,
        backend_regear::router::reject_request,
        backend_regear::router::list_event_deaths,
        backend_regear::router::run_extraction,
        backend_regear::router::get_settings,
        backend_regear::router::update_settings,
        backend_regear::router::get_my_summary,
        backend_regear::router::get_self_service_events,
        backend_regear::router::create_self_service_request,
        backend_intel::router::list_scouts,
        backend_intel::router::get_scout,
        backend_intel::router::update_scout,
        backend_intel::router::delete_scout,
        backend_intel::router::scout_battle,
        backend_intel::router::similar_scouts,
        backend_intel::router::counters,
        backend_intel::router::threats_to_comp,
        backend_intel::router::matchup_matrix,
        backend_identity::admin::router::get_permission_matrix,
        backend_identity::admin::router::update_role_permissions,
        backend_identity::admin::router::create_role,
        backend_identity::admin::router::update_role,
        backend_identity::admin::router::delete_role,
        backend_identity::admin::router::list_guild_discord_roles,
        backend_identity::admin::router::list_guild_discord_channels,
        backend_identity::admin::router::list_guild_discord_members,
        backend_identity::admin::router::get_guild_settings,
        backend_identity::admin::router::update_guild_settings,
        backend_identity::admin::router::get_autorole,
        backend_identity::admin::router::list_discord_roles,
        backend_identity::admin::router::update_autorole,
        backend_splits::router::complete_splits_batch,
        backend_intel::router::leaderboards,
        backend_intel::router::guild_report,
        backend_intel::router::refresh_guild_report,
        backend_intel::router::player_report,
        backend_progression::router::get_me,
        backend_progression::router::get_settings,
        backend_progression::router::update_settings,
        backend_progression::router::list_seasons,
        backend_progression::router::create_season,
        backend_progression::router::update_season,
        backend_progression::router::activate_season,
        backend_progression::router::award_message,
        backend_progression::router::get_leaderboard,
        backend_progression::router::get_user,
        backend_progression::router::get_user_ledger,
        backend_progression::router::adjust_user,
        backend_community::vods::router::submit_vod,
        backend_community::vods::router::list_mine,
        backend_community::warns::router::issue_warn,
        backend_community::warns::router::list_warns,
        backend_community::warns::router::revoke_warn,
        backend_community::warns::router::list_escalations,
        backend_community::warns::router::ack_escalation,
        backend_rewards::giveaways::router::list_giveaways,
        backend_rewards::giveaways::router::create_giveaway,
        backend_rewards::giveaways::router::get_giveaway,
        backend_rewards::giveaways::router::enter_giveaway,
        backend_rewards::giveaways::router::leave_giveaway,
        backend_rewards::giveaways::router::cancel_giveaway,
        backend_rewards::giveaways::router::draw_giveaway,
        backend_rewards::giveaways::router::set_discord_message,
        backend_identity::notifications::router::list_notifications,
        backend_identity::notifications::router::unread_count,
        backend_identity::notifications::router::mark_read,
        backend_identity::notifications::router::mark_all_read,
        backend_identity::notifications::router::broadcast,
        backend_identity::platform::router::list_tenants,
        backend_identity::platform::router::create_tenant,
        backend_identity::platform::router::get_tenant,
        backend_identity::platform::router::patch_tenant,
        backend_identity::platform::router::list_catalog,
        backend_identity::platform::router::list_ranks,
        backend_identity::platform::router::create_rank,
        backend_identity::platform::router::patch_rank,
        backend_identity::platform::router::delete_rank,
        backend_identity::platform::router::put_rank_features,
        backend_identity::platform::router::get_features,
        backend_identity::platform::router::put_features,
        backend_identity::platform::router::list_admins,
        backend_identity::platform::router::assign_admin,
        backend_identity::platform::router::revoke_admin,
        backend_identity::platform::router::reload_admins,
        backend_events::events::platform_routes::list_exhausted_fanout,
        backend_events::events::platform_routes::requeue_exhausted_fanout,
        backend_identity::platform::public::tenant_status,
        backend_identity::platform::public::register_tenant,
        backend_identity::platform::public::albion_search,
        backend_identity::platform::public::attachable_guilds,
        backend_identity::platform::public::my_alliance_context,
        backend_identity::platform::public::list_alliance_members,
        backend_identity::platform::public::patch_alliance_member,
        backend_identity::platform::public::accept_alliance_member,
        backend_identity::platform::public::leave_alliance_member,
        backend_events::alliance_share::router::create_share,
        backend_events::alliance_share::router::get_build_share,
        backend_events::alliance_share::router::unshare_build,
        backend_events::alliance_share::router::get_comp_share,
        backend_events::alliance_share::router::unshare_comp,
        backend_events::alliance_share::router::get_split_share,
        backend_events::alliance_share::router::unshare_split,
        backend_battles::enemies::router::list_enemy_guilds,
        backend_battles::enemies::router::get_enemy_guild,
        backend_battles::enemies::router::list_enemy_players,
        backend_battles::enemies::router::get_enemy_player,
        backend_battles::fingerprints::router::list_fingerprints,
        backend_battles::fingerprints::router::get_fingerprint,
        backend_battles::fingerprints::router::get_build_observations,
        backend_battles::fingerprints::router::meta,
        backend_battles::economy::router::get_battle_economy,
        backend_battles::economy::router::get_fight_economy,
        backend_battles::economy::router::get_event_economy,
        backend_battles::fight_analytics::router::get_fight_analytics,
        backend_fights::attention::router::get_attention_findings,
        backend_fights::fights::get_fight_backfill_issues,
        backend_intel::router::scout_snapshots_backfill,
        backend_events::events::router::remove_participant,
        backend_events::events::router::list_pending_vod_forum_posts,
        backend_events::events::router::get_event_signup_options,
        backend_events::events::router::claim_vod_forum_post,
        backend_events::events::router::record_vod_forum_post_created,
        backend_events::events::router::retry_vod_forum_post,
        backend_events::events::router::set_participant,
        backend_splits::router::delete_split,
        backend_splits::router::update_split,
        backend_fights::fights::list_fights,
        backend_fights::fights::get_fight_trends,
        backend_fights::fights::get_fight,
        backend_fights::fights::merge_fights,
        backend_fights::fights::move_battle,
        backend_fights::fights::split_fight,
        backend_identity::admin::router::get_tenant_features,
        backend_identity::admin::router::put_tenant_features,
        backend_identity::platform::public::invite_alliance_member,
        backend_bank::router::reject_withdrawal,
        backend_comps::router::archive_build,
        backend_comps::router::unarchive_build,
        backend_comps::router::archive_comp,
        backend_comps::router::unarchive_comp,
    ),
    components(
        schemas(
            backend_identity::capabilities::model::ApiResponseCapabilities,
            backend_events::actions::model::ApiResponseActionList,
            backend_events::actions::model::ApiResponseActionResult,
            backend_events::actions::model::ApiResponseActionCatalog,
            backend_events::actions::model::ActionList,
            backend_events::actions::model::ActionDescriptor,
            backend_events::actions::model::ActionResult,
            backend_events::actions::model::ActionRequest,
            backend_events::actions::model::ConfirmBody,
            backend_events::actions::model::EntityRef,
            backend_events::actions::model::StateChange,
            backend_events::actions::model::SyncInfo,
            backend_events::actions::model::CatalogEntry,
            backend_events::actions::model::Style,
            backend_identity::capabilities::model::Capabilities,
            backend_identity::capabilities::model::TenantBlock,
            backend_identity::capabilities::model::AllianceBlock,
            backend_identity::capabilities::model::UserBlock,
            backend_identity::capabilities::model::ModuleEntry,
            backend_identity::capabilities::model::CommandEntry,
            backend_identity::capabilities::model::NavEntry,
            backend_identity::audit::router::AuditLogResponse,
            backend_identity::audit::router::PaginatedAuditLogResponse,
            backend_identity::audit::router::ApiResponsePaginatedAuditLogs,
            backend_identity::users::service::UserProfile,
            backend_identity::users::service::UserMetrics,
            backend_identity::users::service::UserFilters,
            backend_identity::users::service::CreateUserRequest,
            backend_identity::users::router::BlockUserRequest,
            backend_identity::users::weapons::WeaponProficiency,
            backend_identity::users::weapons::UserWeaponView,
            backend_identity::users::weapons::DeclareWeaponInput,
            backend_identity::users::weapons::UpdateMyWeaponsRequest,
            backend_identity::users::weapons::ManageWeaponInput,
            backend_identity::users::weapons::ManageUserWeaponsRequest,
            backend_combat::schemas::ApiResponseUserWeapons,
            backend_identity::users::member_roles::UserRolesView,
            backend_identity::users::member_roles::UserRoleAssignmentView,
            backend_identity::users::member_roles::AssignUserRoleRequest,
            backend_identity::users::schemas::ApiResponseUserMetrics,
            backend_core::pagination::PaginationParams,
            backend_core::errors::ProblemDetails,
            backend_identity::auth::service::DiscordUserProfile,
            backend_identity::auth::service::TenantChoice,
            backend_identity::auth::service::RegisterableGuild,
            backend_identity::users::schemas::ApiResponseUserProfile,
            backend_identity::auth::schemas::ApiResponseDiscordUserProfile,
            backend_identity::users::schemas::PaginatedUserProfile,
            backend_bank::models::TransactionView,
            backend_bank::models::BalanceSummary,
            backend_bank::models::GuildBalanceBreakdown,
            backend_bank::models::UnavailableGuild,
            backend_bank::models::GuildBankSummary,
            backend_bank::models::BankBreakdown,
            backend_bank::models::BankAnalyticsSummary,
            backend_bank::models::TransactionFilters,
            backend_bank::models::WithdrawRequest,
            backend_bank::models::AcceptWithdrawalRequest,
            backend_bank::models::CreateTransactionRequest,
            backend_bank::models::UpdateTransactionRequest,
            backend_bank::models::RejectWithdrawalRequest,
            backend_entities::status::bank::TransactionStatus,
            backend_bank::schemas::PaginatedTransactionView,
            backend_bank::schemas::ApiResponseBalanceSummary,
            backend_bank::schemas::ApiResponseGuildBankSummary,
            backend_bank::schemas::ApiResponseBankAnalyticsSummary,
            backend_bank::schemas::ApiResponseTransactionView,
            backend_splits::models::SplitSummary,
            backend_splits::models::SplitKpiSummary,
            backend_splits::schemas::ApiResponseSplitKpiSummary,
            backend_splits::models::SplitDetail,
            backend_splits::models::SplitParticipantView,
            backend_splits::models::CreateSplitRequest,
            backend_splits::models::UpsertParticipantRequest,
            backend_splits::models::SplitFilters,
            backend_splits::models::SplitIslandView,
            backend_splits::models::SplitIslandTabView,
            backend_splits::models::CreateIslandRequest,
            backend_splits::models::UpdateIslandRequest,
            backend_splits::models::CreateIslandTabRequest,
            backend_splits::models::UpdateIslandTabRequest,
            backend_entities::status::splits::SplitStatus,
            backend_splits::city::SplitIslandCity,
            backend_splits::schemas::PaginatedSplitSummary,
            backend_splits::schemas::ApiResponseSplitDetail,
            backend_identity::albion::client::AlbionSearchResult,
            backend_identity::albion::client::AlbionGuildSummary,
            backend_identity::albion::client::AlbionPlayerSummary,
            backend_identity::albion::client::AlbionGuildMember,
            backend_identity::albion::client::AlbionGuild,
            backend_identity::albion::client::AlbionPlayer,
            backend_identity::albion::service::AlbionLinkStatus,
            backend_identity::albion::router::LinkPlayerRequest,
            backend_identity::albion::router::RegisterByIgnRequest,
            backend_identity::albion::schemas::ApiResponseAlbionLinkStatus,
            backend_identity::albion::schemas::ApiResponsePaginatedAlbionGuildMembers,
            backend_identity::albion::schemas::PaginatedAlbionGuildMember,
            backend_albion_data::openalbion::catalog::OpenAlbionCategory,
            backend_albion_data::openalbion::catalog::OpenAlbionWeapon,
            backend_albion_data::openalbion::catalog::OpenAlbionStatEntry,
            backend_albion_data::openalbion::catalog::OpenAlbionWeaponQualityStat,
            backend_albion_data::openalbion::catalog::OpenAlbionWeaponStats,
            backend_albion_data::openalbion::catalog::OpenAlbionItem,
            backend_albion_data::openalbion::catalog::OpenAlbionAbility,
            backend_albion_data::openalbion::catalog::OpenAlbionItemAbilities,
            backend_albion_data::openalbion::catalog::OpenAlbionItemType,
            backend_albion_data::openalbion::schemas::ApiResponsePaginatedOpenAlbionWeapons,
            backend_albion_data::openalbion::schemas::PaginatedOpenAlbionWeapon,
            backend_albion_data::openalbion::schemas::ApiResponsePaginatedOpenAlbionItems,
            backend_albion_data::openalbion::schemas::PaginatedOpenAlbionItem,
            backend_albion_data::albiondata::client::AlbionDataMarketPrice,
            backend_albion_data::albiondata::client::AlbionDataItemIcon,
            backend_albion_data::albiondata::schemas::ApiResponseAlbionDataMarketPriceList,
            backend_albion_data::albiondata::schemas::ApiResponseAlbionDataItemIcon,
            backend_comps::models::BuildCategoryView,
            backend_comps::models::CompCategoryView,
            backend_comps::models::BuildSummary,
            backend_comps::models::BuildDetail,
            backend_combat::models::CombatDatasetView,
            backend_combat::models::SimulateRequest,
            backend_combat::models::SimulateView,
            backend_combat::sim::AttackerStyle,
            backend_combat::sim::DeclaredCast,
            backend_combat::sim::SideCounts,
            backend_combat::sim::CastOutcome,
            backend_combat::sim::ResolvedAttributeChange,
            backend_combat::sim::ResolvedCrowdControl,
            backend_combat::sim::BurstResult,
            backend_combat::spell::EffectSide,
            backend_combat::models::ItemPowerRequest,
            backend_combat::models::LoadoutItemRequest,
            backend_combat::models::SpecSource,
            backend_combat::models::ItemPowerView,
            backend_gamedata::data_types::DatasetVersion,
            backend_combat::ip::CharacterIpBreakdown,
            backend_combat::ip::ItemIpBreakdown,
            backend_combat::ip::SpecContribution,
            backend_combat::fit::Assignment,
            backend_combat::fit::Placement,
            backend_combat::fit::FitScore,
            backend_combat::fit::Preference,
            backend_combat::fit::FitStrategy,
            backend_combat::models::ScenarioDefinition,
            backend_combat::models::CreateScenarioRequest,
            backend_combat::models::UpdateScenarioRequest,
            backend_combat::models::ScenarioSummary,
            backend_combat::models::ScenarioVersionRef,
            backend_combat::models::ScenarioDetail,
            backend_combat::models::RunSummary,
            backend_combat::models::RunDetail,
            backend_combat::scenario::Side,
            backend_combat::scenario::UnitGroup,
            backend_combat::scenario::DeclaredCast,
            backend_combat::scenario::UnitOutcome,
            backend_combat::scenario::ResolvedCastLog,
            backend_combat::scenario::ScenarioResult,
            backend_combat::schemas::ApiResponseScenarioDetail,
            backend_combat::schemas::ApiResponseScenarioSummaryList,
            backend_combat::schemas::ApiResponseRunDetail,
            backend_combat::schemas::ApiResponseRunSummaryList,
            backend_comps::models::BuildItemView,
            backend_comps::models::BuildItemSpells,
            backend_comps::models::BuildVersionRef,
            backend_events::events::models::BuildPerformanceView,
            backend_events::events::models::BuildBattleStats,
            backend_comps::models::CompSummary,
            backend_comps::models::CompDetail,
            backend_comps::models::ItemPriceRow,
            backend_comps::models::BuildPriceView,
            backend_comps::models::CompBuildPriceRow,
            backend_comps::models::CompPriceView,
            backend_comps::models::CompBuildView,
            backend_comps::models::CreateBuildCategoryRequest,
            backend_comps::models::UpdateBuildCategoryRequest,
            backend_comps::models::CreateCompCategoryRequest,
            backend_comps::models::UpdateCompCategoryRequest,
            backend_comps::models::CreateBuildRequest,
            backend_comps::models::UpdateBuildRequest,
            backend_comps::models::UpsertBuildItemRequest,
            backend_comps::models::CreateCompRequest,
            backend_comps::models::UpdateCompRequest,
            backend_comps::models::AddCompBuildRequest,
            backend_comps::models::UpdateCompBuildQuantityRequest,
            backend_comps::models::BuildFilters,
            backend_comps::models::CompFilters,
            backend_entities::status::comps::BuildRole,
            backend_entities::status::comps::BuildSlot,
            backend_comps::schemas::ApiResponseBuildCategoryList,
            backend_comps::schemas::ApiResponseCompCategoryList,
            backend_comps::schemas::ApiResponseBuildDetail,
            backend_combat::schemas::ApiResponseCombatDataset,
            backend_combat::schemas::ApiResponseSimulate,
            backend_combat::schemas::ApiResponseItemPower,
            backend_combat::schemas::ApiResponseRosterSuggestions,
            backend_comps::schemas::ApiResponseCompDetail,
            backend_comps::schemas::ApiResponsePaginatedComps,
            backend_comps::schemas::ApiResponsePaginatedBuilds,
            backend_comps::schemas::PaginatedCompSummary,
            backend_comps::schemas::PaginatedBuildSummary,
            backend_events::events::models::EventView,
            backend_events::events::models::EventParticipantView,
            backend_events::events::models::EventDetailView,
            backend_events::events::models::CreateEventRequest,
            backend_events::events::models::UpdateEventRequest,
            backend_events::events::models::SetEventVoiceChannelRequest,
            backend_events::events::models::ParticipateEventRequest,
            backend_events::events::models::AddEventMemberRequest,
            backend_events::events::models::SetParticipantRequest,
            backend_events::events::models::UpdateEventBattlesRequest,
            backend_events::events::models::EventBattleView,
            backend_events::events::models::EventManagementAuthorityView,
            backend_events::events::schemas::PaginatedEventSummary,
            backend_events::events::schemas::ApiResponseEventList,
            backend_events::events::schemas::ApiResponseEventSummary,
            backend_events::events::models::EventSummary,
            backend_events::events::schemas::ApiResponseEventCalendarList,
            backend_events::events::schemas::ApiResponseEventRevisionList,
            backend_events::events::schemas::ApiResponseEventManagementAuthority,
            backend_events::events::schemas::ApiResponseEventView,
            backend_events::events::models::EventEffectsResponse,
            backend_events::events::lifecycle::EffectRef,
            backend_events::events::schemas::ApiResponseEventFanoutStatus,
            backend_events::events::models::EventRevision,
            backend_events::events::schemas::ApiResponseEventDetail,
            backend_events::events::schemas::ApiResponseEventRoster,
            backend_events::events::schemas::ApiResponseEventPartyChange,
            backend_events::events::models::EventPartyView,
            backend_events::events::models::EventPartyRoleCount,
            backend_events::events::models::EventSignupPartyView,
            backend_events::events::models::EventPartyChangeView,
            backend_events::events::models::CreateEventPartyRequest,
            backend_events::events::models::UpdateEventPartyRequest,
            backend_events::events::models::DeleteEventPartyRequest,
            backend_events::events::models::ReorderEventPartiesRequest,
            backend_splits::models::MatchParticipantsRequest,
            backend_splits::models::MatchedParticipant,
            backend_splits::schemas::ApiResponseMatchedParticipantList,
            crate::modules::utils::models::OcrResult,
            crate::modules::utils::schemas::ApiResponseOcrResult,
            backend_albion_data::albionbb::client::AlbionBbBattleSummary,
            backend_albion_data::albionbb::client::AlbionBbBattleDetail,
            backend_albion_data::albionbb::client::AlbionBbGuild,
            backend_albion_data::albionbb::client::AlbionBbGuildInfo,
            backend_albion_data::albionbb::client::AlbionBbPlayer,
            backend_albion_data::albionbb::client::AlbionBbKillEvent,
            backend_albion_data::albionbb::client::AlbionBbKillParticipant,
            backend_albion_data::albionbb::router::AlbionBbBattlesList,
            backend_albion_data::albionbb::schemas::ApiResponseAlbionBbBattlesList,
            backend_albion_data::albionbb::schemas::ApiResponseAlbionBbBattleDetail,
            backend_albion_data::albionbb::schemas::ApiResponseAlbionBbKillEventList,
            backend_albion_data::albionbb::schemas::ApiResponseAlbionBbGuildInfo,
            backend_albion_data::albionbb::schemas::ApiResponseAlbionBbPlayerStats,
            backend_battles::battles::models::BattleGuildSummary,
            backend_battles::battles::models::BattleSummary,
            backend_entities::battles::BattlePlayer,
            backend_battles::battles::models::BattleKillParticipant,
            backend_battles::battles::models::BattleKillEvent,
            backend_battles::battles::models::BattleDetail,
            backend_battles::battles::schemas::PaginatedBattleSummary,
            backend_battles::battles::schemas::ApiResponsePaginatedBattles,
            backend_battles::battles::schemas::ApiResponseBattleDetail,
            backend_rewards::siphoned::models::EntryView,
            backend_rewards::siphoned::models::EntryMutationRequest,
            backend_rewards::siphoned::models::PlayerBalance,
            backend_rewards::siphoned::models::PlayerBalanceDetail,
            backend_rewards::siphoned::models::BalanceSort,
            backend_rewards::siphoned::models::IngestRow,
            backend_rewards::siphoned::models::IngestRequest,
            backend_rewards::siphoned::models::IngestResponse,
            backend_rewards::siphoned::models::EntryFilters,
            backend_rewards::siphoned::models::BatchSummary,
            backend_rewards::siphoned::models::DeletedCount,
            backend_rewards::siphoned::models::SettlementQuoteRequest,
            backend_rewards::siphoned::models::SettlementQuoteView,
            backend_rewards::siphoned::models::SettlementResult,
            backend_entities::status::siphoned::SiphonedEntrySource,
            backend_rewards::siphoned::schemas::PaginatedEntryView,
            backend_rewards::siphoned::schemas::ApiResponseIngestResponse,
            backend_rewards::siphoned::schemas::ApiResponseEntryView,
            backend_rewards::siphoned::schemas::ApiResponsePaginatedEntryView,
            backend_rewards::siphoned::schemas::PaginatedPlayerBalance,
            backend_rewards::siphoned::schemas::ApiResponsePaginatedPlayerBalance,
            backend_rewards::siphoned::schemas::ApiResponsePlayerBalanceDetail,
            backend_rewards::siphoned::schemas::ApiResponseBatchSummaryList,
            backend_rewards::siphoned::schemas::ApiResponseDeletedCount,
            backend_regear::models::BreakdownRow,
            backend_regear::models::DeathView,
            backend_regear::models::DeathFilters,
            backend_regear::models::RegearSettingsView,
            backend_regear::models::UpdateRegearSettingsRequest,
            backend_regear::models::AcceptRegearRequest,
            backend_regear::models::RejectRegearRequest,
            backend_regear::models::RegearBudgetSummary,
            backend_regear::models::ExtractionReport,
            backend_regear::models::SelfServiceEventOption,
            backend_regear::models::SelfServiceCompBuildOption,
            backend_regear::models::CreateSelfServiceRegearRequest,
            backend_regear::models::RegearItemOverride,
            backend_entities::status::regear::RegearStatus,
            backend_entities::status::regear::RegearSource,
            backend_intel::models::ScoutedCompSummary,
            backend_intel::models::ScoutedCompDetail,
            backend_intel::models::SimilarityHit,
            backend_intel::models::CounterSuggestion,
            backend_intel::models::ScoutOutcome,
            backend_intel::models::ScoutFilters,
            backend_intel::models::UpdateScoutRequest,
            backend_intel::models::MergeScoutRequest,
            backend_intel::scout::ScoutedPlayer,
            backend_intel::matchups::MatchupRow,
            backend_intel::matchups::MatchupCoverage,
            backend_intel::matchups::MatchupReport,
            backend_entities::status::intel::IntelScoutCategory,
            backend_identity::admin::models::PermissionMatrix,
            backend_identity::admin::models::PermissionCatalogEntry,
            backend_identity::admin::models::RolePermissionsView,
            backend_identity::admin::models::UpdateRolePermissionsRequest,
            backend_identity::admin::models::CreateRoleRequest,
            backend_identity::admin::models::UpdateRoleRequest,
            backend_identity::admin::models::GuildSettingsView,
            backend_identity::admin::models::UpdateGuildSettingsRequest,
            backend_identity::admin::models::DiscordRoleView,
            backend_identity::admin::models::DiscordMemberView,
            backend_identity::admin::models::DiscordChannelView,
            backend_identity::admin::models::DiscordForumTagView,
            backend_identity::admin::models::AutoRoleSettingsView,
            backend_identity::admin::models::UpdateAutoRoleRequest,
            backend_splits::models::CompleteSplitsBatchRequest,
            backend_splits::models::CompleteSplitsBatchResult,
            backend_splits::models::BatchFailure,
            backend_splits::alliance_distribution::DistributionStatus,
            backend_events::events::mirror_retry::MirrorRequestStatus,
            backend_splits::alliance_distribution::DistributionRecipientStatus,
            backend_intel::report::GuildReport,
            backend_intel::report::ReportOverview,
            backend_intel::report::ReportOperations,
            backend_intel::report::ReportEconomy,
            backend_intel::report::ReportDataQuality,
            backend_intel::report::ReportLeaderboards,
            backend_intel::report::LeaderboardEntry,
            backend_intel::report::FightSummary,
            backend_intel::report::MemberRow,
            backend_intel::report::CompRow,
            backend_intel::report::EnemyRow,
            backend_intel::report::WeaponShare,
            backend_intel::report::HourBucket,
            backend_intel::report::TrendBucket,
            backend_intel::report::TimelineEntry,
            backend_intel::report::PlayerReport,
            backend_intel::report::PlayerTrendBucket,
            backend_intel::schemas::PaginatedScoutedComp,
            backend_regear::schemas::PaginatedDeathView,
            backend_progression::models::SeasonView,
            backend_progression::models::ProgressionMeView,
            backend_progression::models::ProgressionSettingsView,
            backend_progression::models::LevelThresholdView,
            backend_progression::models::UpdateProgressionSettingsRequest,
            backend_progression::models::CreateSeasonRequest,
            backend_progression::models::UpdateSeasonRequest,
            backend_progression::models::AwardMessageRequest,
            backend_progression::models::AwardMessageView,
            backend_progression::models::LeaderboardEntryView,
            backend_progression::models::XpLedgerEntryView,
            backend_progression::models::AdjustProgressionRequest,
            backend_entities::status::progression::XpSource,
            backend_community::vods::models::SubmitVodRequest,
            backend_community::vods::models::VodReviewView,
            backend_community::warns::models::IssueWarnRequest,
            backend_community::warns::models::WarnView,
            backend_community::warns::models::WarnEscalationView,
            backend_entities::status::warns::WarnSeverity,
            backend_progression::schemas::PaginatedLeaderboardEntryView,
            backend_progression::schemas::PaginatedXpLedgerEntryView,
            backend_community::warns::schemas::PaginatedWarnView,
            backend_community::warns::schemas::PaginatedWarnEscalationView,
            backend_progression::schemas::ApiResponseProgressionMeView,
            backend_progression::schemas::ApiResponseAwardMessageView,
            backend_progression::schemas::ApiResponsePaginatedLeaderboardEntryView,
            backend_progression::schemas::ApiResponsePaginatedXpLedgerEntryView,
            backend_community::vods::schemas::ApiResponseVodReviewView,
            backend_community::vods::schemas::ApiResponseVodReviewViewList,
            backend_community::warns::schemas::ApiResponseWarnView,
            backend_community::warns::schemas::ApiResponsePaginatedWarnView,
            backend_community::warns::schemas::ApiResponseWarnEscalationView,
            backend_community::warns::schemas::ApiResponsePaginatedWarnEscalationView,
            backend_identity::notifications::models::BroadcastRequest,
            backend_identity::notifications::models::BroadcastResult,
            backend_identity::notifications::models::NotificationView,
            backend_identity::notifications::models::UnreadCountView,
            backend_identity::notifications::models::ReadAllResult,
            backend_entities::status::notifications::NotificationKind,
            backend_identity::notifications::schemas::PaginatedNotificationView,
            backend_identity::notifications::schemas::ApiResponseNotificationView,
            backend_identity::notifications::schemas::ApiResponsePaginatedNotificationView,
            backend_identity::notifications::schemas::ApiResponseUnreadCountView,
            backend_identity::notifications::schemas::ApiResponseReadAllResult,
            backend_identity::notifications::schemas::ApiResponseBroadcastResult,
            backend_rewards::giveaways::schemas::ApiResponseGiveawayDetail,
            backend_rewards::giveaways::schemas::ApiResponsePaginatedGiveawayView,
            backend_rewards::giveaways::models::GiveawayView,
            backend_rewards::giveaways::models::GiveawayDetailView,
            backend_rewards::giveaways::models::GiveawayPrizeView,
            backend_rewards::giveaways::models::GiveawayEntryView,
            backend_rewards::giveaways::models::CreateGiveawayRequest,
            backend_rewards::giveaways::models::CreateGiveawayPrizeRequest,
            backend_rewards::giveaways::models::SetGiveawayDiscordMessageRequest,
            backend_entities::status::giveaways::GiveawayStatus,
            backend_rewards::giveaways::schemas::PaginatedGiveawayView,
            backend_identity::platform::models::TenantView,
            backend_identity::platform::models::CreateTenantRequest,
            backend_identity::platform::models::PatchTenantRequest,
            backend_identity::platform::models::TenantRankView,
            backend_identity::platform::models::CreateRankRequest,
            backend_identity::platform::models::PatchRankRequest,
            backend_identity::platform::models::PutRankFeaturesRequest,
            backend_identity::platform::models::FeatureCatalogItem,
            backend_identity::platform::models::TenantFeatureFlag,
            backend_identity::platform::models::TenantFeaturesView,
            backend_identity::platform::models::PutTenantFeaturesRequest,
            backend_identity::platform::models::PlatformAdminView,
            backend_events::events::fanout_outbox::ExhaustedTarget,
            backend_identity::platform::models::AssignAdminRequest,
            backend_identity::platform::models::RegisterTenantRequest,
            backend_identity::platform::models::TenantStatusView,
            backend_identity::platform::models::AttachableGuildView,
            backend_identity::platform::models::AllianceMemberView,
            backend_identity::platform::models::PatchAllianceMemberRequest,
            backend_identity::platform::models::AllianceContextView,
            backend_events::alliance_share::models::CreateAllianceShareRequest,
            backend_events::alliance_share::models::AllianceShareView,
            backend_events::alliance_share::models::AllianceShareStatusView,
            backend_events::alliance_share::models::ArtifactType,
            backend_battles::enemies::models::EnemyRollup,
            backend_battles::enemies::models::EnemyGuildSummary,
            backend_battles::enemies::models::EnemyAliasValue,
            backend_battles::enemies::models::EnemyAliasGroup,
            backend_battles::enemies::models::EnemyGuildRosterPlayer,
            backend_battles::enemies::models::WeaponHistogramEntry,
            backend_battles::enemies::models::EnemyGuildDossier,
            backend_battles::enemies::models::EnemyPlayerSummary,
            backend_battles::enemies::models::EnemyPlayerBattleEntry,
            backend_battles::enemies::models::EnemyPlayerDossier,
            backend_battles::enemies::schemas::PaginatedEnemyGuildSummary,
            backend_battles::enemies::schemas::PaginatedEnemyPlayerSummary,
            backend_battles::enemies::schemas::ApiResponsePaginatedEnemyGuilds,
            backend_battles::enemies::schemas::ApiResponseEnemyGuildDossier,
            backend_battles::enemies::schemas::ApiResponsePaginatedEnemyPlayers,
            backend_battles::enemies::schemas::ApiResponseEnemyPlayerDossier,
            backend_battles::fingerprints::models::FingerprintRollup,
            backend_battles::fingerprints::models::FingerprintSummary,
            backend_battles::fingerprints::models::FingerprintObservationEntry,
            backend_battles::fingerprints::models::FingerprintDetail,
            backend_battles::fingerprints::models::BuildObservationSummary,
            backend_battles::fingerprints::models::MetaEntry,
            backend_battles::fingerprints::schemas::PaginatedFingerprintSummary,
            backend_battles::fingerprints::schemas::ApiResponsePaginatedFingerprints,
            backend_battles::fingerprints::schemas::ApiResponseFingerprintDetail,
            backend_battles::economy::models::BattleEconomyView,
            backend_battles::economy::models::FightEconomyView,
            backend_battles::economy::models::EventEconomyView,
            backend_battles::economy::schemas::ApiResponseBattleEconomy,
            backend_battles::economy::schemas::ApiResponseFightEconomy,
            backend_battles::economy::schemas::ApiResponseEventEconomy,
            backend_battles::fingerprints::schemas::ApiResponseBuildObservationSummary,
            backend_battles::fingerprints::schemas::ApiResponseMetaEntries,
            backend_battles::fight_analytics::service::FightAnalyticsView,
            backend_battles::fight_analytics::service::FightStatsView,
            backend_battles::fight_analytics::schemas::ApiResponseFightAnalytics,
            backend_fights::attention::service::AttentionFindingView,
            backend_fights::attention::schemas::ApiResponseAttentionFindingList,
            backend_fights::fights::FightBackfillIssueView,
            backend_fights::fights::schemas::ApiResponseFightBackfillIssueList,
            backend_intel::auto_scout::BackfillOutcome,
            backend_intel::schemas::ApiResponseScoutBackfillOutcome,
        )
    ),
    tags(
        (name = "auth", description = "Discord OAuth2 login flow and session management. Start here: every other \
            endpoint requires the `session_user` cookie this flow sets."),
        (name = "users", description = "Guild member directory. Used to look up usernames/ids (e.g. to populate a \
            split's participant picker) and to read the caller's own resolved role."),
        (name = "bank", description = "The Guild Bank ledger: what's owed to each member, and the two-step \
            withdrawal flow (member requests -> officer accepts and pays)."),
        (name = "splits", description = "Loot split lifecycle: a member requests a split with its participants, \
            an officer closes it out as completed (pays out), not completed, or lost."),
        (name = "albion", description = "Albion Online integration: browse the configured in-game guild's roster \
            and self-link a Discord account to an Albion Online character."),
        (name = "albionbb", description = "Read-only passthrough for the public AlbionBB battle-history API (third-party, community-run). Used internally by the `battles` module; not typically called directly by the frontend."),
        (name = "albiondata", description = "Self-owned Albion item utilities: render-service icon URLs from Sandbox and current market prices from Albion Online Data."),
                (name = "battles", description = "Battle history for the configured Weaklings guild, sourced from AlbionBB and reshaped for the frontend. Includes a `/me` endpoint filtered by the caller's linked Albion character."),
        (name = "openalbion", description = "Read-only OpenAlbion item database passthrough (weapons, armor, accessories, consumables, categories, \
            per-weapon stats) used by the composition/loadout builder. Third-party data, cached server-side."),
        (name = "comps", description = "Compositions and builds: comps group reusable builds of Albion Online items; builds are per-slot loadouts sourced from OpenAlbion. Two DB-creatable category tables (build categories, comp categories)."),
        (name = "events", description = "Events and participations: schedule events with compositions and let logged-in players sign up using build roles with automatic variant capacity scaling."),
        (name = "siphoned", description = "Guild Siphoned Energy ledger: bulk-import the Albion Online in-game export as immutable rows, browse the ledger, and compute per-player balances (who is in debt to the guild)."),
        (name = "regear", description = "Call-To-Arms gear reimbursement: deaths are extracted from CTA-linked battles, members request regear one death at a time, officers accept (crediting a Guild Bank `regear_credit` row) or reject (terminal)."),
        (name = "intel", description = "Enemy scouting and guild analytics: battle snapshots are distilled into scouted enemy compositions, scored for similarity against each other and against our own comps, and tallied into a win/loss matchup matrix."),
        (name = "enemies", description = "Enemy guild/player dossiers built from battle evidence: identity, alias history, battle-derived tallies, rosters and weapon histograms. A drill-down of intel, gated on the same feature key."),
        (name = "fingerprints", description = "Equipment identity built from battle evidence: immutable, deduplicated equipment fingerprints matched at most once against the internal build catalog, browsable by fingerprint or by build, plus a per-side current-meta ranking. A drill-down of intel, gated on the same feature key."),
        (name = "economy", description = "The economic bridge between combat evidence and money: per-battle/fight trade indicators computed from `battle_loss_estimates`, and the real per-event P&L built entirely from the declared ledger (`splits`, `regear_deaths`). Income is always declared, never inferred from combat. A drill-down of battle/fight evidence, gated on the same feature key."),
        (name = "fight_analytics", description = "Persisted per-fight outcome and stats rollup, recomputed eagerly on battle hydration and manual Fight merge/split/move. `enemy_*` figures are trade/observation indicators only, never income. A drill-down of battle/fight evidence, gated on the same feature key."),
        (name = "fights", description = "Read-only canonical Fight API: persisted fights grouped from one or more AlbionBB battles, with manual merge/split/move tools and grouping-review diagnostics."),
        (name = "attention", description = "Deterministic, versioned rules answering \"what's wrong\" instead of leaving an officer to infer it from totals. Recomputed synchronously on every read; a finding disappears once its condition stops holding. A drill-down of intel, gated on the same feature key."),
        (name = "members", description = "Member provisioning from the Discord bot: a verified server member gets or regains a local account (`POST /members/ensure`)."),
        (name = "progression", description = "Season-scoped XP and levels: members earn XP from Discord and guild actions; admins model the season dates and curve."),
        (name = "vods", description = "VOD review claims: one XP grant per normalized URL per covering season, posted in the configured Discord forum."),
        (name = "warns", description = "Disciplinary warn register: issue/revoke with audit, and an admin escalation when the active-warn count reaches the configured threshold. No auto-kick."),
        (name = "giveaways", description = "Guild giveaways: officers create a timed Discord prize draw (Albion items plus optional Guild Bank silver); members enter from Discord; expiry auto-draws one winner."),
        (name = "notifications", description = "Per-member in-app inbox: list/read own notifications, unread badge, and officer broadcast fan-out. Discord DMs are delivered by a background worker."),
        (name = "admin", description = "Administrative operations: permission cache reload."),
        (name = "alliance", description = "Publish a guild artifact snapshot into the alliance tenant schema. Called on the guild session; the copy appears on the alliance tenant's existing list endpoints."),
        (name = "platform", description = "Control-plane operators: register and suspend tenants, toggle feature flags, and assign platform SuperAdmin. Requires a platform role; not tenant-scoped."),
        (name = "utils", description = "Generic, reusable backend utilities not tied to any specific domain — currently just image OCR via Mistral AI.")
    ),
    info(
        title = "Weaklings Gateway API",
        version = "0.1.0",
        description = "\
# Weaklings Gateway API

Backend REST API for the Weaklings guild management app: Discord OAuth2 login, a database-backed \
Guild Bank ledger, loot splits, and Albion Online integrations. This description is the map — \
read it once before touching any endpoint below.

## Base URL and routing

Every path documented here is already prefixed with `/api` (e.g. the `auth` tag's login endpoint is \
served at `/api/auth/discord/login`). The frontend should never need any other prefix.

## Authentication: it's a cookie, not a bearer token

There is no `Authorization` header and no JWT. Login is a server-side Discord OAuth2 redirect flow:

1. Send the browser to `GET /api/auth/discord/login`. It redirects to Discord, which redirects back \
   to `GET /api/auth/discord/callback` on this server.
2. The callback exchanges the code, resolves the user's Discord guild roles against the local `roles` \
   table, upserts a local `users` row, and sets an **httponly** `session_user` cookie (7-day expiry) \
   containing the serialized profile — the frontend never reads or parses this cookie directly.
3. The server then redirects the browser to the frontend's `/dashboard`.
4. From then on, the browser sends the cookie automatically on every same-site request. Call \
   `GET /api/auth/me` on app load to check whether a session exists and to get the logged-in user's \
   profile (id, username, avatar, roles). A `401` means \"not logged in\" — show the login button.
5. `POST /api/auth/logout` revokes the session server-side and clears the cookie; \
   `POST /api/auth/logout-all` revokes every session of the caller's account.

Every endpoint below other than the four `auth` ones requires this cookie to already be set; they are \
all annotated with the `session_cookie` security requirement. Because it's a cookie, `fetch()` calls \
from the frontend need `credentials: \"include\"` (or same-origin, if proxied).

## Roles and authorization

Authorization is **permission-based**: each protected endpoint declares a fine-grained
`Permission` (e.g. `bank.withdraw.accept`, `splits.manage`) via a `Require(...)` extractor,
and the request is rejected with `403` if the caller's roles don't grant it.

The mapping **role → permission** lives in the `role_permissions` database table and is
loaded into an in-memory cache at startup. To change who can do what:

1. Create a gestionale role with `POST /api/admin/roles` and link it to a Discord snowflake.
2. Grant or revoke keys on that role with `PUT /api/admin/roles/{id}/permissions` (applies immediately).
3. `POST /api/admin/permissions/reload` still exists for out-of-band SQL edits.

The configured `super_admin_discord_id` (env) bypasses every permission check.

Current permissions:

| Permission               | Granted to        | Used by                                    |
|--------------------------|-------------------|--------------------------------------------|
| `bank.withdraw.accept`   | Admin, Officer    | `POST /bank/transactions/withdraw/accept`  |
| `bank.view_others`       | Admin             | `GET /bank/balance?user_id=`, `GET /bank/transactions?user_id=` |
| `splits.manage`          | Admin, Officer    | split edit/close endpoints                 |
| `splits.islands.manage`  | Admin             | island/tab catalog CRUD                    |
| `users.create`           | Admin             | `POST /users`, `GET /admin/discord/members` |
| `permissions.reload`     | Admin             | `POST /admin/permissions/reload`           |
| `roles.manage`           | Admin             | `POST/PATCH/DELETE /admin/roles`           |
| `comps.build_categories.manage` | Admin, Officer | build category CRUD endpoints |
| `comps.comp_categories.manage` | Admin, Officer | comp category CRUD endpoints |
| `comps.builds.manage`    | Admin, Officer    | edit/delete/archive/version any build (create/edit/delete alone: own builds only) |
| `comps.comps.manage`     | Admin, Officer    | edit/delete/archive/version any comp (create/edit/delete alone: own comps only) |

A `403 Forbidden` (`ProblemDetails`) means the session is valid but the caller's roles don't
grant the required permission.

## Response envelope

Every successful (2xx) JSON response — except the two endpoints that stream a raw array or object \
directly (`openalbion` weapon stats/categories) — is wrapped JSend-style:

```json
{ \"status\": \"success\", \"data\": { /* the documented body schema */ } }
```

Always read the payload from `.data`, not the top level.

## Error format (RFC 7807)

Every non-2xx response is `application/problem+json`:

```json
{
  \"type\": \"/errors/validation-error\",
  \"title\": \"Validation Error\",
  \"status\": 400,
  \"detail\": \"human-readable explanation, safe to show the user\"
}
```

Common `status`/`type` pairs you'll see across this API: `400` validation-error, `401` unauthorized (no/invalid \
session), `403` forbidden (valid session, wrong role, or acting on someone else's resource), `404` \
not-found, `409` conflict (e.g. an Albion player already linked to another account), `502` \
upstream-service-error (a third-party API — Albion Online or OpenAlbion — failed or timed out).

## The two-step Guild Bank withdrawal flow

Money owed to a member never gets marked paid in one step. `bank.TransactionStatus` moves strictly \
forward: `pending` (owed, untouched) -> `requested` (the member asked to withdraw it, via \
`POST /bank/transactions/withdraw`) -> `withdrawn` (an officer accepted and paid it, via \
`POST /bank/transactions/withdraw/accept`, which stamps that officer's user id onto the transaction's \
`from_user_id` as the recorded payer). `GET /bank/balance` reports `pending_total`/`pending_count` and \
`requested_total`/`requested_count` separately so the UI can distinguish \"owed\" from \"already asked \
for, awaiting payout\".

## The loot split lifecycle

A split is requested by any member together with its participants and their relative weights up \
front (`POST /splits` — there is no separate \"add participants later\" step required to make a split \
valid, though `POST /splits/{id}/participants` still exists for an officer to adjust the roster while \
it's pending). `splits.SplitStatus` starts at `pending` and an officer closes it out exactly once, into \
one of three terminal-ish states: `completed` (`POST /splits/{id}/complete` — computes \
`net_value = estimated_market_value - repair_value + bags_value` and generates one `pending` Guild \
Bank transaction per participant, split proportionally by weight with remainder correction so the \
sum is exact), `not_completed` (the split didn't happen; no transactions), or `lost` \
(`POST /splits/{id}/lost` — the loot itself was never recovered; no transactions). Only `pending` \
splits can be edited or closed; every closing action is a one-way door.

## Albion Online vs. OpenAlbion — two unrelated third-party integrations

Don't confuse these tags: `albion` calls Sandbox Interactive's own (unofficial, undocumented) \
`gameinfo` API — live player/guild data for the configured in-game guild, plus the Discord-account-to- \
Albion-character self-link feature. `openalbion` calls the separate, community-run OpenAlbion item \
database — static reference data (weapon catalog, categories, per-quality stats) used by the \
composition/loadout builder, with the full weapon list cached server-side for an hour. Neither \
requires or shares any credentials; both simply require a valid session cookie like everything else.
"
    ),
    modifiers(&SecurityAddon)
)]
pub struct ApiDoc;

/// Serves the `OpenAPI` document as JSON for generated clients (`apps/contracts`).
///
/// Public and cacheable: it describes routes and schemas, never tenant data.
pub async fn serve_openapi_json() -> impl IntoResponse {
    (
        [(axum::http::header::CACHE_CONTROL, "public, max-age=300")],
        Json(ApiDoc::openapi()),
    )
}

struct SecurityAddon;

impl utoipa::Modify for SecurityAddon {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        if let Some(components) = openapi.components.as_mut() {
            components.add_security_scheme(
                "session_cookie",
                utoipa::openapi::security::SecurityScheme::ApiKey(
                    utoipa::openapi::security::ApiKey::Cookie(
                        utoipa::openapi::security::ApiKeyValue::new("session_user"),
                    ),
                ),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use backend_identity::auth::Permission;
    use std::collections::{BTreeMap, BTreeSet};
    use std::fs;
    use std::path::{Path, PathBuf};
    use utoipa::OpenApi;

    /// `apps/contracts`: the committed OpenAPI snapshot and the route allowlist.
    fn contracts_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../contracts")
    }

    fn update_requested() -> bool {
        std::env::var("UPDATE_CONTRACTS").is_ok_and(|value| value == "1")
    }

    /// Replaces every `{param}` segment with `{}`, so router parameter names
    /// (`{id}`) and annotation names (`{event_id}`) compare equal.
    fn shape(path: &str) -> String {
        let mut out = String::with_capacity(path.len());
        let mut in_param = false;
        for ch in path.chars() {
            match ch {
                '{' => {
                    in_param = true;
                    out.push_str("{}");
                }
                '}' => in_param = false,
                _ if in_param => {}
                _ => out.push(ch),
            }
        }
        out
    }

    const HTTP_METHODS: [&str; 8] = [
        "get", "post", "put", "patch", "delete", "head", "options", "trace",
    ];

    fn rendered_document() -> String {
        let value = serde_json::to_value(ApiDoc::openapi()).expect("OpenAPI serialises");
        format!(
            "{}\n",
            serde_json::to_string_pretty(&value).expect("OpenAPI pretty-prints")
        )
    }

    /// Every `(METHOD, shape)` the live `ApiDoc` declares.
    fn documented_routes() -> BTreeSet<(String, String)> {
        let value = serde_json::to_value(ApiDoc::openapi()).expect("OpenAPI serialises");
        let mut out = BTreeSet::new();
        for (path, item) in value["paths"].as_object().into_iter().flatten() {
            for method in HTTP_METHODS {
                if item.get(method).is_some() {
                    out.insert((method.to_uppercase(), shape(path)));
                }
            }
        }
        out
    }

    /// The HTTP methods of a `.route(...)` argument list, e.g. `get(a).patch(b)`.
    fn methods_in(args: &str) -> Vec<&'static str> {
        let bytes = args.as_bytes();
        let mut found = Vec::new();
        for method in HTTP_METHODS {
            for (idx, _) in args.match_indices(method) {
                let starts_token =
                    idx == 0 || !(bytes[idx - 1].is_ascii_alphanumeric() || bytes[idx - 1] == b'_');
                if starts_token && args[idx + method.len()..].trim_start().starts_with('(') {
                    found.push(method);
                }
            }
        }
        found
    }

    /// `(literal path, methods)` for every `.route("...", ...)` call in `src`.
    fn route_calls(src: &str) -> Vec<(String, Vec<&'static str>)> {
        let mut out = Vec::new();
        let mut rest = src;
        while let Some(idx) = rest.find(".route(") {
            let after = rest[idx + ".route(".len()..].trim_start();
            let Some(body) = after.strip_prefix('"') else {
                rest = &rest[idx + ".route(".len()..];
                continue;
            };
            let Some(end) = body.find('"') else { break };
            let literal = &body[..end];
            let args_src = &body[end + 1..];
            let mut depth = 1usize;
            let mut close = args_src.len();
            for (i, ch) in args_src.char_indices() {
                match ch {
                    '(' => depth += 1,
                    ')' => {
                        depth -= 1;
                        if depth == 0 {
                            close = i;
                            break;
                        }
                    }
                    _ => {}
                }
            }
            out.push((literal.to_owned(), methods_in(&args_src[..close])));
            rest = &args_src[close..];
        }
        out
    }

    /// Where the `.route(...)` calls of every mounted router live, relative to `apps/backend`
    /// (the app crate's manifest directory), and the prefix they are mounted under. A module entry
    /// (`crates/events/src/events`) covers `events.rs` next to it and every file below it; a crate
    /// entry (`crates/comps/src`) covers the whole crate; a file entry
    /// (`crates/events/src/events/comp_routes.rs`) wins over its module, so handlers relocated into
    /// another feature and merged into a router there keep their real mount prefix. The registry
    /// is `src/modules/mod.rs`; `platform` is mounted by `src/lib.rs`, and its `public.rs` splits
    /// further into `/tenants` and `/alliances` (see `mounted_routes`).
    /// `route_sources_cover_every_mount` keeps this table complete.
    const ROUTE_SOURCES: &[(&str, &str)] = &[
        ("src/modules/health", "/health"),
        ("crates/identity/src/users", "/users"),
        ("crates/identity/src/members", "/members"),
        ("crates/identity/src/auth", "/auth"),
        ("crates/bank/src", "/bank"),
        ("crates/splits/src", "/splits"),
        ("crates/identity/src/albion", "/albion"),
        ("crates/albion-data/src/albionbb", "/albionbb"),
        ("crates/community/src/applications", "/applications"),
        ("crates/community/src/tickets", "/tickets"),
        ("crates/albion-data/src/albiondata", "/albiondata"),
        ("crates/battles/src/battles", "/battles"),
        ("crates/fights/src/attention", "/attention"),
        ("crates/battles/src/enemies", "/enemies"),
        ("crates/battles/src/fingerprints", "/fingerprints"),
        ("crates/battles/src/economy", "/economy"),
        ("crates/battles/src/fight_analytics", "/fight-analytics"),
        ("crates/albion-data/src/openalbion", "/openalbion"),
        ("crates/combat/src", "/combat"),
        ("crates/comps/src", "/comps"),
        ("crates/combat/src/comp_routes.rs", "/comps"),
        ("crates/combat/src/user_weapons.rs", "/users"),
        ("crates/events/src/events/comp_routes.rs", "/comps"),
        ("crates/events/src/events", "/events"),
        ("crates/events/src/actions", "/actions"),
        ("crates/fights/src/fights", "/fights"),
        ("crates/rewards/src/giveaways", "/giveaways"),
        ("crates/rewards/src/siphoned", "/siphoned"),
        ("crates/regear/src", "/regear"),
        ("crates/events/src/alliance_share", "/alliance"),
        ("crates/identity/src/capabilities", "/me"),
        ("crates/identity/src/admin", "/admin"),
        ("src/modules/utils", "/utils"),
        ("crates/identity/src/audit", "/audit"),
        ("crates/intel/src", "/intel"),
        ("crates/progression/src", "/progression"),
        ("crates/community/src/vods", "/vods"),
        ("crates/community/src/warns", "/warns"),
        ("crates/identity/src/notifications", "/notifications"),
        ("crates/identity/src/platform", "/platform"),
        ("crates/events/src/events/platform_routes.rs", "/platform"),
    ];

    /// Mounts in `modules/mod.rs` the route scan skips on purpose. `/sync`: its routes have no
    /// `#[utoipa::path]` and are not on the allowlist; the previous `.nest(...)` line scan never
    /// matched `sync::router::router()`, so documenting or allowlisting them is its own change.
    const UNSCANNED_MOUNTS: &[&str] = &["/sync"];

    /// The `ROUTE_SOURCES` entry that owns `rel` (a path under `apps/backend`): the most
    /// specific one, so a file entry beats its module entry.
    fn route_source(rel: &Path) -> Option<&'static str> {
        ROUTE_SOURCES
            .iter()
            .filter(|(source, _)| {
                if source.ends_with(".rs") {
                    rel == Path::new(source)
                } else {
                    rel == Path::new(&format!("{source}.rs")) || rel.starts_with(source)
                }
            })
            .max_by_key(|(source, _)| Path::new(source).components().count())
            .map(|(_, prefix)| *prefix)
    }

    /// The `(METHOD, shape)` of every route mounted under `/api` by the module
    /// routers, with each file's prefix taken from `ROUTE_SOURCES`.
    fn mounted_routes(manifest_dir: &Path) -> BTreeSet<(String, String)> {
        let mut files = BTreeSet::new();
        for (source, _) in ROUTE_SOURCES {
            let path = manifest_dir.join(source);
            let mut found = Vec::new();
            if path.is_dir() {
                collect_rs_files(&path, &mut found);
            }
            for file in [path.clone(), path.with_extension("rs")] {
                if file.is_file() {
                    found.push(file);
                }
            }
            files.extend(found);
        }
        let mut out = BTreeSet::new();
        for file in files {
            let rel = file.strip_prefix(manifest_dir).expect("under apps/backend");
            let Some(prefix) = route_source(rel) else {
                continue;
            };
            let text = fs::read_to_string(&file).expect("readable module source");
            // Test code mounts throwaway routers; only production code counts.
            let production = text.split("#[cfg(test)]").next().unwrap_or_default();
            let alliance_split = production.find("pub fn alliance_router");
            for (literal, methods) in route_calls(production) {
                let mut mount = prefix.to_owned();
                if rel == Path::new("crates/identity/src/platform/public.rs") {
                    let at = production
                        .find(&format!(".route(\"{literal}\""))
                        .unwrap_or(0);
                    mount = match alliance_split {
                        Some(split) if at > split => "/alliances".to_owned(),
                        _ => "/tenants".to_owned(),
                    };
                }
                let full = if literal == "/" {
                    format!("/api{mount}")
                } else {
                    format!("/api{mount}{literal}")
                };
                for method in methods {
                    out.insert((method.to_uppercase(), shape(&full)));
                }
            }
        }
        out
    }

    fn collect_rs_files(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in fs::read_dir(dir).expect("readable directory") {
            let path = entry.expect("directory entry").path();
            if path.is_dir() {
                collect_rs_files(&path, out);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                out.push(path);
            }
        }
    }

    /// Header written above the allowlist entries. Lines starting with `#` are comments.
    const UNDOCUMENTED_HEADER: &str = "\
# Mounted /api routes with no ApiDoc entry yet. This list may only shrink.
# SA-1 deviation: the spec asks for every existing path in ApiDoc. These handlers
# (applications, tickets, health, event roster, split discord-sync, tenant members,
# alliance setup, VOD forum post delete/archive) are deferred
# to follow-up slices; remove a line when its handler gets a #[utoipa::path].
";

    /// Successful bodies that stay bare on purpose: the Albion proxy routes return
    /// the upstream payload unwrapped. Changing them would change client behaviour.
    const BARE_BODY_EXCEPTIONS: [&str; 2] = [
        "GET /api/albion/guilds/{id}",
        "GET /api/albion/players/{id}",
    ];

    fn allowlist() -> BTreeSet<(String, String)> {
        let text =
            fs::read_to_string(contracts_dir().join("undocumented.allowlist")).unwrap_or_default();
        text.lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .filter_map(|line| line.split_once(' '))
            .map(|(method, path)| (method.to_uppercase(), shape(path)))
            .collect()
    }

    #[test]
    fn contracts_are_current() {
        let rendered = rendered_document();
        let path = contracts_dir().join("openapi.json");
        if update_requested() {
            fs::write(&path, &rendered).expect("write apps/contracts/openapi.json");
            return;
        }
        let committed = fs::read_to_string(&path).unwrap_or_default();
        assert!(
            committed == rendered,
            "apps/contracts/openapi.json is stale; run `UPDATE_CONTRACTS=1 cargo test contracts_are_current` and commit the result"
        );
    }

    /// Every mounted route is either in `ApiDoc` or on the committed allowlist,
    /// and the allowlist lists only routes that are still undocumented.
    #[test]
    fn mounted_routes_are_documented_or_allowlisted() {
        let mounted = mounted_routes(Path::new(env!("CARGO_MANIFEST_DIR")));
        let documented = documented_routes();
        let undocumented: BTreeSet<_> = mounted.difference(&documented).cloned().collect();
        if update_requested() {
            let entries: String = undocumented
                .iter()
                .map(|(method, path)| format!("{method} {path}\n"))
                .collect();
            fs::write(
                contracts_dir().join("undocumented.allowlist"),
                format!("{UNDOCUMENTED_HEADER}{entries}"),
            )
            .expect("write undocumented.allowlist");
            return;
        }
        let allowed = allowlist();
        let unlisted: Vec<_> = undocumented.difference(&allowed).collect();
        let stale: Vec<_> = allowed.difference(&undocumented).collect();
        assert!(
            unlisted.is_empty(),
            "routes mounted but neither in ApiDoc nor allowlisted: {unlisted:?}"
        );
        assert!(
            stale.is_empty(),
            "allowlist entries that are now documented or gone (remove them): {stale:?}"
        );
    }

    /// `ROUTE_SOURCES` stays complete: every `.nest("/x", ...)` in `src/modules/mod.rs` has an
    /// entry (or is a deliberate `UNSCANNED_MOUNTS` gap), every router merged in from another
    /// crate's file has a file entry, and every entry still exists. Without this, a new or
    /// moved router would silently skip `mounted_routes_are_documented_or_allowlisted`.
    #[test]
    fn route_sources_cover_every_mount() {
        let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let src = manifest_dir.join("src");
        // Whitespace removed, so a `.nest(` that rustfmt wrapped over several lines still matches.
        let squash = |path: PathBuf| -> String {
            fs::read_to_string(&path)
                .unwrap_or_else(|_| panic!("readable {}", path.display()))
                .split_whitespace()
                .collect()
        };
        let registry = squash(src.join("modules").join("mod.rs"));
        let lib = squash(src.join("lib.rs"));
        let prefixes: BTreeSet<&str> = ROUTE_SOURCES.iter().map(|(_, prefix)| *prefix).collect();

        let nests: Vec<&str> = registry
            .split(".nest(\"")
            .skip(1)
            .filter_map(|chunk| chunk.split('"').next())
            .collect();
        assert!(
            !nests.is_empty(),
            "no `.nest(\"` found in src/modules/mod.rs"
        );
        let uncovered: Vec<_> = nests
            .iter()
            .filter(|prefix| !prefixes.contains(*prefix) && !UNSCANNED_MOUNTS.contains(*prefix))
            .collect();
        assert!(
            uncovered.is_empty(),
            "mounted in src/modules/mod.rs but missing from ROUTE_SOURCES: {uncovered:?}"
        );

        // `.merge(backend_events::events::comp_routes::comp_routes())` lives in
        // `crates/events/src/events/comp_routes.rs`.
        for text in [&registry, &lib] {
            for chunk in text.split(".merge(backend_").skip(1) {
                let call = chunk.split("()").next().unwrap_or_default();
                let mut segments: Vec<&str> = call.split("::").collect();
                segments.pop();
                let crate_dir = segments.remove(0).replace('_', "-");
                let file = format!("crates/{crate_dir}/src/{}.rs", segments.join("/"));
                assert!(
                    ROUTE_SOURCES.iter().any(|(source, _)| *source == file),
                    "merged router `{call}` lives in {file}, which has no ROUTE_SOURCES entry"
                );
            }
        }

        for (source, _) in ROUTE_SOURCES {
            let path = manifest_dir.join(source);
            assert!(
                path.exists() || path.with_extension("rs").exists(),
                "ROUTE_SOURCES entry {source} does not exist under apps/backend"
            );
        }
    }

    /// Successful JSON bodies go through the `ApiResponse*` / paginated envelope,
    /// so clients unwrap `data` the same way everywhere.
    #[test]
    fn success_bodies_use_the_envelope() {
        let value = serde_json::to_value(ApiDoc::openapi()).expect("OpenAPI serialises");
        let mut bare = Vec::new();
        for (path, item) in value["paths"].as_object().into_iter().flatten() {
            for method in HTTP_METHODS {
                let Some(op) = item.get(method) else { continue };
                for (code, response) in op["responses"].as_object().into_iter().flatten() {
                    if !code.starts_with('2') {
                        continue;
                    }
                    let Some(schema) =
                        response["content"]["application/json"]["schema"].get("$ref")
                    else {
                        continue;
                    };
                    let name = schema
                        .as_str()
                        .unwrap_or_default()
                        .rsplit('/')
                        .next()
                        .unwrap_or_default();
                    let route = format!("{} {path}", method.to_uppercase());
                    // `EventEffectsResponse` is the success envelope (`status`, `data`) plus the
                    // Discord `effects` the lifecycle routes wrote.
                    if !name.starts_with("ApiResponse")
                        && !name.starts_with("Paginated")
                        && name != "EventEffectsResponse"
                        && !BARE_BODY_EXCEPTIONS.contains(&route.as_str())
                    {
                        bare.push(format!("{route} -> {name}"));
                    }
                }
            }
        }
        assert!(
            bare.is_empty(),
            "success bodies without an envelope: {bare:?}"
        );
    }

    /// `operationId`s name the generated client functions, so each one must be unique.
    #[test]
    fn operation_ids_are_unique() {
        let value = serde_json::to_value(ApiDoc::openapi()).expect("OpenAPI serialises");
        let mut seen: BTreeMap<String, String> = BTreeMap::new();
        let mut dupes = Vec::new();
        for (path, item) in value["paths"].as_object().into_iter().flatten() {
            for method in HTTP_METHODS {
                let Some(id) = item[method]["operationId"].as_str() else {
                    continue;
                };
                let route = format!("{} {path}", method.to_uppercase());
                if let Some(first) = seen.insert(id.to_owned(), route.clone()) {
                    dupes.push(format!("{id}: {first} and {route}"));
                }
            }
        }
        assert!(dupes.is_empty(), "duplicate operationIds: {dupes:?}");
    }

    /// Every `$ref` points at a component the document declares.
    #[test]
    fn every_schema_reference_resolves() {
        let value = serde_json::to_value(ApiDoc::openapi()).expect("OpenAPI serialises");
        let mut refs = Vec::new();
        collect_refs(&value, &mut refs);
        let schemas = value["components"]["schemas"].as_object();
        let dangling: Vec<_> = refs
            .iter()
            .filter(|name| schemas.is_none_or(|map| !map.contains_key(name.as_str())))
            .collect();
        assert!(dangling.is_empty(), "dangling $ref targets: {dangling:?}");
    }

    fn collect_refs(value: &serde_json::Value, out: &mut Vec<String>) {
        match value {
            serde_json::Value::Object(map) => {
                for (key, child) in map {
                    if key == "$ref" {
                        if let Some(target) = child.as_str() {
                            out.push(target.rsplit('/').next().unwrap_or_default().to_owned());
                        }
                    } else {
                        collect_refs(child, out);
                    }
                }
            }
            serde_json::Value::Array(items) => {
                for item in items {
                    collect_refs(item, out);
                }
            }
            _ => {}
        }
    }

    /// Every `security(("session_cookie" = ["..."]))` scope declared on a route
    /// must be a valid `Permission::as_str()` value. Catches typos and drift
    /// between the `OpenAPI` annotations and the `Permission` enum at CI time.
    #[test]
    fn all_security_scopes_are_valid_permissions() {
        use utoipa::openapi::path::Operation;

        fn check(op: Option<&Operation>) {
            let Some(op) = op else { return };
            let Some(reqs) = &op.security else { return };
            // `SecurityRequirement` keeps its map private; round-trip via JSON
            // to read the (scheme_name -> scopes) pairs.
            let val = serde_json::to_value(reqs).unwrap_or(serde_json::Value::Null);
            if let Some(arr) = val.as_array() {
                for entry in arr {
                    if let Some(map) = entry.as_object() {
                        for scopes in map.values() {
                            if let Some(scopes) = scopes.as_array() {
                                for scope in scopes {
                                    if let Some(s) = scope.as_str() {
                                        assert!(
                                            Permission::from_str(s).is_some(),
                                            "OpenAPI declares unknown permission scope: {s:?}"
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        let api = ApiDoc::openapi();
        for path_item in api.paths.paths.values() {
            check(path_item.get.as_ref());
            check(path_item.post.as_ref());
            check(path_item.put.as_ref());
            check(path_item.delete.as_ref());
            check(path_item.patch.as_ref());
        }
    }
}
