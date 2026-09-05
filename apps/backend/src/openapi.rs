//! `OpenAPI` generation module.
//!
//! Exposes the `OpenApi` specification for all modular endpoints in the backend.

use utoipa::OpenApi;

/// `OpenAPI` documentation structure containing API metadata, paths, and components.
#[derive(OpenApi)]
#[openapi(
    paths(
        crate::modules::audit::router::list_audit_logs,
        crate::modules::users::router::get_my_profile,
        crate::modules::users::router::get_my_metrics,
        crate::modules::users::router::list_users,
        crate::modules::users::router::get_user,
        crate::modules::users::router::create_user,
        crate::modules::auth::router::discord_login,
        crate::modules::auth::router::discord_callback,
        crate::modules::auth::router::get_me,
        crate::modules::auth::router::logout,
        crate::modules::bank::router::get_balance,
        crate::modules::bank::router::get_guild_summary,
        crate::modules::bank::router::get_admin_summary,
        crate::modules::bank::router::list_transactions,
        crate::modules::bank::router::withdraw,
        crate::modules::bank::router::accept_withdrawal,
        crate::modules::bank::router::create_transaction,
        crate::modules::bank::router::update_transaction,
        crate::modules::bank::router::delete_transaction,
        crate::modules::splits::router::create_split,
        crate::modules::splits::router::list_splits,
        crate::modules::splits::router::split_kpi_summary,
        crate::modules::splits::router::get_split,
        crate::modules::splits::router::list_islands,
        crate::modules::splits::router::create_island,
        crate::modules::splits::router::update_island,
        crate::modules::splits::router::delete_island,
        crate::modules::splits::router::add_island_tab,
        crate::modules::splits::router::update_island_tab,
        crate::modules::splits::router::delete_island_tab,
        crate::modules::splits::router::add_or_update_participant,
        crate::modules::splits::router::remove_participant,
        crate::modules::splits::router::complete_split,
        crate::modules::splits::router::archive_split,
        crate::modules::splits::router::unarchive_split,
        crate::modules::splits::router::donate_split_share,
        crate::modules::splits::router::not_completed_split,
        crate::modules::splits::router::lost_split,
        crate::modules::albion::router::get_guild_roster,
        crate::modules::albion::router::search,
        crate::modules::albion::router::get_player,
        crate::modules::albion::router::get_guild,
        crate::modules::albion::router::get_link_status,
        crate::modules::albion::router::link_player,
        crate::modules::albion::router::unlink_player,
        crate::modules::albion::router::get_user_link_status,
        crate::modules::albion::router::admin_link_user_handler,
        crate::modules::albion::router::admin_unlink_user_handler,
        crate::modules::openalbion::router::list_weapons,
        crate::modules::openalbion::router::get_weapon_stats,
        crate::modules::openalbion::router::list_categories,
        crate::modules::openalbion::router::list_items,
        crate::modules::openalbion::router::get_catalog,
        crate::modules::openalbion::router::get_abilities,
        crate::modules::comps::router::set_build_item_spells,
        crate::modules::comps::router::create_build_version,
        crate::modules::comps::router::create_comp_version,
        crate::modules::comps::router::get_build_performance,
        crate::modules::comps::router::get_build_item_power,
        crate::modules::comps::router::get_build_roster_fit,
        crate::modules::comps::router::get_comp_readiness,
        crate::modules::combat::router::get_dataset,
        crate::modules::combat::router::post_item_power,
        crate::modules::combat::router::get_member_item_power,
        crate::modules::albiondata::router::get_prices,
        crate::modules::albiondata::router::get_item_icon,
        crate::modules::admin::router::reload_permissions,
        crate::modules::comps::router::list_build_categories,
        crate::modules::comps::router::create_build_category,
        crate::modules::comps::router::update_build_category,
        crate::modules::comps::router::delete_build_category,
        crate::modules::comps::router::list_comp_categories,
        crate::modules::comps::router::create_comp_category,
        crate::modules::comps::router::update_comp_category,
        crate::modules::comps::router::delete_comp_category,
        crate::modules::comps::router::list_builds,
        crate::modules::comps::router::create_build,
        crate::modules::comps::router::get_build,
        crate::modules::comps::router::update_build,
        crate::modules::comps::router::delete_build,
        crate::modules::comps::router::upsert_build_item,
        crate::modules::comps::router::remove_build_item,
        crate::modules::comps::router::list_comps,
        crate::modules::comps::router::create_comp,
        crate::modules::comps::router::get_comp,
        crate::modules::comps::router::get_comp_performance,
        crate::modules::comps::router::update_comp,
        crate::modules::comps::router::delete_comp,
        crate::modules::comps::router::add_comp_build,
        crate::modules::comps::router::update_comp_build_quantity,
        crate::modules::comps::router::remove_comp_build,
        crate::modules::events::router::list_events,
        crate::modules::events::router::get_event,
        crate::modules::events::router::get_roster_suggestions,
        crate::modules::events::router::list_event_roster_roles,
        crate::modules::events::router::create_event_roster_role,
        crate::modules::events::router::delete_event_roster_role,
        crate::modules::events::router::create_event,
        crate::modules::events::router::list_event_discord_roles,
        crate::modules::events::router::update_event,
        crate::modules::events::router::delete_event,
        crate::modules::events::router::archive_event,
        crate::modules::events::router::unarchive_event,
        crate::modules::events::router::participate,
        crate::modules::events::router::add_event_member,
        crate::modules::events::router::cancel_participation,
        crate::modules::events::router::remind_event,
        crate::modules::events::router::set_event_voice_channel,
        crate::modules::events::router::clear_event_voice_channel,
        crate::modules::events::router::start_event,
        crate::modules::events::router::stop_event,
        crate::modules::events::router::list_event_battles,
        crate::modules::events::router::replace_event_battles,
        crate::modules::splits::router::match_participants,
        crate::modules::utils::router::ocr_image,
        crate::modules::albionbb::router::list_battles,
        crate::modules::albionbb::router::get_battle,
        crate::modules::albionbb::router::get_battle_kills,
        crate::modules::albionbb::router::get_guild,
        crate::modules::albionbb::router::get_player_stats,
        crate::modules::battles::router::list_battles,
        crate::modules::battles::router::get_battle,
        crate::modules::battles::router::list_my_battles,
        crate::modules::siphoned::router::ingest,
        crate::modules::siphoned::router::list_entries,
        crate::modules::siphoned::router::create_entry,
        crate::modules::siphoned::router::update_entry,
        crate::modules::siphoned::router::delete_entry,
        crate::modules::siphoned::router::list_balances,
        crate::modules::siphoned::router::get_balance,
        crate::modules::siphoned::router::list_batches,
        crate::modules::siphoned::router::delete_batch,
        crate::modules::regear::router::list_deaths,
        crate::modules::regear::router::get_death,
        crate::modules::regear::router::request_regear,
        crate::modules::regear::router::list_pending_requests,
        crate::modules::regear::router::accept_request,
        crate::modules::regear::router::reject_request,
        crate::modules::regear::router::list_event_deaths,
        crate::modules::regear::router::run_extraction,
        crate::modules::regear::router::get_settings,
        crate::modules::regear::router::update_settings,
        crate::modules::regear::router::get_my_summary,
        crate::modules::intel::router::list_scouts,
        crate::modules::intel::router::get_scout,
        crate::modules::intel::router::update_scout,
        crate::modules::intel::router::delete_scout,
        crate::modules::intel::router::scout_battle,
        crate::modules::intel::router::similar_scouts,
        crate::modules::intel::router::counters,
        crate::modules::intel::router::threats_to_comp,
        crate::modules::intel::router::matchup_matrix,
        crate::modules::admin::router::get_permission_matrix,
        crate::modules::admin::router::update_role_permissions,
        crate::modules::admin::router::create_role,
        crate::modules::admin::router::update_role,
        crate::modules::admin::router::delete_role,
        crate::modules::admin::router::list_guild_discord_roles,
        crate::modules::admin::router::list_guild_discord_channels,
        crate::modules::admin::router::get_guild_settings,
        crate::modules::admin::router::update_guild_settings,
        crate::modules::admin::router::get_autorole,
        crate::modules::admin::router::list_discord_roles,
        crate::modules::admin::router::update_autorole,
        crate::modules::splits::router::complete_splits_batch,
        crate::modules::intel::router::leaderboards,
        crate::modules::intel::router::guild_report,
        crate::modules::intel::router::refresh_guild_report,
        crate::modules::intel::router::player_report,
        crate::modules::progression::router::get_me,
        crate::modules::progression::router::get_settings,
        crate::modules::progression::router::update_settings,
        crate::modules::progression::router::list_seasons,
        crate::modules::progression::router::create_season,
        crate::modules::progression::router::update_season,
        crate::modules::progression::router::activate_season,
        crate::modules::progression::router::award_message,
        crate::modules::progression::router::get_leaderboard,
        crate::modules::progression::router::get_user,
        crate::modules::progression::router::get_user_ledger,
        crate::modules::progression::router::adjust_user,
        crate::modules::vods::router::submit_vod,
        crate::modules::vods::router::list_mine,
        crate::modules::warns::router::issue_warn,
        crate::modules::warns::router::list_warns,
        crate::modules::warns::router::revoke_warn,
        crate::modules::warns::router::list_escalations,
        crate::modules::warns::router::ack_escalation,
        crate::modules::giveaways::router::list_giveaways,
        crate::modules::giveaways::router::create_giveaway,
        crate::modules::giveaways::router::get_giveaway,
        crate::modules::giveaways::router::enter_giveaway,
        crate::modules::giveaways::router::leave_giveaway,
        crate::modules::giveaways::router::cancel_giveaway,
        crate::modules::giveaways::router::draw_giveaway,
        crate::modules::giveaways::router::set_discord_message,
        crate::modules::notifications::router::list_notifications,
        crate::modules::notifications::router::unread_count,
        crate::modules::notifications::router::mark_read,
        crate::modules::notifications::router::mark_all_read,
        crate::modules::notifications::router::broadcast,
    ),
    components(
        schemas(
            crate::modules::audit::router::AuditLogResponse,
            crate::modules::audit::router::PaginatedAuditLogResponse,
            crate::modules::audit::router::ApiResponsePaginatedAuditLogs,
            crate::modules::users::service::UserProfile,
            crate::modules::users::service::UserMetrics,
            crate::modules::users::service::UserFilters,
            crate::responses::ApiResponseUserMetrics,
            crate::pagination::PaginationParams,
            crate::errors::ProblemDetails,
            crate::modules::auth::service::DiscordUserProfile,
            crate::responses::ApiResponseUserProfile,
            crate::responses::ApiResponseDiscordUserProfile,
            crate::pagination::PaginatedUserProfile,
            crate::modules::bank::models::TransactionView,
            crate::modules::bank::models::BalanceSummary,
            crate::modules::bank::models::GuildBankSummary,
            crate::modules::bank::models::BankBreakdown,
            crate::modules::bank::models::BankAnalyticsSummary,
            crate::modules::bank::models::TransactionFilters,
            crate::modules::bank::models::WithdrawRequest,
            crate::modules::bank::models::AcceptWithdrawalRequest,
            crate::modules::bank::models::CreateTransactionRequest,
            crate::modules::bank::models::UpdateTransactionRequest,
            crate::modules::bank::status::TransactionStatus,
            crate::pagination::PaginatedTransactionView,
            crate::responses::ApiResponseBalanceSummary,
            crate::responses::ApiResponseGuildBankSummary,
            crate::responses::ApiResponseBankAnalyticsSummary,
            crate::responses::ApiResponseTransactionView,
            crate::modules::splits::models::SplitSummary,
            crate::modules::splits::models::SplitKpiSummary,
            crate::responses::ApiResponseSplitKpiSummary,
            crate::modules::splits::models::SplitDetail,
            crate::modules::splits::models::SplitParticipantView,
            crate::modules::splits::models::CreateSplitRequest,
            crate::modules::splits::models::UpsertParticipantRequest,
            crate::modules::splits::models::SplitFilters,
            crate::modules::splits::models::SplitIslandView,
            crate::modules::splits::models::SplitIslandTabView,
            crate::modules::splits::models::CreateIslandRequest,
            crate::modules::splits::models::UpdateIslandRequest,
            crate::modules::splits::models::CreateIslandTabRequest,
            crate::modules::splits::models::UpdateIslandTabRequest,
            crate::modules::splits::status::SplitStatus,
            crate::modules::splits::city::SplitIslandCity,
            crate::pagination::PaginatedSplitSummary,
            crate::responses::ApiResponseSplitDetail,
            crate::modules::albion::client::AlbionSearchResult,
            crate::modules::albion::client::AlbionGuildSummary,
            crate::modules::albion::client::AlbionPlayerSummary,
            crate::modules::albion::client::AlbionGuildMember,
            crate::modules::albion::client::AlbionGuild,
            crate::modules::albion::client::AlbionPlayer,
            crate::modules::albion::service::AlbionLinkStatus,
            crate::modules::albion::router::LinkPlayerRequest,
            crate::responses::ApiResponseAlbionLinkStatus,
            crate::responses::ApiResponsePaginatedAlbionGuildMembers,
            crate::pagination::PaginatedAlbionGuildMember,
            crate::modules::openalbion::catalog::OpenAlbionCategory,
            crate::modules::openalbion::catalog::OpenAlbionWeapon,
            crate::modules::openalbion::catalog::OpenAlbionStatEntry,
            crate::modules::openalbion::catalog::OpenAlbionWeaponQualityStat,
            crate::modules::openalbion::catalog::OpenAlbionWeaponStats,
            crate::modules::openalbion::catalog::OpenAlbionItem,
            crate::modules::openalbion::catalog::OpenAlbionAbility,
            crate::modules::openalbion::catalog::OpenAlbionItemAbilities,
            crate::modules::openalbion::catalog::OpenAlbionItemType,
            crate::responses::ApiResponsePaginatedOpenAlbionWeapons,
            crate::pagination::PaginatedOpenAlbionWeapon,
            crate::responses::ApiResponsePaginatedOpenAlbionItems,
            crate::pagination::PaginatedOpenAlbionItem,
            crate::modules::albiondata::client::AlbionDataMarketPrice,
            crate::modules::albiondata::client::AlbionDataItemIcon,
            crate::responses::ApiResponseAlbionDataMarketPriceList,
            crate::responses::ApiResponseAlbionDataItemIcon,
            crate::modules::comps::models::BuildCategoryView,
            crate::modules::comps::models::CompCategoryView,
            crate::modules::comps::models::BuildSummary,
            crate::modules::comps::models::BuildDetail,
            crate::modules::combat::models::CombatDatasetView,
            crate::modules::combat::models::ItemPowerRequest,
            crate::modules::combat::models::LoadoutItemRequest,
            crate::modules::combat::models::SpecSource,
            crate::modules::combat::models::ItemPowerView,
            crate::modules::combat::models::MemberItemPowerView,
            crate::modules::combat::models::BlockingNode,
            crate::modules::combat::models::BuildRosterFitView,
            crate::modules::combat::data_types::DatasetVersion,
            crate::modules::combat::ip::CharacterIpBreakdown,
            crate::modules::combat::ip::ItemIpBreakdown,
            crate::modules::combat::ip::SpecContribution,
            crate::modules::combat::fit::Assignment,
            crate::modules::combat::fit::Placement,
            crate::modules::combat::fit::FitScore,
            crate::modules::combat::fit::Preference,
            crate::modules::combat::fit::FitStrategy,
            crate::modules::combat::readiness::CompReadiness,
            crate::modules::combat::readiness::SeatReadiness,
            crate::modules::combat::readiness::BuildCoverage,
            crate::modules::comps::models::BuildItemView,
            crate::modules::comps::models::BuildItemSpells,
            crate::modules::comps::models::BuildVersionRef,
            crate::modules::events::models::BuildPerformanceView,
            crate::modules::events::models::BuildBattleStats,
            crate::modules::comps::models::CompSummary,
            crate::modules::comps::models::CompDetail,
            crate::modules::comps::models::CompBuildView,
            crate::modules::comps::models::CreateBuildCategoryRequest,
            crate::modules::comps::models::UpdateBuildCategoryRequest,
            crate::modules::comps::models::CreateCompCategoryRequest,
            crate::modules::comps::models::UpdateCompCategoryRequest,
            crate::modules::comps::models::CreateBuildRequest,
            crate::modules::comps::models::UpdateBuildRequest,
            crate::modules::comps::models::UpsertBuildItemRequest,
            crate::modules::comps::models::CreateCompRequest,
            crate::modules::comps::models::UpdateCompRequest,
            crate::modules::comps::models::AddCompBuildRequest,
            crate::modules::comps::models::UpdateCompBuildQuantityRequest,
            crate::modules::comps::models::BuildFilters,
            crate::modules::comps::models::CompFilters,
            crate::modules::comps::status::BuildRole,
            crate::modules::comps::status::BuildSlot,
            crate::responses::ApiResponseBuildCategoryList,
            crate::responses::ApiResponseCompCategoryList,
            crate::responses::ApiResponseBuildDetail,
            crate::responses::ApiResponseCombatDataset,
            crate::responses::ApiResponseItemPower,
            crate::responses::ApiResponseBuildRosterFit,
            crate::responses::ApiResponseRosterSuggestions,
            crate::responses::ApiResponseCompReadiness,
            crate::responses::ApiResponseCompDetail,
            crate::responses::ApiResponsePaginatedComps,
            crate::responses::ApiResponsePaginatedBuilds,
            crate::pagination::PaginatedCompSummary,
            crate::pagination::PaginatedBuildSummary,
            crate::modules::events::models::EventView,
            crate::modules::events::models::EventParticipantView,
            crate::modules::events::models::EventDetailView,
            crate::modules::events::models::CreateEventRequest,
            crate::modules::events::models::UpdateEventRequest,
            crate::modules::events::models::SetEventVoiceChannelRequest,
            crate::modules::events::models::ParticipateEventRequest,
            crate::modules::events::models::AddEventMemberRequest,
            crate::modules::events::models::SetParticipantRequest,
            crate::modules::events::models::UpdateEventBattlesRequest,
            crate::modules::events::models::EventBattleView,
            crate::pagination::PaginatedEventSummary,
            crate::responses::ApiResponseEventList,
            crate::responses::ApiResponseEventView,
            crate::responses::ApiResponseEventDetail,
            crate::modules::splits::models::MatchParticipantsRequest,
            crate::modules::splits::models::MatchedParticipant,
            crate::responses::ApiResponseMatchedParticipantList,
            crate::modules::utils::models::OcrResult,
            crate::responses::ApiResponseOcrResult,
            crate::modules::albionbb::client::AlbionBbBattleSummary,
            crate::modules::albionbb::client::AlbionBbBattleDetail,
            crate::modules::albionbb::client::AlbionBbGuild,
            crate::modules::albionbb::client::AlbionBbGuildInfo,
            crate::modules::albionbb::client::AlbionBbPlayer,
            crate::modules::albionbb::client::AlbionBbKillEvent,
            crate::modules::albionbb::client::AlbionBbKillParticipant,
            crate::modules::albionbb::router::AlbionBbBattlesList,
            crate::responses::ApiResponseAlbionBbBattlesList,
            crate::responses::ApiResponseAlbionBbBattleDetail,
            crate::responses::ApiResponseAlbionBbKillEventList,
            crate::responses::ApiResponseAlbionBbGuildInfo,
            crate::responses::ApiResponseAlbionBbPlayerStats,
            crate::modules::battles::models::BattleGuildSummary,
            crate::modules::battles::models::BattleSummary,
            crate::modules::battles::models::BattlePlayer,
            crate::modules::battles::models::BattleKillParticipant,
            crate::modules::battles::models::BattleKillEvent,
            crate::modules::battles::models::BattleDetail,
            crate::pagination::PaginatedBattleSummary,
            crate::responses::ApiResponsePaginatedBattles,
            crate::responses::ApiResponseBattleDetail,
            crate::modules::siphoned::models::EntryView,
            crate::modules::siphoned::models::EntryMutationRequest,
            crate::modules::siphoned::models::PlayerBalance,
            crate::modules::siphoned::models::PlayerBalanceDetail,
            crate::modules::siphoned::models::BalanceSort,
            crate::modules::siphoned::models::IngestRow,
            crate::modules::siphoned::models::IngestRequest,
            crate::modules::siphoned::models::IngestResponse,
            crate::modules::siphoned::models::EntryFilters,
            crate::modules::siphoned::models::BatchSummary,
            crate::modules::siphoned::models::DeletedCount,
            crate::modules::siphoned::status::SiphonedEntrySource,
            crate::pagination::PaginatedEntryView,
            crate::responses::ApiResponseIngestResponse,
            crate::responses::ApiResponseEntryView,
            crate::responses::ApiResponsePaginatedEntryView,
            crate::pagination::PaginatedPlayerBalance,
            crate::responses::ApiResponsePaginatedPlayerBalance,
            crate::responses::ApiResponsePlayerBalanceDetail,
            crate::responses::ApiResponseBatchSummaryList,
            crate::responses::ApiResponseDeletedCount,
            crate::modules::regear::models::BreakdownRow,
            crate::modules::regear::models::DeathView,
            crate::modules::regear::models::DeathFilters,
            crate::modules::regear::models::RegearSettingsView,
            crate::modules::regear::models::UpdateRegearSettingsRequest,
            crate::modules::regear::models::AcceptRegearRequest,
            crate::modules::regear::models::RejectRegearRequest,
            crate::modules::regear::models::RegearBudgetSummary,
            crate::modules::regear::models::ExtractionReport,
            crate::modules::regear::status::RegearStatus,
            crate::modules::intel::models::ScoutedCompSummary,
            crate::modules::intel::models::ScoutedCompDetail,
            crate::modules::intel::models::SimilarityHit,
            crate::modules::intel::models::CounterSuggestion,
            crate::modules::intel::models::ScoutOutcome,
            crate::modules::intel::models::ScoutFilters,
            crate::modules::intel::models::UpdateScoutRequest,
            crate::modules::intel::models::MergeScoutRequest,
            crate::modules::intel::scout::ScoutedPlayer,
            crate::modules::intel::matchups::MatchupRow,
            crate::modules::intel::matchups::MatchupCoverage,
            crate::modules::intel::matchups::MatchupReport,
            crate::modules::intel::status::IntelScoutCategory,
            crate::modules::admin::models::PermissionMatrix,
            crate::modules::admin::models::PermissionCatalogEntry,
            crate::modules::admin::models::RolePermissionsView,
            crate::modules::admin::models::UpdateRolePermissionsRequest,
            crate::modules::admin::models::CreateRoleRequest,
            crate::modules::admin::models::UpdateRoleRequest,
            crate::modules::admin::models::GuildSettingsView,
            crate::modules::admin::models::UpdateGuildSettingsRequest,
            crate::modules::admin::models::DiscordRoleView,
            crate::modules::admin::models::DiscordChannelView,
            crate::modules::admin::models::DiscordForumTagView,
            crate::modules::admin::models::AutoRoleSettingsView,
            crate::modules::admin::models::UpdateAutoRoleRequest,
            crate::modules::splits::models::CompleteSplitsBatchRequest,
            crate::modules::splits::models::CompleteSplitsBatchResult,
            crate::modules::splits::models::BatchFailure,
            crate::modules::intel::report::GuildReport,
            crate::modules::intel::report::ReportOverview,
            crate::modules::intel::report::ReportOperations,
            crate::modules::intel::report::ReportEconomy,
            crate::modules::intel::report::ReportDataQuality,
            crate::modules::intel::report::ReportLeaderboards,
            crate::modules::intel::report::LeaderboardEntry,
            crate::modules::intel::report::FightSummary,
            crate::modules::intel::report::MemberRow,
            crate::modules::intel::report::CompRow,
            crate::modules::intel::report::EnemyRow,
            crate::modules::intel::report::WeaponShare,
            crate::modules::intel::report::HourBucket,
            crate::modules::intel::report::TrendBucket,
            crate::modules::intel::report::TimelineEntry,
            crate::modules::intel::report::PlayerReport,
            crate::modules::intel::report::PlayerTrendBucket,
            crate::pagination::PaginatedScoutedComp,
            crate::pagination::PaginatedDeathView,
            crate::modules::progression::models::SeasonView,
            crate::modules::progression::models::ProgressionMeView,
            crate::modules::progression::models::ProgressionSettingsView,
            crate::modules::progression::models::LevelThresholdView,
            crate::modules::progression::models::UpdateProgressionSettingsRequest,
            crate::modules::progression::models::CreateSeasonRequest,
            crate::modules::progression::models::UpdateSeasonRequest,
            crate::modules::progression::models::AwardMessageRequest,
            crate::modules::progression::models::AwardMessageView,
            crate::modules::progression::models::LeaderboardEntryView,
            crate::modules::progression::models::XpLedgerEntryView,
            crate::modules::progression::models::AdjustProgressionRequest,
            crate::modules::progression::status::XpSource,
            crate::modules::vods::models::SubmitVodRequest,
            crate::modules::vods::models::VodReviewView,
            crate::modules::warns::models::IssueWarnRequest,
            crate::modules::warns::models::WarnView,
            crate::modules::warns::models::WarnEscalationView,
            crate::modules::warns::status::WarnSeverity,
            crate::pagination::PaginatedLeaderboardEntryView,
            crate::pagination::PaginatedXpLedgerEntryView,
            crate::pagination::PaginatedWarnView,
            crate::pagination::PaginatedWarnEscalationView,
            crate::responses::ApiResponseProgressionMeView,
            crate::responses::ApiResponseAwardMessageView,
            crate::responses::ApiResponsePaginatedLeaderboardEntryView,
            crate::responses::ApiResponsePaginatedXpLedgerEntryView,
            crate::responses::ApiResponseVodReviewView,
            crate::responses::ApiResponseVodReviewViewList,
            crate::responses::ApiResponseWarnView,
            crate::responses::ApiResponsePaginatedWarnView,
            crate::responses::ApiResponseWarnEscalationView,
            crate::responses::ApiResponsePaginatedWarnEscalationView,
            crate::modules::notifications::models::BroadcastRequest,
            crate::modules::notifications::models::BroadcastResult,
            crate::modules::notifications::models::NotificationView,
            crate::modules::notifications::models::UnreadCountView,
            crate::modules::notifications::models::ReadAllResult,
            crate::modules::notifications::status::NotificationKind,
            crate::pagination::PaginatedNotificationView,
            crate::responses::ApiResponseNotificationView,
            crate::responses::ApiResponsePaginatedNotificationView,
            crate::responses::ApiResponseUnreadCountView,
            crate::responses::ApiResponseReadAllResult,
            crate::responses::ApiResponseBroadcastResult,
            crate::responses::ApiResponseGiveawayDetail,
            crate::responses::ApiResponsePaginatedGiveawayView,
            crate::modules::giveaways::models::GiveawayView,
            crate::modules::giveaways::models::GiveawayDetailView,
            crate::modules::giveaways::models::GiveawayPrizeView,
            crate::modules::giveaways::models::GiveawayEntryView,
            crate::modules::giveaways::models::CreateGiveawayRequest,
            crate::modules::giveaways::models::CreateGiveawayPrizeRequest,
            crate::modules::giveaways::models::SetGiveawayDiscordMessageRequest,
            crate::modules::giveaways::status::GiveawayStatus,
            crate::pagination::PaginatedGiveawayView,
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
        (name = "progression", description = "Season-scoped XP and levels: members earn XP from Discord and guild actions; admins model the season dates and curve."),
        (name = "vods", description = "VOD review claims: one XP grant per normalized URL per covering season, posted in the configured Discord forum."),
        (name = "warns", description = "Disciplinary warn register: issue/revoke with audit, and an admin escalation when the active-warn count reaches the configured threshold. No auto-kick."),
        (name = "giveaways", description = "Guild giveaways: officers create a timed Discord prize draw (Albion items plus optional Guild Bank silver); members enter from Discord; expiry auto-draws one winner."),
        (name = "notifications", description = "Per-member in-app inbox: list/read own notifications, unread badge, and officer broadcast fan-out. Discord DMs are delivered by a background worker."),
        (name = "admin", description = "Administrative operations: permission cache reload."),
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
5. `POST /api/auth/logout` clears the cookie.

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
| `users.create`           | Admin             | `POST /users`                              |
| `permissions.reload`     | Admin             | `POST /admin/permissions/reload`           |
| `roles.manage`           | Admin             | `POST/PATCH/DELETE /admin/roles`           |
| `comps.build_categories.manage` | Admin, Officer | build category CRUD endpoints |
| `comps.comp_categories.manage` | Admin, Officer | comp category CRUD endpoints |
| `comps.builds.manage`    | Admin, Officer    | build CRUD endpoints                       |
| `comps.comps.manage`     | Admin, Officer    | comp CRUD endpoints                        |

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
    use crate::modules::auth::Permission;
    use utoipa::OpenApi;

    /// Every `security(("session_cookie" = ["..."]))` scope declared on a route
    /// must be a valid `Permission::as_str()` value. Catches typos and drift
    /// between the OpenAPI annotations and the `Permission` enum at CI time.
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
        for (_path, path_item) in &api.paths.paths {
            check(path_item.get.as_ref());
            check(path_item.post.as_ref());
            check(path_item.put.as_ref());
            check(path_item.delete.as_ref());
            check(path_item.patch.as_ref());
        }
    }
}
