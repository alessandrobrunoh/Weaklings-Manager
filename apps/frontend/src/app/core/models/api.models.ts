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
  | 'siphoned.view'
  | 'regear.view'
  | 'regear.request'
  | 'regear.adjudicate'
  | 'regear.settings.manage'
  | 'admin.settings.manage'
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

export interface UserMetrics {
  most_played_build: string | null;
  events_attended: number;
  total_estimated_loss: number;
  top_estimated_loss: number;
  /** Events the guild ran, so attendance reads as a rate, not a bare count. */
  events_total: number;
  attendance_rate: number;
  attendance_streak: number;
  next_event_title: string | null;
  next_event_at: string | null;
  battles_fought: number;
  kills: number;
  deaths: number;
  kill_fame: number;
  regears_claimed: number;
  regears_pending: number;
  regears_approved: number;
  regear_silver: number;
  splits_joined: number;
  split_earnings: number;
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
  discord_id: string | null;
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
  /** Also create an empty loot split already linked to this event. */
  create_split?: boolean;
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
  /**
   * The guild event this battle was fought under.
   *
   * Null means the background sync found it and it was never linked, so it
   * cannot be attributed to one of our compositions.
   */
  linked_event: LinkedEvent | null;
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

/** The guild event a battle was fought under. */
export interface LinkedEvent {
  id: number;
  title: string;
  call_to_arms: boolean;
}

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
  description: string | null;
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
  description: string | null;
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

/* ----------------------------- Regear ------------------------------ */

export type RegearStatus = 'available' | 'pending' | 'approved' | 'rejected';

export type RegearBuildSlot =
  'weapon' | 'off_hand' | 'head' | 'armor' | 'shoes' | 'cape' | 'bag' | 'potion' | 'food' | 'mount';

export interface RegearBreakdownRow {
  slot: RegearBuildSlot;
  item_id: string;
  quality: number;
  unit_price: number | string;
  quantity: number;
  included: boolean;
}

export interface RegearDeathView {
  id: number;
  event_id: number;
  event_title: string;
  event_battle_id: number;
  albionbb_battle_id: string;
  albion_kill_event_id: string;
  killed_at: string;
  user_id: number | null;
  player_name: string;
  primary_build_id: number | null;
  primary_build_name: string | null;
  loadout_json: Record<string, unknown>;
  auto_estimate_total: number | string;
  auto_estimate_breakdown: RegearBreakdownRow[];
  status: RegearStatus;
  requested_at: string | null;
  decided_at: string | null;
  decided_by_user_id: number | null;
  final_amount: number | string | null;
  final_breakdown: RegearBreakdownRow[] | null;
  officer_note: string | null;
  bank_transaction_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface RegearDeathFilters {
  event_id?: number;
  status?: RegearStatus;
  user_id?: number;
  global?: boolean;
  bank_transaction_id?: number;
}

export interface RegearSettingsView {
  max_regears_per_event: number;
  max_regears_per_month: number;
  enabled_slots_mask: number;
  pricing_location: string;
  pricing_fallback_strategy: 'cheapest_any' | 'strict';
}

export interface UpdateRegearSettingsRequest {
  max_regears_per_event?: number;
  max_regears_per_month?: number;
  enabled_slots_mask?: number;
  pricing_location?: string;
  pricing_fallback_strategy?: 'cheapest_any' | 'strict';
}

export interface AcceptRegearRequest {
  final_amount: number | string;
  breakdown: RegearBreakdownRow[];
  note?: string;
}

export interface RejectRegearRequest {
  note: string;
}

export interface RegearBudgetSummary {
  per_event_used: number;
  per_event_max: number;
  per_month_used: number;
  per_month_max: number;
}

export interface RegearExtractionReport {
  event_id: number;
  battles_scanned: number;
  deaths_inserted: number;
  deaths_skipped: number;
}

/* ------------------------------ Admin ------------------------------- */

export interface AdminMessage {
  message: string;
}

/* ------------------------------- Intel ------------------------------ */

/** Engagement bracket a scouted composition falls into. */
export type IntelScoutCategory = 'gank' | 'small_scale' | 'zvz';

/** One enemy player observed in a scouted composition. */
export interface ScoutedPlayer {
  name: string;
  role: string;
  /**
   * Main-hand weapon. Absent when the player never appeared in the kill feed,
   * which is the normal case for most of a large enemy force.
   */
  weapon: string | null;
  /** True when the role came from the keyword fallback, not a curated build. */
  role_inferred: boolean;
  item_power: number;
}

/** Summary of a scouted enemy composition. */
export interface ScoutedCompSummary {
  id: number;
  name: string;
  opponent_guild_id: string | null;
  opponent_guild_name: string;
  opponent_alliance_name: string | null;
  category: IntelScoutCategory;
  player_count: number;
  /**
   * How many observed players contributed a weapon. Lower than `player_count`
   * whenever the kill feed covered only part of the fight, which weakens the
   * weapon half of every similarity score involving this scout.
   */
  weapon_sample_size: number;
  full_weapon_coverage: boolean;
  avg_ip: number;
  roles: Record<string, number>;
  weapons: Record<string, number>;
  source_battle_count: number;
  threat_score: number;
  is_archived: boolean;
  notes: string | null;
  first_seen_at: string;
  saved_at: string;
}

/** One cell of the matchup matrix. */
export interface MatchupRow {
  our_comp_id: number;
  our_comp_name: string;
  scouted_comp_id: number;
  battles: number;
  wins: number;
  losses: number;
  win_rate: number;
}

/** How much of the underlying battle data could be attributed to a comp. */
export interface MatchupCoverage {
  total_battles: number;
  battles_with_comp: number;
}

/** The matchup matrix plus the caveat that explains its gaps. */
export interface MatchupReport {
  rows: MatchupRow[];
  coverage: MatchupCoverage;
}

/** Our comp ranked as an answer to a scouted composition. */
export interface CounterSuggestion {
  comp_id: number;
  comp_name: string;
  similarity: number;
  battles: number;
  wins: number;
  losses: number;
  win_rate: number;
  /** True when we have actually fought this pairing, rather than inferred it. */
  tested: boolean;
}

/** One scored comparison against another composition. */
export interface SimilarityHit {
  id: number;
  name: string;
  score: number;
  full_weapon_coverage: boolean;
}

/** Full dossier for one scouted composition. */
export interface ScoutedCompDetail extends ScoutedCompSummary {
  players: ScoutedPlayer[];
  source_battle_ids: number[];
  fingerprint: string;
  matchups: MatchupRow[];
  matchup_coverage: MatchupCoverage;
  recommended_counter: CounterSuggestion | null;
}

/** The result of scouting a battle. */
export interface ScoutOutcome {
  scouted_comp_id: number | null;
  name: string;
  opponent_guild_name: string;
  category: IntelScoutCategory;
  player_count: number;
  weapon_sample_size: number;
  merged: boolean;
  already_linked: boolean;
}

/** Body of a scout update. */
export interface UpdateScoutRequest {
  name?: string;
  notes?: string;
  category?: IntelScoutCategory;
  is_archived?: boolean;
}

/* --------------------------- Intel report --------------------------- */

/** One battle, scored so the best and worst can be surfaced. */
export interface FightSummary {
  battle_id: number;
  started_at: string;
  is_win: boolean;
  kills: number;
  deaths: number;
  kill_fame: number;
  opponent: string | null;
  score: number;
}

/** Headline combat performance. */
export interface ReportOverview {
  fights: number;
  wins: number;
  losses: number;
  win_rate: number;
  kills: number;
  deaths: number;
  kill_death_ratio: number;
  kill_fame: number;
  silver_lost: number;
  avg_item_power: number;
  enemy_avg_item_power: number;
  item_power_delta: number;
  win_streak: number;
  best_fight: FightSummary | null;
  worst_fight: FightSummary | null;
  attributed_fights: number;
}

/** Roster, attendance and role coverage. */
export interface ReportOperations {
  roster: number;
  officers: number;
  unlinked: number;
  events_total: number;
  events_live: number;
  events_scheduled: number;
  events_finished: number;
  call_to_arms: number;
  cta_rate: number;
  attendance: number;
  slots: number;
  fill_rate: number;
  role_need: Record<string, number>;
  role_fill: Record<string, number>;
  inactive_members: string[];
}

/**
 * Silver flow.
 *
 * `outflow_splits`, `outflow_regear` and `outflow_other` are slices of
 * `outflow_total`, not additions to it — they sum to it exactly.
 */
export interface ReportEconomy {
  loot_in: number;
  outflow_total: number;
  outflow_splits: number;
  outflow_regear: number;
  outflow_other: number;
  net: number;
  bank_pending: number;
  bank_requested: number;
  bank_withdrawn: number;
  regear_open: number;
  regear_paid: number;
  split_pending: number;
  split_completed: number;
  siphoned_net: number;
  fame_per_player: number;
  fame_per_million_lost: number;
}

/** One member's contribution over the window. */
export interface ReportMemberRow {
  user_id: number;
  username: string;
  albion_name: string | null;
  role: string;
  is_officer: boolean;
  linked: boolean;
  events_signed: number;
  fill_rate: number;
  fights: number;
  kills: number;
  deaths: number;
  kill_death_ratio: number;
  kill_fame: number;
  death_fame: number;
  silver_lost: number;
  regears_claimed: number;
  regear_silver: number;
  split_earnings: number;
  bank_pending: number;
  siphoned: number;
}

/** One of our comps and how it has performed. */
export interface ReportCompRow {
  comp_id: number;
  name: string;
  seats: number;
  events: number;
  fights: number;
  wins: number;
  losses: number;
  win_rate: number;
  kills: number;
  deaths: number;
  fill_rate: number;
}

/** One scouted opponent and our record against them. */
export interface ReportEnemyRow {
  scouted_comp_id: number;
  name: string;
  opponent_guild_name: string;
  category: IntelScoutCategory;
  player_count: number;
  wins: number;
  losses: number;
  threat_score: number;
  last_seen: string;
  counter_comp_name: string | null;
}

export interface WeaponShare {
  weapon: string;
  count: number;
}

/**
 * One calendar week's activity, Monday-anchored in UTC.
 *
 * Every metric on the report is a total over the window; a trend needs
 * direction, which only a series of these gives you.
 */
export interface TrendBucket {
  week_start: string;
  fights: number;
  wins: number;
  losses: number;
  kills: number;
  deaths: number;
  kill_fame: number;
  silver_lost: number;
  events: number;
  attendance: number;
  loot_in: number;
  outflow: number;
}

export interface HourBucket {
  hour: number;
  fights: number;
  wins: number;
  losses: number;
}

export interface TimelineEntry {
  at: string;
  kind: 'battle' | 'event' | 'scout';
  title: string;
  detail: string;
}

export interface LeaderboardEntry {
  user_id: number;
  username: string;
  value: number;
}

export interface ReportLeaderboards {
  attendance: LeaderboardEntry[];
  kills: LeaderboardEntry[];
  deaths: LeaderboardEntry[];
  kill_fame: LeaderboardEntry[];
  death_fame: LeaderboardEntry[];
  silver_lost: LeaderboardEntry[];
  split_earnings: LeaderboardEntry[];
  regear_silver: LeaderboardEntry[];
  siphoned: LeaderboardEntry[];
}

/** Caveats that explain gaps in the report's numbers. */
export interface ReportDataQuality {
  total_battles: number;
  attributed_battles: number;
  /** Albion characters seen in battle that map to no linked member. */
  unlinked_players: string[];
}

/** The whole guild report. */
export interface GuildReport {
  from: string;
  to: string;
  overview: ReportOverview;
  operations: ReportOperations;
  economy: ReportEconomy;
  members: ReportMemberRow[];
  comps: ReportCompRow[];
  enemies: ReportEnemyRow[];
  our_meta: WeaponShare[];
  enemy_meta: WeaponShare[];
  hours: HourBucket[];
  /** One entry per calendar week, oldest first, including quiet weeks. */
  trends: TrendBucket[];
  timeline: TimelineEntry[];
  leaderboards: ReportLeaderboards;
  data_quality: ReportDataQuality;
}

/** One split that could not be completed in a batch, and why. */
export interface BatchFailure {
  split_id: number;
  reason: string;
}

/** Outcome of completing several splits at once. */
export interface CompleteSplitsBatchResult {
  completed: number[];
  failed: BatchFailure[];
  total_distributed: string;
}

/* ------------------------------- Admin ------------------------------ */

/** One role and the permissions granted to it. */
export interface RolePermissionsView {
  role_id: string;
  role_name: string;
  priority: number;
  permissions: string[];
}

/** The authorization matrix, plus every key that could be granted. */
export interface PermissionMatrix {
  roles: RolePermissionsView[];
  available_permissions: string[];
}

/**
 * The guild's Discord integration settings — channel/role IDs that used to live only in
 * deployment env vars. Every field is nullable: an unset channel means the code that would post
 * there skips it.
 */
export interface GuildSettingsView {
  discord_events_channel_id: string | null;
  discord_battles_channel_id: string | null;
  discord_battles_cta_channel_id: string | null;
  discord_audit_log_channel_id: string | null;
  discord_transaction_spam_channel_id: string | null;
  discord_event_role_id: string | null;
}

/**
 * Request body for `PUT /admin/settings`. Partial update: a field absent here is left unchanged;
 * an empty string clears it.
 */
export type UpdateGuildSettingsRequest = Partial<GuildSettingsView>;

/** One row of the admin curve preview. */
export interface LevelThresholdView {
  level: number;
  xp: number;
}

/** Guild-wide XP curve, rates, and warn threshold. */
export interface ProgressionSettingsView {
  xp_base: number;
  xp_exponent: string | number;
  max_level: number;
  xp_message: number;
  xp_event_create: number;
  xp_event_join: number;
  xp_event_complete: number;
  xp_vod: number;
  message_cooldown_secs: number;
  message_min_chars: number;
  warn_threshold: number;
  vod_forum_channel_id: string | null;
  message_channel_deny_list: string[];
  level_preview: LevelThresholdView[];
}

/** Partial update of progression settings. */
export type UpdateProgressionSettingsRequest = Partial<{
  xp_base: number;
  xp_exponent: number;
  max_level: number;
  xp_message: number;
  xp_event_create: number;
  xp_event_join: number;
  xp_event_complete: number;
  xp_vod: number;
  message_cooldown_secs: number;
  message_min_chars: number;
  warn_threshold: number;
  vod_forum_channel_id: string;
  message_channel_deny_list: string[];
}>;

/** One Albion-aligned, admin-modellable XP season. */
export interface ProgressionSeasonView {
  id: number;
  name: string;
  starts_at: string;
  ends_at: string;
  is_active: boolean;
}

/** The caller's (or a target user's) season XP snapshot. */
export interface ProgressionMeView {
  season: ProgressionSeasonView | null;
  level: number;
  xp: number;
  xp_to_next: number;
  next_level_at: number;
  rank: number | null;
  multiplier: string | number;
  lifetime_xp: number;
}

/** One ranked row on the season XP leaderboard. */
export interface ProgressionLeaderboardEntry {
  user_id: number;
  username: string;
  xp: number;
  level: number;
  rank: number;
}

/** Why a progression ledger row was written. */
export type XpSource =
  | 'message'
  | 'event_create'
  | 'event_join'
  | 'event_complete'
  | 'vod'
  | 'admin_adjust';

/** One append-only XP award (or admin adjust) row. */
export interface ProgressionLedgerRow {
  id: number;
  user_id: number;
  season_id: number;
  source: XpSource | string;
  base_amount: number;
  applied_amount: number;
  multiplier_at_time: string | number;
  idempotency_key: string;
  actor_user_id: number | null;
  created_at: string;
}

/** Officer body for `POST /progression/users/{id}/adjust`. Omit unused fields. */
export interface AdjustProgressionRequest {
  set_xp?: number;
  add_xp?: number;
  set_level?: number;
  set_multiplier?: number;
  multiplier_expires_at?: string;
  reason: string;
}

/** Warn severity stored on `user_warns`. */
export type WarnSeverity = 'note' | 'warn' | 'strike';

/** One row of the guild warn register. */
export interface WarnView {
  id: number;
  user_id: number;
  username?: string | null;
  issued_by_user_id: number;
  issued_by_username?: string | null;
  reason: string;
  severity: WarnSeverity;
  multiplier?: string | number | null;
  multiplier_expires_at?: string | null;
  revoked_at: string | null;
  revoked_by?: number | null;
  created_at: string;
}

/** Body for `POST /warns`. */
export interface CreateWarnRequest {
  user_id: number;
  reason: string;
  severity: WarnSeverity;
  multiplier?: number;
  multiplier_expires_at?: string;
}

/** One admin-facing kick/handle reminder when the warn threshold is hit. */
export interface WarnEscalationView {
  id: number;
  user_id: number;
  username?: string | null;
  threshold_at_time: number;
  warn_count_at_time: number;
  opened_at: string;
  acknowledged_at: string | null;
  acknowledged_by?: number | null;
  closed_reason?: string | null;
}
