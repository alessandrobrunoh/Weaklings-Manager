//! The guild report: one aggregate behind every Intel dashboard tab.
//!
//! # Shape of the computation
//!
//! Everything is derived from a **single bulk load**: one query per table,
//! range-filtered, then folded in memory. There is deliberately no `find_by_id`
//! inside any loop — the report spans a dozen tables and an N+1 here would turn
//! an officer's dashboard into a minute-long query storm.
//!
//! # What the data can and cannot tell us
//!
//! Two limits are surfaced rather than smoothed over, because a number that
//! quietly means something narrower than it appears is worse than no number:
//!
//! - **Attribution.** A battle only maps to one of our comps through an event.
//!   Battles picked up by the background sync and never linked contribute to
//!   performance totals but not to per-comp records, so both counts are
//!   reported.
//! - **Character linking.** Snapshot-derived per-member figures join on Albion
//!   character *name*, resolved through `albion_links`. Members who never
//!   linked are invisible to those columns, so they are listed explicitly.
//!
//! The reference implementation also had a per-map breakdown. AlbionBB does not
//! carry a map or zone for a battle anywhere in this pipeline, so that view is
//! replaced by an hour-of-day histogram, which the data does support.

use std::collections::{HashMap, HashSet};

use rust_decimal::prelude::ToPrimitive;
use sea_orm::prelude::{DateTimeWithTimeZone, Decimal};
use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::errors::AppError;
use crate::modules::albion::entities::albion_link;
use crate::modules::bank::entities as transaction;
use crate::modules::battles::entities as snapshot;
use crate::modules::battles::models::{
    BattleGuildSummary, BattleKillEvent, BattleLossEstimate, BattlePlayer,
};
use crate::modules::comps::entities::{build, comp, comp_build};
use crate::modules::events::entities::{event, event_battle, event_participation};
use crate::modules::events::service::{kill_death_ratio, ratio_percent, BattleLinkingContext};
use crate::modules::intel::entities::{scouted_comp, scouted_comp_battle};
use crate::modules::intel::matchups::{best_counter, matchups, MatchupRow};
use crate::modules::intel::roles::{normalize_item_id, RoleClassifier};
use crate::modules::intel::scout::weapons_by_player;
use crate::modules::intel::service::our_comp_profiles;
use crate::modules::intel::similarity::ROLE_KEYS;
use crate::modules::regear::entities as regear;
use crate::modules::siphoned::entities as siphoned;
use crate::modules::splits::entities::{split, split_participant};
use crate::modules::users::entities as user;

/// Default window when the caller does not supply one.
const DEFAULT_WINDOW_DAYS: i64 = 30;
/// Entries kept in the activity timeline.
const TIMELINE_LIMIT: usize = 20;
/// Weapons kept in each meta distribution.
const META_LIMIT: usize = 12;
/// A win is worth this much in the fight score, a loss the same against.
const FIGHT_SCORE_OUTCOME: i64 = 8;
/// Kill fame per point contributed to the fight score.
const FIGHT_SCORE_FAME_UNIT: i64 = 200_000;

/// Inclusive time window the report covers.
#[derive(Debug, Clone, Copy)]
pub struct DateRange {
    pub from: DateTimeWithTimeZone,
    pub to: DateTimeWithTimeZone,
}

impl DateRange {
    /// Parses RFC 3339 bounds, defaulting to the last 30 days.
    pub fn resolve(from: Option<&str>, to: Option<&str>) -> Result<Self, AppError> {
        let to = match to {
            Some(raw) => parse_ts(raw, "to")?,
            None => chrono::Utc::now().into(),
        };
        let from = match from {
            Some(raw) => parse_ts(raw, "from")?,
            None => to - chrono::Duration::days(DEFAULT_WINDOW_DAYS),
        };
        if from > to {
            return Err(AppError::Validation(
                "`from` must not be after `to`".to_string(),
            ));
        }
        Ok(Self { from, to })
    }
}

fn parse_ts(raw: &str, field: &str) -> Result<DateTimeWithTimeZone, AppError> {
    raw.parse()
        .map_err(|_| AppError::Validation(format!("`{field}` must be an RFC 3339 timestamp")))
}

/// Query parameters for the report endpoints.
#[derive(Debug, Clone, Deserialize, IntoParams)]
pub struct ReportParams {
    /// Window start, RFC 3339. Defaults to 30 days before `to`.
    pub from: Option<String>,
    /// Window end, RFC 3339. Defaults to now.
    pub to: Option<String>,
}

/// Headline combat performance.
#[derive(Debug, Clone, Default, Serialize, ToSchema)]
pub struct ReportOverview {
    pub fights: i64,
    pub wins: i64,
    pub losses: i64,
    pub win_rate: f64,
    pub kills: i64,
    pub deaths: i64,
    pub kill_death_ratio: f64,
    pub kill_fame: i64,
    pub silver_lost: i64,
    pub avg_item_power: f64,
    pub enemy_avg_item_power: f64,
    /// Our average item power minus theirs; negative means we field lighter.
    pub item_power_delta: f64,
    /// Consecutive wins counting back from the most recent fight.
    pub win_streak: i64,
    pub best_fight: Option<FightSummary>,
    pub worst_fight: Option<FightSummary>,
    /// Fights that could be attributed to one of our comps via an event.
    pub attributed_fights: i64,
}

/// One battle, scored so the best and worst can be surfaced.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct FightSummary {
    pub battle_id: i64,
    pub started_at: String,
    pub is_win: bool,
    pub kills: i64,
    pub deaths: i64,
    pub kill_fame: i64,
    pub opponent: Option<String>,
    /// `(kills - deaths) ± 8 for the outcome + 1 per 200k kill fame`.
    pub score: i64,
}

/// Roster, attendance and role coverage.
#[derive(Debug, Clone, Default, Serialize, ToSchema)]
pub struct ReportOperations {
    pub roster: i64,
    pub officers: i64,
    /// Members with no linked Albion character.
    pub unlinked: i64,
    pub events_total: i64,
    pub events_live: i64,
    pub events_scheduled: i64,
    pub events_finished: i64,
    pub call_to_arms: i64,
    pub cta_rate: f64,
    /// Total signups across events in range.
    pub attendance: i64,
    /// Total seats those events called for.
    pub slots: i64,
    pub fill_rate: f64,
    /// Seats each role was asked for, from comp build quantities.
    pub role_need: HashMap<String, i64>,
    /// Seats each role was actually filled with, from signups.
    pub role_fill: HashMap<String, i64>,
    /// Members with no signups in the window.
    pub inactive_members: Vec<String>,
}

/// Silver in and out.
///
/// Regear and split figures are **breakdowns of** `outflow_total`, not addends
/// to it. See [`compute_economy`] for why that distinction matters.
#[derive(Debug, Clone, Default, Serialize, ToSchema)]
pub struct ReportEconomy {
    pub loot_in: i64,
    pub outflow_total: i64,
    pub outflow_splits: i64,
    pub outflow_regear: i64,
    pub outflow_other: i64,
    pub net: i64,
    pub bank_pending: i64,
    pub bank_requested: i64,
    pub bank_withdrawn: i64,
    pub regear_open: i64,
    pub regear_paid: i64,
    pub split_pending: i64,
    pub split_completed: i64,
    pub siphoned_net: i64,
    pub fame_per_player: i64,
    /// Kill fame earned per million silver lost.
    pub fame_per_million_lost: i64,
}

/// One member's contribution over the window.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct MemberRow {
    pub user_id: i64,
    pub username: String,
    pub albion_name: Option<String>,
    pub role: String,
    pub is_officer: bool,
    pub linked: bool,
    pub events_signed: i64,
    pub fill_rate: f64,
    pub fights: i64,
    pub kills: i64,
    pub deaths: i64,
    pub kill_death_ratio: f64,
    pub kill_fame: i64,
    pub silver_lost: i64,
    pub regears_claimed: i64,
    pub regear_silver: i64,
    pub split_earnings: i64,
    pub bank_pending: i64,
    pub siphoned: i64,
}

/// One of our comps and how it has performed.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct CompRow {
    pub comp_id: i64,
    pub name: String,
    pub seats: i64,
    pub events: i64,
    pub fights: i64,
    pub wins: i64,
    pub losses: i64,
    pub win_rate: f64,
    pub kills: i64,
    pub deaths: i64,
    pub fill_rate: f64,
}

/// One scouted opponent and our record against them.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct EnemyRow {
    pub scouted_comp_id: i64,
    pub name: String,
    pub opponent_guild_name: String,
    pub category: String,
    pub player_count: i64,
    pub wins: i64,
    pub losses: i64,
    pub threat_score: i64,
    pub last_seen: String,
    /// Our best-performing comp against them, when we have fought them.
    pub counter_comp_name: Option<String>,
}

/// One weapon's share of a force.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct WeaponShare {
    pub weapon: String,
    pub count: i64,
}

/// Activity in one UTC hour.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct HourBucket {
    pub hour: u32,
    pub fights: i64,
    pub wins: i64,
    pub losses: i64,
}

/// One entry in the unified activity feed.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct TimelineEntry {
    pub at: String,
    /// `battle`, `event` or `scout`.
    pub kind: String,
    pub title: String,
    pub detail: String,
}

/// Members ranked on a single measure.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct LeaderboardEntry {
    pub user_id: i64,
    pub username: String,
    pub value: i64,
}

/// Every leaderboard, recomputed from real activity.
#[derive(Debug, Clone, Default, Serialize, ToSchema)]
pub struct ReportLeaderboards {
    pub attendance: Vec<LeaderboardEntry>,
    pub kills: Vec<LeaderboardEntry>,
    pub deaths: Vec<LeaderboardEntry>,
    pub kill_fame: Vec<LeaderboardEntry>,
    pub silver_lost: Vec<LeaderboardEntry>,
    pub split_earnings: Vec<LeaderboardEntry>,
    pub regear_silver: Vec<LeaderboardEntry>,
    pub siphoned: Vec<LeaderboardEntry>,
}

/// Caveats that explain gaps in the numbers above.
#[derive(Debug, Clone, Default, Serialize, ToSchema)]
pub struct ReportDataQuality {
    pub total_battles: i64,
    pub attributed_battles: i64,
    /// Albion characters seen in battle that map to no linked member.
    pub unlinked_players: Vec<String>,
}

/// The whole aggregate.
#[derive(Debug, Clone, Default, Serialize, ToSchema)]
pub struct GuildReport {
    pub from: String,
    pub to: String,
    pub overview: ReportOverview,
    pub operations: ReportOperations,
    pub economy: ReportEconomy,
    pub members: Vec<MemberRow>,
    pub comps: Vec<CompRow>,
    pub enemies: Vec<EnemyRow>,
    /// Weapon distribution of our own players, from the kill feed.
    pub our_meta: Vec<WeaponShare>,
    /// Weapon distribution across every scouted enemy composition.
    pub enemy_meta: Vec<WeaponShare>,
    pub hours: Vec<HourBucket>,
    pub timeline: Vec<TimelineEntry>,
    pub leaderboards: ReportLeaderboards,
    pub data_quality: ReportDataQuality,
}

/// Everything the report needs, loaded once.
struct RawData {
    snapshots: Vec<snapshot::Model>,
    events: Vec<event::Model>,
    event_battles: Vec<event_battle::Model>,
    participations: Vec<event_participation::Model>,
    transactions: Vec<transaction::Model>,
    regears: Vec<regear::regear_death::Model>,
    splits: Vec<split::Model>,
    split_participants: Vec<split_participant::Model>,
    siphoned: Vec<siphoned::Model>,
    users: Vec<user::Model>,
    links: Vec<albion_link::Model>,
    comps: Vec<comp::Model>,
    comp_builds: Vec<comp_build::Model>,
    builds: Vec<build::Model>,
    scouts: Vec<scouted_comp::Model>,
    scout_links: Vec<scouted_comp_battle::Model>,
}

/// Builds the full guild report for a window.
///
/// Takes no market-data client: every silver figure already lives in the
/// database, so the report can never fail because an upstream API is down.
pub async fn build_guild_report(
    db: &DatabaseConnection,
    guild_ctx: &BattleLinkingContext,
    range: DateRange,
) -> Result<GuildReport, AppError> {
    let raw = load(db, range).await?;
    let classifier = RoleClassifier::load(db).await?;
    let matchup_rows = matchups(db, &[]).await?.rows;

    // One decoded view of each snapshot, reused by every tab below.
    let fights = decode_fights(&raw.snapshots, guild_ctx)?;
    let name_to_user = link_names_to_users(&raw);

    let attributed: HashSet<i64> = raw
        .event_battles
        .iter()
        .filter_map(|row| row.albionbb_battle_id.parse::<i64>().ok())
        .collect();

    let overview = compute_overview(&fights, &attributed);
    let operations = compute_operations(&raw, &range);
    let economy = compute_economy(&raw, &overview);
    let members = compute_members(&raw, &fights, &name_to_user);
    let comps = compute_comps(&raw, &matchup_rows);
    let enemies = compute_enemies(&raw, &matchup_rows);
    let (our_meta, enemy_meta) = compute_meta(&raw, &fights, &classifier);
    let hours = compute_hours(&fights);
    let timeline = compute_timeline(&raw, &fights);
    let leaderboards = compute_leaderboards(&members);
    let data_quality = ReportDataQuality {
        total_battles: fights.len() as i64,
        attributed_battles: overview.attributed_fights,
        unlinked_players: unresolved_players(&fights, &name_to_user),
    };

    Ok(GuildReport {
        from: range.from.to_rfc3339(),
        to: range.to.to_rfc3339(),
        overview,
        operations,
        economy,
        members,
        comps,
        enemies,
        our_meta,
        enemy_meta,
        hours,
        timeline,
        leaderboards,
        data_quality,
    })
}

/// One query per table, all range-filtered. No N+1 anywhere downstream.
async fn load(db: &DatabaseConnection, range: DateRange) -> Result<RawData, AppError> {
    let events = event::Entity::find()
        .filter(event::Column::EventDateUtc.between(range.from, range.to))
        .all(db)
        .await?;
    let event_ids: Vec<i64> = events.iter().map(|row| row.id).collect();

    let participations = if event_ids.is_empty() {
        Vec::new()
    } else {
        event_participation::Entity::find()
            .filter(event_participation::Column::EventId.is_in(event_ids.clone()))
            .all(db)
            .await?
    };

    let splits = split::Entity::find()
        .filter(split::Column::CreatedAt.between(range.from, range.to))
        .all(db)
        .await?;
    let split_ids: Vec<i64> = splits.iter().map(|row| row.id).collect();
    let split_participants = if split_ids.is_empty() {
        Vec::new()
    } else {
        split_participant::Entity::find()
            .filter(split_participant::Column::SplitId.is_in(split_ids))
            .all(db)
            .await?
    };

    Ok(RawData {
        snapshots: snapshot::Entity::find()
            .filter(snapshot::Column::StartTime.between(range.from, range.to))
            .all(db)
            .await?,
        event_battles: event_battle::Entity::find()
            .filter(event_battle::Column::BattleStartedAt.between(range.from, range.to))
            .all(db)
            .await?,
        events,
        participations,
        transactions: transaction::Entity::find()
            .filter(transaction::Column::CreatedAt.between(range.from, range.to))
            .all(db)
            .await?,
        regears: regear::regear_death::Entity::find()
            .filter(regear::regear_death::Column::KilledAt.between(range.from, range.to))
            .all(db)
            .await?,
        splits,
        split_participants,
        siphoned: siphoned::Entity::find()
            .filter(siphoned::Column::OccurredAt.between(range.from, range.to))
            .all(db)
            .await?,
        // Roster tables are small and not time-scoped: a member who did
        // nothing this window still belongs in the roster view.
        users: user::Entity::find().all(db).await?,
        links: albion_link::Entity::find().all(db).await?,
        comps: comp::Entity::find().all(db).await?,
        comp_builds: comp_build::Entity::find().all(db).await?,
        builds: build::Entity::find().all(db).await?,
        scouts: scouted_comp::Entity::find()
            .filter(scouted_comp::Column::IsArchived.eq(false))
            .all(db)
            .await?,
        scout_links: scouted_comp_battle::Entity::find().all(db).await?,
    })
}

/// A battle snapshot decoded into the parts every tab needs.
struct Fight {
    battle_id: i64,
    started_at: DateTimeWithTimeZone,
    is_win: bool,
    kills: i64,
    deaths: i64,
    kill_fame: i64,
    silver_lost: i64,
    opponent: Option<String>,
    our_players: Vec<BattlePlayer>,
    enemy_players: Vec<BattlePlayer>,
    weapons: std::collections::BTreeMap<String, String>,
    per_player_loss: HashMap<String, i64>,
}

impl Fight {
    /// `(kills - deaths) ± 8 for the outcome, + 1 per 200k kill fame`.
    ///
    /// Hand-tuned rather than principled: it exists to rank fights against each
    /// other for "best" and "worst", not to mean anything on its own.
    fn score(&self) -> i64 {
        let outcome = if self.is_win {
            FIGHT_SCORE_OUTCOME
        } else {
            -FIGHT_SCORE_OUTCOME
        };
        self.kills - self.deaths + outcome + self.kill_fame / FIGHT_SCORE_FAME_UNIT
    }

    fn summary(&self) -> FightSummary {
        FightSummary {
            battle_id: self.battle_id,
            started_at: self.started_at.to_rfc3339(),
            is_win: self.is_win,
            kills: self.kills,
            deaths: self.deaths,
            kill_fame: self.kill_fame,
            opponent: self.opponent.clone(),
            score: self.score(),
        }
    }
}

/// Decodes snapshots into fights, dropping battles our guild was not in.
///
/// A battle without our guild in the line-up has no "us versus them" to
/// measure; counting it would read as a loss and inflate every downside metric.
fn decode_fights(
    snapshots: &[snapshot::Model],
    guild_ctx: &BattleLinkingContext,
) -> Result<Vec<Fight>, AppError> {
    let mut fights = Vec::new();
    for row in snapshots {
        let guilds: Vec<BattleGuildSummary> = parse(&row.guilds_json, "guilds_json")?;
        let Some(ours) = guilds.iter().find(|g| g.id == guild_ctx.guild_id()) else {
            continue;
        };
        let players: Vec<BattlePlayer> = parse(&row.players_json, "players_json")?;
        let kills: Vec<BattleKillEvent> = parse(&row.kills_json, "kills_json")?;
        let losses: BattleLossEstimate = parse(&row.losses_json, "losses_json")?;

        let (our_players, enemy_players): (Vec<_>, Vec<_>) = players
            .into_iter()
            .partition(|p| guild_ctx.is_friendly_guild(&p.guild_id, &p.guild_name));

        let opponent = guilds
            .iter()
            .filter(|g| !guild_ctx.is_friendly_guild(&g.id, &g.name))
            .max_by_key(|g| g.kill_fame)
            .map(|g| g.name.clone());

        fights.push(Fight {
            battle_id: row.battle_id,
            started_at: row.start_time,
            is_win: ours.winner,
            kills: ours.kills,
            deaths: ours.deaths,
            kill_fame: ours.kill_fame,
            silver_lost: losses.total_estimated_loss,
            opponent,
            weapons: weapons_by_player(&kills),
            per_player_loss: losses
                .players
                .iter()
                .map(|p| (p.player_name.to_ascii_lowercase(), p.estimated_loss))
                .collect(),
            our_players,
            enemy_players,
        });
    }
    fights.sort_by_key(|fight| std::cmp::Reverse(fight.started_at));
    Ok(fights)
}

fn parse<T: for<'de> Deserialize<'de>>(raw: &str, column: &str) -> Result<T, AppError> {
    serde_json::from_str(raw)
        .map_err(|err| AppError::Internal(format!("malformed {column} in battle snapshot: {err}")))
}

/// Maps lowercased Albion character names to user ids.
///
/// Two hops, because `albion_links` carries a Discord id rather than a user id:
/// `albion_links.discord_id -> users.discord_id -> users.id`. Names are the
/// join key for anything derived from a snapshot, since the battle payload
/// names players but does not reliably carry their Albion id.
fn link_names_to_users(raw: &RawData) -> HashMap<String, i64> {
    let by_discord: HashMap<&str, i64> = raw
        .users
        .iter()
        .filter_map(|u| u.discord_id.as_deref().map(|d| (d, u.id)))
        .collect();
    raw.links
        .iter()
        .filter_map(|link| {
            by_discord
                .get(link.discord_id.as_str())
                .map(|id| (link.albion_player_name.to_ascii_lowercase(), *id))
        })
        .collect()
}

/// Character names seen in battle that resolve to no linked member.
fn unresolved_players(fights: &[Fight], name_to_user: &HashMap<String, i64>) -> Vec<String> {
    let mut unresolved: Vec<String> = fights
        .iter()
        .flat_map(|f| f.our_players.iter())
        .filter(|p| !name_to_user.contains_key(&p.name.to_ascii_lowercase()))
        .map(|p| p.name.clone())
        .collect();
    unresolved.sort_unstable();
    unresolved.dedup();
    unresolved
}

fn compute_overview(fights: &[Fight], attributed: &HashSet<i64>) -> ReportOverview {
    let wins = fights.iter().filter(|f| f.is_win).count() as i64;
    let total = fights.len() as i64;
    let kills: i64 = fights.iter().map(|f| f.kills).sum();
    let deaths: i64 = fights.iter().map(|f| f.deaths).sum();

    let our_ip: Vec<f64> = fights
        .iter()
        .flat_map(|f| f.our_players.iter().map(|p| p.item_power))
        .collect();
    let enemy_ip: Vec<f64> = fights
        .iter()
        .flat_map(|f| f.enemy_players.iter().map(|p| p.item_power))
        .collect();
    let avg_ours = mean(&our_ip);
    let avg_theirs = mean(&enemy_ip);

    // `fights` is newest-first, so a plain scan gives the current streak.
    let win_streak = fights.iter().take_while(|f| f.is_win).count() as i64;

    let best = fights.iter().max_by_key(|f| f.score()).map(Fight::summary);
    let worst = fights.iter().min_by_key(|f| f.score()).map(Fight::summary);

    ReportOverview {
        fights: total,
        wins,
        losses: total - wins,
        win_rate: ratio_percent(wins, total),
        kills,
        deaths,
        kill_death_ratio: kill_death_ratio(kills, deaths),
        kill_fame: fights.iter().map(|f| f.kill_fame).sum(),
        silver_lost: fights.iter().map(|f| f.silver_lost).sum(),
        avg_item_power: avg_ours,
        enemy_avg_item_power: avg_theirs,
        item_power_delta: avg_ours - avg_theirs,
        win_streak,
        best_fight: best,
        worst_fight: worst,
        attributed_fights: fights
            .iter()
            .filter(|f| attributed.contains(&f.battle_id))
            .count() as i64,
    }
}

fn compute_operations(raw: &RawData, _range: &DateRange) -> ReportOperations {
    const OFFICER_ROLES: [&str; 3] = ["Officer", "Admin", "SuperAdmin"];

    let linked_discord: HashSet<&str> = raw.links.iter().map(|l| l.discord_id.as_str()).collect();
    let officers = raw
        .users
        .iter()
        .filter(|u| OFFICER_ROLES.contains(&u.role.as_str()))
        .count() as i64;
    let unlinked = raw
        .users
        .iter()
        .filter(|u| {
            u.discord_id
                .as_deref()
                .is_none_or(|d| !linked_discord.contains(d))
        })
        .count() as i64;

    // Seats per comp, expanded from build quantities.
    let mut seats_by_comp: HashMap<i64, i64> = HashMap::new();
    let mut role_by_build: HashMap<i64, &str> = HashMap::new();
    for b in &raw.builds {
        role_by_build.insert(b.id, b.role.as_str());
    }
    let mut need_by_comp: HashMap<i64, HashMap<String, i64>> = HashMap::new();
    for row in &raw.comp_builds {
        let quantity = i64::from(row.quantity.max(0));
        *seats_by_comp.entry(row.comp_id).or_insert(0) += quantity;
        if let Some(role) = role_by_build.get(&row.build_id) {
            *need_by_comp
                .entry(row.comp_id)
                .or_default()
                .entry((*role).to_string())
                .or_insert(0) += quantity;
        }
    }

    let mut role_need: HashMap<String, i64> = ROLE_KEYS.iter().map(|k| ((*k).to_string(), 0)).collect();
    let mut role_fill: HashMap<String, i64> = role_need.clone();
    let mut slots = 0i64;
    for e in &raw.events {
        slots += seats_by_comp.get(&e.comp_id).copied().unwrap_or(0);
        if let Some(needs) = need_by_comp.get(&e.comp_id) {
            for (role, count) in needs {
                *role_need.entry(role.clone()).or_insert(0) += count;
            }
        }
    }
    for p in &raw.participations {
        if let Some(role) = role_by_build.get(&p.primary_build_id) {
            *role_fill.entry((*role).to_string()).or_insert(0) += 1;
        }
    }

    let signed_by_user: HashMap<i64, i64> =
        raw.participations.iter().fold(HashMap::new(), |mut acc, p| {
            *acc.entry(p.user_id).or_insert(0) += 1;
            acc
        });
    let inactive_members = raw
        .users
        .iter()
        .filter(|u| !signed_by_user.contains_key(&u.id))
        .map(|u| u.username.clone())
        .collect();

    let events_total = raw.events.len() as i64;
    let cta = raw.events.iter().filter(|e| e.call_to_arms).count() as i64;
    let attendance = raw.participations.len() as i64;

    ReportOperations {
        roster: raw.users.len() as i64,
        officers,
        unlinked,
        events_total,
        events_live: count_status(&raw.events, "live"),
        events_scheduled: count_status(&raw.events, "scheduled"),
        events_finished: raw
            .events
            .iter()
            .filter(|e| e.status == "stopped" || e.status == "auto_stopped")
            .count() as i64,
        call_to_arms: cta,
        cta_rate: ratio_percent(cta, events_total),
        attendance,
        slots,
        fill_rate: ratio_percent(attendance, slots),
        role_need,
        role_fill,
        inactive_members,
    }
}

fn count_status(events: &[event::Model], status: &str) -> i64 {
    events.iter().filter(|e| e.status == status).count() as i64
}

/// Silver flow, with the reference implementation's double-count corrected.
///
/// # The bug this fixes
///
/// The reference computed `outflow = regear_paid + bank_paid`. In this schema an
/// approved regear writes a `transactions` row and stores its id on the death,
/// and a completed split writes `transactions` rows tagged with `split_id`. So
/// the bank total **already contains** both: adding regears again counted them
/// twice and understated net silver.
///
/// The bank is therefore the single source of outflow, and regear and split are
/// reported as *slices of* it. The four figures satisfy
/// `total == splits + regear + other` by construction.
fn compute_economy(raw: &RawData, overview: &ReportOverview) -> ReportEconomy {
    let regear_tx_ids: HashSet<i64> = raw
        .regears
        .iter()
        .filter_map(|r| r.bank_transaction_id)
        .collect();

    let mut bank_pending = 0i64;
    let mut bank_requested = 0i64;
    let mut outflow_total = 0i64;
    let mut outflow_splits = 0i64;
    let mut outflow_regear = 0i64;

    for tx in &raw.transactions {
        let amount = to_i64(tx.amount);
        match tx.status.as_str() {
            "pending" => bank_pending += amount,
            "requested" => bank_requested += amount,
            "withdrawn" => {
                outflow_total += amount;
                if tx.split_id.is_some() {
                    outflow_splits += amount;
                } else if regear_tx_ids.contains(&tx.id) {
                    outflow_regear += amount;
                }
            }
            _ => {}
        }
    }
    debug_assert!(
        outflow_splits + outflow_regear <= outflow_total,
        "split and regear payouts must be slices of bank outflow, not additions"
    );
    let outflow_other = outflow_total - outflow_splits - outflow_regear;

    let split_net = |s: &split::Model| -> i64 {
        let net = to_i64(s.estimated_market_value) - to_i64(s.repair_value) - to_i64(s.bags_value);
        net.max(0)
    };
    let split_pending: i64 = raw
        .splits
        .iter()
        .filter(|s| s.status == "pending")
        .map(split_net)
        .sum();
    let split_completed: i64 = raw
        .splits
        .iter()
        .filter(|s| s.status == "completed")
        .map(split_net)
        .sum();

    let regear_amount = |r: &regear::regear_death::Model| {
        to_i64(r.final_amount.unwrap_or(r.auto_estimate_total))
    };
    let regear_open: i64 = raw
        .regears
        .iter()
        .filter(|r| r.status == "available" || r.status == "pending")
        .map(regear_amount)
        .sum();
    let regear_paid: i64 = raw
        .regears
        .iter()
        .filter(|r| r.status == "approved")
        .map(regear_amount)
        .sum();

    let our_player_count: i64 = raw.snapshots.len().max(1) as i64;
    let fame_per_player = if overview.fights > 0 {
        overview.kill_fame / our_player_count.max(1)
    } else {
        0
    };
    let fame_per_million_lost = if overview.silver_lost > 0 {
        overview.kill_fame * 1_000_000 / overview.silver_lost
    } else {
        overview.kill_fame
    };

    ReportEconomy {
        loot_in: split_completed,
        outflow_total,
        outflow_splits,
        outflow_regear,
        outflow_other,
        net: split_completed - outflow_total,
        bank_pending,
        bank_requested,
        bank_withdrawn: outflow_total,
        regear_open,
        regear_paid,
        split_pending,
        split_completed,
        siphoned_net: raw.siphoned.iter().map(|e| to_i64(e.amount)).sum(),
        fame_per_player,
        fame_per_million_lost,
    }
}

fn compute_members(
    raw: &RawData,
    fights: &[Fight],
    name_to_user: &HashMap<String, i64>,
) -> Vec<MemberRow> {
    const OFFICER_ROLES: [&str; 3] = ["Officer", "Admin", "SuperAdmin"];

    let link_by_discord: HashMap<&str, &albion_link::Model> = raw
        .links
        .iter()
        .map(|l| (l.discord_id.as_str(), l))
        .collect();

    // Per-user combat totals, resolved from snapshots by character name.
    let mut combat: HashMap<i64, (i64, i64, i64, i64, i64)> = HashMap::new();
    for fight in fights {
        for player in &fight.our_players {
            let key = player.name.to_ascii_lowercase();
            let Some(user_id) = name_to_user.get(&key).copied() else {
                continue;
            };
            let entry = combat.entry(user_id).or_insert((0, 0, 0, 0, 0));
            entry.0 += 1; // fights
            entry.1 += player.kills;
            entry.2 += player.deaths;
            entry.3 += player.kill_fame;
            entry.4 += fight.per_player_loss.get(&key).copied().unwrap_or(0);
        }
    }

    let signups: HashMap<i64, i64> = raw.participations.iter().fold(HashMap::new(), |mut a, p| {
        *a.entry(p.user_id).or_insert(0) += 1;
        a
    });
    let events_total = raw.events.len() as i64;

    let split_by_user: HashMap<i64, i64> = raw
        .transactions
        .iter()
        .filter(|tx| tx.split_id.is_some())
        .fold(HashMap::new(), |mut a, tx| {
            *a.entry(tx.to_user_id).or_insert(0) += to_i64(tx.amount);
            a
        });
    let bank_pending_by_user: HashMap<i64, i64> = raw
        .transactions
        .iter()
        .filter(|tx| tx.status == "pending" || tx.status == "requested")
        .fold(HashMap::new(), |mut a, tx| {
            *a.entry(tx.to_user_id).or_insert(0) += to_i64(tx.amount);
            a
        });

    let mut regear_count: HashMap<i64, i64> = HashMap::new();
    let mut regear_silver: HashMap<i64, i64> = HashMap::new();
    for r in &raw.regears {
        let Some(user_id) = r.user_id else { continue };
        *regear_count.entry(user_id).or_insert(0) += 1;
        if r.status == "approved" {
            *regear_silver.entry(user_id).or_insert(0) +=
                to_i64(r.final_amount.unwrap_or(r.auto_estimate_total));
        }
    }

    let siphoned_by_name: HashMap<String, i64> =
        raw.siphoned.iter().fold(HashMap::new(), |mut a, e| {
            *a.entry(e.player_name.to_ascii_lowercase()).or_insert(0) += to_i64(e.amount);
            a
        });

    let mut rows: Vec<MemberRow> = raw
        .users
        .iter()
        .map(|u| {
            let link = u
                .discord_id
                .as_deref()
                .and_then(|d| link_by_discord.get(d).copied());
            let (fights_n, kills, deaths, fame, lost) =
                combat.get(&u.id).copied().unwrap_or((0, 0, 0, 0, 0));
            let signed = signups.get(&u.id).copied().unwrap_or(0);
            let siphoned = link
                .map(|l| l.albion_player_name.to_ascii_lowercase())
                .and_then(|name| siphoned_by_name.get(&name).copied())
                .unwrap_or(0);

            MemberRow {
                user_id: u.id,
                username: u.username.clone(),
                albion_name: link.map(|l| l.albion_player_name.clone()),
                role: u.role.clone(),
                is_officer: OFFICER_ROLES.contains(&u.role.as_str()),
                linked: link.is_some(),
                events_signed: signed,
                fill_rate: ratio_percent(signed, events_total),
                fights: fights_n,
                kills,
                deaths,
                kill_death_ratio: kill_death_ratio(kills, deaths),
                kill_fame: fame,
                silver_lost: lost,
                regears_claimed: regear_count.get(&u.id).copied().unwrap_or(0),
                regear_silver: regear_silver.get(&u.id).copied().unwrap_or(0),
                split_earnings: split_by_user.get(&u.id).copied().unwrap_or(0),
                bank_pending: bank_pending_by_user.get(&u.id).copied().unwrap_or(0),
                siphoned,
            }
        })
        .collect();
    rows.sort_by(|a, b| b.kills.cmp(&a.kills).then_with(|| a.username.cmp(&b.username)));
    rows
}

fn compute_comps(raw: &RawData, matchup_rows: &[MatchupRow]) -> Vec<CompRow> {
    let mut seats: HashMap<i64, i64> = HashMap::new();
    for row in &raw.comp_builds {
        *seats.entry(row.comp_id).or_insert(0) += i64::from(row.quantity.max(0));
    }

    let events_by_comp: HashMap<i64, Vec<i64>> =
        raw.events.iter().fold(HashMap::new(), |mut a, e| {
            a.entry(e.comp_id).or_default().push(e.id);
            a
        });
    let signups_by_event: HashMap<i64, i64> =
        raw.participations.iter().fold(HashMap::new(), |mut a, p| {
            *a.entry(p.event_id).or_insert(0) += 1;
            a
        });
    let battles_by_event: HashMap<i64, Vec<&event_battle::Model>> =
        raw.event_battles.iter().fold(HashMap::new(), |mut a, b| {
            a.entry(b.event_id).or_default().push(b);
            a
        });

    let mut rows: Vec<CompRow> = raw
        .comps
        .iter()
        .map(|c| {
            let event_ids = events_by_comp.get(&c.id).cloned().unwrap_or_default();
            let comp_seats = seats.get(&c.id).copied().unwrap_or(0);
            let signed: i64 = event_ids
                .iter()
                .map(|id| signups_by_event.get(id).copied().unwrap_or(0))
                .sum();
            let capacity = comp_seats * event_ids.len() as i64;

            let battles: Vec<&event_battle::Model> = event_ids
                .iter()
                .filter_map(|id| battles_by_event.get(id))
                .flatten()
                .copied()
                .collect();
            let wins = battles.iter().filter(|b| b.is_win).count() as i64;
            let total = battles.len() as i64;

            CompRow {
                comp_id: c.id,
                name: c.name.clone(),
                seats: comp_seats,
                events: event_ids.len() as i64,
                fights: total,
                wins,
                losses: total - wins,
                win_rate: ratio_percent(wins, total),
                kills: battles.iter().map(|b| b.guild_kills).sum(),
                deaths: battles.iter().map(|b| b.guild_deaths).sum(),
                fill_rate: ratio_percent(signed, capacity),
            }
        })
        .collect();

    // A comp with a proven record outranks one that merely exists.
    let _ = matchup_rows;
    rows.sort_by(|a, b| b.fights.cmp(&a.fights).then_with(|| a.name.cmp(&b.name)));
    rows
}

fn compute_enemies(raw: &RawData, matchup_rows: &[MatchupRow]) -> Vec<EnemyRow> {
    let mut rows: Vec<EnemyRow> = raw
        .scouts
        .iter()
        .map(|s| {
            let wins: i64 = matchup_rows
                .iter()
                .filter(|m| m.scouted_comp_id == s.id)
                .map(|m| m.wins)
                .sum();
            let losses: i64 = matchup_rows
                .iter()
                .filter(|m| m.scouted_comp_id == s.id)
                .map(|m| m.losses)
                .sum();
            EnemyRow {
                scouted_comp_id: s.id,
                name: s.name.clone(),
                opponent_guild_name: s.opponent_guild_name.clone(),
                category: s.category.clone(),
                player_count: i64::from(s.player_count),
                wins,
                losses,
                threat_score: i64::from(s.threat_score),
                last_seen: s.saved_at.to_rfc3339(),
                counter_comp_name: best_counter(matchup_rows, s.id)
                    .map(|row| row.our_comp_name.clone()),
            }
        })
        .collect();
    rows.sort_by_key(|row| std::cmp::Reverse(row.threat_score));
    rows
}

/// Weapon distributions for both sides.
///
/// Ours comes from the kill feed, so it shares the same partial-coverage caveat
/// as enemy scouting: only players who killed or died contribute a weapon.
/// Theirs is aggregated across the stored scout histograms.
fn compute_meta(
    raw: &RawData,
    fights: &[Fight],
    _classifier: &RoleClassifier,
) -> (Vec<WeaponShare>, Vec<WeaponShare>) {
    let mut ours: HashMap<String, i64> = HashMap::new();
    for fight in fights {
        for player in &fight.our_players {
            if let Some(weapon) = fight.weapons.get(&player.name) {
                *ours.entry(normalize_item_id(weapon)).or_insert(0) += 1;
            }
        }
    }

    let mut theirs: HashMap<String, i64> = HashMap::new();
    for scout in &raw.scouts {
        let Ok(weapons) = serde_json::from_str::<HashMap<String, i64>>(&scout.weapons_json) else {
            continue;
        };
        for (weapon, count) in weapons {
            *theirs.entry(weapon).or_insert(0) += count;
        }
    }

    (top_weapons(ours), top_weapons(theirs))
}

fn top_weapons(map: HashMap<String, i64>) -> Vec<WeaponShare> {
    let mut rows: Vec<WeaponShare> = map
        .into_iter()
        .map(|(weapon, count)| WeaponShare { weapon, count })
        .collect();
    rows.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.weapon.cmp(&b.weapon)));
    rows.truncate(META_LIMIT);
    rows
}

/// Fights bucketed by UTC hour.
///
/// Bucketed in Rust rather than with `EXTRACT`, which is not portable to the
/// SQLite backend the test suite runs on.
fn compute_hours(fights: &[Fight]) -> Vec<HourBucket> {
    use chrono::Timelike;
    let mut buckets: Vec<HourBucket> = (0..24)
        .map(|hour| HourBucket {
            hour,
            fights: 0,
            wins: 0,
            losses: 0,
        })
        .collect();
    for fight in fights {
        let hour = fight.started_at.with_timezone(&chrono::Utc).hour() as usize;
        let bucket = &mut buckets[hour];
        bucket.fights += 1;
        if fight.is_win {
            bucket.wins += 1;
        } else {
            bucket.losses += 1;
        }
    }
    buckets
}

fn compute_timeline(raw: &RawData, fights: &[Fight]) -> Vec<TimelineEntry> {
    let mut entries: Vec<(DateTimeWithTimeZone, TimelineEntry)> = Vec::new();

    for fight in fights {
        entries.push((
            fight.started_at,
            TimelineEntry {
                at: fight.started_at.to_rfc3339(),
                kind: "battle".to_string(),
                title: format!("Battle #{}", fight.battle_id),
                detail: format!(
                    "{} · {}",
                    if fight.is_win { "Win" } else { "Loss" },
                    fight.opponent.as_deref().unwrap_or("Unknown opponent")
                ),
            },
        ));
    }
    for e in &raw.events {
        entries.push((
            e.event_date_utc,
            TimelineEntry {
                at: e.event_date_utc.to_rfc3339(),
                kind: "event".to_string(),
                title: e.title.clone(),
                detail: e.status.clone(),
            },
        ));
    }
    for s in &raw.scouts {
        entries.push((
            s.saved_at,
            TimelineEntry {
                at: s.saved_at.to_rfc3339(),
                kind: "scout".to_string(),
                title: s.name.clone(),
                detail: format!("{} players observed", s.player_count),
            },
        ));
    }

    entries.sort_by_key(|(at, _)| std::cmp::Reverse(*at));
    entries
        .into_iter()
        .take(TIMELINE_LIMIT)
        .map(|(_, entry)| entry)
        .collect()
}

/// Every board, derived from the member rows already computed.
///
/// This replaces the reference implementation's static counters, which were
/// written once and never updated, so newly active members permanently ranked
/// last regardless of what they actually did.
fn compute_leaderboards(members: &[MemberRow]) -> ReportLeaderboards {
    fn board(members: &[MemberRow], value: impl Fn(&MemberRow) -> i64) -> Vec<LeaderboardEntry> {
        let mut rows: Vec<LeaderboardEntry> = members
            .iter()
            .map(|m| LeaderboardEntry {
                user_id: m.user_id,
                username: m.username.clone(),
                value: value(m),
            })
            .filter(|entry| entry.value != 0)
            .collect();
        rows.sort_by_key(|entry| std::cmp::Reverse(entry.value));
        rows
    }

    ReportLeaderboards {
        attendance: board(members, |m| m.events_signed),
        kills: board(members, |m| m.kills),
        deaths: board(members, |m| m.deaths),
        kill_fame: board(members, |m| m.kill_fame),
        silver_lost: board(members, |m| m.silver_lost),
        split_earnings: board(members, |m| m.split_earnings),
        regear_silver: board(members, |m| m.regear_silver),
        siphoned: board(members, |m| m.siphoned),
    }
}

fn mean(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.iter().sum::<f64>() / values.len() as f64
}

/// Silver amounts are whole numbers in practice; a non-representable decimal
/// becomes zero rather than panicking a whole dashboard.
fn to_i64(value: Decimal) -> i64 {
    value.to_i64().unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn member(id: i64, kills: i64, signed: i64) -> MemberRow {
        MemberRow {
            user_id: id,
            username: format!("user{id}"),
            albion_name: None,
            role: "User".to_string(),
            is_officer: false,
            linked: false,
            events_signed: signed,
            fill_rate: 0.0,
            fights: 0,
            kills,
            deaths: 0,
            kill_death_ratio: 0.0,
            kill_fame: 0,
            silver_lost: 0,
            regears_claimed: 0,
            regear_silver: 0,
            split_earnings: 0,
            bank_pending: 0,
            siphoned: 0,
        }
    }

    #[test]
    fn date_range_defaults_to_a_thirty_day_window() {
        let range = DateRange::resolve(None, None).unwrap();
        let span = range.to - range.from;
        assert_eq!(span.num_days(), DEFAULT_WINDOW_DAYS);
    }

    #[test]
    fn date_range_rejects_an_inverted_window() {
        let err = DateRange::resolve(
            Some("2026-08-02T00:00:00Z"),
            Some("2026-08-01T00:00:00Z"),
        )
        .unwrap_err();
        assert!(format!("{err}").contains("must not be after"));
    }

    #[test]
    fn date_range_rejects_garbage() {
        assert!(DateRange::resolve(Some("yesterday"), None).is_err());
    }

    #[test]
    fn leaderboards_drop_members_with_nothing_to_show() {
        let boards = compute_leaderboards(&[member(1, 5, 2), member(2, 0, 0)]);
        assert_eq!(boards.kills.len(), 1);
        assert_eq!(boards.kills[0].user_id, 1);
        assert!(boards.deaths.is_empty());
    }

    #[test]
    fn leaderboards_rank_descending() {
        let boards = compute_leaderboards(&[member(1, 3, 0), member(2, 9, 0), member(3, 6, 0)]);
        let order: Vec<i64> = boards.kills.iter().map(|e| e.user_id).collect();
        assert_eq!(order, vec![2, 3, 1]);
    }

    #[test]
    fn hour_histogram_always_has_24_buckets() {
        let buckets = compute_hours(&[]);
        assert_eq!(buckets.len(), 24);
        assert_eq!(buckets[23].hour, 23);
        assert!(buckets.iter().all(|b| b.fights == 0));
    }

    #[test]
    fn mean_of_nothing_is_zero() {
        assert_eq!(mean(&[]), 0.0);
        assert_eq!(mean(&[1.0, 3.0]), 2.0);
    }

    #[test]
    fn decimal_conversion_is_lossy_but_never_panics() {
        assert_eq!(to_i64(Decimal::new(1_500, 0)), 1_500);
        assert_eq!(to_i64(Decimal::MAX), 0);
    }
}
