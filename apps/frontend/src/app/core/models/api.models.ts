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
  invalid_params?: unknown;
}

/** One row blocking a delete/update, e.g. an event still using a comp being deleted. */
export interface BlockingReference {
  /** The kind of thing blocking the action, e.g. `'event'`. */
  resource: string;
  id: number;
  /** Human-readable label for that row (its title/name), for display. */
  label: string;
}

/* ------------------------------ Auth -------------------------------- */

export type Role = string;

export type PermissionKey =
  | 'bank.withdraw.accept'
  | 'bank.view_others'
  | 'bank.transactions.create'
  | 'bank.transactions.edit'
  | 'bank.transactions.delete'
  | 'splits.manage'
  | 'splits.view'
  | 'splits.create'
  | 'splits.edit'
  | 'splits.delete'
  | 'splits.islands.manage'
  | 'users.create'
  | 'users.specializations.manage'
  | 'permissions.reload'
  | 'roles.manage'
  | 'autorole.manage'
  | 'comps.build_categories.manage'
  | 'comps.build_categories.view'
  | 'comps.build_categories.create'
  | 'comps.build_categories.edit'
  | 'comps.build_categories.delete'
  | 'comps.comp_categories.manage'
  | 'comps.comp_categories.view'
  | 'comps.comp_categories.create'
  | 'comps.comp_categories.edit'
  | 'comps.comp_categories.delete'
  | 'comps.builds.manage'
  | 'comps.builds.view'
  | 'comps.builds.create'
  | 'comps.builds.edit'
  | 'comps.builds.delete'
  | 'comps.comps.manage'
  | 'comps.comps.view'
  | 'comps.comps.create'
  | 'comps.comps.edit'
  | 'comps.comps.delete'
  | 'events.manage'
  | 'events.view'
  | 'events.create'
  | 'events.edit'
  | 'events.delete'
  | 'fights.manage'
  | 'fights.view'
  | 'fights.edit'
  | 'siphoned.ingest'
  | 'siphoned.view'
  | 'audit.view'
  | 'intel.view'
  | 'intel.manage'
  | 'intel.create'
  | 'intel.edit'
  | 'intel.delete'
  | 'intel.report.view'
  | 'regear.view'
  | 'regear.request'
  | 'regear.adjudicate'
  | 'regear.settings.manage'
  | 'admin.settings.manage'
  | 'progression.view'
  | 'progression.settings.manage'
  | 'progression.settings.create'
  | 'progression.settings.edit'
  | 'progression.adjust'
  | 'warns.view'
  | 'warns.issue'
  | 'vod.submit'
  | 'notifications.broadcast';

export interface DiscordUserProfile {
  id: string;
  username: string;
  avatar: string | null;
  email: string | null;
  user_id: number;
  roles: Role[];
  highest_role: Role;
  is_superadmin: boolean;
  permissions: string[];
}

/* ----------------------------- Users -------------------------------- */

export interface UserProfile {
  id: number;
  username: string;
  email: string;
  role: Role;
}

export type AlbionCombatCategory = 'weapon' | 'armor';

export interface UserSpecialization {
  node_key: string;
  node_name: string;
  category: AlbionCombatCategory;
  level: number;
  updated_at: string;
}

export interface UserSpecializationInput {
  node_key: string;
  node_name: string;
  category: AlbionCombatCategory;
  level: number;
}

export interface UpdateSpecializationsRequest {
  specializations: UserSpecializationInput[];
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

export type TransactionStatus = 'pending' | 'requested' | 'rejected' | 'withdrawn' | 'donated';

export interface TransactionView {
  id: number;
  from_user_id: number | null;
  from_label: string;
  to_user_id: number;
  to_username: string;
  to_label: string;
  to_guild_bank: boolean;
  amount: number;
  status: TransactionStatus;
  type: string;
  split_id: number | null;
  created_at: string;
  requested_at: string | null;
  withdrawn_at: string | null;
}

export interface CreateTransactionRequest {
  to_user_id: number;
  amount: number;
  status?: TransactionStatus;
  type?: string;
  split_id?: number;
  to_guild_bank?: boolean;
  from_user_id?: number;
}

export interface UpdateTransactionRequest {
  to_user_id?: number;
  /** `null` explicitly clears the payer back to the virtual Guild Bank. */
  from_user_id?: number | null;
  amount?: number;
  status?: TransactionStatus;
  type?: string;
  /** `null` explicitly unlinks the transaction from any split. */
  split_id?: number | null;
  to_guild_bank?: boolean;
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

/** One source, destination, or transaction-type line in the guild bank report. */
export interface BankBreakdown {
  label: string;
  transaction_count: number;
  total_amount: number | string;
}

/** Server-side, whole-ledger finance totals for officers and administrators. */
export interface BankAnalyticsSummary {
  transaction_count: number;
  ledger_volume: number | string;
  outstanding_total: number | string;
  outstanding_count: number;
  requested_total: number | string;
  requested_count: number;
  paid_out_total: number | string;
  paid_out_count: number;
  donated_total: number | string;
  donated_count: number;
  sources: BankBreakdown[];
  destinations: BankBreakdown[];
  transaction_types: BankBreakdown[];
}

export interface WithdrawRequest {
  transaction_ids?: number[];
  all?: boolean;
}

export type AcceptWithdrawalRequest = WithdrawRequest;

export type RejectWithdrawalRequest = WithdrawRequest;

/* ----------------------------- Splits ------------------------------- */

export type SplitStatus = 'pending' | 'awaiting_event' | 'completed' | 'not_completed' | 'lost';

export interface SplitKpiSummary {
  pending_count: number;
  completed_count: number;
  total_net_distributed: number;
  total_estimated_volume: number;
  total_participants: number;
  default_split_fee: number | string;
}

export interface SplitParticipant {
  user_id: number;
  username: string;
  weight: number | string;
  share_amount: number | string | null;
}

export interface SplitSummary {
  id: number;
  created_by_username: string;
  status: SplitStatus;
  estimated_market_value: number;
  fee: number | string;
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
  archived_at?: string | null;
}

export interface SplitDetail extends SplitSummary {
  participants: SplitParticipant[];
}

export interface SplitFilters {
  status?: SplitStatus;
  event_id?: number;
  island_id?: number;
  search?: string;
  date_from?: string;
  date_to?: string;
  archived?: boolean;
}

export interface CreateSplitRequest {
  note?: string;
  estimated_market_value: number;
  fee: number;
  repair_value: number;
  bags_value: number;
  event_id?: number;
  island_tab_id: number;
  participants: Array<{ user_id: number; weight: number }>;
}

export interface UpdateSplitRequest {
  note?: string;
  estimated_market_value?: number;
  fee?: number;
  repair_value?: number;
  bags_value?: number;
  event_id?: number | null;
  island_tab_id?: number;
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

export type SplitIslandCity =
  'lymhurst' | 'bridgewatch' | 'martlock' | 'fort_sterling' | 'thetford' | 'caerleon' | 'brecilien';

export interface SplitIslandTab {
  id: number;
  name: string;
  sort_order: number;
}

export interface SplitIsland {
  id: number;
  name: string;
  city: SplitIslandCity;
  tabs: SplitIslandTab[];
}

export interface CreateIslandRequest {
  name: string;
  city: SplitIslandCity;
  tabs: string[];
}

export interface UpdateIslandRequest {
  name?: string;
  city?: SplitIslandCity;
}

export interface CreateIslandTabRequest {
  name: string;
  sort_order?: number;
}

export interface UpdateIslandTabRequest {
  name?: string;
  sort_order?: number;
}

/* ----------------------------- Events ------------------------------- */

export type EventStatus = 'scheduled' | 'live' | 'stopped' | 'auto_stopped' | 'cancelled';

export interface EventView {
  id: number;
  title: string;
  description: string | null;
  call_to_arms: boolean;
  discord_role_ids: string[];
  regear: boolean;
  /** Optional threshold that advances the comp expansion without blocking signups. */
  player_cap?: number | null;
  comp_id: number;
  comp_name: string;
  created_by: number;
  created_by_username: string;
  event_date_utc: string;
  mass_time_utc?: string | null;
  start_time_utc?: string | null;
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
  archived_at?: string | null;
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

export interface EventRosterRole {
  /** `null` identifies the automatic, unlimited Fill role. */
  id: number | null;
  build_id: number | null;
  name: string;
  is_fill: boolean;
}

export interface EventFight {
  id: number;
  started_at: string;
  ended_at: string | null;
  grouping_method: 'seeded' | 'automatic' | 'manual' | string;
  grouping_confidence: number;
  needs_review: boolean;
  /** Raw AlbionBB Battle IDs, in their persisted Fight sequence. */
  battle_ids: string[];
  /** Optional canonical aggregates when included by the event-detail endpoint. */
  outcome?: FightOutcomeView;
  stats?: FightAggregateStats;
  segment_count?: number;
  total_players?: number;
  total_kills?: number;
  total_fame?: number;
}

/** Optional aggregate metrics exposed by the canonical fight detail endpoint. */
export interface FightAggregateStats {
  total_players?: number;
  players?: number;
  total_kills?: number;
  kills?: number;
  total_deaths?: number;
  deaths?: number;
  total_fame?: number;
  total_kill_fame?: number;
  kill_fame?: number;
  kill_death_ratio?: number;
  win_rate?: number;
}

export interface FightOutcomeView {
  outcome: 'victory' | 'defeat' | 'draw' | 'unknown';
  evidence_count: number;
  method: string;
}

/** Aggregate row returned by the canonical, guild-wide fight list. */
export interface FightListItem {
  id: number;
  event_id: number | null;
  event_title: string | null;
  started_at: string;
  ended_at: string | null;
  grouping_method: string;
  grouping_confidence: number;
  needs_review: boolean;
  segment_count: number;
  total_players: number;
  total_kills: number;
  total_fame: number;
  outcome: FightOutcomeView;
}

export interface FightSegmentSummary {
  battle_id: number;
  sequence_number: number;
  started_at: string;
  ended_at: string | null;
  total_players: number;
  total_kills: number;
  total_fame: number;
}

export interface ObservedFriendlyPlayer {
  albion_player_id: string;
  name: string;
  guild_id: string;
  guild_name: string;
  segments_observed: number;
  kills: number;
  deaths: number;
  kill_fame: number;
  death_fame: number;
  average_item_power: number;
  user_id: number | null;
}

export interface FightPlannedComp {
  id: number;
  name: string | null;
}

export interface PlannedFightParticipant {
  user_id: number;
  username: string;
  albion_player_id: string | null;
  primary_build_id: number | null;
  primary_build_name: string | null;
  secondary_build_id: number | null;
  secondary_build_name: string | null;
  observed: boolean;
}

export interface FightParticipantCoverage {
  event_linked: boolean;
  planned_participants: number;
  matchable_planned_participants: number;
  observed_planned_participants: number;
  unmatched_planned_participants: number;
  unplanned_observed_players: number;
  persisted_segments: number;
  total_segments: number;
}

/* ------------------------- Fight management ------------------------- */

/** Payload for consolidating compatible canonical fights. */
export interface MergeFightsRequest {
  target_fight_id: number;
  fight_ids: number[];
}

/** Payload for moving one battle segment between compatible fights. */
export interface MoveBattleRequest {
  battle_id: number;
  target_fight_id: number;
}

/** Payload for extracting a proper subset of segments into a new fight. */
export interface SplitFightRequest {
  battle_ids: number[];
}

/** Result of a manual fight grouping operation. */
export interface FightMutationResult {
  fight_id: number;
  deleted_fight_ids: number[];
  battle_ids: number[];
}

/**
 * Canonical fight detail. Rich analytics are optional so the page also supports
 * responses produced before the backend aggregation rollout.
 */
export interface FightDetail extends EventFight {
  event_id?: number | null;
  created_at?: string;
  updated_at?: string;
  stats?: FightAggregateStats;
  segment_count?: number;
  total_players?: number;
  total_kills?: number;
  total_deaths?: number;
  total_fame?: number;
  total_kill_fame?: number;
  unique_players?: number;
  kill_death_ratio?: number;
  win_rate?: number;
  guilds?: BattleGuildSummary[];
  players?: BattlePlayer[];
  estimated_losses?: BattleLossEstimate;
  segments?: FightSegmentSummary[];
  observed_friendly_players?: ObservedFriendlyPlayer[];
  planned_comp?: FightPlannedComp | null;
  planned_participants?: PlannedFightParticipant[];
  participant_coverage?: FightParticipantCoverage;
}

export interface EventDetailView extends EventView {
  active_comp_id: number;
  active_comp_name: string;
  active_comp_capacity: number;
  /** Fill is always present; all remaining entries are event-specific extra build roles. */
  roster_roles: EventRosterRole[];
  participants: EventParticipant[];
  /** Canonical real-world fights; raw segments remain available in `battles`. */
  fights: EventFight[];
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
  /** `null` identifies the virtual, unlimited Fill role. */
  primary_build_id: number | null;
  primary_build_name: string;
  secondary_build_id: number | null;
  secondary_build_name: string | null;
  specializations?: Record<string, number>;
}

/** Participant fields included by the live roster snapshot. */
export interface EventRosterParticipant {
  user_id: number;
  username: string;
  discord_id: string | null;
  primary_build_id: number | null;
  primary_build_name: string;
  secondary_build_id: number | null;
  secondary_build_name: string | null;
  specializations: Record<string, number>;
}

/** A concrete composition seat in the authoritative event roster. */
export interface EventRosterSeat {
  key: string;
  party_number: number;
  position: number;
  build_id: number;
  build_name: string;
  build_version: number;
  role: string;
  participant: EventRosterParticipant | null;
}

/** A registered participant not occupying a concrete roster seat. */
export interface EventRosterBenchParticipant extends EventRosterParticipant {}

/** Authoritative roster snapshot returned by the roster endpoints. */
export interface EventRosterView {
  event_id: number;
  roster_version: number;
  active_comp_id: number;
  seats: EventRosterSeat[];
  bench: EventRosterBenchParticipant[];
}

/** Assign a registered participant to a concrete roster seat. */
export interface AssignRosterSeatRequest {
  user_id: number;
  expected_roster_version: number;
}

/** Remove the participant from a concrete roster seat. */
export interface ClearRosterSeatRequest {
  expected_roster_version: number;
}

/** Exchange the participants assigned to two concrete roster seats. */
export interface SwapRosterSeatsRequest {
  source_seat_key: string;
  target_seat_key: string;
  expected_roster_version: number;
}

/** Fill currently empty concrete roster seats from registered participants. */
export interface AutoFillRosterRequest {
  expected_roster_version: number;
}

export interface RosterRealtimeReadyMessage {
  type: 'ready';
  event_id: number;
  roster_version: number;
}

export interface RosterRealtimeChangedMessage {
  type: 'roster_changed';
  event_id: number;
  roster_version: number;
  change_kind?: string;
  changed_seat_keys?: string[];
}

export interface RosterRealtimeResyncRequiredMessage {
  type: 'resync_required';
  event_id: number;
  roster_version: number;
}

/** Notifications sent by `GET /api/events/{id}/roster/live`. */
export type RosterRealtimeMessage =
  RosterRealtimeReadyMessage | RosterRealtimeChangedMessage | RosterRealtimeResyncRequiredMessage;

export interface EventFilters {
  search?: string;
  date_from?: string;
  date_to?: string;
  archived?: boolean;
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
  regear?: boolean;
  comp_id: number;
  /** Optional planning threshold; reaching it advances to the next comp expansion. */
  player_cap?: number;
  event_date_utc: string;
  mass_time_utc?: string;
  start_time_utc?: string;
  /** Discord role IDs to mention in the event announcement. */
  discord_role_ids?: string[];
  /** Also create an empty loot split already linked to this event. */
  create_split?: boolean;
  island_tab_id?: number;
}

export interface UpdateEventRequest {
  title?: string;
  description?: string;
  call_to_arms?: boolean;
  regear?: boolean;
  event_date_utc?: string;
  mass_time_utc?: string;
  start_time_utc?: string;
  comp_id?: number;
}

export interface UpdateEventBattlesRequest {
  battle_ids: string[];
}

export interface ParticipateEventRequest {
  /** `null` selects the virtual, unlimited Fill role. */
  primary_build_id: number | null;
  secondary_build_id?: number;
}

/* ----------------------------- Battles ------------------------------ */

export interface BattleGuildSummary {
  id: string;
  name: string;
  alliance_name?: string | null;
  alliance_id?: string | null;
  players: number;
  kills: number;
  deaths: number;
  kill_fame: number;
  winner: boolean;
  average_item_power?: number;
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
  alliance_name?: string | null;
  alliance_id?: string | null;
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
  alliance_name?: string | null;
  alliance_id?: string | null;
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
  regear: boolean;
}

/** Which loadout of a build an item belongs to: the main set, or the single swap. */
export type BuildLoadout = 'main' | 'swap';

/** One selectable ability on an equipped item. */
export interface OpenAlbionAbility {
  /** Albion's internal spell id; also the icon key. */
  id: string;
  name: string;
  cooldown?: string | null;
  energy?: string | null;
}

/**
 * Every ability an item family offers, keyed in the catalog by tier-stripped base identifier.
 *
 * `active` and `passive` map a 1-based slot index to the choices that slot accepts. Active slots
 * 1/2/3 are the player's Q/W/E on a weapon; armor pieces have one active slot, bound to D (head),
 * R (chest) or F (shoes). An item with zero slots of a kind carries an empty map.
 */
export interface OpenAlbionItemAbilities {
  label: string;
  slot_type: string | null;
  two_handed: boolean;
  active_slots: number;
  passive_slots: number;
  active: Record<string, OpenAlbionAbility[]>;
  passive: Record<string, OpenAlbionAbility[]>;
}

/** The abilities chosen on one equipped item, keyed by 1-based slot index. */
export interface BuildItemSpells {
  active: Record<string, string>;
  passive: Record<string, string>;
}

export interface BuildItemSlot {
  /** Defaults to `'main'` for items saved before swaps existed. */
  loadout: BuildLoadout;
  /** Chosen abilities. Absent on items saved before ability selection existed. */
  spells?: BuildItemSpells;
  slot: BuildSlot;
  openalbion_item_type: string;
  openalbion_item_id: number;
  openalbion_item_name: string;
  openalbion_item_icon?: string | null;
  openalbion_item_tier?: string | null;
  /** Albion quality 1..=5. Omitted on older rows; treat as Excellent (4). */
  openalbion_item_quality?: number | null;
  /**
   * Albion enchantment 0..=4. Omitted on rows saved before enchantment was recorded; treat as
   * plain (0). With the tier, this is what fixes the item's Item Power.
   */
  openalbion_item_enchantment?: number | null;
}

export interface BuildSummary {
  id: number;
  name: string;
  description: string | null;
  role: BuildRole;
  category_id: number;
  /** Version within the `(name, category)` group. Starts at 1. */
  version: number;
  category_name: string | null;
  created_by_username: string;
  updated_at: string;
  item_count: number;
  /** When this build was archived, if it has been. `null` means it's active. */
  archived_at: string | null;
}

/** One sibling version of a build or comp, for the version switcher. */
export interface VersionRef {
  id: number;
  version: number;
}

export interface BuildDetail extends BuildSummary {
  items: BuildItemSlot[];
  /** Every version sharing this build's `(name, category)` identity, in version order. */
  versions?: VersionRef[];
}

/** Battle numbers attributed to the players who actually ran one build version. */
export interface BuildBattleStats {
  events: number;
  battles: number;
  /** Signed-up players found by name in a battle snapshot — the real sample size. */
  matched_players: number;
  wins: number;
  losses: number;
  kills: number;
  deaths: number;
  kill_fame: number;
  death_fame: number;
}

/**
 * How one build version has performed.
 *
 * `stats` is `null` — not zeroed — when the version has no battle data, so "never used" stays
 * distinguishable from "lost every time".
 */
export interface BuildPerformanceView {
  build_id: number;
  build_name: string;
  version: number;
  signups_as_primary: number;
  signups_as_secondary: number;
  /** Signed-up members with no linked Albion account; excluded from `stats`. */
  players_without_an_albion_link: number;
  stats: BuildBattleStats | null;
}

/** Provenance of the bundled Albion combat dataset — echoed on every combat response. */
export interface DatasetVersion {
  source: string;
  dumps_commit: string;
  dumps_committed_at: string;
  generated_at: string;
  generator_version: number;
}

/** One Destiny Board node's contribution to a single item's Item Power. */
export interface SpecContribution {
  node: string;
  /** `'spec'` for a leaf specialization, `'mastery'` for the family node. */
  kind: string;
  level: number;
  item_power: number;
}

/** Item Power for one equipped item, itemised so every point traces to its source. */
export interface ItemIpBreakdown {
  slot: BuildSlot;
  base: string;
  tier: number;
  enchantment: number;
  quality: number;
  base_item_power: number;
  quality_bonus: number;
  spec_bonus: number;
  total: number;
  /** `null` for capes and bags, which have no combat specialization at all. */
  spec_node: string | null;
  contributions: SpecContribution[];
  /** True when the item's base identifier is unknown to the dataset — a data gap, not a zero. */
  unknown_item: boolean;
}

/** Item Power across a whole loadout, as the character sheet reports it. */
export interface CharacterIpBreakdown {
  /** One entry per equipped item, in character-sheet slot order. */
  items: ItemIpBreakdown[];
  /** The mean over the six counted slots — the figure the character sheet shows. */
  average: number;
  /** The sum the mean is taken from, with a two-handed weapon counted twice. */
  total: number;
  empty_slots: BuildSlot[];
  two_handed: boolean;
  /** False until a family mastery level is recorded, which makes every figure a lower bound. */
  mastery_levels_known: boolean;
}

/** An Item Power figure, with the ceiling it is measured against. */
export interface ItemPowerView {
  breakdown: CharacterIpBreakdown;
  /** The same loadout with every Destiny Board node at 100. */
  at_max_spec: number;
  /** `breakdown.average / at_max_spec`, `0..1`. Comparable across builds unlike raw Item Power. */
  readiness: number;
  dataset_version: DatasetVersion;
}

/** A Destiny Board node holding a member back on a build. */
export interface BlockingNode {
  node: string;
  level: number;
  max_level: number;
  item_power_gap: number;
}

/** One member's Item Power on a given build. */
export interface MemberItemPowerView {
  user_id: number;
  username: string;
  item_power: number;
  at_max_spec: number;
  readiness: number;
  blocking_nodes: BlockingNode[];
  mastery_levels_known: boolean;
}

/** Every member with a recorded specialization, scored against one build, best first. */
export interface BuildRosterFitView {
  build_id: number;
  build_name: string;
  at_max_spec: number;
  members: MemberItemPowerView[];
  dataset_version: DatasetVersion;
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
  /** Version within the `(name, category)` group. Starts at 1. */
  version: number;
  category_name: string | null;
  created_by_username: string;
  created_at: string;
  build_count: number;
  total_quantity: number;
  parent_id: number | null;
  /** When this comp was archived, if it has been. `null` means it's active. */
  archived_at: string | null;
}

export interface CompDetail extends CompSummary {
  builds: CompBuildEntry[];
  /** Every version sharing this comp's `(name, category)` identity, in version order. */
  versions?: VersionRef[];
}

export interface CompFilters {
  category_id?: number;
  q?: string;
  search?: string;
  date_from?: string;
  date_to?: string;
  /** When `true`, lists archived comps instead of active ones. */
  archived?: boolean;
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
  /** `null` explicitly removes the parent. */
  parent_id?: number | null;
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
  regear_paid: number;
}

export interface HourBucket {
  hour: number;
  fights: number;
  wins: number;
  losses: number;
}

/** Rolling 30-day canonical fight performance and its evidence coverage. */
export interface FightTrendView {
  generated_at: string;
  last_30_days: FightTrendPeriod;
  previous_30_days: FightTrendPeriod;
  rolling_daily_fight_counts: FightTrendDay[];
}

export interface FightTrendPeriod {
  window_started_at: string;
  window_ended_at: string;
  fight_sample_size: number;
  combat_sample_size: number;
  win_sample_size: number;
  wins: number;
  losses: number;
  win_rate: number | null;
  kills: number;
  deaths: number;
  kd_ratio: number | null;
  kill_fame: number;
  coverage: FightTrendCoverage;
  planned_participation: FightTrendPlannedParticipation;
}

export interface FightTrendCoverage {
  fights_with_snapshots: number;
  persisted_segments: number;
  total_segments: number;
  fights_with_winner_data: number;
  linked_event_fights: number;
  linked_events: number;
}

export interface FightTrendPlannedParticipation {
  linked_fights: number;
  linked_events: number;
  planned_participant_assignments: number;
  primary_build_assignments: FightTrendSelectionCount[];
  secondary_build_assignments: FightTrendSelectionCount[];
  comp_assignments: FightTrendSelectionCount[];
}

export interface FightTrendSelectionCount {
  id: number;
  name: string | null;
  count: number;
}

export interface FightTrendDay {
  date: string;
  fights: number;
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

/** One member's activity in a single week — the per-player counterpart to {@link TrendBucket}. */
export interface PlayerTrendBucket {
  week_start: string;
  fights: number;
  wins: number;
  losses: number;
  win_rate: number;
  kills: number;
  deaths: number;
  kill_fame: number;
  silver_lost: number;
}

/** One member's combat record for a window: their roster row, a weekly breakdown, and recent fights. */
export interface PlayerReport {
  user_id: number;
  username: string;
  albion_name: string | null;
  role: string;
  is_officer: boolean;
  linked: boolean;
  from: string;
  to: string;
  member: ReportMemberRow;
  /** One entry per week in the window, oldest first, including quiet weeks. */
  weekly: PlayerTrendBucket[];
  /** This member's fights, newest first. */
  recent_fights: FightSummary[];
  win_streak: number;
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
  discord_role_id: string | null;
  is_default: boolean;
  permissions: string[];
}

export interface CreateRoleRequest {
  name: string;
  priority?: number;
  discord_role_id?: string | null;
  is_default?: boolean;
}

export interface UpdateRoleRequest {
  name?: string;
  priority?: number;
  discord_role_id?: string | null;
  is_default?: boolean;
}

/** The authorization matrix, plus every key that could be granted. */
export interface PermissionCatalogEntry {
  key: string;
  resource: string;
  action: string;
}

export interface PermissionMatrix {
  roles: RolePermissionsView[];
  available_permissions: string[];
  permission_catalog: PermissionCatalogEntry[];
}

export interface DiscordRoleView {
  id: string;
  name: string;
  position: number;
  managed: boolean;
}

export type DiscordChannelKind = 'text' | 'voice' | 'category' | 'forum' | 'other';

export interface DiscordForumTagView {
  id: string;
  name: string;
}

export interface DiscordChannelView {
  id: string;
  name: string;
  kind: DiscordChannelKind | string;
  type_id: number;
  parent_id: string | null;
  position: number;
  available_tags: DiscordForumTagView[];
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
  discord_auto_role_id: string | null;
  default_role_discord_id?: string | null;
  discord_splits_forum_channel_id: string | null;
  discord_split_pending_tag_id: string | null;
  discord_split_completed_tag_id: string | null;
  discord_split_not_completed_tag_id: string | null;
  discord_split_lost_tag_id: string | null;
  discord_event_voice_category_id: string | null;
  discord_applications_channel_id: string | null;
  discord_applications_category_id: string | null;
  discord_applications_archive_category_id: string | null;
  discord_applications_manage_role_id: string | null;
  discord_applications_status_channel_id: string | null;
  discord_applications_open: boolean;
  discord_applications_panel_title: string;
  discord_applications_panel_message: string;
  discord_applications_welcome_title: string;
  discord_applications_welcome_message: string;
  discord_applications_status_open_message: string;
  discord_applications_status_closed_message: string;
  /** Optional Discord application lifecycle copy; older backends may omit these fields. */
  discord_applications_manage_title?: string;
  discord_applications_manage_message?: string;
  discord_applications_accept_title?: string;
  discord_applications_accept_message?: string;
  discord_applications_decline_title?: string;
  discord_applications_decline_message?: string;
  discord_applications_close_title?: string;
  discord_applications_close_message?: string;
  discord_applications_no_permission_title?: string;
  discord_applications_no_permission_message?: string;
  discord_applications_already_open_title?: string;
  discord_applications_already_open_message?: string;
  discord_applications_closed_title?: string;
  discord_applications_closed_message?: string;
  discord_applications_error_message?: string;
  discord_applications_final_title?: string;
  discord_applications_result_message?: string;
  discord_applications_panel_message_id: string | null;
  discord_giveaways_channel_id?: string | null;
  discord_giveaways_role_id?: string | null;
  default_split_fee: number | string;
}

export type GiveawayStatus = 'open' | 'drawn' | 'cancelled' | 'expired_empty';

export interface GiveawayPrizeView {
  id: number;
  openalbion_item_id: number;
  openalbion_item_name: string;
  openalbion_item_icon?: string | null;
  openalbion_item_identifier?: string | null;
  openalbion_item_tier?: string | null;
  openalbion_item_quality: number;
  quantity: number;
}

export interface GiveawayEntryView {
  id: number;
  user_id: number;
  username: string;
  discord_id?: string | null;
  entered_at: string;
}

export interface GiveawayView {
  id: number;
  title: string;
  description?: string | null;
  ends_at: string;
  status: GiveawayStatus;
  created_by: number;
  created_by_username: string;
  created_at: string;
  silver_amount?: string | number | null;
  winner_user_id?: number | null;
  winner_username?: string | null;
  winner_discord_id?: string | null;
  drawn_at?: string | null;
  silver_transaction_id?: number | null;
  discord_message_id?: string | null;
  discord_channel_id?: string | null;
  entry_count: number;
  prizes: GiveawayPrizeView[];
}

export interface GiveawayDetailView extends GiveawayView {
  entries: GiveawayEntryView[];
}

export interface CreateGiveawayPrizeRequest {
  openalbion_item_id: number;
  openalbion_item_name: string;
  openalbion_item_icon?: string | null;
  openalbion_item_identifier?: string | null;
  openalbion_item_tier?: string | null;
  openalbion_item_quality?: number;
  quantity?: number;
}

export interface CreateGiveawayRequest {
  title: string;
  description?: string | null;
  ends_at: string;
  silver_amount?: string | null;
  prizes: CreateGiveawayPrizeRequest[];
}

/**
 * Request body for `PUT /admin/settings`. Partial update: a field absent here is left unchanged;
 * an empty string clears it.
 */
export type UpdateGuildSettingsRequest = Partial<GuildSettingsView>;

/** Current AutoRole configuration. */
export interface AutoRoleSettingsView {
  discord_auto_role_id: string | null;
  default_role_discord_id?: string | null;
}

/** Replacement request for AutoRole; an empty string disables it. */
export interface UpdateAutoRoleRequest {
  discord_auto_role_id: string;
}

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
  'message' | 'event_create' | 'event_join' | 'event_complete' | 'vod' | 'admin_adjust';

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

/* -------------------------- Notifications --------------------------- */

/** Kind of in-app notification. */
export type NotificationKind =
  | 'broadcast'
  | 'regear_accepted'
  | 'regear_rejected'
  | 'bank_withdraw_accepted'
  | 'bank_withdraw_rejected'
  | 'warn_issued'
  | 'split_credited'
  | 'event_created'
  | 'event_reminder_1h'
  | 'giveaway_won';

/** One inbox row as seen by the recipient. */
export interface NotificationView {
  id: number;
  kind: NotificationKind;
  title: string;
  body: string;
  link_path: string | null;
  source_type: string;
  source_id: number;
  read_at: string | null;
  created_at: string;
}

/** Unread badge payload. */
export interface UnreadCountView {
  count: number;
}

/** Result of mark-all-read. */
export interface ReadAllResult {
  updated: number;
}

/** Result of a guild-wide broadcast. */
export interface BroadcastResult {
  id: number;
  recipient_count: number;
}

/** Body for `POST /notifications/broadcast`. */
export interface BroadcastRequest {
  title: string;
  body: string;
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
