//! Our side of the story: how the guild is doing, fight by fight, player by player, comp by comp.
//!
//! The scout library and the enemy dossiers answer "who are we fighting". This module answers the
//! other half of Intel: **how are we doing**. It serves four views over one selectable period:
//!
//! - [`build_overview`]: headline numbers, the previous period for comparison, a weekly trend.
//! - [`build_fights`]: our canonical fights, filterable and sortable.
//! - [`build_comps`]: the comps we fielded, with record and matchups.
//! - [`build_roster`] / [`build_player`]: the guild's members, with a per-member drill-down.
//!
//! # Where the numbers come from
//!
//! Nothing here parses the snapshot JSON blobs. Every figure is read from tables the battle
//! pipeline already normalized, so the cost is a handful of indexed queries per call:
//!
//! - `fights` and `fight_stats`: the canonical engagement, its **stored** outcome (the same value
//!   the fights list and the event page show) and the friendly-side rollup.
//! - `fight_battles` + `battle_guild_stats`: which enemy guild we fought.
//! - `battle_player_stats`: one row per player per segment, already flagged `is_friendly` against
//!   the tenant's own side when the battle was hydrated, with the observed weapon and role.
//! - `events.comp_id`: the comp a fight was planned with. A fight with no event has no comp, so
//!   it counts toward every total but toward no comp row (reported as `unattributed_fights`).
//!
//! Because the tenant's side is stamped at hydration time and `fight_stats` is computed from the
//! same rows, the numbers here always agree with the fight detail and event pages.
//!
//! # What is deliberately not here
//!
//! - **Income.** Guild income comes only from the splits users declare; nothing in this module
//!   infers earnings from battles. The only silver figure is our own estimated equipment loss, and
//!   it is withheld from callers without `intel.report.view` (the same gate as the guild report).
//! - **Fabricated zeros.** A rate with no denominator is `None`, never `0.0`, so the UI can say
//!   "no fights in this period" instead of "0% win rate".

use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::Duration;
use sea_orm::prelude::DateTimeWithTimeZone;
use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::report::WeaponShare;
use backend_battles::battles::outcome::BattleOutcome;
use backend_battles::battles::roles::normalize_item_id;
use backend_core::errors::AppError;
use backend_core::pagination::{PaginationParams, SortOrder, paginate_vec, resolve_sort_key};
use backend_core::ratios::{kill_death_ratio, ratio_percent};
use backend_entities::albion::albion_link;
use backend_entities::battles_evidence::{battle_guild_stat, battle_player_stat};
use backend_entities::comps::{build, comp};
use backend_entities::events::{event, event_participation, fight, fight_battle};
use backend_entities::fight_analytics::fight_stat;
use backend_entities::users as user;

/// Period used when the caller names none.
const DEFAULT_PERIOD: &str = "30d";
/// Window length, in days, for a custom range that omits `from`.
const DEFAULT_CUSTOM_DAYS: i64 = 30;
/// Ids per `IN (...)` list; keeps well under every backend's bind-variable ceiling.
const ID_CHUNK: usize = 500;
/// Fights shown on the overview.
const RECENT_FIGHTS_LIMIT: usize = 8;
/// Opponents shown on the overview.
const TOP_OPPONENTS_LIMIT: usize = 5;
/// Opponent names offered as filter options on the fights list.
const OPPONENT_OPTIONS_LIMIT: usize = 40;
/// Matchups kept per comp.
const COMP_MATCHUPS_LIMIT: usize = 8;
/// Weapons shown on a roster row.
const ROSTER_WEAPONS_LIMIT: usize = 3;
/// Weapons shown on a player's detail page.
const PLAYER_WEAPONS_LIMIT: usize = 10;
/// Fights listed on a player's detail page.
const PLAYER_FIGHTS_LIMIT: usize = 100;
/// Unlinked character names listed on the roster.
const UNLINKED_LIMIT: usize = 25;
/// Upper bound on weekly buckets, so a bogus range cannot allocate without limit.
const MAX_WEEKS: usize = 600;
/// Roles whose members are shown as officers.
const OFFICER_ROLES: [&str; 3] = ["Officer", "Admin", "SuperAdmin"];

// ---------------------------------------------------------------------------------------------
// Period
// ---------------------------------------------------------------------------------------------

/// Query parameters selecting the period every Intel view is computed over.
#[derive(Debug, Clone, Deserialize, IntoParams)]
pub struct PeriodParams {
    /// `7d`, `30d` (default), `90d` or `all`. Ignored when `from` or `to` is given.
    pub period: Option<String>,
    /// Custom window start, RFC 3339.
    pub from: Option<String>,
    /// Custom window end, RFC 3339. Defaults to now.
    pub to: Option<String>,
}

/// The resolved, inclusive time window.
#[derive(Debug, Clone, Copy)]
pub struct Window {
    /// `None` means "since the beginning" (`period=all`).
    pub from: Option<DateTimeWithTimeZone>,
    pub to: DateTimeWithTimeZone,
    /// `7d`, `30d`, `90d`, `all` or `custom`.
    pub key: &'static str,
}

impl Window {
    /// Resolves the request's period against the current time.
    pub fn resolve(params: &PeriodParams) -> Result<Self, AppError> {
        Self::resolve_at(chrono::Utc::now().into(), params)
    }

    /// Resolves the request's period against an explicit `now` (the testable seam).
    pub fn resolve_at(now: DateTimeWithTimeZone, params: &PeriodParams) -> Result<Self, AppError> {
        if params.from.is_some() || params.to.is_some() {
            let to = match params.to.as_deref() {
                Some(raw) => parse_rfc3339(raw, "to")?,
                None => now,
            };
            let from = match params.from.as_deref() {
                Some(raw) => parse_rfc3339(raw, "from")?,
                None => to - Duration::days(DEFAULT_CUSTOM_DAYS),
            };
            if from > to {
                return Err(AppError::Validation(
                    "`from` must not be after `to`".to_string(),
                ));
            }
            return Ok(Self {
                from: Some(from),
                to,
                key: "custom",
            });
        }
        let requested = params
            .period
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(DEFAULT_PERIOD);
        let (days, key) = match requested {
            "7d" => (7, "7d"),
            "30d" => (30, "30d"),
            "90d" => (90, "90d"),
            "all" => {
                return Ok(Self {
                    from: None,
                    to: now,
                    key: "all",
                });
            }
            other => {
                return Err(AppError::Validation(format!(
                    "unknown period '{other}'; expected 7d, 30d, 90d or all"
                )));
            }
        };
        Ok(Self {
            from: Some(now - Duration::days(days)),
            to: now,
            key,
        })
    }

    /// The window of equal length immediately before this one; `None` for `all`.
    #[must_use]
    pub fn previous(&self) -> Option<Self> {
        let from = self.from?;
        let span = self.to - from;
        let to = from - Duration::milliseconds(1);
        Some(Self {
            from: Some(to - span),
            to,
            key: self.key,
        })
    }

    fn view(&self, earliest: Option<DateTimeWithTimeZone>) -> PeriodView {
        PeriodView {
            key: self.key.to_string(),
            from: self.from.or(earliest).map(|from| from.to_rfc3339()),
            to: self.to.to_rfc3339(),
        }
    }
}

fn parse_rfc3339(raw: &str, field: &str) -> Result<DateTimeWithTimeZone, AppError> {
    raw.parse()
        .map_err(|_| AppError::Validation(format!("`{field}` must be an RFC 3339 timestamp")))
}

/// The window a response was computed over.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PeriodView {
    /// `7d`, `30d`, `90d`, `all` or `custom`.
    pub key: String,
    /// Window start, RFC 3339. For `all`, the first fight on record; `None` when there is none.
    pub from: Option<String>,
    /// Window end, RFC 3339.
    pub to: String,
}

// ---------------------------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------------------------

/// Combat totals over a set of fights.
///
/// Rates are `None` when their denominator is empty, so a client can tell "no data" from "zero".
/// Combat figures cover only fights that have a computed rollup (`fights_with_stats`).
#[derive(Debug, Clone, Default, Serialize, ToSchema)]
pub struct PeriodTotals {
    /// Fights in the set.
    pub fights: i64,
    pub wins: i64,
    pub losses: i64,
    pub draws: i64,
    /// Fights whose outcome could not be decided; never counted as losses.
    pub unknown: i64,
    /// Fights with a decided outcome (`wins + losses + draws`).
    pub decided: i64,
    /// Percentage `0..=100`, `wins / decided`. `None` when nothing was decided.
    pub win_rate: Option<f64>,
    /// Fights whose combat rollup has been computed.
    pub fights_with_stats: i64,
    pub kills: i64,
    pub deaths: i64,
    /// Kill/death ratio; equals `kills` when there were no deaths. `None` without rollups.
    pub kd_ratio: Option<f64>,
    /// Fame our side earned from kills.
    pub kill_fame: i64,
    /// Fame the enemy earned by killing our players.
    pub death_fame: i64,
    /// Mean distinct friendly players per fight.
    pub avg_players: Option<f64>,
    /// Mean friendly item power across player appearances.
    pub avg_item_power: Option<f64>,
    /// Mean enemy item power across player appearances.
    pub enemy_avg_item_power: Option<f64>,
    /// Estimated silver value of our equipment lost. Present only for callers holding
    /// `intel.report.view`; `None` otherwise (and `0` is a real figure, not a placeholder).
    pub estimated_silver_lost: Option<i64>,
}

/// One calendar week (Monday-anchored, UTC) of the trend.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct WeekBucket {
    /// Monday 00:00 UTC, RFC 3339.
    pub week_start: String,
    pub fights: i64,
    pub wins: i64,
    pub losses: i64,
    pub draws: i64,
    pub win_rate: Option<f64>,
    pub kills: i64,
    pub deaths: i64,
    pub kill_fame: i64,
    pub avg_players: Option<f64>,
}

/// Our record against one enemy guild.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct OpponentRecord {
    pub opponent: String,
    pub fights: i64,
    pub wins: i64,
    pub losses: i64,
    pub draws: i64,
    pub win_rate: Option<f64>,
}

/// One fight, from our side.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct IntelFightRow {
    /// Canonical fight id; the detail page lives at `/fights/{id}`.
    pub fight_id: i64,
    pub started_at: String,
    pub event_id: Option<i64>,
    pub event_title: Option<String>,
    pub comp_id: Option<i64>,
    pub comp_name: Option<String>,
    /// The stored `fights.outcome`.
    pub outcome: BattleOutcome,
    /// The enemy guild with the most players across the fight's segments.
    pub opponent: Option<String>,
    pub segments: i64,
    /// Distinct friendly players. `None` when the fight has no computed rollup.
    pub our_players: Option<i64>,
    pub enemy_players: Option<i64>,
    pub kills: Option<i64>,
    pub deaths: Option<i64>,
    pub kd_ratio: Option<f64>,
    pub kill_fame: Option<i64>,
    pub death_fame: Option<i64>,
    pub avg_item_power: Option<f64>,
    pub enemy_avg_item_power: Option<f64>,
    /// Withheld (`None`) from callers without `intel.report.view`.
    pub estimated_silver_lost: Option<i64>,
}

/// How complete the data behind a response is.
#[derive(Debug, Clone, Default, Serialize, ToSchema)]
pub struct DataQuality {
    /// Fights with no computed rollup: counted as fights, absent from combat figures.
    pub fights_without_stats: i64,
    /// Fights whose outcome is `unknown`: counted as fights, absent from the win rate.
    pub fights_unknown_outcome: i64,
    /// Fights not linked to an event, so attributable to no comp.
    pub fights_without_comp: i64,
}

/// `GET /api/intel/overview`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct IntelOverview {
    pub period: PeriodView,
    pub current: PeriodTotals,
    /// The same figures for the preceding window of equal length. `None` for `period=all`.
    pub previous: Option<PeriodTotals>,
    /// One bucket per calendar week, oldest first, quiet weeks included.
    pub weekly: Vec<WeekBucket>,
    /// The newest fights in the period.
    pub recent_fights: Vec<IntelFightRow>,
    /// The enemy guilds we met most often.
    pub top_opponents: Vec<OpponentRecord>,
    pub data_quality: DataQuality,
}

/// A comp offered as a filter option.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct CompOption {
    pub comp_id: i64,
    pub name: String,
}

/// `GET /api/intel/fights`: a page of fights plus what the filters were applied to.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct IntelFightList {
    pub period: PeriodView,
    pub items: Vec<IntelFightRow>,
    pub total_items: u64,
    pub total_pages: u64,
    pub current_page: u64,
    pub limit: u64,
    /// Totals over every fight matching the filters, not just this page.
    pub summary: PeriodTotals,
    /// Enemy guilds met in the period (before filtering), most frequent first.
    pub opponents: Vec<String>,
    /// Comps fielded in the period (before filtering).
    pub comps: Vec<CompOption>,
}

/// Query parameters for `GET /api/intel/fights`.
///
/// Fields are inline rather than flattened: axum's `Query` cannot deserialize non-string fields
/// through a flattened struct.
#[derive(Debug, Clone, Deserialize, IntoParams)]
pub struct FightsQuery {
    /// `7d`, `30d` (default), `90d` or `all`. Ignored when `from` or `to` is given.
    pub period: Option<String>,
    /// Custom window start, RFC 3339.
    pub from: Option<String>,
    /// Custom window end, RFC 3339.
    pub to: Option<String>,
    /// `victory`, `defeat`, `draw` or `unknown`.
    pub outcome: Option<String>,
    /// Case-insensitive substring of the opponent guild name.
    pub opponent: Option<String>,
    /// Only fights planned with this comp.
    pub comp_id: Option<i64>,
    /// Minimum distinct friendly players.
    pub min_players: Option<i64>,
    /// Maximum distinct friendly players.
    pub max_players: Option<i64>,
    /// `started_at` (default), `players`, `kills`, `deaths`, `kill_fame` or `kd`.
    pub sort: Option<String>,
    /// `asc` or `desc` (default).
    pub order: Option<String>,
    /// Page number, 1-indexed.
    pub page: Option<u64>,
    /// Page size, defaults to 10.
    pub limit: Option<u64>,
}

impl FightsQuery {
    fn period(&self) -> PeriodParams {
        PeriodParams {
            period: self.period.clone(),
            from: self.from.clone(),
            to: self.to.clone(),
        }
    }
}

/// One comp we fielded.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct CompUsage {
    pub comp_id: i64,
    pub name: String,
    /// Distinct events that fielded the comp.
    pub events: i64,
    /// Record and combat figures over the fights played with this comp.
    pub totals: PeriodTotals,
    pub last_used_at: String,
    /// Enemy guild we beat more often than not, best rate first.
    pub best_matchup: Option<OpponentRecord>,
    /// Enemy guild that beat us more often than not, worst rate first.
    pub worst_matchup: Option<OpponentRecord>,
    /// Most frequent opponents, capped.
    pub matchups: Vec<OpponentRecord>,
}

/// `GET /api/intel/comps`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct IntelComps {
    pub period: PeriodView,
    pub comps: Vec<CompUsage>,
    /// Fights in the period, with or without a comp.
    pub total_fights: i64,
    /// Fights not linked to an event, so counted in no comp row.
    pub unattributed_fights: i64,
}

/// One member's combat record over the period.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct RosterMember {
    pub user_id: i64,
    pub username: String,
    /// The linked Albion character, when the member has linked one.
    pub albion_name: Option<String>,
    pub role: String,
    pub is_officer: bool,
    /// Still present in the Discord server. Former members appear only if they fought.
    pub active: bool,
    pub linked: bool,
    /// Fights the member took part in.
    pub fights: i64,
    /// `fights / fights with a computed rollup`, as a percentage. `None` when there were none.
    pub attendance_rate: Option<f64>,
    pub wins: i64,
    pub losses: i64,
    pub draws: i64,
    /// Win rate of the fights the member attended.
    pub win_rate: Option<f64>,
    pub kills: i64,
    pub deaths: i64,
    pub kd_ratio: Option<f64>,
    pub kill_fame: i64,
    pub death_fame: i64,
    pub avg_item_power: Option<f64>,
    /// Most-played main-hand weapons (item id with the tier stripped), most used first.
    pub weapons: Vec<WeaponShare>,
    /// Most-played role (`dps`, `healer`, ...), when any role was observed.
    pub main_role: Option<String>,
    pub last_fight_at: Option<String>,
    pub last_fight_id: Option<i64>,
}

/// A character seen fighting for us that no member has linked.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct UnlinkedPlayer {
    pub name: String,
    pub fights: i64,
}

/// `GET /api/intel/roster`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct IntelRoster {
    pub period: PeriodView,
    /// Fights with a computed rollup: the denominator of every attendance rate.
    pub total_fights: i64,
    /// `all` for officers, `self` when the caller sees only their own row.
    pub scope: String,
    pub members: Vec<RosterMember>,
    /// Empty unless `scope` is `all`.
    pub unlinked_players: Vec<UnlinkedPlayer>,
}

/// One role's share of a member's appearances.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct RoleShare {
    pub role: String,
    pub count: i64,
}

/// One week of a member's activity.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PlayerWeek {
    pub week_start: String,
    pub fights: i64,
    pub wins: i64,
    pub losses: i64,
    pub draws: i64,
    pub kills: i64,
    pub deaths: i64,
    pub kill_fame: i64,
}

/// One fight a member took part in.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PlayerFightRow {
    pub fight_id: i64,
    pub started_at: String,
    pub event_title: Option<String>,
    pub comp_id: Option<i64>,
    pub comp_name: Option<String>,
    pub outcome: BattleOutcome,
    pub opponent: Option<String>,
    pub kills: i64,
    pub deaths: i64,
    pub kill_fame: i64,
    pub death_fame: i64,
    pub avg_item_power: Option<f64>,
    /// The weapon the member used most in this fight.
    pub weapon: Option<String>,
    pub role: Option<String>,
}

/// A build the member signed up with for events they then fought in.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct BuildUse {
    pub build_id: i64,
    pub name: String,
    pub role: String,
    /// Events fought with this build as the primary choice.
    pub events: i64,
}

/// A comp the member fought in.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PlayerCompUse {
    pub comp_id: i64,
    pub name: String,
    pub fights: i64,
    pub wins: i64,
    pub losses: i64,
    pub draws: i64,
}

/// `GET /api/intel/roster/{user_id}`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct IntelPlayer {
    pub period: PeriodView,
    pub total_fights: i64,
    pub member: RosterMember,
    /// One bucket per week, oldest first, quiet weeks included.
    pub weekly: Vec<PlayerWeek>,
    /// Newest first, capped.
    pub fights: Vec<PlayerFightRow>,
    pub weapons: Vec<WeaponShare>,
    pub roles: Vec<RoleShare>,
    pub builds: Vec<BuildUse>,
    pub comps: Vec<PlayerCompUse>,
}

// ---------------------------------------------------------------------------------------------
// Facts: one row per canonical fight
// ---------------------------------------------------------------------------------------------

/// The friendly-side rollup of a fight, from `fight_stats`.
#[derive(Debug, Clone, Copy)]
struct StatsFact {
    players: i64,
    enemy_players: i64,
    kills: i64,
    deaths: i64,
    kill_fame: i64,
    /// `fight_stats.enemy_kill_fame`: the fame the enemy earned by killing our players.
    death_fame: i64,
    item_power: f64,
    enemy_item_power: f64,
    loss: i64,
}

/// A canonical fight with everything the views need, joined once.
#[derive(Debug, Clone)]
struct FightFact {
    id: i64,
    started_at: DateTimeWithTimeZone,
    event_id: Option<i64>,
    event_title: Option<String>,
    comp_id: Option<i64>,
    outcome: BattleOutcome,
    segments: i64,
    battle_ids: Vec<i64>,
    stats: Option<StatsFact>,
    opponent: Option<String>,
}

/// Running totals over fights; the one accumulator behind every view.
#[derive(Debug, Clone, Default)]
struct Tally {
    fights: i64,
    wins: i64,
    losses: i64,
    draws: i64,
    unknown: i64,
    with_stats: i64,
    kills: i64,
    deaths: i64,
    kill_fame: i64,
    death_fame: i64,
    players: i64,
    ip_sum: f64,
    ip_count: i64,
    enemy_ip_sum: f64,
    enemy_ip_count: i64,
    loss: i64,
}

impl Tally {
    fn add(&mut self, fact: &FightFact) {
        self.fights += 1;
        match fact.outcome {
            BattleOutcome::Victory => self.wins += 1,
            BattleOutcome::Defeat => self.losses += 1,
            BattleOutcome::Draw => self.draws += 1,
            BattleOutcome::Unknown => self.unknown += 1,
        }
        if let Some(stats) = fact.stats {
            self.with_stats += 1;
            self.kills += stats.kills;
            self.deaths += stats.deaths;
            self.kill_fame += stats.kill_fame;
            self.death_fame += stats.death_fame;
            self.players += stats.players;
            self.loss += stats.loss;
            if stats.item_power > 0.0 {
                self.ip_sum += stats.item_power;
                self.ip_count += 1;
            }
            if stats.enemy_item_power > 0.0 {
                self.enemy_ip_sum += stats.enemy_item_power;
                self.enemy_ip_count += 1;
            }
        }
    }

    fn decided(&self) -> i64 {
        self.wins + self.losses + self.draws
    }

    fn win_rate(&self) -> Option<f64> {
        (self.decided() > 0).then(|| ratio_percent(self.wins, self.decided()))
    }

    #[allow(clippy::cast_precision_loss)]
    fn avg_players(&self) -> Option<f64> {
        (self.with_stats > 0).then(|| self.players as f64 / self.with_stats as f64)
    }

    fn totals(&self, financials: bool) -> PeriodTotals {
        #[allow(clippy::cast_precision_loss)]
        let mean = |sum: f64, count: i64| (count > 0).then(|| sum / count as f64);
        PeriodTotals {
            fights: self.fights,
            wins: self.wins,
            losses: self.losses,
            draws: self.draws,
            unknown: self.unknown,
            decided: self.decided(),
            win_rate: self.win_rate(),
            fights_with_stats: self.with_stats,
            kills: self.kills,
            deaths: self.deaths,
            kd_ratio: (self.with_stats > 0).then(|| kill_death_ratio(self.kills, self.deaths)),
            kill_fame: self.kill_fame,
            death_fame: self.death_fame,
            avg_players: self.avg_players(),
            avg_item_power: mean(self.ip_sum, self.ip_count),
            enemy_avg_item_power: mean(self.enemy_ip_sum, self.enemy_ip_count),
            estimated_silver_lost: financials.then_some(self.loss),
        }
    }

    fn record(&self, opponent: &str) -> OpponentRecord {
        OpponentRecord {
            opponent: opponent.to_string(),
            fights: self.fights,
            wins: self.wins,
            losses: self.losses,
            draws: self.draws,
            win_rate: self.win_rate(),
        }
    }
}

fn tally_of<'a>(facts: impl IntoIterator<Item = &'a FightFact>) -> Tally {
    let mut tally = Tally::default();
    for fact in facts {
        tally.add(fact);
    }
    tally
}

/// Splits `ids` into `IN (...)`-sized chunks.
fn chunks(ids: &[i64]) -> impl Iterator<Item = Vec<i64>> + '_ {
    ids.chunks(ID_CHUNK).map(<[i64]>::to_vec)
}

/// Loads every canonical fight inside `window`, newest first, joined with its rollup, event and
/// opponent. One query per table; no per-fight lookups.
async fn load_facts(
    db: &DatabaseConnection,
    window: &Window,
    with_opponents: bool,
) -> Result<Vec<FightFact>, AppError> {
    let mut find = fight::Entity::find().filter(fight::Column::StartedAt.lte(window.to));
    if let Some(from) = window.from {
        find = find.filter(fight::Column::StartedAt.gte(from));
    }
    let fights = find
        .order_by_desc(fight::Column::StartedAt)
        .order_by_desc(fight::Column::Id)
        .all(db)
        .await?;
    if fights.is_empty() {
        return Ok(Vec::new());
    }
    let fight_ids: Vec<i64> = fights.iter().map(|row| row.id).collect();

    let mut stats_by_fight: HashMap<i64, StatsFact> = HashMap::new();
    let mut battles_by_fight: HashMap<i64, Vec<(i32, i64)>> = HashMap::new();
    for chunk in chunks(&fight_ids) {
        for row in fight_stat::Entity::find()
            .filter(fight_stat::Column::FightId.is_in(chunk.clone()))
            .all(db)
            .await?
        {
            stats_by_fight.insert(
                row.fight_id,
                StatsFact {
                    players: i64::from(row.unique_friendly_players),
                    enemy_players: i64::from(row.unique_enemy_players),
                    kills: row.friendly_kills,
                    deaths: row.friendly_deaths,
                    kill_fame: row.friendly_kill_fame,
                    death_fame: row.enemy_kill_fame,
                    item_power: row.avg_friendly_item_power,
                    enemy_item_power: row.avg_enemy_item_power,
                    loss: row.friendly_estimated_loss,
                },
            );
        }
        for row in fight_battle::Entity::find()
            .filter(fight_battle::Column::FightId.is_in(chunk))
            .all(db)
            .await?
        {
            battles_by_fight
                .entry(row.fight_id)
                .or_default()
                .push((row.sequence_number, row.battle_id));
        }
    }

    let event_ids: Vec<i64> = {
        let mut ids: Vec<i64> = fights.iter().filter_map(|row| row.event_id).collect();
        ids.sort_unstable();
        ids.dedup();
        ids
    };
    let mut events: HashMap<i64, (String, Option<i64>)> = HashMap::new();
    for chunk in chunks(&event_ids) {
        for row in event::Entity::find()
            .filter(event::Column::Id.is_in(chunk))
            .all(db)
            .await?
        {
            events.insert(row.id, (row.title, row.comp_id));
        }
    }

    let opponents = if with_opponents {
        load_opponents(db, &battles_by_fight).await?
    } else {
        HashMap::new()
    };

    Ok(fights
        .into_iter()
        .map(|row| {
            let mut battles = battles_by_fight.remove(&row.id).unwrap_or_default();
            battles.sort_unstable();
            let event = row.event_id.and_then(|id| events.get(&id));
            FightFact {
                id: row.id,
                started_at: row.started_at,
                event_id: row.event_id,
                event_title: event.map(|(title, _)| title.clone()),
                comp_id: event.and_then(|(_, comp_id)| *comp_id),
                outcome: BattleOutcome::from_query(&row.outcome).unwrap_or(BattleOutcome::Unknown),
                segments: i64::try_from(battles.len()).unwrap_or(i64::MAX),
                battle_ids: battles.into_iter().map(|(_, battle_id)| battle_id).collect(),
                stats: stats_by_fight.get(&row.id).copied(),
                opponent: opponents.get(&row.id).cloned(),
            }
        })
        .collect())
}

/// The enemy guild each fight was mostly against: most players across its segments, then most
/// kill fame, then name (so the answer is stable).
async fn load_opponents(
    db: &DatabaseConnection,
    battles_by_fight: &HashMap<i64, Vec<(i32, i64)>>,
) -> Result<HashMap<i64, String>, AppError> {
    let mut fight_of_battle: HashMap<i64, i64> = HashMap::new();
    for (fight_id, battles) in battles_by_fight {
        for (_, battle_id) in battles {
            fight_of_battle.insert(*battle_id, *fight_id);
        }
    }
    let battle_ids: Vec<i64> = fight_of_battle.keys().copied().collect();

    let mut per_fight: HashMap<i64, HashMap<String, (i64, i64)>> = HashMap::new();
    for chunk in chunks(&battle_ids) {
        for row in battle_guild_stat::Entity::find()
            .filter(battle_guild_stat::Column::BattleId.is_in(chunk))
            .filter(battle_guild_stat::Column::IsFriendly.eq(false))
            .all(db)
            .await?
        {
            let name = row.guild_name.trim();
            if name.is_empty() {
                continue;
            }
            let Some(fight_id) = fight_of_battle.get(&row.battle_id) else {
                continue;
            };
            let entry = per_fight
                .entry(*fight_id)
                .or_default()
                .entry(name.to_string())
                .or_insert((0, 0));
            entry.0 += i64::from(row.players);
            entry.1 += row.kill_fame;
        }
    }

    Ok(per_fight
        .into_iter()
        .filter_map(|(fight_id, guilds)| {
            guilds
                .into_iter()
                .max_by(|(name_a, (players_a, fame_a)), (name_b, (players_b, fame_b))| {
                    players_a
                        .cmp(players_b)
                        .then(fame_a.cmp(fame_b))
                        .then(name_b.cmp(name_a))
                })
                .map(|(name, _)| (fight_id, name))
        })
        .collect())
}

async fn comp_names(
    db: &DatabaseConnection,
    facts: &[FightFact],
) -> Result<HashMap<i64, String>, AppError> {
    let mut ids: Vec<i64> = facts.iter().filter_map(|fact| fact.comp_id).collect();
    ids.sort_unstable();
    ids.dedup();
    let mut names = HashMap::new();
    for chunk in chunks(&ids) {
        for row in comp::Entity::find()
            .filter(comp::Column::Id.is_in(chunk))
            .all(db)
            .await?
        {
            names.insert(row.id, row.name);
        }
    }
    Ok(names)
}

fn comp_label(comp_id: i64, names: &HashMap<i64, String>) -> String {
    names
        .get(&comp_id)
        .cloned()
        .unwrap_or_else(|| format!("Comp #{comp_id}"))
}

fn fight_row(
    fact: &FightFact,
    names: &HashMap<i64, String>,
    financials: bool,
) -> IntelFightRow {
    let stats = fact.stats;
    IntelFightRow {
        fight_id: fact.id,
        started_at: fact.started_at.to_rfc3339(),
        event_id: fact.event_id,
        event_title: fact.event_title.clone(),
        comp_id: fact.comp_id,
        comp_name: fact.comp_id.map(|id| comp_label(id, names)),
        outcome: fact.outcome,
        opponent: fact.opponent.clone(),
        segments: fact.segments,
        our_players: stats.map(|s| s.players),
        enemy_players: stats.map(|s| s.enemy_players),
        kills: stats.map(|s| s.kills),
        deaths: stats.map(|s| s.deaths),
        kd_ratio: stats.map(|s| kill_death_ratio(s.kills, s.deaths)),
        kill_fame: stats.map(|s| s.kill_fame),
        death_fame: stats.map(|s| s.death_fame),
        avg_item_power: stats.map(|s| s.item_power).filter(|ip| *ip > 0.0),
        enemy_avg_item_power: stats.map(|s| s.enemy_item_power).filter(|ip| *ip > 0.0),
        estimated_silver_lost: stats.filter(|_| financials).map(|s| s.loss),
    }
}

fn data_quality(facts: &[FightFact]) -> DataQuality {
    let count = |predicate: fn(&FightFact) -> bool| {
        i64::try_from(facts.iter().filter(|fact| predicate(fact)).count()).unwrap_or(i64::MAX)
    };
    DataQuality {
        fights_without_stats: count(|fact| fact.stats.is_none()),
        fights_unknown_outcome: count(|fact| fact.outcome == BattleOutcome::Unknown),
        fights_without_comp: count(|fact| fact.comp_id.is_none()),
    }
}

// ---------------------------------------------------------------------------------------------
// Weeks
// ---------------------------------------------------------------------------------------------

/// Monday 00:00 UTC of the week containing `dt`.
fn week_start(dt: DateTimeWithTimeZone) -> DateTimeWithTimeZone {
    use chrono::Datelike;
    let utc = dt.with_timezone(&chrono::Utc);
    let days_since_monday = i64::from(utc.weekday().num_days_from_monday());
    let monday = utc.date_naive() - Duration::days(days_since_monday);
    monday
        .and_hms_opt(0, 0, 0)
        .unwrap_or_default()
        .and_utc()
        .into()
}

/// Every week start from the window's start (or the first fight, for `all`) to its end.
fn week_axis(
    window: &Window,
    earliest: Option<DateTimeWithTimeZone>,
) -> Vec<DateTimeWithTimeZone> {
    let Some(start) = window.from.or(earliest) else {
        return Vec::new();
    };
    let end = week_start(window.to);
    let mut cursor = week_start(start);
    let mut weeks = Vec::new();
    while cursor <= end && weeks.len() < MAX_WEEKS {
        weeks.push(cursor);
        cursor = cursor + Duration::days(7);
    }
    weeks
}

fn earliest_of(facts: &[FightFact]) -> Option<DateTimeWithTimeZone> {
    facts.iter().map(|fact| fact.started_at).min()
}

fn weekly_tallies(facts: &[FightFact]) -> BTreeMap<i64, Tally> {
    let mut weeks: BTreeMap<i64, Tally> = BTreeMap::new();
    for fact in facts {
        weeks
            .entry(week_start(fact.started_at).timestamp())
            .or_default()
            .add(fact);
    }
    weeks
}

fn weekly_buckets(window: &Window, facts: &[FightFact]) -> Vec<WeekBucket> {
    let tallies = weekly_tallies(facts);
    week_axis(window, earliest_of(facts))
        .into_iter()
        .map(|start| {
            let tally = tallies.get(&start.timestamp()).cloned().unwrap_or_default();
            WeekBucket {
                week_start: start.to_rfc3339(),
                fights: tally.fights,
                wins: tally.wins,
                losses: tally.losses,
                draws: tally.draws,
                win_rate: tally.win_rate(),
                kills: tally.kills,
                deaths: tally.deaths,
                kill_fame: tally.kill_fame,
                avg_players: tally.avg_players(),
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------------------------

/// Opponents grouped from `facts`, most frequent first (then by name).
fn opponent_records<'a>(facts: impl IntoIterator<Item = &'a FightFact>) -> Vec<OpponentRecord> {
    let mut by_opponent: HashMap<&str, Tally> = HashMap::new();
    for fact in facts {
        if let Some(opponent) = fact.opponent.as_deref() {
            by_opponent.entry(opponent).or_default().add(fact);
        }
    }
    let mut records: Vec<OpponentRecord> = by_opponent
        .into_iter()
        .map(|(opponent, tally)| tally.record(opponent))
        .collect();
    records.sort_by(|a, b| {
        b.fights
            .cmp(&a.fights)
            .then_with(|| a.opponent.cmp(&b.opponent))
    });
    records
}

/// Builds the overview: totals, the previous period, the weekly trend and the newest fights.
pub async fn build_overview(
    db: &DatabaseConnection,
    window: &Window,
    financials: bool,
) -> Result<IntelOverview, AppError> {
    let facts = load_facts(db, window, true).await?;
    let previous = match window.previous() {
        Some(previous) => {
            let facts = load_facts(db, &previous, false).await?;
            Some(tally_of(&facts).totals(financials))
        }
        None => None,
    };
    let names = comp_names(db, &facts).await?;
    let mut top_opponents = opponent_records(&facts);
    top_opponents.truncate(TOP_OPPONENTS_LIMIT);

    Ok(IntelOverview {
        period: window.view(earliest_of(&facts)),
        current: tally_of(&facts).totals(financials),
        previous,
        weekly: weekly_buckets(window, &facts),
        recent_fights: facts
            .iter()
            .take(RECENT_FIGHTS_LIMIT)
            .map(|fact| fight_row(fact, &names, financials))
            .collect(),
        top_opponents,
        data_quality: data_quality(&facts),
    })
}

// ---------------------------------------------------------------------------------------------
// Fights
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Copy)]
enum FightSort {
    StartedAt,
    Players,
    Kills,
    Deaths,
    KillFame,
    Kd,
}

/// Builds a filtered, sorted, paginated list of our fights.
pub async fn build_fights(
    db: &DatabaseConnection,
    query: &FightsQuery,
    financials: bool,
) -> Result<IntelFightList, AppError> {
    let window = Window::resolve(&query.period())?;
    let sort = resolve_sort_key(
        query.sort.as_deref(),
        &[
            ("started_at", FightSort::StartedAt),
            ("players", FightSort::Players),
            ("kills", FightSort::Kills),
            ("deaths", FightSort::Deaths),
            ("kill_fame", FightSort::KillFame),
            ("kd", FightSort::Kd),
        ],
        FightSort::StartedAt,
    )?;
    let order = SortOrder::from_query(query.order.as_deref());
    let outcome = query
        .outcome
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            BattleOutcome::from_query(value)
                .ok_or_else(|| AppError::Validation(format!("unknown fight outcome '{value}'")))
        })
        .transpose()?;
    let opponent_filter = query
        .opponent
        .as_deref()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());

    let facts = load_facts(db, &window, true).await?;
    let names = comp_names(db, &facts).await?;

    let opponents: Vec<String> = {
        let mut records = opponent_records(&facts);
        records.truncate(OPPONENT_OPTIONS_LIMIT);
        records.into_iter().map(|record| record.opponent).collect()
    };
    let comps = {
        let mut options: Vec<CompOption> = facts
            .iter()
            .filter_map(|fact| fact.comp_id)
            .collect::<HashSet<i64>>()
            .into_iter()
            .map(|comp_id| CompOption {
                comp_id,
                name: comp_label(comp_id, &names),
            })
            .collect();
        options.sort_by(|a, b| a.name.cmp(&b.name).then(a.comp_id.cmp(&b.comp_id)));
        options
    };

    let mut matching: Vec<&FightFact> = facts
        .iter()
        .filter(|fact| outcome.is_none_or(|wanted| fact.outcome == wanted))
        .filter(|fact| query.comp_id.is_none_or(|id| fact.comp_id == Some(id)))
        .filter(|fact| {
            opponent_filter.as_deref().is_none_or(|needle| {
                fact.opponent
                    .as_deref()
                    .is_some_and(|name| name.to_ascii_lowercase().contains(needle))
            })
        })
        .filter(|fact| {
            let players = fact.stats.map(|s| s.players);
            query.min_players.is_none_or(|min| players.is_some_and(|p| p >= min))
                && query.max_players.is_none_or(|max| players.is_some_and(|p| p <= max))
        })
        .collect();

    let summary = tally_of(matching.iter().copied()).totals(financials);

    matching.sort_by(|a, b| {
        let ordering = match sort {
            FightSort::StartedAt => a.started_at.cmp(&b.started_at),
            FightSort::Players => a
                .stats
                .map(|s| s.players)
                .cmp(&b.stats.map(|s| s.players)),
            FightSort::Kills => a.stats.map(|s| s.kills).cmp(&b.stats.map(|s| s.kills)),
            FightSort::Deaths => a.stats.map(|s| s.deaths).cmp(&b.stats.map(|s| s.deaths)),
            FightSort::KillFame => a
                .stats
                .map(|s| s.kill_fame)
                .cmp(&b.stats.map(|s| s.kill_fame)),
            FightSort::Kd => {
                let kd = |fact: &FightFact| {
                    fact.stats.map(|s| kill_death_ratio(s.kills, s.deaths))
                };
                kd(a).partial_cmp(&kd(b)).unwrap_or(std::cmp::Ordering::Equal)
            }
        };
        let ordering = match order {
            SortOrder::Asc => ordering,
            SortOrder::Desc => ordering.reverse(),
        };
        ordering.then_with(|| match order {
            SortOrder::Asc => a.id.cmp(&b.id),
            SortOrder::Desc => b.id.cmp(&a.id),
        })
    });

    let rows: Vec<IntelFightRow> = matching
        .into_iter()
        .map(|fact| fight_row(fact, &names, financials))
        .collect();
    let page = paginate_vec(
        rows,
        &PaginationParams {
            page: query.page,
            limit: query.limit,
        },
    );

    Ok(IntelFightList {
        period: window.view(earliest_of(&facts)),
        items: page.items,
        total_items: page.total_items,
        total_pages: page.total_pages,
        current_page: page.current_page,
        limit: page.limit,
        summary,
        opponents,
        comps,
    })
}

// ---------------------------------------------------------------------------------------------
// Comps
// ---------------------------------------------------------------------------------------------

/// Picks the opponent we beat most convincingly and the one that beat us worst.
///
/// A matchup only qualifies as "best" with more wins than losses and as "worst" with more losses
/// than wins, so a comp with an even record against everyone claims neither.
fn best_and_worst(matchups: &[OpponentRecord]) -> (Option<OpponentRecord>, Option<OpponentRecord>) {
    let rate = |record: &OpponentRecord| record.win_rate.unwrap_or(0.0);
    let best = matchups
        .iter()
        .filter(|record| record.wins > record.losses)
        .max_by(|a, b| {
            rate(a)
                .partial_cmp(&rate(b))
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(a.fights.cmp(&b.fights))
                .then(b.opponent.cmp(&a.opponent))
        })
        .cloned();
    let worst = matchups
        .iter()
        .filter(|record| record.losses > record.wins)
        .min_by(|a, b| {
            rate(a)
                .partial_cmp(&rate(b))
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(b.fights.cmp(&a.fights))
                .then(a.opponent.cmp(&b.opponent))
        })
        .cloned();
    (best, worst)
}

/// Builds the comps we fielded over the period.
pub async fn build_comps(
    db: &DatabaseConnection,
    window: &Window,
    financials: bool,
) -> Result<IntelComps, AppError> {
    let facts = load_facts(db, window, true).await?;
    let names = comp_names(db, &facts).await?;

    let mut by_comp: HashMap<i64, Vec<&FightFact>> = HashMap::new();
    for fact in &facts {
        if let Some(comp_id) = fact.comp_id {
            by_comp.entry(comp_id).or_default().push(fact);
        }
    }

    let mut comps: Vec<CompUsage> = by_comp
        .into_iter()
        .map(|(comp_id, comp_facts)| {
            let events = comp_facts
                .iter()
                .filter_map(|fact| fact.event_id)
                .collect::<HashSet<i64>>()
                .len();
            let last_used_at = comp_facts
                .iter()
                .map(|fact| fact.started_at)
                .max()
                .map(|at| at.to_rfc3339())
                .unwrap_or_default();
            let mut matchups = opponent_records(comp_facts.iter().copied());
            let (best_matchup, worst_matchup) = best_and_worst(&matchups);
            matchups.truncate(COMP_MATCHUPS_LIMIT);
            CompUsage {
                comp_id,
                name: comp_label(comp_id, &names),
                events: i64::try_from(events).unwrap_or(i64::MAX),
                totals: tally_of(comp_facts.iter().copied()).totals(financials),
                last_used_at,
                best_matchup,
                worst_matchup,
                matchups,
            }
        })
        .collect();
    comps.sort_by(|a, b| {
        b.totals
            .fights
            .cmp(&a.totals.fights)
            .then_with(|| a.name.cmp(&b.name))
            .then(a.comp_id.cmp(&b.comp_id))
    });

    let total_fights = i64::try_from(facts.len()).unwrap_or(i64::MAX);
    Ok(IntelComps {
        period: window.view(earliest_of(&facts)),
        comps,
        total_fights,
        unattributed_fights: data_quality(&facts).fights_without_comp,
    })
}

// ---------------------------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------------------------

/// One member's lines in one fight, summed over the fight's segments.
#[derive(Debug, Clone, Default)]
struct Appearance {
    kills: i64,
    deaths: i64,
    kill_fame: i64,
    death_fame: i64,
    ip_sum: f64,
    ip_count: i64,
    weapons: HashMap<String, i64>,
    roles: HashMap<String, i64>,
}

/// Friendly player lines, grouped by who they belong to.
#[derive(Debug, Default)]
struct Appearances {
    /// member -> fight -> lines
    by_user: HashMap<i64, HashMap<i64, Appearance>>,
    /// lowercased character name -> (display name, fights)
    unlinked: HashMap<String, (String, HashSet<i64>)>,
}

/// Resolves a battle's character to a member through the Albion link.
///
/// Players usually carry no Albion id in the battle payload, so the character name is the
/// fallback key; the id wins whenever both sides have one.
struct Identity {
    by_albion_id: HashMap<String, i64>,
    by_name: HashMap<String, i64>,
}

impl Identity {
    fn new(users: &[user::Model], links: &[albion_link::Model]) -> Self {
        let by_discord: HashMap<&str, i64> = users
            .iter()
            .filter_map(|u| u.discord_id.as_deref().map(|discord| (discord, u.id)))
            .collect();
        let mut by_albion_id = HashMap::new();
        let mut by_name = HashMap::new();
        for link in links {
            if let Some(user_id) = by_discord.get(link.discord_id.as_str()) {
                by_albion_id.insert(link.albion_player_id.clone(), *user_id);
                by_name.insert(link.albion_player_name.to_ascii_lowercase(), *user_id);
            }
        }
        Self {
            by_albion_id,
            by_name,
        }
    }

    fn resolve(&self, player_id: Option<&str>, name: &str) -> Option<i64> {
        player_id
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .and_then(|id| self.by_albion_id.get(id).copied())
            .or_else(|| self.by_name.get(&name.to_ascii_lowercase()).copied())
    }
}

async fn collect_appearances(
    db: &DatabaseConnection,
    facts: &[FightFact],
    identity: &Identity,
) -> Result<Appearances, AppError> {
    let mut fight_of_battle: HashMap<i64, i64> = HashMap::new();
    for fact in facts {
        for battle_id in &fact.battle_ids {
            fight_of_battle.insert(*battle_id, fact.id);
        }
    }
    let battle_ids: Vec<i64> = fight_of_battle.keys().copied().collect();

    let mut appearances = Appearances::default();
    for chunk in chunks(&battle_ids) {
        for row in battle_player_stat::Entity::find()
            .filter(battle_player_stat::Column::BattleId.is_in(chunk))
            .filter(battle_player_stat::Column::IsFriendly.eq(true))
            .all(db)
            .await?
        {
            let Some(fight_id) = fight_of_battle.get(&row.battle_id).copied() else {
                continue;
            };
            let Some(user_id) = identity.resolve(row.player_id.as_deref(), &row.player_name) else {
                let entry = appearances
                    .unlinked
                    .entry(row.player_name.to_ascii_lowercase())
                    .or_insert_with(|| (row.player_name.clone(), HashSet::new()));
                entry.1.insert(fight_id);
                continue;
            };
            let line = appearances
                .by_user
                .entry(user_id)
                .or_default()
                .entry(fight_id)
                .or_default();
            line.kills += i64::from(row.kills);
            line.deaths += i64::from(row.deaths);
            line.kill_fame += row.kill_fame;
            line.death_fame += row.death_fame;
            if row.item_power > 0.0 {
                line.ip_sum += row.item_power;
                line.ip_count += 1;
            }
            if let Some(weapon) = row
                .main_hand_item_id
                .as_deref()
                .map(normalize_item_id)
                .filter(|weapon| !weapon.is_empty())
            {
                *line.weapons.entry(weapon).or_insert(0) += 1;
            }
            if let Some(role) = row
                .role
                .as_deref()
                .map(str::trim)
                .filter(|role| !role.is_empty() && *role != "unobserved")
            {
                *line.roles.entry(role.to_string()).or_insert(0) += 1;
            }
        }
    }
    Ok(appearances)
}

fn top_counts(counts: HashMap<String, i64>, limit: usize) -> Vec<(String, i64)> {
    let mut rows: Vec<(String, i64)> = counts.into_iter().collect();
    rows.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    rows.truncate(limit);
    rows
}

fn weapon_shares(counts: HashMap<String, i64>, limit: usize) -> Vec<WeaponShare> {
    top_counts(counts, limit)
        .into_iter()
        .map(|(weapon, count)| WeaponShare { weapon, count })
        .collect()
}

/// Builds one member's roster row from the fights they attended.
fn member_row(
    account: &user::Model,
    link: Option<&albion_link::Model>,
    lines: Option<&HashMap<i64, Appearance>>,
    facts_by_id: &HashMap<i64, &FightFact>,
    attendance_base: i64,
) -> RosterMember {
    let mut attended = Tally::default();
    let (mut kills, mut deaths, mut kill_fame, mut death_fame) = (0, 0, 0, 0);
    let (mut ip_sum, mut ip_count) = (0.0_f64, 0_i64);
    let mut weapons: HashMap<String, i64> = HashMap::new();
    let mut roles: HashMap<String, i64> = HashMap::new();
    let mut last: Option<&FightFact> = None;

    for (fight_id, line) in lines.into_iter().flatten() {
        let Some(&fact) = facts_by_id.get(fight_id) else {
            continue;
        };
        attended.add(fact);
        kills += line.kills;
        deaths += line.deaths;
        kill_fame += line.kill_fame;
        death_fame += line.death_fame;
        ip_sum += line.ip_sum;
        ip_count += line.ip_count;
        for (weapon, count) in &line.weapons {
            *weapons.entry(weapon.clone()).or_insert(0) += count;
        }
        for (role, count) in &line.roles {
            *roles.entry(role.clone()).or_insert(0) += count;
        }
        if last.is_none_or(|current| (fact.started_at, fact.id) > (current.started_at, current.id))
        {
            last = Some(fact);
        }
    }

    #[allow(clippy::cast_precision_loss)]
    let avg_item_power = (ip_count > 0).then(|| ip_sum / ip_count as f64);
    RosterMember {
        user_id: account.id,
        username: account.username.clone(),
        albion_name: link.map(|l| l.albion_player_name.clone()),
        role: account.role.clone(),
        is_officer: OFFICER_ROLES.contains(&account.role.as_str()),
        active: account.active,
        linked: link.is_some(),
        fights: attended.fights,
        attendance_rate: (attendance_base > 0)
            .then(|| ratio_percent(attended.fights, attendance_base)),
        wins: attended.wins,
        losses: attended.losses,
        draws: attended.draws,
        win_rate: attended.win_rate(),
        kills,
        deaths,
        kd_ratio: (attended.fights > 0).then(|| kill_death_ratio(kills, deaths)),
        kill_fame,
        death_fame,
        avg_item_power,
        weapons: weapon_shares(weapons, ROSTER_WEAPONS_LIMIT),
        main_role: top_counts(roles, 1).into_iter().next().map(|(role, _)| role),
        last_fight_at: last.map(|fact| fact.started_at.to_rfc3339()),
        last_fight_id: last.map(|fact| fact.id),
    }
}

/// The accounts and their Albion links.
struct People {
    users: Vec<user::Model>,
    links: Vec<albion_link::Model>,
}

impl People {
    async fn load(db: &DatabaseConnection) -> Result<Self, AppError> {
        Ok(Self {
            users: user::Entity::find().all(db).await?,
            links: albion_link::Entity::find().all(db).await?,
        })
    }

    fn link_of(&self, account: &user::Model) -> Option<&albion_link::Model> {
        let discord = account.discord_id.as_deref()?;
        self.links.iter().find(|link| link.discord_id == discord)
    }
}

/// Builds the roster. `only_user` restricts it to one member (the caller's own row).
pub async fn build_roster(
    db: &DatabaseConnection,
    window: &Window,
    only_user: Option<i64>,
) -> Result<IntelRoster, AppError> {
    let facts = load_facts(db, window, false).await?;
    let people = People::load(db).await?;
    let identity = Identity::new(&people.users, &people.links);
    let appearances = collect_appearances(db, &facts, &identity).await?;
    let facts_by_id: HashMap<i64, &FightFact> = facts.iter().map(|fact| (fact.id, fact)).collect();
    let base = tally_of(&facts).with_stats;

    let mut members: Vec<RosterMember> = people
        .users
        .iter()
        .filter(|account| only_user.is_none_or(|id| account.id == id))
        .map(|account| {
            member_row(
                account,
                people.link_of(account),
                appearances.by_user.get(&account.id),
                &facts_by_id,
                base,
            )
        })
        .filter(|member| only_user.is_some() || member.active || member.fights > 0)
        .collect();
    members.sort_by(|a, b| {
        b.fights
            .cmp(&a.fights)
            .then(b.kills.cmp(&a.kills))
            .then_with(|| a.username.cmp(&b.username))
    });

    let (scope, unlinked_players) = if only_user.is_some() {
        ("self", Vec::new())
    } else {
        let mut unlinked: Vec<UnlinkedPlayer> = appearances
            .unlinked
            .into_values()
            .map(|(name, fights)| UnlinkedPlayer {
                name,
                fights: i64::try_from(fights.len()).unwrap_or(i64::MAX),
            })
            .collect();
        unlinked.sort_by(|a, b| b.fights.cmp(&a.fights).then_with(|| a.name.cmp(&b.name)));
        unlinked.truncate(UNLINKED_LIMIT);
        ("all", unlinked)
    };

    Ok(IntelRoster {
        period: window.view(earliest_of(&facts)),
        total_fights: base,
        scope: scope.to_string(),
        members,
        unlinked_players,
    })
}

/// Builds one member's detail page. `None` when the member does not exist.
#[allow(clippy::too_many_lines)]
pub async fn build_player(
    db: &DatabaseConnection,
    window: &Window,
    user_id: i64,
) -> Result<Option<IntelPlayer>, AppError> {
    let facts = load_facts(db, window, true).await?;
    let people = People::load(db).await?;
    let Some(account) = people.users.iter().find(|u| u.id == user_id) else {
        return Ok(None);
    };
    let identity = Identity::new(&people.users, &people.links);
    let appearances = collect_appearances(db, &facts, &identity).await?;
    let facts_by_id: HashMap<i64, &FightFact> = facts.iter().map(|fact| (fact.id, fact)).collect();
    let base = tally_of(&facts).with_stats;
    let lines = appearances.by_user.get(&user_id);

    let member = member_row(account, people.link_of(account), lines, &facts_by_id, base);
    let names = comp_names(db, &facts).await?;

    // The fights this member attended, newest first.
    let attended: Vec<(&FightFact, &Appearance)> = facts
        .iter()
        .filter_map(|fact| {
            lines
                .and_then(|lines| lines.get(&fact.id))
                .map(|line| (fact, line))
        })
        .collect();

    let attended_facts: Vec<FightFact> = attended.iter().map(|(fact, _)| (*fact).clone()).collect();
    let tallies = weekly_tallies(&attended_facts);
    let mut kills_by_week: BTreeMap<i64, (i64, i64, i64)> = BTreeMap::new();
    for (fact, line) in &attended {
        let entry = kills_by_week
            .entry(week_start(fact.started_at).timestamp())
            .or_insert((0, 0, 0));
        entry.0 += line.kills;
        entry.1 += line.deaths;
        entry.2 += line.kill_fame;
    }
    let weekly: Vec<PlayerWeek> = week_axis(window, earliest_of(&facts))
        .into_iter()
        .map(|start| {
            let tally = tallies.get(&start.timestamp()).cloned().unwrap_or_default();
            let (kills, deaths, kill_fame) = kills_by_week
                .get(&start.timestamp())
                .copied()
                .unwrap_or_default();
            PlayerWeek {
                week_start: start.to_rfc3339(),
                fights: tally.fights,
                wins: tally.wins,
                losses: tally.losses,
                draws: tally.draws,
                kills,
                deaths,
                kill_fame,
            }
        })
        .collect();

    let fight_rows: Vec<PlayerFightRow> = attended
        .iter()
        .take(PLAYER_FIGHTS_LIMIT)
        .map(|(fact, line)| {
            let weapon = top_counts(line.weapons.clone(), 1)
                .into_iter()
                .next()
                .map(|(weapon, _)| weapon);
            let role = top_counts(line.roles.clone(), 1)
                .into_iter()
                .next()
                .map(|(role, _)| role);
            #[allow(clippy::cast_precision_loss)]
            let avg_item_power = (line.ip_count > 0).then(|| line.ip_sum / line.ip_count as f64);
            PlayerFightRow {
                fight_id: fact.id,
                started_at: fact.started_at.to_rfc3339(),
                event_title: fact.event_title.clone(),
                comp_id: fact.comp_id,
                comp_name: fact.comp_id.map(|id| comp_label(id, &names)),
                outcome: fact.outcome,
                opponent: fact.opponent.clone(),
                kills: line.kills,
                deaths: line.deaths,
                kill_fame: line.kill_fame,
                death_fame: line.death_fame,
                avg_item_power,
                weapon,
                role,
            }
        })
        .collect();

    let mut weapon_totals: HashMap<String, i64> = HashMap::new();
    let mut role_totals: HashMap<String, i64> = HashMap::new();
    for (_, line) in &attended {
        for (weapon, count) in &line.weapons {
            *weapon_totals.entry(weapon.clone()).or_insert(0) += count;
        }
        for (role, count) in &line.roles {
            *role_totals.entry(role.clone()).or_insert(0) += count;
        }
    }

    let mut by_comp: HashMap<i64, Tally> = HashMap::new();
    for (fact, _) in &attended {
        if let Some(comp_id) = fact.comp_id {
            by_comp.entry(comp_id).or_default().add(fact);
        }
    }
    let mut comps: Vec<PlayerCompUse> = by_comp
        .into_iter()
        .map(|(comp_id, tally)| PlayerCompUse {
            comp_id,
            name: comp_label(comp_id, &names),
            fights: tally.fights,
            wins: tally.wins,
            losses: tally.losses,
            draws: tally.draws,
        })
        .collect();
    comps.sort_by(|a, b| b.fights.cmp(&a.fights).then_with(|| a.name.cmp(&b.name)));

    let builds = build_usage(db, user_id, &attended_facts).await?;

    Ok(Some(IntelPlayer {
        period: window.view(earliest_of(&facts)),
        total_fights: base,
        member,
        weekly,
        fights: fight_rows,
        weapons: weapon_shares(weapon_totals, PLAYER_WEAPONS_LIMIT),
        roles: top_counts(role_totals, usize::MAX)
            .into_iter()
            .map(|(role, count)| RoleShare { role, count })
            .collect(),
        builds,
        comps,
    }))
}

/// The primary builds the member signed up with for events they then fought in.
async fn build_usage(
    db: &DatabaseConnection,
    user_id: i64,
    attended: &[FightFact],
) -> Result<Vec<BuildUse>, AppError> {
    let event_ids: Vec<i64> = {
        let mut ids: Vec<i64> = attended.iter().filter_map(|fact| fact.event_id).collect();
        ids.sort_unstable();
        ids.dedup();
        ids
    };
    let mut events_by_build: HashMap<i64, HashSet<i64>> = HashMap::new();
    for chunk in chunks(&event_ids) {
        for row in event_participation::Entity::find()
            .filter(event_participation::Column::UserId.eq(user_id))
            .filter(event_participation::Column::EventId.is_in(chunk))
            .all(db)
            .await?
        {
            if let Some(build_id) = row.primary_build_id {
                events_by_build
                    .entry(build_id)
                    .or_default()
                    .insert(row.event_id);
            }
        }
    }
    if events_by_build.is_empty() {
        return Ok(Vec::new());
    }
    let build_ids: Vec<i64> = events_by_build.keys().copied().collect();
    let mut rows: Vec<BuildUse> = build::Entity::find()
        .filter(build::Column::Id.is_in(build_ids))
        .all(db)
        .await?
        .into_iter()
        .map(|row| BuildUse {
            build_id: row.id,
            events: events_by_build
                .get(&row.id)
                .map_or(0, |events| i64::try_from(events.len()).unwrap_or(i64::MAX)),
            name: row.name,
            role: row.role,
        })
        .collect();
    rows.sort_by(|a, b| b.events.cmp(&a.events).then_with(|| a.name.cmp(&b.name)));
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use axum::{
        Extension,
        extract::{Path, Query},
    };
    use sea_orm::{ActiveModelTrait, ActiveValue::Set};

    use super::*;
    use backend_entities::albion::albion_link as link_entity;
    use backend_entities::auth::{role, role_permission};
    use backend_identity::auth::{Permission, Permissions, UserContext};

    fn ts(raw: &str) -> DateTimeWithTimeZone {
        raw.parse().expect("valid timestamp")
    }

    fn params(period: Option<&str>) -> PeriodParams {
        PeriodParams {
            period: period.map(str::to_string),
            from: None,
            to: None,
        }
    }

    // ---- period -------------------------------------------------------------------------

    #[test]
    fn period_defaults_to_thirty_days() {
        let now = ts("2026-11-12T12:00:00Z");
        let window = Window::resolve_at(now, &params(None)).unwrap();
        assert_eq!(window.key, "30d");
        assert_eq!(window.to - window.from.unwrap(), Duration::days(30));
    }

    #[test]
    fn period_all_has_no_lower_bound_and_no_previous() {
        let window = Window::resolve_at(ts("2026-11-12T12:00:00Z"), &params(Some("all"))).unwrap();
        assert!(window.from.is_none());
        assert!(window.previous().is_none());
    }

    #[test]
    fn period_rejects_unknown_values() {
        let err = Window::resolve_at(ts("2026-11-12T12:00:00Z"), &params(Some("3y"))).unwrap_err();
        assert!(format!("{err}").contains("unknown period"));
    }

    #[test]
    fn custom_range_wins_over_period_and_rejects_inversion() {
        let now = ts("2026-11-12T12:00:00Z");
        let custom = PeriodParams {
            period: Some("7d".to_string()),
            from: Some("2026-10-01T00:00:00Z".to_string()),
            to: Some("2026-10-10T00:00:00Z".to_string()),
        };
        let window = Window::resolve_at(now, &custom).unwrap();
        assert_eq!(window.key, "custom");
        assert_eq!(window.to, ts("2026-10-10T00:00:00Z"));

        let inverted = PeriodParams {
            period: None,
            from: Some("2026-10-10T00:00:00Z".to_string()),
            to: Some("2026-10-01T00:00:00Z".to_string()),
        };
        assert!(Window::resolve_at(now, &inverted).is_err());
    }

    #[test]
    fn previous_window_has_equal_length_and_does_not_overlap() {
        let window = Window::resolve_at(ts("2026-11-12T12:00:00Z"), &params(Some("7d"))).unwrap();
        let previous = window.previous().unwrap();
        assert_eq!(
            previous.to - previous.from.unwrap(),
            window.to - window.from.unwrap()
        );
        assert!(previous.to < window.from.unwrap());
    }

    #[test]
    fn week_axis_covers_every_week_including_quiet_ones() {
        let window = Window {
            from: Some(ts("2026-11-02T10:00:00Z")),
            to: ts("2026-11-18T10:00:00Z"),
            key: "custom",
        };
        // Mon Nov 2, Nov 9, Nov 16.
        assert_eq!(week_axis(&window, None).len(), 3);
    }

    #[test]
    fn week_start_is_monday_midnight_utc() {
        assert_eq!(
            week_start(ts("2026-11-12T15:30:00Z")).to_rfc3339(),
            ts("2026-11-09T00:00:00Z").to_rfc3339()
        );
    }

    // ---- tally --------------------------------------------------------------------------

    fn fact(outcome: BattleOutcome, stats: Option<(i64, i64, i64)>) -> FightFact {
        FightFact {
            id: 1,
            started_at: ts("2026-11-10T20:00:00Z"),
            event_id: None,
            event_title: None,
            comp_id: None,
            outcome,
            segments: 1,
            battle_ids: vec![1],
            stats: stats.map(|(players, kills, deaths)| StatsFact {
                players,
                enemy_players: 10,
                kills,
                deaths,
                kill_fame: kills * 1_000,
                death_fame: deaths * 1_000,
                item_power: 1_200.0,
                enemy_item_power: 1_100.0,
                loss: deaths * 10_000,
            }),
            opponent: None,
        }
    }

    #[test]
    fn empty_tally_has_no_rates_rather_than_zero() {
        let totals = Tally::default().totals(true);
        assert_eq!(totals.fights, 0);
        assert!(totals.win_rate.is_none());
        assert!(totals.kd_ratio.is_none());
        assert!(totals.avg_players.is_none());
        assert!(totals.avg_item_power.is_none());
        assert_eq!(totals.estimated_silver_lost, Some(0));
    }

    #[test]
    fn unknown_outcomes_are_not_losses() {
        let facts = [
            fact(BattleOutcome::Victory, Some((20, 10, 2))),
            fact(BattleOutcome::Defeat, Some((22, 4, 8))),
            fact(BattleOutcome::Unknown, None),
        ];
        let totals = tally_of(&facts).totals(false);
        assert_eq!(totals.fights, 3);
        assert_eq!(totals.decided, 2);
        assert_eq!(totals.unknown, 1);
        assert_eq!(totals.win_rate, Some(50.0));
        assert_eq!(totals.fights_with_stats, 2);
        assert_eq!(totals.kills, 14);
        assert_eq!(totals.deaths, 10);
        assert_eq!(totals.avg_players, Some(21.0));
        assert_eq!(totals.kd_ratio, Some(1.4));
        assert!(totals.estimated_silver_lost.is_none());
    }

    #[test]
    fn best_matchup_needs_a_winning_record_and_worst_a_losing_one() {
        let record = |opponent: &str, wins: i64, losses: i64| OpponentRecord {
            opponent: opponent.to_string(),
            fights: wins + losses,
            wins,
            losses,
            draws: 0,
            win_rate: Some(ratio_percent(wins, wins + losses)),
        };
        let (best, worst) = best_and_worst(&[
            record("A", 3, 1),
            record("B", 1, 3),
            record("C", 2, 2),
            record("D", 5, 0),
        ]);
        assert_eq!(best.unwrap().opponent, "D");
        assert_eq!(worst.unwrap().opponent, "B");

        let (best, worst) = best_and_worst(&[record("C", 2, 2)]);
        assert!(best.is_none() && worst.is_none());
    }

    // ---- database -----------------------------------------------------------------------

    async fn seed_db() -> DatabaseConnection {
        backend_migration::testkit::migrated_sqlite().await
    }

    async fn insert_user(db: &DatabaseConnection, name: &str, discord: Option<&str>) -> i64 {
        user::ActiveModel {
            username: Set(name.to_string()),
            email: Set(format!("{name}@example.com")),
            role: Set("User".to_string()),
            discord_id: Set(discord.map(str::to_string)),
            created_at: Set(ts("2026-01-01T00:00:00Z")),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert user")
        .id
    }

    async fn link(db: &DatabaseConnection, discord: &str, albion_id: &str, name: &str) {
        link_entity::ActiveModel {
            discord_id: Set(discord.to_string()),
            albion_player_id: Set(albion_id.to_string()),
            albion_player_name: Set(name.to_string()),
            linked_at: Set(ts("2026-01-01T00:00:00Z")),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert link");
    }

    async fn insert_comp(db: &DatabaseConnection, name: &str, owner: i64) -> i64 {
        let category = backend_entities::comps::comp_category::ActiveModel {
            name: Set(format!("cat-{name}")),
            slug: Set(format!("cat-{name}")),
            created_at: Set(ts("2026-01-01T00:00:00Z")),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert category")
        .id;
        comp::ActiveModel {
            name: Set(name.to_string()),
            category_id: Set(category),
            version: Set(1),
            created_by: Set(owner),
            created_at: Set(ts("2026-01-01T00:00:00Z")),
            updated_at: Set(ts("2026-01-01T00:00:00Z")),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert comp")
        .id
    }

    async fn insert_event(db: &DatabaseConnection, title: &str, comp_id: i64, owner: i64) -> i64 {
        event::ActiveModel {
            title: Set(title.to_string()),
            comp_id: Set(Some(comp_id)),
            created_by: Set(owner),
            event_date_utc: Set(ts("2026-01-01T00:00:00Z")),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert event")
        .id
    }

    struct Seed<'a> {
        db: &'a DatabaseConnection,
        started_at: &'a str,
        outcome: &'a str,
        event_id: Option<i64>,
        battle_id: i64,
        opponent: &'a str,
        players: i32,
        kills: i64,
        deaths: i64,
    }

    /// One fight with one segment, its rollup, an enemy guild row and two friendly players.
    async fn seed_fight(seed: Seed<'_>) -> i64 {
        let db = seed.db;
        let fight_id = fight::ActiveModel {
            started_at: Set(ts(seed.started_at)),
            outcome: Set(seed.outcome.to_string()),
            event_id: Set(seed.event_id),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert fight")
        .id;
        fight_battle::ActiveModel {
            fight_id: Set(fight_id),
            battle_id: Set(seed.battle_id),
            sequence_number: Set(1),
            created_at: Set(ts(seed.started_at)),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert fight battle");
        fight_stat::ActiveModel {
            fight_id: Set(fight_id),
            segment_count: Set(1),
            unique_friendly_players: Set(seed.players),
            unique_enemy_players: Set(30),
            friendly_kills: Set(seed.kills),
            friendly_deaths: Set(seed.deaths),
            friendly_kill_fame: Set(seed.kills * 1_000),
            enemy_kills: Set(seed.deaths),
            enemy_deaths: Set(seed.kills),
            enemy_kill_fame: Set(seed.deaths * 1_000),
            avg_friendly_item_power: Set(1_300.0),
            avg_enemy_item_power: Set(1_200.0),
            friendly_estimated_loss: Set(seed.deaths * 100_000),
            enemy_estimated_loss: Set(0),
            computed_at: Set(ts(seed.started_at)),
            created_at: Set(ts(seed.started_at)),
            updated_at: Set(ts(seed.started_at)),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert fight stat");
        battle_guild_stat::ActiveModel {
            battle_id: Set(seed.battle_id),
            guild_id: Set(format!("enemy-{}", seed.opponent)),
            guild_name: Set(seed.opponent.to_string()),
            is_friendly: Set(false),
            players: Set(30),
            kills: Set(seed.deaths as i32),
            deaths: Set(seed.kills as i32),
            kill_fame: Set(seed.deaths * 1_000),
            avg_item_power: Set(1_200.0),
            winner: Set(seed.outcome == "defeat"),
            created_at: Set(ts(seed.started_at)),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert guild stat");
        fight_id
    }

    async fn seed_player(
        db: &DatabaseConnection,
        battle_id: i64,
        name: &str,
        friendly: bool,
        kills: i32,
        deaths: i32,
    ) {
        battle_player_stat::ActiveModel {
            battle_id: Set(battle_id),
            player_key: Set(format!("name:{}", name.to_ascii_lowercase())),
            player_id: Set(None),
            player_name: Set(name.to_string()),
            identity_source: Set("name_only".to_string()),
            guild_id: Set("g".to_string()),
            guild_name: Set("Ours".to_string()),
            is_friendly: Set(friendly),
            kills: Set(kills),
            deaths: Set(deaths),
            kill_fame: Set(i64::from(kills) * 1_000),
            death_fame: Set(i64::from(deaths) * 1_000),
            item_power: Set(1_300.0),
            main_hand_item_id: Set(Some("T8_MAIN_SWORD@2".to_string())),
            role: Set(Some("dps".to_string())),
            role_confidence: Set(Some("heuristic".to_string())),
            created_at: Set(ts("2026-11-01T00:00:00Z")),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert player stat");
    }

    fn at(now: &str, period: &str) -> Window {
        Window::resolve_at(ts(now), &params(Some(period))).unwrap()
    }

    #[tokio::test]
    async fn overview_of_an_empty_tenant_reports_no_data_not_zero_rates() {
        let db = seed_db().await;
        let overview = build_overview(&db, &at("2026-11-12T12:00:00Z", "30d"), true)
            .await
            .unwrap();
        assert_eq!(overview.current.fights, 0);
        assert!(overview.current.win_rate.is_none());
        assert!(overview.previous.as_ref().unwrap().win_rate.is_none());
        assert!(overview.recent_fights.is_empty());
        assert!(overview.top_opponents.is_empty());
        // Quiet weeks are still on the axis so the chart has a shape.
        assert!(!overview.weekly.is_empty());
        assert!(overview.weekly.iter().all(|week| week.fights == 0));
    }

    #[tokio::test]
    async fn overview_aggregates_the_period_and_compares_with_the_previous_one() {
        let db = seed_db().await;
        // Current 7 days: 2 wins, 1 loss. Previous 7 days: 1 loss.
        for (battle, started, outcome, kills, deaths) in [
            (1, "2026-11-11T20:00:00Z", "victory", 20, 5),
            (2, "2026-11-10T20:00:00Z", "victory", 15, 10),
            (3, "2026-11-09T20:00:00Z", "defeat", 5, 15),
            (4, "2026-11-03T20:00:00Z", "defeat", 2, 20),
        ] {
            seed_fight(Seed {
                db: &db,
                started_at: started,
                outcome,
                event_id: None,
                battle_id: battle,
                opponent: "Rivals",
                players: 20,
                kills,
                deaths,
            })
            .await;
        }

        let overview = build_overview(&db, &at("2026-11-12T12:00:00Z", "7d"), true)
            .await
            .unwrap();
        assert_eq!(overview.current.fights, 3);
        assert_eq!(overview.current.wins, 2);
        assert_eq!(overview.current.losses, 1);
        assert_eq!(overview.current.kills, 40);
        assert_eq!(overview.current.deaths, 30);
        assert_eq!(overview.current.win_rate.map(f64::round), Some(67.0));
        assert_eq!(overview.current.avg_players, Some(20.0));
        assert_eq!(overview.current.estimated_silver_lost, Some(3_000_000));
        let previous = overview.previous.unwrap();
        assert_eq!(previous.fights, 1);
        assert_eq!(previous.win_rate, Some(0.0));
        assert_eq!(overview.recent_fights.len(), 3);
        assert_eq!(overview.recent_fights[0].started_at, ts("2026-11-11T20:00:00Z").to_rfc3339());
        assert_eq!(overview.top_opponents[0].opponent, "Rivals");
        assert_eq!(overview.top_opponents[0].fights, 3);
    }

    #[tokio::test]
    async fn silver_lost_is_withheld_without_the_financial_permission() {
        let db = seed_db().await;
        seed_fight(Seed {
            db: &db,
            started_at: "2026-11-11T20:00:00Z",
            outcome: "victory",
            event_id: None,
            battle_id: 1,
            opponent: "Rivals",
            players: 20,
            kills: 10,
            deaths: 2,
        })
        .await;
        let overview = build_overview(&db, &at("2026-11-12T12:00:00Z", "7d"), false)
            .await
            .unwrap();
        assert!(overview.current.estimated_silver_lost.is_none());
        assert!(overview.recent_fights[0].estimated_silver_lost.is_none());
    }

    #[tokio::test]
    async fn fights_are_filtered_by_outcome_opponent_comp_and_size() {
        let db = seed_db().await;
        let owner = insert_user(&db, "owner", None).await;
        let comp_id = insert_comp(&db, "Frontline", owner).await;
        let event_id = insert_event(&db, "ZvZ night", comp_id, owner).await;
        seed_fight(Seed {
            db: &db,
            started_at: "2026-11-11T20:00:00Z",
            outcome: "victory",
            event_id: Some(event_id),
            battle_id: 1,
            opponent: "Alpha Guild",
            players: 40,
            kills: 30,
            deaths: 5,
        })
        .await;
        seed_fight(Seed {
            db: &db,
            started_at: "2026-11-10T20:00:00Z",
            outcome: "defeat",
            event_id: None,
            battle_id: 2,
            opponent: "Beta Guild",
            players: 10,
            kills: 2,
            deaths: 9,
        })
        .await;

        let base = FightsQuery {
            period: Some("30d".to_string()),
            from: None,
            to: None,
            outcome: None,
            opponent: None,
            comp_id: None,
            min_players: None,
            max_players: None,
            sort: None,
            order: None,
            page: None,
            limit: None,
        };
        // `build_fights` resolves "now" itself, so anchor the fixtures to a custom window.
        let all = FightsQuery {
            period: None,
            from: Some("2026-11-01T00:00:00Z".to_string()),
            to: Some("2026-11-12T00:00:00Z".to_string()),
            ..base.clone()
        };
        let listed = build_fights(&db, &all, true).await.unwrap();
        assert_eq!(listed.total_items, 2);
        assert_eq!(listed.items[0].fight_id, 1, "newest first by default");
        assert_eq!(listed.items[0].comp_name.as_deref(), Some("Frontline"));
        assert_eq!(listed.items[0].opponent.as_deref(), Some("Alpha Guild"));
        assert_eq!(listed.summary.fights, 2);
        assert_eq!(listed.comps.len(), 1);
        assert_eq!(listed.opponents.len(), 2);

        let wins = build_fights(
            &db,
            &FightsQuery {
                outcome: Some("victory".to_string()),
                ..all.clone()
            },
            true,
        )
        .await
        .unwrap();
        assert_eq!(wins.total_items, 1);
        assert_eq!(wins.summary.wins, 1);
        // The filter options stay unfiltered so the dropdowns do not collapse.
        assert_eq!(wins.opponents.len(), 2);

        let by_opponent = build_fights(
            &db,
            &FightsQuery {
                opponent: Some("beta".to_string()),
                ..all.clone()
            },
            true,
        )
        .await
        .unwrap();
        assert_eq!(by_opponent.items.len(), 1);
        assert_eq!(by_opponent.items[0].fight_id, 2);

        let by_comp = build_fights(
            &db,
            &FightsQuery {
                comp_id: Some(comp_id),
                ..all.clone()
            },
            true,
        )
        .await
        .unwrap();
        assert_eq!(by_comp.total_items, 1);

        let large = build_fights(
            &db,
            &FightsQuery {
                min_players: Some(30),
                ..all.clone()
            },
            true,
        )
        .await
        .unwrap();
        assert_eq!(large.total_items, 1);
        assert_eq!(large.items[0].fight_id, 1);

        let none = build_fights(
            &db,
            &FightsQuery {
                outcome: Some("draw".to_string()),
                ..all.clone()
            },
            true,
        )
        .await
        .unwrap();
        assert_eq!(none.total_items, 0);
        assert!(none.summary.win_rate.is_none());

        let bad = build_fights(
            &db,
            &FightsQuery {
                outcome: Some("flawless".to_string()),
                ..all
            },
            true,
        )
        .await;
        assert!(bad.is_err());
    }

    #[tokio::test]
    async fn comps_carry_record_and_best_and_worst_matchups() {
        let db = seed_db().await;
        let owner = insert_user(&db, "owner", None).await;
        let comp_id = insert_comp(&db, "Frontline", owner).await;
        let event_id = insert_event(&db, "ZvZ night", comp_id, owner).await;
        for (battle, started, outcome, opponent) in [
            (1, "2026-11-11T20:00:00Z", "victory", "Alpha"),
            (2, "2026-11-10T20:00:00Z", "victory", "Alpha"),
            (3, "2026-11-09T20:00:00Z", "defeat", "Beta"),
            (4, "2026-11-08T20:00:00Z", "victory", "Beta"),
            (5, "2026-11-07T20:00:00Z", "defeat", "Beta"),
        ] {
            seed_fight(Seed {
                db: &db,
                started_at: started,
                outcome,
                event_id: Some(event_id),
                battle_id: battle,
                opponent,
                players: 20,
                kills: 10,
                deaths: 5,
            })
            .await;
        }
        // One fight with no event: counted as unattributed, in no comp row.
        seed_fight(Seed {
            db: &db,
            started_at: "2026-11-06T20:00:00Z",
            outcome: "victory",
            event_id: None,
            battle_id: 6,
            opponent: "Gamma",
            players: 20,
            kills: 10,
            deaths: 5,
        })
        .await;

        let window = Window::resolve_at(
            ts("2026-11-12T12:00:00Z"),
            &PeriodParams {
                period: None,
                from: Some("2026-11-01T00:00:00Z".to_string()),
                to: Some("2026-11-12T00:00:00Z".to_string()),
            },
        )
        .unwrap();
        let comps = build_comps(&db, &window, false).await.unwrap();
        assert_eq!(comps.total_fights, 6);
        assert_eq!(comps.unattributed_fights, 1);
        assert_eq!(comps.comps.len(), 1);
        let usage = &comps.comps[0];
        assert_eq!(usage.name, "Frontline");
        assert_eq!(usage.events, 1);
        assert_eq!(usage.totals.fights, 5);
        assert_eq!(usage.totals.wins, 3);
        assert_eq!(usage.best_matchup.as_ref().unwrap().opponent, "Alpha");
        // Beta is 1-2 against us: the only losing matchup.
        assert_eq!(usage.worst_matchup.as_ref().unwrap().opponent, "Beta");
        assert_eq!(usage.matchups.len(), 2);
        assert!(usage.totals.estimated_silver_lost.is_none());
    }

    #[tokio::test]
    async fn roster_counts_attendance_per_member_and_lists_unlinked_characters() {
        let db = seed_db().await;
        let alice = insert_user(&db, "alice", Some("d-alice")).await;
        let _bob = insert_user(&db, "bob", Some("d-bob")).await;
        link(&db, "d-alice", "a-1", "AliceInGame").await;
        link(&db, "d-bob", "a-2", "BobInGame").await;

        for (battle, started, outcome) in [
            (1, "2026-11-11T20:00:00Z", "victory"),
            (2, "2026-11-10T20:00:00Z", "defeat"),
        ] {
            seed_fight(Seed {
                db: &db,
                started_at: started,
                outcome,
                event_id: None,
                battle_id: battle,
                opponent: "Rivals",
                players: 2,
                kills: 6,
                deaths: 2,
            })
            .await;
            seed_player(&db, battle, "AliceInGame", true, 4, 1).await;
            seed_player(&db, battle, "Stranger", true, 2, 1).await;
            // An enemy line must never be attributed to anyone.
            seed_player(&db, battle, "BobInGame", false, 9, 9).await;
        }

        let window = Window::resolve_at(
            ts("2026-11-12T12:00:00Z"),
            &PeriodParams {
                period: None,
                from: Some("2026-11-01T00:00:00Z".to_string()),
                to: Some("2026-11-12T00:00:00Z".to_string()),
            },
        )
        .unwrap();
        let roster = build_roster(&db, &window, None).await.unwrap();
        assert_eq!(roster.scope, "all");
        assert_eq!(roster.total_fights, 2);
        let row = roster.members.iter().find(|m| m.user_id == alice).unwrap();
        assert_eq!(row.fights, 2);
        assert_eq!(row.attendance_rate, Some(100.0));
        assert_eq!(row.kills, 8);
        assert_eq!(row.deaths, 2);
        assert_eq!(row.kd_ratio, Some(4.0));
        assert_eq!(row.wins, 1);
        assert_eq!(row.losses, 1);
        assert_eq!(row.win_rate, Some(50.0));
        assert_eq!(row.avg_item_power, Some(1_300.0));
        assert_eq!(row.weapons[0].weapon, "MAIN_SWORD");
        assert_eq!(row.main_role.as_deref(), Some("dps"));
        assert!(row.linked);
        let bob = roster.members.iter().find(|m| m.username == "bob").unwrap();
        assert_eq!(bob.fights, 0, "an enemy-side line is not Bob's");
        assert_eq!(bob.attendance_rate, Some(0.0));
        assert!(bob.kd_ratio.is_none());
        assert_eq!(roster.unlinked_players.len(), 1);
        assert_eq!(roster.unlinked_players[0].name, "Stranger");
        assert_eq!(roster.unlinked_players[0].fights, 2);

        let mine = build_roster(&db, &window, Some(alice)).await.unwrap();
        assert_eq!(mine.scope, "self");
        assert_eq!(mine.members.len(), 1);
        assert_eq!(mine.members[0].user_id, alice);
        assert!(mine.unlinked_players.is_empty());
    }

    #[tokio::test]
    async fn player_detail_lists_fights_weekly_activity_and_comps() {
        let db = seed_db().await;
        let alice = insert_user(&db, "alice", Some("d-alice")).await;
        link(&db, "d-alice", "a-1", "AliceInGame").await;
        let comp_id = insert_comp(&db, "Frontline", alice).await;
        let event_id = insert_event(&db, "ZvZ night", comp_id, alice).await;
        seed_fight(Seed {
            db: &db,
            started_at: "2026-11-11T20:00:00Z",
            outcome: "victory",
            event_id: Some(event_id),
            battle_id: 1,
            opponent: "Rivals",
            players: 1,
            kills: 4,
            deaths: 1,
        })
        .await;
        seed_player(&db, 1, "AliceInGame", true, 4, 1).await;

        let window = Window::resolve_at(
            ts("2026-11-12T12:00:00Z"),
            &PeriodParams {
                period: None,
                from: Some("2026-10-26T00:00:00Z".to_string()),
                to: Some("2026-11-12T00:00:00Z".to_string()),
            },
        )
        .unwrap();
        let detail = build_player(&db, &window, alice).await.unwrap().unwrap();
        assert_eq!(detail.member.fights, 1);
        assert_eq!(detail.fights.len(), 1);
        assert_eq!(detail.fights[0].comp_name.as_deref(), Some("Frontline"));
        assert_eq!(detail.fights[0].weapon.as_deref(), Some("MAIN_SWORD"));
        assert_eq!(detail.comps.len(), 1);
        assert_eq!(detail.comps[0].wins, 1);
        // Oct 26, Nov 2, Nov 9: three weeks, one of them with the fight.
        assert_eq!(detail.weekly.len(), 3);
        assert_eq!(detail.weekly.iter().map(|w| w.fights).sum::<i64>(), 1);
        assert_eq!(detail.weekly.iter().map(|w| w.kills).sum::<i64>(), 4);
        assert!(build_player(&db, &window, 9_999).await.unwrap().is_none());
    }

    // ---- handlers and permissions -------------------------------------------------------

    /// Creates a role holding `permissions` and returns the name a session carries for it.
    async fn grant(db: &DatabaseConnection, role_id: &str, permissions: &[Permission]) -> String {
        let name = format!("Test {role_id}");
        role::ActiveModel {
            id: Set(role_id.to_string()),
            name: Set(name.clone()),
            priority: Set(50),
            discord_role_id: Set(Some(format!("discord-{role_id}"))),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert role");
        for permission in permissions {
            role_permission::ActiveModel {
                role_id: Set(role_id.to_string()),
                permission: Set(permission.as_str().to_string()),
            }
            .insert(db)
            .await
            .expect("insert role permission");
        }
        name
    }

    fn account(user_id: i64, role_name: &str) -> UserContext {
        UserContext {
            id: format!("discord-{user_id}"),
            username: format!("Member {user_id}"),
            email: None,
            avatar: None,
            roles: vec![role_name.to_string()],
            highest_role: role_name.to_string(),
            user_id,
            super_admin_id: None,
            is_tenant_owner: false,
        }
    }

    async fn permissions(db: &DatabaseConnection) -> Permissions {
        let perms = Permissions::new_empty();
        perms.reload(db).await.expect("load permissions");
        perms
    }

    #[tokio::test]
    async fn every_intel_view_is_refused_without_intel_view() {
        let db = seed_db().await;
        let nobody = grant(&db, "nobody", &[]).await;
        let perms = permissions(&db).await;
        let user = || account(1, &nobody);
        let period = || Query(params(Some("30d")));

        let overview = crate::router::overview(
            user(),
            Extension(perms.clone()),
            Extension(db.clone()),
            period(),
        )
        .await;
        assert!(matches!(overview, Err(AppError::Forbidden(_))));
        let comps = crate::router::our_comps(
            user(),
            Extension(perms.clone()),
            Extension(db.clone()),
            period(),
        )
        .await;
        assert!(matches!(comps, Err(AppError::Forbidden(_))));
        let roster = crate::router::roster(
            user(),
            Extension(perms.clone()),
            Extension(db.clone()),
            period(),
        )
        .await;
        assert!(matches!(roster, Err(AppError::Forbidden(_))));
        let own_page = crate::router::roster_member(
            user(),
            Extension(perms),
            Extension(db),
            Path(1),
            period(),
        )
        .await;
        assert!(matches!(own_page, Err(AppError::Forbidden(_))));
    }

    #[tokio::test]
    async fn members_see_only_their_own_player_and_officers_see_everyone() {
        let db = seed_db().await;
        let alice = insert_user(&db, "alice", Some("d-alice")).await;
        let bob = insert_user(&db, "bob", Some("d-bob")).await;
        let member = grant(&db, "member", &[Permission::IntelView]).await;
        let officer = grant(
            &db,
            "officer",
            &[Permission::IntelView, Permission::IntelReportView],
        )
        .await;
        let perms = permissions(&db).await;
        let period = || Query(params(Some("30d")));

        let mine = crate::router::roster(
            account(alice, &member),
            Extension(perms.clone()),
            Extension(db.clone()),
            period(),
        )
        .await
        .unwrap();
        assert_eq!(mine.0.data.scope, "self");
        assert_eq!(mine.0.data.members.len(), 1);
        assert_eq!(mine.0.data.members[0].user_id, alice);

        let everyone = crate::router::roster(
            account(alice, &officer),
            Extension(perms.clone()),
            Extension(db.clone()),
            period(),
        )
        .await
        .unwrap();
        assert_eq!(everyone.0.data.scope, "all");
        assert_eq!(everyone.0.data.members.len(), 2);

        let own_page = crate::router::roster_member(
            account(alice, &member),
            Extension(perms.clone()),
            Extension(db.clone()),
            Path(alice),
            period(),
        )
        .await;
        assert!(own_page.is_ok());
        let someone_elses = crate::router::roster_member(
            account(alice, &member),
            Extension(perms.clone()),
            Extension(db.clone()),
            Path(bob),
            period(),
        )
        .await;
        assert!(matches!(someone_elses, Err(AppError::Forbidden(_))));
        let as_officer = crate::router::roster_member(
            account(alice, &officer),
            Extension(perms.clone()),
            Extension(db.clone()),
            Path(bob),
            period(),
        )
        .await;
        assert!(as_officer.is_ok());
        let missing = crate::router::roster_member(
            account(alice, &officer),
            Extension(perms),
            Extension(db),
            Path(9_999),
            period(),
        )
        .await;
        assert!(matches!(missing, Err(AppError::NotFound(_))));
    }

    #[tokio::test]
    async fn silver_lost_reaches_officers_only() {
        let db = seed_db().await;
        let member = grant(&db, "member", &[Permission::IntelView]).await;
        let officer = grant(
            &db,
            "officer",
            &[Permission::IntelView, Permission::IntelReportView],
        )
        .await;
        let perms = permissions(&db).await;
        seed_fight(Seed {
            db: &db,
            started_at: &(chrono::Utc::now() - Duration::days(1)).to_rfc3339(),
            outcome: "victory",
            event_id: None,
            battle_id: 1,
            opponent: "Rivals",
            players: 20,
            kills: 10,
            deaths: 2,
        })
        .await;

        let as_member = crate::router::overview(
            account(1, &member),
            Extension(perms.clone()),
            Extension(db.clone()),
            Query(params(Some("7d"))),
        )
        .await
        .unwrap();
        assert_eq!(as_member.0.data.current.fights, 1);
        assert!(as_member.0.data.current.estimated_silver_lost.is_none());
        assert!(as_member.0.data.recent_fights[0].estimated_silver_lost.is_none());

        let as_officer = crate::router::overview(
            account(1, &officer),
            Extension(perms),
            Extension(db),
            Query(params(Some("7d"))),
        )
        .await
        .unwrap();
        assert_eq!(as_officer.0.data.current.estimated_silver_lost, Some(200_000));
    }

    #[tokio::test]
    async fn an_unknown_period_is_a_validation_error_not_a_default() {
        let db = seed_db().await;
        let member = grant(&db, "member", &[Permission::IntelView]).await;
        let perms = permissions(&db).await;
        let result = crate::router::overview(
            account(1, &member),
            Extension(perms),
            Extension(db),
            Query(params(Some("yesterday"))),
        )
        .await;
        assert!(matches!(result, Err(AppError::Validation(_))));
    }
}
