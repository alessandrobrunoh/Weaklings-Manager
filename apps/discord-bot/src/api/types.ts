/**
 * Shared type definitions mirroring the backend Rust API responses.
 * Kept in sync with apps/frontend/src/app/core/models/api.models.ts.
 */

/* ----------------------------- Envelope ----------------------------- */

export interface ApiResponse<T> {
  status: 'success';
  data: T;
}

export interface PaginatedData<T> {
  items: T[];
  total_items: number;
  total_pages: number;
  current_page: number;
  limit: number;
}

/* ------------------------------ Auth -------------------------------- */

export type Role = 'User' | 'Officer' | 'Admin' | 'SuperAdmin';

export type BuildRole =
  | 'healer'
  | 'tank'
  | 'dps'
  | 'support'
  | 'battle_mount'
  | 'brawler';

export interface BuildSummary {
  id: number;
  name: string;
  role: BuildRole;
  category_id: number;
  category_name?: string;
  created_by_username: string;
  updated_at: string;
  item_count: number;
}

export interface CompBuildView {
  build_id: number;
  build: BuildSummary;
  quantity: number;
}

export interface CompSummary {
  id: number;
  name: string;
  category_id: number;
  category_name?: string;
  created_by_username: string;
  created_at: string;
  build_count: number;
  total_quantity: number;
  parent_id?: number;
}

export interface CompDetail extends CompSummary {
  builds: CompBuildView[];
}

export type PermissionKey =
  | 'bank.withdraw.accept'
  | 'bank.view_others'
  | 'splits.manage'
  | 'splits.islands.manage'
  | 'users.create'
  | 'permissions.reload'
  | 'comps.build_categories.manage'
  | 'comps.comp_categories.manage'
  | 'comps.builds.manage'
  | 'comps.comps.manage'
  | 'events.manage'
  | 'siphoned.ingest'
  | 'siphoned.view'
  | 'progression.view'
  | 'progression.settings.manage'
  | 'progression.adjust'
  | 'warns.view'
  | 'warns.issue'
  | 'vod.submit';

export interface DiscordUserProfile {
  id: string;
  username: string;
  avatar: string | null;
  email: string | null;
  user_id: number;
  roles: Role[];
  highest_role: Role;
  is_superadmin: boolean;
  permissions: PermissionKey[];
}

/* ----------------------------- Users -------------------------------- */

export interface UserProfile {
  id: number;
  username: string;
  email: string;
  role: Role;
}

/* ------------------------------ Bank -------------------------------- */

export type TransactionStatus = 'pending' | 'requested' | 'rejected' | 'withdrawn' | 'donated';

export interface TransactionView {
  id: number;
  to_user_id: number;
  to_username: string;
  to_label: string;
  to_guild_bank: boolean;
  amount: number;
  status: TransactionStatus;
  type: string;
  split_id: number | null;
  from_user_id: number | null;
  from_label: string;
  created_at: string;
  requested_at: string | null;
  withdrawn_at: string | null;
}

export interface BalanceSummary {
  user_id: number;
  pending_total: number;
  pending_count: number;
  requested_total: number;
  requested_count: number;
}

export interface WithdrawRequest {
  transaction_ids?: number[];
  all?: boolean;
}

/* ----------------------------- Splits ------------------------------- */

export type SplitStatus = 'pending' | 'completed' | 'not_completed' | 'lost';
export type SplitParticipantCreditStatus = TransactionStatus;

/** Detail returned by the bot split-sync endpoint. Financial values are authoritative backend data. */
export interface SplitParticipant {
  user_id: number;
  username: string;
  discord_id?: string | null;
  weight: number;
  share_amount: number | null;
  credit_status?: SplitParticipantCreditStatus | null;
}

export interface SplitDetail {
  id: number;
  created_by_username: string;
  status: SplitStatus;
  estimated_market_value: number;
  fee: number;
  repair_value: number;
  bags_value: number;
  net_value: number | null;
  note: string | null;
  event_id: number | null;
  event_title: string | null;
  island_id: number | null;
  island_name: string | null;
  island_city: string | null;
  island_tab_id: number | null;
  island_tab_name: string | null;
  participant_count: number;
  created_at: string;
  finalized_at: string | null;
  /** Monotonic backend version or updated timestamp; required for incremental polling. */
  updated_at?: string | null;
  participants: SplitParticipant[];
}

export interface SplitDiscoveryBatch {
  items: SplitDetail[];
  next_updated_at: string | null;
  next_id: number | null;
  has_more: boolean;
}

export interface SplitAuditLog {
  id: number;
  action: string;
  entity_type: string | null;
  entity_id: number | null;
  split_id: number | null;
  user_id: number | null;
  details: unknown;
  created_at: string;
}

export interface SplitDiscordSync {
  split_id: number;
  detail: SplitDetail;
  transactions: TransactionView[];
  audit: SplitAuditLog[];
  next_audit_cursor: number;
  next_transaction_cursor: number;
  thread_id: string | null;
  summary_message_id: string | null;
}

export interface UpdateSplitDiscordSyncState {
  thread_id?: string;
  summary_message_id?: string;
  last_audit_id?: number;
  last_transaction_id?: number;
}

/* ----------------------------- Events ------------------------------- */

export type EventStatus = 'scheduled' | 'live' | 'stopped' | 'auto_stopped';

export interface EventView {
  id: number;
  title: string;
  description: string | null;
  call_to_arms: boolean;
  discord_role_ids: string[];
  regear: boolean;
  /** Optional planning threshold that advances comp expansions without blocking signups. */
  player_cap?: number | null;
  comp_id: number;
  comp_name: string;
  created_by: number;
  created_by_username: string;
  event_date_utc: string;
  created_at: string;
  updated_at: string;
  status: EventStatus;
  started_at: string | null;
  stopped_at: string | null;
  auto_stop_deadline: string | null;
  discord_voice_channel_id: string | null;
  link_status: string;
}

export interface EventParticipant {
  user_id: number;
  username: string;
  discord_id: string | null;
  primary_build_id: number | null;
  primary_build_name: string;
  secondary_build_id: number | null;
  secondary_build_name: string | null;
}

export interface EventCompBuild {
  build_id: number;
  name: string;
  quantity: number;
}

export interface EventDetailView extends EventView {
  active_comp_id: number;
  active_comp_name: string;
  active_comp_capacity: number;
  /** Full active comp snapshot so the Discord message can render empty slots. */
  comp_builds?: EventCompBuild[];
  participants: EventParticipant[];
}

export interface EventSignupBuildOption {
  build_id: number;
  name: string;
  role: BuildRole;
  quantity: number;
}

/** Server-authoritative comp tier and builds for the requesting member's next concrete signup. */
export interface EventSignupOptionsView {
  active_comp_id: number;
  active_comp_name: string;
  active_comp_capacity: number;
  is_already_registered: boolean;
  builds: EventSignupBuildOption[];
}

export interface CreateEventRequest {
  title: string;
  description?: string;
  call_to_arms?: boolean;
  regear?: boolean;
  comp_id: number;
  player_cap?: number;
  event_date_utc: string;
  discord_role_ids?: string[];
}

export interface ParticipateEventRequest {
  primary_build_id: number | null;
  secondary_build_id?: number;
}

/* ------------------------------ Comps ------------------------------- */

/* ----------------------------- Battles ------------------------------ */

export interface BattleGuildSummary {
  id: string;
  name: string;
  players: number;
  kills: number;
  deaths: number;
  kill_fame: number;
  winner: boolean;
}

export interface BattleSummary {
  battle_id: number;
  start_time: string;
  end_time: string;
  total_players: number;
  total_kills: number;
  total_fame: number;
  guilds: BattleGuildSummary[];
}

/* ------------------------------ Albion ------------------------------ */

export interface AlbionLinkRequest {
  albion_player_id: string;
  albion_player_name: string;
}

export interface AlbionLinkStatus {
  linked: boolean;
  albion_player_id?: string;
  albion_player_name?: string;
  linked_at?: string;
}

export interface AlbionPlayerSummary {
  id: string;
  name: string;
}

export interface AlbionGuildSummary {
  id: string;
  name: string;
}

export interface AlbionSearchResult {
  players: AlbionPlayerSummary[];
  guilds: AlbionGuildSummary[];
}

export interface AlbionPlayer {
  id: string;
  name: string;
  guildName?: string | null;
  allianceName?: string | null;
  killFame: number;
  deathFame: number;
  pveFame: number;
  gatheringFame: number;
  craftingFame: number;
  fishingFame?: number;
  farmingFame?: number;
}

export interface AlbionGuildMember {
  id: string;
  name: string;
}

/**
 * The guild's Discord integration settings — channel/role IDs configured from the admin
 * Settings page instead of this process's own env vars. Every field is nullable: an unset
 * channel means "skip this notification", same as the env vars they replaced.
 */
export interface GuildSettingsView {
  discord_events_channel_id: string | null;
  discord_battles_channel_id: string | null;
  discord_battles_cta_channel_id: string | null;
  discord_audit_log_channel_id: string | null;
  discord_transaction_spam_channel_id: string | null;
  discord_event_role_id: string | null;
  discord_auto_role_id: string | null;
  discord_splits_forum_channel_id: string | null;
  discord_event_voice_category_id: string | null;
}

/* -------------------------- Progression ----------------------------- */

export interface ProgressionSeasonView {
  id: number;
  name: string;
  starts_at: string;
  ends_at: string;
  is_active: boolean;
}

export interface ProgressionMeView {
  season?: ProgressionSeasonView | null;
  level: number;
  xp: number;
  xp_to_next: number;
  next_level_at: number;
  rank?: number | null;
  multiplier: string | number;
  lifetime_xp: number;
}

export interface ProgressionLeaderboardEntry {
  user_id: number;
  username: string;
  xp: number;
  level: number;
  rank: number;
}

export interface AwardMessageRequest {
  discord_id: string;
  message_id: string;
  channel_id: string;
  length: number;
}

export interface AwardMessageResponse {
  awarded: boolean;
  reason?: string;
}

export interface AdjustXpRequest {
  set_xp?: number;
  add_xp?: number;
  set_level?: number;
  set_multiplier?: number;
  multiplier_expires_at?: string;
  reason: string;
}

export interface SubmitVodRequest {
  url: string;
  discord_thread_id: string;
  discord_message_id: string;
  forum_channel_id: string;
  thread_owner_discord_id: string;
}

export interface VodReviewView {
  id?: number;
  user_id?: number;
  url: string;
  discord_thread_id?: string;
  discord_message_id?: string;
}

export type WarnSeverity = 'note' | 'warn' | 'strike';

export interface IssueWarnRequest {
  user_id: number;
  reason: string;
  severity?: WarnSeverity;
  multiplier?: number;
  multiplier_expires_at?: string;
}

export interface WarnView {
  id: number;
  user_id: number;
  username?: string;
  issued_by_user_id?: number;
  reason: string;
  severity: WarnSeverity | string;
  multiplier?: string | number | null;
  multiplier_expires_at?: string | null;
  revoked_at?: string | null;
  revoked_by?: number | null;
  created_at?: string;
}

export interface WarnEscalationView {
  id: number;
  user_id: number;
  username?: string;
  threshold_at_time: number;
  warn_count_at_time: number;
  opened_at: string;
  acknowledged_at?: string | null;
  acknowledged_by?: number | null;
}
