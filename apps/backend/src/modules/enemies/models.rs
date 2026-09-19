//! Request/response DTOs for the enemy identity dossiers.
//!
//! `enemy_guilds`/`enemy_players` carry no rollup columns (see
//! `entities.rs`'s module doc), so every rollup field here (`battles_fought`,
//! `our_kills`, `their_kills`, weapon histograms, "latest observed" fields)
//! is computed by `service.rs` at read time from `enemy_player_battles`.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Battle-derived tallies shared by both the guild and player list/detail views.
#[derive(Debug, Clone, Default, Serialize, ToSchema)]
pub struct EnemyRollup {
    /// Distinct `enemy_player_battles.battle_id` values — raw `AlbionBB`
    /// battle segments. A single real engagement that `AlbionBB` happened to
    /// split into several technical battle records counts more than once
    /// here whenever more than one of those segments produced a row for this
    /// enemy. Kept alongside `distinct_fights` because it is still a real,
    /// useful number ("we exchanged fire across N technical battle records").
    pub battles_fought: i64,
    /// Distinct canonical Fights (`fight_battles.battle_id -> fight_id`)
    /// underlying `battles_fought`'s battle ids, PLUS one for every
    /// `battle_id` that has no matching `fight_battles` row at all. This is
    /// the deduplicated, more meaningful "how many times did we actually
    /// fight them" number — prefer it over `battles_fought` wherever a
    /// single count is needed. A `battle_id` nobody has grouped into a Fight
    /// yet is still one real engagement, so it always contributes exactly
    /// one to this total rather than being silently dropped.
    pub distinct_fights: i64,
    /// Sum of `our_kills_on_them` across those battles.
    pub our_kills: i64,
    /// Sum of `their_kills_on_us` across those battles.
    pub their_kills: i64,
}

/// One row of `GET /api/enemies/guilds`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct EnemyGuildSummary {
    /// Surrogate primary key.
    pub id: i64,
    /// Opaque identity key (`"id:<albion guild id>"` or `"name:<lowercased name>"`).
    pub guild_key: String,
    /// Latest known display name.
    pub name: String,
    /// Alliance display name the guild currently belongs to, when known.
    pub current_alliance_name: Option<String>,
    /// RFC 3339. When this guild was first observed.
    pub first_seen_at: String,
    /// RFC 3339. When this guild was most recently observed.
    pub last_seen_at: String,
    /// Officer-set flag marking this guild for closer attention.
    pub is_watchlisted: bool,
    /// Battle-derived tallies for this guild, computed from `enemy_player_battles`.
    #[serde(flatten)]
    pub rollup: EnemyRollup,
}

/// One historical value ever observed for an [`EnemyAliasGroup`].
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct EnemyAliasValue {
    /// The observed value itself (a name or an alliance name).
    pub value: String,
    /// RFC 3339. When this value was first observed.
    pub first_seen_at: String,
    /// RFC 3339. When this value was most recently observed.
    pub last_seen_at: String,
}

/// Every distinct value ever observed for one alias `kind` (`"name"` or `"alliance"`).
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct EnemyAliasGroup {
    /// `"name"` or `"alliance"` — see `enemy_guild_aliases.kind`.
    pub kind: String,
    /// Every distinct value observed for this kind, oldest first.
    pub values: Vec<EnemyAliasValue>,
}

/// One roster entry in an [`EnemyGuildDossier`]: an enemy player currently
/// believed to belong to this guild, plus their most recently observed build.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct EnemyGuildRosterPlayer {
    /// Surrogate primary key.
    pub id: i64,
    /// Opaque identity key.
    pub player_key: String,
    /// Latest known display name.
    pub name: String,
    /// Combat role from this player's most recent `enemy_player_battles` row,
    /// when they have at least one battle on record.
    pub role: Option<String>,
    /// Main-hand item type id from this player's most recent battle row.
    pub main_hand_item_id: Option<String>,
    /// Item power from this player's most recent battle row.
    pub item_power: Option<f64>,
    /// RFC 3339. When this player was first observed.
    pub first_seen_at: String,
    /// RFC 3339. When this player was most recently observed.
    pub last_seen_at: String,
}

/// One bucket of a weapon histogram: how many battle-participations used a given weapon.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct WeaponHistogramEntry {
    /// Raw upstream item type id of the main-hand weapon.
    pub main_hand_item_id: String,
    /// Number of `enemy_player_battles` rows observed with this weapon.
    pub count: i64,
}

/// Full dossier for `GET /api/enemies/guilds/{id}`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct EnemyGuildDossier {
    /// Surrogate primary key.
    pub id: i64,
    /// Opaque identity key.
    pub guild_key: String,
    /// Raw Albion guild id, when present.
    pub albion_guild_id: Option<String>,
    /// Latest known display name.
    pub name: String,
    /// Alliance id the guild currently belongs to, when known.
    pub current_alliance_id: Option<String>,
    /// Alliance display name the guild currently belongs to, when known.
    pub current_alliance_name: Option<String>,
    /// RFC 3339. When this guild was first observed.
    pub first_seen_at: String,
    /// RFC 3339. When this guild was most recently observed.
    pub last_seen_at: String,
    /// Officer-set flag marking this guild for closer attention.
    pub is_watchlisted: bool,
    /// Free-form officer notes.
    pub notes: Option<String>,
    /// Name/alliance history, grouped by kind.
    pub aliases: Vec<EnemyAliasGroup>,
    /// Battle-derived tallies for this guild, computed from `enemy_player_battles`
    /// filtered on `enemy_guild_id`.
    #[serde(flatten)]
    pub rollup: EnemyRollup,
    /// Enemy players currently believed to belong to this guild.
    pub roster: Vec<EnemyGuildRosterPlayer>,
    /// Main-hand weapon usage across every battle row of every roster player, most-used first.
    pub weapon_histogram: Vec<WeaponHistogramEntry>,
}

/// One row of `GET /api/enemies/players`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct EnemyPlayerSummary {
    /// Surrogate primary key.
    pub id: i64,
    /// Opaque identity key.
    pub player_key: String,
    /// Latest known display name.
    pub name: String,
    /// The enemy guild this player is currently believed to belong to, when known.
    pub current_enemy_guild_id: Option<i64>,
    /// That guild's latest known display name, when known.
    pub current_enemy_guild_name: Option<String>,
    /// Combat role from this player's most recent `enemy_player_battles` row.
    pub role: Option<String>,
    /// Main-hand item type id from this player's most recent battle row.
    pub main_hand_item_id: Option<String>,
    /// Item power from this player's most recent battle row.
    pub item_power: Option<f64>,
    /// RFC 3339. When this player was first observed.
    pub first_seen_at: String,
    /// RFC 3339. When this player was most recently observed.
    pub last_seen_at: String,
    /// Battle-derived tallies for this player, computed from `enemy_player_battles`.
    #[serde(flatten)]
    pub rollup: EnemyRollup,
}

/// One battle-by-battle history row in an [`EnemyPlayerDossier`].
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct EnemyPlayerBattleEntry {
    /// Canonical `AlbionBB` battle id.
    pub battle_id: i64,
    /// RFC 3339. The battle's own time.
    pub occurred_at: String,
    /// Assigned combat role, when classified.
    pub role: Option<String>,
    /// Raw upstream item type id of the player's main-hand weapon, when observed.
    pub main_hand_item_id: Option<String>,
    /// This player's item power, as observed in this battle.
    pub item_power: f64,
    /// Kills we landed on this player within this one battle.
    pub our_kills_on_them: i32,
    /// Kills this player landed on us within this one battle.
    pub their_kills_on_us: i32,
}

/// Full dossier for `GET /api/enemies/players/{id}`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct EnemyPlayerDossier {
    /// Surrogate primary key.
    pub id: i64,
    /// Opaque identity key.
    pub player_key: String,
    /// Raw Albion player id, when present.
    pub albion_player_id: Option<String>,
    /// Latest known display name.
    pub name: String,
    /// How `player_key` was derived: `"player_id"` or `"name_only"`.
    pub identity_source: String,
    /// The enemy guild this player is currently believed to belong to, when known.
    pub current_enemy_guild_id: Option<i64>,
    /// That guild's latest known display name, when known.
    pub current_enemy_guild_name: Option<String>,
    /// RFC 3339. When this player was first observed.
    pub first_seen_at: String,
    /// RFC 3339. When this player was most recently observed.
    pub last_seen_at: String,
    /// Officer-set flag marking this player for closer attention.
    pub is_watchlisted: bool,
    /// Free-form officer notes.
    pub notes: Option<String>,
    /// Full battle-by-battle history, newest first.
    pub battles: Vec<EnemyPlayerBattleEntry>,
    /// Battle-derived tallies across the whole history above.
    #[serde(flatten)]
    pub rollup: EnemyRollup,
}

/// Query parameters for `GET /api/enemies/guilds`.
#[derive(Debug, Clone, Deserialize, ToSchema, utoipa::IntoParams)]
pub struct ListEnemyGuildsQuery {
    /// 1-indexed page number. Defaults to 1.
    pub page: Option<u64>,
    /// Page size. Defaults to 10.
    pub limit: Option<u64>,
    /// Case-insensitive substring match on `name`.
    pub search: Option<String>,
    /// Sort column: `last_seen_at` (default) or `name`.
    pub sort: Option<String>,
    /// Sort direction: `asc` or `desc` (default).
    pub order: Option<String>,
}

/// Query parameters for `GET /api/enemies/players`.
#[derive(Debug, Clone, Deserialize, ToSchema, utoipa::IntoParams)]
pub struct ListEnemyPlayersQuery {
    /// 1-indexed page number. Defaults to 1.
    pub page: Option<u64>,
    /// Page size. Defaults to 10.
    pub limit: Option<u64>,
    /// Case-insensitive substring match on `name`.
    pub search: Option<String>,
    /// Restrict to players currently believed to belong to this enemy guild.
    pub guild_id: Option<i64>,
    /// Restrict to players whose most recently observed role matches exactly.
    pub role: Option<String>,
    /// Sort column: `last_seen_at` (default) or `name`.
    pub sort: Option<String>,
    /// Sort direction: `asc` or `desc` (default).
    pub order: Option<String>,
}
