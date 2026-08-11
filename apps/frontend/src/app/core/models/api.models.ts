/**
 * Type definitions for every backend API response payload.
 *
 * Mirrors the Rust serde structs in the backend modules. One canonical place
 * so feature pages import types from here instead of re-declaring per-page.
 */

/* ----------------------------- Envelope ----------------------------- */

/** JSend-style success wrapper returned by every JSON endpoint. */
export interface ApiResponse<T> {
  status: 'success';
  data: T;
}

/** Standard pagination metadata returned alongside list endpoints (flat in the JSON payload). */
export interface PaginatedData<T> {
  items: T[];
  total_items: number;
  total_pages: number;
  current_page: number;
  limit: number;
}

/** Problem-details payload returned on error (RFC 7807-ish). */
export interface ProblemDetails {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
}

/* ------------------------------ Auth -------------------------------- */

export type Role = 'User' | 'Officer' | 'Admin' | 'SuperAdmin';

export type PermissionKey =
  | 'bank.withdraw.accept'
  | 'bank.view_others'
  | 'splits.manage'
  | 'users.create'
  | 'permissions.reload'
  | 'comps.build_categories.manage'
  | 'comps.comp_categories.manage'
  | 'comps.builds.manage'
  | 'comps.comps.manage'
  | 'events.manage'
  | 'siphoned.ingest'
  | 'siphoned.view';

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

export interface UserMetrics {
  most_played_build: string | null;
  events_attended: number;
  total_estimated_loss: number;
  top_estimated_loss: number;
}

export interface UserFilters {
  username?: string;
  email?: string;
  role?: string;
}

/* ------------------------------ Bank -------------------------------- */

export type TransactionStatus = 'pending' | 'requested' | 'rejected' | 'withdrawn';

export interface TransactionView {
  id: number;
  to_user_id: number;
  to_username: string;
  amount: number;
  reason: string | null;
  status: TransactionStatus;
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

export interface GuildBankSummary {
  paid_total: number;
  paid_count: number;
}

export interface WithdrawRequest {
  transaction_ids?: number[];
  all?: boolean;
}

export type AcceptWithdrawalRequest = WithdrawRequest;

export type RejectWithdrawalRequest = WithdrawRequest;

/* ----------------------------- Splits ------------------------------- */

export type SplitStatus = 'pending' | 'completed' | 'not_completed' | 'lost';

export interface SplitParticipant {
  user_id: number;
  username: string;
  weight: number;
  share_amount: number | null;
}

export interface SplitSummary {
  id: number;
  created_by_username: string;
  status: SplitStatus;
  estimated_market_value: number;
  repair_value: number;
  bags_value: number;
  net_value: number | null;
  note: string | null;
  event_id: number | null;
  event_title: string | null;
  participant_count: number;
  created_at: string;
  finalized_at: string | null;
}

export interface SplitDetail extends SplitSummary {
  participants: SplitParticipant[];
}

export interface SplitFilters {
  status?: SplitStatus;
  event_id?: number;
  search?: string;
  date_from?: string;
  date_to?: string;
}

export interface CreateSplitRequest {
  note?: string;
  estimated_market_value: number;
  repair_value: number;
  bags_value: number;
  event_id?: number;
  participants: Array<{ user_id: number; weight: number }>;
}

export interface UpdateSplitRequest {
  note?: string;
  estimated_market_value?: number;
  repair_value?: number;
  bags_value?: number;
  event_id?: number | null;
}

export interface UpsertParticipantRequest {
  user_id: number;
  weight: number;
}

export interface MatchParticipantsRequest {
  names: string[];
}

export interface MatchedParticipant {
  user_id: number;
  username: string;
  matched_name: string;
}

/* ----------------------------- Events ------------------------------- */

export type EventStatus = 'scheduled' | 'live' | 'stopped' | 'auto_stopped';

export interface EventView {
  id: number;
  title: string;
  description: string | null;
  call_to_arms: boolean;
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
  link_status: string;
  link_attempts: number;
  link_last_error: string | null;
  link_battles_completed_at: string | null;
}

export interface BattlePerformanceStats {
  total_battles: number;
  wins: number;
  losses: number;
  win_rate: number;
  total_kills: number;
  total_deaths: number;
  kill_death_ratio: number;
  total_kill_fame: number;
  average_guild_players: number;
  top_opponents: OpponentPerformanceView[];
}

export interface OpponentPerformanceView {
  guild_id: string | null;
  guild_name: string;
  battles: number;
  wins: number;
  losses: number;
  guild_kill_fame: number;
  opponent_kill_fame: number;
}

export interface CompPerformanceView {
  comp_id: number;
  comp_name: string;
  events_with_battles: number;
  stats: BattlePerformanceStats;
}

export interface EventSplitStats {
  total_splits: number;
  pending_splits: number;
  completed_splits: number;
  not_completed_splits: number;
  lost_splits: number;
  estimated_market_value: string;
  repair_value: string;
  bags_value: string;
  completed_net_value: string;
  participant_entries: number;
}

export interface EventDetailView extends EventView {
  active_comp_id: number;
  active_comp_name: string;
  active_comp_capacity: number;
  participants: EventParticipant[];
  battles: EventBattleSummary[];
  stats: BattlePerformanceStats;
  estimated_losses: BattleLossEstimate;
  splits: SplitSummary[];
  split_stats: EventSplitStats;
}

export interface EventParticipant {
  user_id: number;
  username: string;
  primary_build_id: number;
  primary_build_name: string;
  secondary_build_id: number | null;
  secondary_build_name: string | null;
}

export interface EventFilters {
  search?: string;
  date_from?: string;
  date_to?: string;
}

export interface EventBattleSummary {
  id: number;
  albionbb_battle_id: string;
  battle_started_at: string;
  guild_players_count: number;
  battle_total_players: number | null;
  fetched_at: string;
  guild_kills: number;
  guild_deaths: number;
  guild_kill_fame: number;
  is_win: boolean;
  opponent_guild_id: string | null;
  opponent_guild_name: string | null;
  opponent_players_count: number | null;
  opponent_kills: number | null;
  opponent_deaths: number | null;
  opponent_kill_fame: number | null;
}

export interface CreateEventRequest {
  title: string;
  description?: string;
  call_to_arms?: boolean;
  comp_id: number;
  event_date_utc: string;
}

export interface UpdateEventRequest {
  title?: string;
  description?: string;
  call_to_arms?: boolean;
  event_date_utc?: string;
  comp_id?: number;
}

export interface UpdateEventBattlesRequest {
  battle_ids: string[];
}

export interface ParticipateEventRequest {
  primary_build_id: number;
  secondary_build_id?: number;
}

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

export interface BattlePlayer {
  id: string;
  name: string;
  guild_id: string;
  guild_name: string;
  kills: number;
  deaths: number;
  kill_fame: number;
  death_fame: number;
  item_power: number;
}

export interface BattleKillParticipant {
  id: string;
  name: string;
  guild_id: string | null;
  guild_name: string | null;
}

export interface BattleKillEvent {
  event_id: number;
  time: string;
  killer: BattleKillParticipant;
  victim: BattleKillParticipant;
  killer_item_power: number;
  victim_item_power: number;
  total_kill_fame: number;
  raw: unknown;
}

export interface BattleLossEstimate {
  total_estimated_loss: number;
  priced_items: number;
  total_items: number;
  players: PlayerLossEstimate[];
  guilds: GuildLossEstimate[];
}

export interface PlayerLossEstimate {
  player_name: string;
  guild_name: string | null;
  estimated_loss: number;
  deaths: number;
  priced_items: number;
  total_items: number;
}

export interface GuildLossEstimate {
  guild_name: string;
  estimated_loss: number;
  deaths: number;
  priced_items: number;
  total_items: number;
}

export interface BattleDetail extends BattleSummary {
  players: BattlePlayer[];
  kills: BattleKillEvent[];
  estimated_losses: BattleLossEstimate;
}

/* ------------------------------ Albion ------------------------------ */

export interface AlbionGuildMember {
  id: string;
  name: string;
}

export interface AlbionPlayer {
  id: string;
  name: string;
  guild_id: string | null;
  guild_name: string | null;
  kill_fame: number;
  death_fame: number;
}

export interface AlbionGuild {
  id: string;
  name: string;
  member_count: number;
  kill_fame: number;
}

export interface AlbionSearchResult {
  guilds: AlbionGuild[];
  players: AlbionPlayer[];
}

export interface AlbionLinkStatus {
  linked: boolean;
  albion_player_id?: string;
  albion_player_name?: string;
  linked_at?: string;
}

export interface AlbionLinkRequest {
  albion_player_id: string;
  albion_player_name: string;
}

/* ----------------------------- OpenAlbion --------------------------- */

export interface OpenAlbionWeapon {
  id: number;
  name: string;
  tier: string;
  category_id: number | null;
  subcategory_id: number | null;
}

export interface OpenAlbionWeaponStats {
  enchantment: number;
  tiers: Array<{ quality: string; stats: Record<string, number> }>;
}

export interface OpenAlbionItem {
  id: number;
  name: string;
  tier: string;
  type: string;
  category_id: number | null;
  subcategory_id: number | null;
  identifier?: string | null;
  icon?: string | null;
}

export interface OpenAlbionCategory {
  id: number;
  name: string;
  type: string | null;
  subcategories: OpenAlbionCategory[];
}

/* ------------------------------ Comps ------------------------------- */

export interface BuildCategoryView {
  id: number;
  name: string;
  slug?: string;
  description?: string | null;
  created_at?: string;
}

export interface CreateBuildCategoryRequest {
  name: string;
  description?: string;
}

export interface UpdateBuildCategoryRequest {
  name?: string;
  description?: string;
}

export interface CompCategoryView {
  id: number;
  name: string;
  slug?: string;
  description?: string | null;
  created_at?: string;
}

export interface CreateCompCategoryRequest {
  name: string;
  description?: string;
}

export interface UpdateCompCategoryRequest {
  name?: string;
  description?: string;
}

export type BuildSlot =
  'weapon' | 'off_hand' | 'head' | 'armor' | 'shoes' | 'cape' | 'bag' | 'potion' | 'food' | 'mount';

export interface BuildItemSlot {
  slot: BuildSlot;
  openalbion_item_type: string;
  openalbion_item_id: number;
  openalbion_item_name: string;
  openalbion_item_icon?: string | null;
  openalbion_item_tier?: string | null;
}

export interface BuildSummary {
  id: number;
  name: string;
  role: BuildRole;
  category_id: number;
  category_name: string | null;
  created_by_username: string;
  updated_at: string;
  item_count: number;
}

export interface BuildDetail extends BuildSummary {
  items: BuildItemSlot[];
}

export interface CompBuildEntry {
  build_id: number;
  build: BuildSummary;
  quantity: number;
}

export interface CompSummary {
  id: number;
  name: string;
  category_id: number;
  category_name: string | null;
  created_by_username: string;
  created_at: string;
  build_count: number;
  total_quantity: number;
  parent_id: number | null;
}

export interface CompDetail extends CompSummary {
  builds: CompBuildEntry[];
}

export interface CompFilters {
  category_id?: number;
  q?: string;
  search?: string;
  date_from?: string;
  date_to?: string;
}

export type BuildRole = 'healer' | 'support' | 'dps' | 'tank' | 'battle_mount' | 'brawler';

export interface CreateBuildRequest {
  name: string;
  description?: string;
  role: BuildRole;
  category_id: number;
  items?: BuildItemSlot[];
}

export interface UpdateBuildRequest {
  name?: string;
  description?: string;
  role?: BuildRole;
  category_id?: number;
}

export interface CreateCompRequest {
  name: string;
  description?: string;
  category_id: number;
  parent_id?: number;
  builds: Array<{ build_id: number; quantity: number }>;
}

export interface UpdateCompRequest {
  name?: string;
  description?: string;
  category_id?: number;
  parent_id?: number;
}

/* ------------------------------ Utils ------------------------------- */

export interface OcrResult {
  text: string;
  lines: string[];
}

/* ---------------------------- Siphoned ----------------------------- */

export interface SiphonedEntryView {
  id: number;
  occurred_at: string;
  player_name: string;
  reason: string;
  amount: number;
  source: 'albion_export';
  ingest_batch: string | null;
  ingested_at: string;
}

export interface SiphonedPlayerBalance {
  player_name: string;
  total_deposited: number;
  total_withdrawn: number;
  net: number;
  entry_count: number;
  first_seen: string;
  last_seen: string;
}

export interface SiphonedEntryMutationRequest {
  occurred_at: string;
  player_name: string;
  reason: string;
  amount: number;
}

export type SiphonedIngestRow = SiphonedEntryMutationRequest;

export interface SiphonedIngestRequest {
  rows: SiphonedIngestRow[];
}

export interface SiphonedIngestResponse {
  batch_id: string;
  ingested_count: number;
  ingested_at: string;
}

export interface SiphonedBatchSummary {
  batch_id: string;
  ingested_at: string;
  row_count: number;
}

export interface DeletedCount {
  deleted_count: number;
}

/* ------------------------------ Admin ------------------------------- */

export interface AdminMessage {
  message: string;
}
