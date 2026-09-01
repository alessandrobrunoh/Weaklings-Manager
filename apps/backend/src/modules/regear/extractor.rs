//! The death-extraction job that turns a Regear event's linked battles into `regear_deaths`
//! rows.
//!
//! Idempotent: re-running on the same event inserts only newly discovered deaths (matched by the
//! `(event_battle_id, albion_kill_event_id, player_name)` unique key). Reads the
//! `guild_battle_snapshots` table first; if a snapshot is missing it logs and skips that battle so
//! a manual re-run can pick up late-ingested battles without re-pricing everything.

use chrono::{DateTime, FixedOffset, Utc};
use sea_orm::sea_query::OnConflict;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, Set,
    TransactionTrait,
};
use serde_json::Value;
use std::collections::HashMap;

use crate::errors::AppError;
use crate::modules::albion::entities::albion_link;
use crate::modules::albiondata::service::AlbionDataService;
use crate::modules::battles::entities::{Column as SnapshotColumn, Entity as SnapshotEntity};
use crate::modules::events::entities::{event, event_battle, event_participation};
use crate::modules::users::entities as user_entities;

use super::entities::{
    RegearDeathActiveModel, RegearDeathColumn, RegearDeathEntity, RegearSettingEntity,
};
use super::models::ExtractionReport;
use super::pricing;

/// The configured-guild context the extractor needs to scope victim matching.
///
/// AlbionBB exposes every guild in the kill feed; we only reimburse our own members.
#[derive(Clone)]
pub struct ExtractionGuildContext {
    /// AlbionBB guild id of the configured guild.
    pub guild_id: String,
    /// AlbionBB server region (e.g. `"europe"`), or `None` to use the service default.
    pub server: Option<String>,
}

/// Extracts `regear_deaths` rows for one CTA event.
pub struct RegearExtractor<'a> {
    db: &'a DatabaseConnection,
    albiondata: &'a AlbionDataService,
    guild: ExtractionGuildContext,
}

impl<'a> RegearExtractor<'a> {
    /// Creates a new extractor bound to the given DB and Albion Data service.
    #[must_use]
    pub fn new(
        db: &'a DatabaseConnection,
        albiondata: &'a AlbionDataService,
        guild: ExtractionGuildContext,
    ) -> Self {
        Self {
            db,
            albiondata,
            guild,
        }
    }

    /// Walks every battle linked to `event_id`, prices the victims' loadouts, and inserts new
    /// `regear_deaths` rows.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::Database`] on DB failure, [`AppError::NotFound`] if the event does not
    /// exist, and [`AppError::Validation`] if the event is not a `call_to_arms` event.
    pub async fn extract_for_event(&self, event_id: i64) -> Result<ExtractionReport, AppError> {
        let event_row = event::Entity::find_by_id(event_id)
            .one(self.db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("event {event_id} not found")))?;
        if !event_row.regear {
            return Err(AppError::Validation(format!(
                "event {event_id} is not a regear event"
            )));
        }

        let settings = RegearSettingEntity::find()
            .one(self.db)
            .await?
            .ok_or_else(|| {
                AppError::Internal("regear_settings singleton row is missing".to_string())
            })?;

        let battles = event_battle::Entity::find()
            .filter(event_battle::Column::EventId.eq(event_id))
            .all(self.db)
            .await?;

        let participations = event_participation::Entity::find()
            .filter(event_participation::Column::EventId.eq(event_id))
            .all(self.db)
            .await?;
        let signup_by_user: HashMap<i64, Option<i64>> = participations
            .iter()
            .map(|signup| (signup.user_id, signup.primary_build_id))
            .collect();

        let mut battles_scanned = 0_i64;
        let mut deaths_inserted = 0_i64;
        let mut deaths_skipped = 0_i64;

        for battle in &battles {
            battles_scanned += 1;
            let Some(kills_json) = self.resolve_kills_json(battle).await? else {
                continue;
            };
            let kills = parse_kills(&kills_json);
            for kill in kills {
                if !is_own_guild_victim(&kill.victim_guild_id, &self.guild.guild_id) {
                    continue;
                }
                if kill.victim_name.is_empty() {
                    continue;
                }

                let user_id = self.resolve_user_id(&kill.victim_name).await?;
                let primary_build_id = user_id
                    .and_then(|id| signup_by_user.get(&id).copied())
                    .flatten();

                let equipment = read_victim_equipment(&kill.raw);
                let loadout_json =
                    serde_json::to_string(&equipment).unwrap_or_else(|_| "{}".to_string());
                let (breakdown, total) = pricing::build_breakdown(
                    self.albiondata,
                    &equipment,
                    &settings,
                    self.guild.server.as_deref(),
                )
                .await
                .unwrap_or_else(|err| {
                    tracing::warn!(error = %err, "regear pricing failed; falling back to empty breakdown");
                    (Vec::new(), sea_orm::prelude::Decimal::ZERO)
                });
                let breakdown_json =
                    serde_json::to_string(&breakdown).unwrap_or_else(|_| "[]".to_string());

                let killed_at = parse_kill_time(&kill.time).unwrap_or_else(|| Utc::now().into());

                let active = RegearDeathActiveModel {
                    event_id: Set(event_id),
                    event_battle_id: Set(battle.id),
                    albionbb_battle_id: Set(battle.albionbb_battle_id.clone()),
                    albion_kill_event_id: Set(kill.event_id.clone()),
                    killed_at: Set(killed_at),
                    user_id: Set(user_id),
                    player_name: Set(kill.victim_name.clone()),
                    guild_id: Set(self.guild.guild_id.clone()),
                    primary_build_id: Set(primary_build_id),
                    loadout_json: Set(loadout_json),
                    auto_estimate_total: Set(total),
                    auto_estimate_breakdown_json: Set(breakdown_json),
                    status: Set("available".to_string()),
                    ..Default::default()
                };

                let txn = self.db.begin().await?;
                let inserted = RegearDeathEntity::insert(active)
                    .on_conflict(OnConflict::new().do_nothing().to_owned())
                    .exec(&txn)
                    .await;
                txn.commit().await?;

                match inserted {
                    Ok(_) => deaths_inserted += 1,
                    Err(sea_orm::DbErr::RecordNotInserted) => deaths_skipped += 1,
                    Err(err) => {
                        let msg = err.to_string().to_lowercase();
                        if msg.contains("duplicate")
                            || msg.contains("conflict")
                            || msg.contains("unique")
                        {
                            deaths_skipped += 1;
                        } else {
                            return Err(AppError::Database(err));
                        }
                    }
                }
            }
        }

        Ok(ExtractionReport {
            event_id,
            battles_scanned,
            deaths_inserted,
            deaths_skipped,
        })
    }

    /// Fetches the kill feed JSON for one `event_battles` row.
    ///
    /// Prefers the persisted `guild_battle_snapshots.kills_json` (cheap and deterministic). The
    /// `albionbb_battle_id` is stored as a string in `event_battles` but as `i64` in snapshots, so
    /// we parse it.
    async fn resolve_kills_json(
        &self,
        battle: &event_battle::Model,
    ) -> Result<Option<Value>, AppError> {
        let Ok(battle_id_i64) = battle.albionbb_battle_id.parse::<i64>() else {
            return Ok(None);
        };
        let snapshot = SnapshotEntity::find()
            .filter(SnapshotColumn::BattleId.eq(battle_id_i64))
            .one(self.db)
            .await?;
        let Some(snapshot) = snapshot else {
            tracing::warn!(
                event_battle_id = battle.id,
                battle_id = battle.albionbb_battle_id,
                "no guild_battle_snapshot for event_battle; skipping (call \
                 battles::get_battle_detail_with_losses first to materialize it)"
            );
            return Ok(None);
        };
        Ok(serde_json::from_str(&snapshot.kills_json).ok())
    }

    /// Resolves an Albion in-game name to a `users.id`, if the player has linked their character.
    ///
    /// Two-hop lookup: `albion_links.albion_player_name` → `discord_id` → `users.discord_id` →
    /// `users.id`. Match is case-insensitive on the player name because Albion's display casing is
    /// unstable but the underlying name is unique.
    async fn resolve_user_id(&self, player_name: &str) -> Result<Option<i64>, AppError> {
        let lowered = player_name.to_lowercase();
        let all_links = albion_link::Entity::find().all(self.db).await?;
        let matching_discord_ids: Vec<String> = all_links
            .into_iter()
            .filter(|link| link.albion_player_name.to_lowercase() == lowered)
            .map(|link| link.discord_id)
            .collect();
        if matching_discord_ids.is_empty() {
            return Ok(None);
        }
        let users = user_entities::Entity::find()
            .filter(user_entities::Column::DiscordId.is_in(matching_discord_ids))
            .all(self.db)
            .await?;
        Ok(users.into_iter().next().map(|user| user.id))
    }
}

/// Parsed kill-event row from the snapshot. We only care about the victim-side fields and the raw
/// JSON for equipment extraction.
#[derive(Debug, Clone)]
struct ParsedKill {
    event_id: String,
    time: String,
    victim_name: String,
    victim_guild_id: Option<String>,
    raw: Value,
}

/// Parses the snapshot's `kills_json` into a flat list, tolerating both array and object payloads.
fn parse_kills(kills_json: &Value) -> Vec<ParsedKill> {
    let array = match kills_json {
        Value::Array(arr) => arr.clone(),
        Value::Object(obj) if obj.contains_key("kills") => obj
            .get("kills")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        _ => Vec::new(),
    };
    array.into_iter().map(parse_single_kill).collect()
}

/// Reads one kill event's relevant fields, tolerant of camelCase / PascalCase variants.
fn parse_single_kill(raw: Value) -> ParsedKill {
    let event_id = raw
        .get("EventId")
        .or_else(|| raw.get("eventId"))
        .or_else(|| raw.get("id"))
        .or_else(|| raw.get("Id"))
        .map(|v| value_to_id_string(v))
        .unwrap_or_default();
    let time = raw
        .get("TimeStamp")
        .or_else(|| raw.get("timeStamp"))
        .or_else(|| raw.get("Time"))
        .or_else(|| raw.get("time"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let victim = raw
        .get("Victim")
        .or_else(|| raw.get("victim"))
        .cloned()
        .unwrap_or(Value::Null);
    let victim_name = victim
        .get("Name")
        .or_else(|| victim.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let victim_guild_id = victim
        .get("GuildId")
        .or_else(|| victim.get("guildId"))
        .and_then(Value::as_str)
        .map(str::to_string);
    ParsedKill {
        event_id,
        time,
        victim_name,
        victim_guild_id,
        raw,
    }
}

/// Coerces a JSON value to a string suitable for the `albion_kill_event_id` column (numbers and
/// quoted strings both work).
fn value_to_id_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => value.to_string().trim_matches('"').to_string(),
    }
}

/// Extracts the victim's `Equipment` object from the kill-event raw JSON.
fn read_victim_equipment(raw: &Value) -> Value {
    let victim = raw
        .get("Victim")
        .or_else(|| raw.get("victim"))
        .cloned()
        .unwrap_or(Value::Null);
    victim
        .get("Equipment")
        .or_else(|| victim.get("equipment"))
        .cloned()
        .unwrap_or(Value::Object(serde_json::Map::new()))
}

/// Parses the kill timestamp leniently. AlbionBB emits RFC3339 most of the time but has been seen
/// using bare `YYYY-MM-DD HH:MM:SS` strings on older endpoints.
fn parse_kill_time(time: &str) -> Option<DateTime<FixedOffset>> {
    DateTime::parse_from_rfc3339(time)
        .or_else(|_| DateTime::parse_from_str(time, "%Y-%m-%d %H:%M:%S"))
        .ok()
        .map(DateTime::into)
}

/// Returns `true` when the kill's victim belongs to the configured guild.
fn is_own_guild_victim(victim_guild_id: &Option<String>, guild_id: &str) -> bool {
    victim_guild_id.as_deref() == Some(guild_id)
}
