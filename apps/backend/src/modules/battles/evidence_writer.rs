//! Persists [`NormalizedEvidence`] into the `battle_guild_stats`,
//! `battle_player_stats`, `battle_kills` and `battle_kill_items` tables.
//!
//! # Why this cannot be a naive "delete this battle's rows, then insert everything fresh"
//!
//! `battle_guild_stats` and `battle_player_stats` are scoped to `(battle_id, ...)`
//! only — nothing outside this battle's own rows can collide with them, so a full
//! delete-by-`battle_id` followed by a bulk insert is correct and is exactly what
//! [`persist_evidence`] does for those two tables.
//!
//! `battle_kills` is different: `source_event_id` carries a real, globally unique
//! index (`idx_battle_kills_source_event_unique`), because the same upstream
//! `AlbionBB` kill event can legitimately be observed while hydrating two
//! *different* battle segments that overlap in time — that is the whole point of
//! the fight-grouping feature elsewhere in this codebase, which can split one long
//! engagement into several `AlbionBB` "battles". If this function deleted only
//! `battle_id`'s own kill rows and then blindly re-inserted every kill the fresh
//! evidence carries, a kill that a *different* `battle_id` already owns would hit
//! that unique index and the whole hydration would fail (or, worse, some other
//! insert strategy could silently steal the row out from under the battle that
//! first claimed it).
//!
//! The policy implemented here, in one transaction:
//!
//! 1. Delete every existing `battle_guild_stats`/`battle_player_stats` row for
//!    this `battle_id`, then bulk-insert the fresh rows. Full replace, because
//!    there is no cross-battle uniqueness concern for these two tables.
//! 2. Delete every existing `battle_kills` row for this `battle_id`. Its
//!    `battle_kill_items` children cascade-delete automatically via the
//!    `ON DELETE CASCADE` foreign key declared in
//!    `m20260908_000004_create_battle_evidence_tables`.
//! 3. Query which of the fresh evidence's `source_event_id`s already exist in
//!    `battle_kills` — necessarily under some *other* `battle_id`, since step 2
//!    just cleared this battle's own rows. This is a single
//!    `SELECT source_event_id FROM battle_kills WHERE source_event_id IN (...)`
//!    rather than a catch-the-unique-violation approach, so the logic stays
//!    identical across the Postgres and `SQLite` backends this codebase supports.
//! 4. Insert only the kills (plus their `battle_kill_items`) whose
//!    `source_event_id` was **not** already present. A kill that already
//!    belongs to another `battle_id` keeps that ownership — "first hydration
//!    wins" — the same "reject, don't reassign" idiom already used for
//!    `fight_battles.battle_id`'s global uniqueness (see
//!    `ensure_canonical_fight` in `battles::service` and
//!    `battle_is_assigned_to_another_event` in `events::service`).
//!
//! A future maintainer who "simplifies" this into delete-then-insert-everything
//! for `battle_kills` will reintroduce a unique-constraint failure the very next
//! time a battle gets split or re-grouped and two segments' hydration runs
//! observe the same underlying kill.

use std::collections::HashSet;

use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, Set,
    TransactionTrait,
};

use crate::errors::AppError;

use super::evidence::NormalizedEvidence;
use super::evidence_entities::{
    battle_guild_stat, battle_kill, battle_kill_item, battle_player_stat,
};

/// Persists one battle's normalized evidence, replacing this battle's own
/// guild/player rows and adding only the kills not already owned by another
/// battle. See the [module docs](self) for the full dedup rationale.
///
/// Long by line count rather than by complexity: it is four sequential,
/// independent table steps (guilds, players, kills, kill items) in one
/// transaction, and splitting it into helpers would only scatter the
/// step-by-step policy this function's whole reason for existing is to keep
/// readable in one place.
#[allow(clippy::too_many_lines)]
pub async fn persist_evidence(
    db: &DatabaseConnection,
    battle_id: i64,
    evidence: &NormalizedEvidence,
) -> Result<(), AppError> {
    let txn = db.begin().await?;
    let now = chrono::Utc::now();

    // --- battle_guild_stats: full replace ---
    battle_guild_stat::Entity::delete_many()
        .filter(battle_guild_stat::Column::BattleId.eq(battle_id))
        .exec(&txn)
        .await?;

    if !evidence.guilds.is_empty() {
        let rows = evidence
            .guilds
            .iter()
            .map(|guild| battle_guild_stat::ActiveModel {
                battle_id: Set(battle_id),
                guild_id: Set(guild.guild_id.clone()),
                guild_name: Set(guild.guild_name.clone()),
                alliance_id: Set(guild.alliance_id.clone()),
                alliance_name: Set(guild.alliance_name.clone()),
                is_friendly: Set(guild.is_friendly),
                players: Set(guild.players),
                kills: Set(guild.kills),
                deaths: Set(guild.deaths),
                kill_fame: Set(guild.kill_fame),
                avg_item_power: Set(guild.avg_item_power),
                winner: Set(guild.winner),
                created_at: Set(now.into()),
                ..Default::default()
            })
            .collect::<Vec<_>>();
        battle_guild_stat::Entity::insert_many(rows)
            .exec(&txn)
            .await?;
    }

    // --- battle_player_stats: full replace ---
    battle_player_stat::Entity::delete_many()
        .filter(battle_player_stat::Column::BattleId.eq(battle_id))
        .exec(&txn)
        .await?;

    if !evidence.players.is_empty() {
        let rows = evidence
            .players
            .iter()
            .map(|player| battle_player_stat::ActiveModel {
                battle_id: Set(battle_id),
                player_key: Set(player.player_key.clone()),
                player_id: Set(player.player_id.clone()),
                player_name: Set(player.player_name.clone()),
                identity_source: Set(player.identity_source.to_string()),
                guild_id: Set(player.guild_id.clone()),
                guild_name: Set(player.guild_name.clone()),
                alliance_name: Set(player.alliance_name.clone()),
                is_friendly: Set(player.is_friendly),
                kills: Set(player.kills),
                deaths: Set(player.deaths),
                kill_fame: Set(player.kill_fame),
                death_fame: Set(player.death_fame),
                item_power: Set(player.item_power),
                main_hand_item_id: Set(player.main_hand_item_id.clone()),
                role: Set(player.role.clone()),
                role_confidence: Set(player.role_confidence.map(ToString::to_string)),
                created_at: Set(now.into()),
                ..Default::default()
            })
            .collect::<Vec<_>>();
        battle_player_stat::Entity::insert_many(rows)
            .exec(&txn)
            .await?;
    }

    // --- battle_kills + battle_kill_items: delete this battle's own rows,
    // then insert only the kills not already claimed by another battle_id. ---
    battle_kill::Entity::delete_many()
        .filter(battle_kill::Column::BattleId.eq(battle_id))
        .exec(&txn)
        .await?;

    if !evidence.kills.is_empty() {
        let source_event_ids = evidence
            .kills
            .iter()
            .map(|kill| kill.source_event_id)
            .collect::<Vec<_>>();
        let already_claimed = battle_kill::Entity::find()
            .filter(battle_kill::Column::SourceEventId.is_in(source_event_ids))
            .all(&txn)
            .await?
            .into_iter()
            .map(|row| row.source_event_id)
            .collect::<HashSet<_>>();

        for kill in &evidence.kills {
            if already_claimed.contains(&kill.source_event_id) {
                // Owned by a different battle_id already (this battle's own
                // rows were just cleared above) — first hydration wins, so
                // this kill is left alone rather than reassigned.
                continue;
            }

            let inserted = battle_kill::ActiveModel {
                battle_id: Set(battle_id),
                source_event_id: Set(kill.source_event_id),
                occurred_at: Set(kill.occurred_at),
                killer_player_key: Set(kill.killer_player_key.clone()),
                killer_name: Set(kill.killer_name.clone()),
                killer_guild_id: Set(kill.killer_guild_id.clone()),
                killer_guild_name: Set(kill.killer_guild_name.clone()),
                victim_player_key: Set(kill.victim_player_key.clone()),
                victim_name: Set(kill.victim_name.clone()),
                victim_guild_id: Set(kill.victim_guild_id.clone()),
                victim_guild_name: Set(kill.victim_guild_name.clone()),
                killer_item_power: Set(kill.killer_item_power),
                victim_item_power: Set(kill.victim_item_power),
                total_kill_fame: Set(kill.total_kill_fame),
                created_at: Set(now.into()),
                ..Default::default()
            }
            .insert(&txn)
            .await?;

            if !kill.items.is_empty() {
                let item_rows = kill
                    .items
                    .iter()
                    .map(|item| battle_kill_item::ActiveModel {
                        kill_id: Set(inserted.id),
                        slot: Set(item.slot.clone()),
                        item_type_id: Set(item.item_type_id.clone()),
                        quantity: Set(item.quantity),
                        created_at: Set(now.into()),
                        ..Default::default()
                    })
                    .collect::<Vec<_>>();
                battle_kill_item::Entity::insert_many(item_rows)
                    .exec(&txn)
                    .await?;
            }
        }
    }

    txn.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migration::MigratorTrait;
    use crate::modules::battles::evidence::{GuildStatRow, KillItemRow, KillRow, PlayerStatRow};
    use sea_orm::{Database, PaginatorTrait};

    async fn seed_db() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("connect to in-memory SQLite");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("run database migrations");
        db
    }

    fn guild_row(id: &str, name: &str) -> GuildStatRow {
        GuildStatRow {
            guild_id: id.to_string(),
            guild_name: name.to_string(),
            alliance_id: None,
            alliance_name: None,
            is_friendly: true,
            players: 5,
            kills: 3,
            deaths: 1,
            kill_fame: 10_000,
            avg_item_power: 1300.0,
            winner: true,
        }
    }

    fn player_row(key: &str, name: &str) -> PlayerStatRow {
        PlayerStatRow {
            player_key: key.to_string(),
            player_id: Some(key.to_string()),
            player_name: name.to_string(),
            identity_source: "player_id",
            guild_id: "g1".to_string(),
            guild_name: "Weaklings".to_string(),
            alliance_name: None,
            is_friendly: true,
            kills: 2,
            deaths: 0,
            kill_fame: 5_000,
            death_fame: 0,
            item_power: 1300.0,
            main_hand_item_id: Some("T8_2H_HOLYSTAFF".to_string()),
            role: Some("healer".to_string()),
            role_confidence: Some("curated"),
        }
    }

    fn kill_row(source_event_id: i64) -> KillRow {
        KillRow {
            source_event_id,
            occurred_at: chrono::DateTime::parse_from_rfc3339("2026-08-01T00:00:00Z").unwrap(),
            killer_player_key: "id:killer".to_string(),
            killer_name: "Killer".to_string(),
            killer_guild_id: Some("g1".to_string()),
            killer_guild_name: Some("Weaklings".to_string()),
            victim_player_key: "id:victim".to_string(),
            victim_name: "Victim".to_string(),
            victim_guild_id: Some("g2".to_string()),
            victim_guild_name: Some("Foe".to_string()),
            killer_item_power: 1400.0,
            victim_item_power: 1300.0,
            total_kill_fame: 100,
            items: vec![KillItemRow {
                slot: "MainHand".to_string(),
                item_type_id: "T8_2H_HOLYSTAFF".to_string(),
                quantity: 1,
            }],
        }
    }

    fn small_evidence() -> NormalizedEvidence {
        NormalizedEvidence {
            guilds: vec![guild_row("g1", "Weaklings"), guild_row("g2", "Foe")],
            players: vec![player_row("id:p1", "Alice"), player_row("id:p2", "Bob")],
            kills: vec![kill_row(999)],
        }
    }

    #[tokio::test]
    async fn basic_persistence_writes_all_four_tables() {
        let db = seed_db().await;
        let evidence = small_evidence();

        persist_evidence(&db, 100, &evidence)
            .await
            .expect("persist should succeed");

        let guilds = battle_guild_stat::Entity::find()
            .filter(battle_guild_stat::Column::BattleId.eq(100))
            .all(&db)
            .await
            .unwrap();
        assert_eq!(guilds.len(), 2);

        let players = battle_player_stat::Entity::find()
            .filter(battle_player_stat::Column::BattleId.eq(100))
            .all(&db)
            .await
            .unwrap();
        assert_eq!(players.len(), 2);
        let alice = players.iter().find(|p| p.player_name == "Alice").unwrap();
        assert_eq!(alice.role.as_deref(), Some("healer"));
        assert_eq!(alice.role_confidence.as_deref(), Some("curated"));

        let kills = battle_kill::Entity::find()
            .filter(battle_kill::Column::BattleId.eq(100))
            .all(&db)
            .await
            .unwrap();
        assert_eq!(kills.len(), 1);
        assert_eq!(kills[0].source_event_id, 999);

        let items = battle_kill_item::Entity::find()
            .filter(battle_kill_item::Column::KillId.eq(kills[0].id))
            .all(&db)
            .await
            .unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].item_type_id, "T8_2H_HOLYSTAFF");
    }

    #[tokio::test]
    async fn re_hydrating_the_same_evidence_does_not_duplicate_rows() {
        let db = seed_db().await;
        let evidence = small_evidence();

        persist_evidence(&db, 100, &evidence).await.unwrap();
        persist_evidence(&db, 100, &evidence).await.unwrap();

        let guild_count = battle_guild_stat::Entity::find()
            .filter(battle_guild_stat::Column::BattleId.eq(100))
            .count(&db)
            .await
            .unwrap();
        assert_eq!(guild_count, 2);

        let player_count = battle_player_stat::Entity::find()
            .filter(battle_player_stat::Column::BattleId.eq(100))
            .count(&db)
            .await
            .unwrap();
        assert_eq!(player_count, 2);

        let kill_count = battle_kill::Entity::find()
            .filter(battle_kill::Column::BattleId.eq(100))
            .count(&db)
            .await
            .unwrap();
        assert_eq!(kill_count, 1);

        let item_count = battle_kill_item::Entity::find().count(&db).await.unwrap();
        assert_eq!(item_count, 1, "items must not be duplicated either");
    }

    #[tokio::test]
    async fn a_kill_seen_in_two_overlapping_battles_stays_owned_by_the_first() {
        let db = seed_db().await;

        let mut first_evidence = NormalizedEvidence::default();
        first_evidence.kills.push(kill_row(999));
        persist_evidence(&db, 100, &first_evidence).await.unwrap();

        // A different battle observes the very same source_event_id, but with
        // otherwise different fixture content (different killer name), the way
        // two overlapping AlbionBB battle segments could both report the same
        // real kill.
        let mut second_kill = kill_row(999);
        second_kill.killer_name = "SomeoneElse".to_string();
        let mut second_evidence = NormalizedEvidence::default();
        second_evidence.kills.push(second_kill);
        persist_evidence(&db, 200, &second_evidence).await.unwrap();

        let kills = battle_kill::Entity::find()
            .filter(battle_kill::Column::SourceEventId.eq(999))
            .all(&db)
            .await
            .unwrap();
        assert_eq!(
            kills.len(),
            1,
            "the kill must exist exactly once across all battles"
        );
        assert_eq!(
            kills[0].battle_id, 100,
            "first hydration wins: the kill must stay owned by battle 100"
        );
        assert_eq!(
            kills[0].killer_name, "Killer",
            "the original fixture's data must not be overwritten by the second battle"
        );

        let items = battle_kill_item::Entity::find()
            .filter(battle_kill_item::Column::KillId.eq(kills[0].id))
            .all(&db)
            .await
            .unwrap();
        assert_eq!(
            items.len(),
            1,
            "the winning kill's items must be intact, not duplicated or orphaned"
        );

        // battle 200 owns no kill rows at all, since its only kill was already claimed.
        let battle_200_kills = battle_kill::Entity::find()
            .filter(battle_kill::Column::BattleId.eq(200))
            .count(&db)
            .await
            .unwrap();
        assert_eq!(battle_200_kills, 0);
    }

    #[tokio::test]
    async fn re_hydrating_a_battle_with_a_changed_roster_replaces_the_stale_guild() {
        let db = seed_db().await;

        let mut first_evidence = NormalizedEvidence::default();
        first_evidence.guilds.push(guild_row("g1", "Weaklings"));
        first_evidence.guilds.push(guild_row("g2", "Foe"));
        persist_evidence(&db, 300, &first_evidence).await.unwrap();

        // Foe dropped out of the re-hydrated battle; only Weaklings remains.
        let mut second_evidence = NormalizedEvidence::default();
        second_evidence.guilds.push(guild_row("g1", "Weaklings"));
        persist_evidence(&db, 300, &second_evidence).await.unwrap();

        let guilds = battle_guild_stat::Entity::find()
            .filter(battle_guild_stat::Column::BattleId.eq(300))
            .all(&db)
            .await
            .unwrap();
        assert_eq!(guilds.len(), 1, "the stale guild's row must be gone");
        assert_eq!(guilds[0].guild_id, "g1");
    }
}
