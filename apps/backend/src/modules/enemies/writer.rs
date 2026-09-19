//! Persists [`BattleEnemyFacts`] into the enemy identity tables:
//! `enemy_guilds`, `enemy_guild_aliases`, `enemy_players` and
//! `enemy_player_battles`.
//!
//! # "Most recent battle wins the current pointer, but first/last-seen always widens"
//!
//! Unlike `battles::evidence_writer`'s tables, `enemy_guilds` and
//! `enemy_players` persist ACROSS every battle a given enemy has ever been
//! observed in, rather than being scoped to one `battle_id`. There is no
//! per-battle counter on them to double on re-hydration — see
//! `m20260908_000005_create_enemy_identity_tables` for why these tables
//! deliberately carry no rollups — but their "current" identity snapshot
//! (`name` / `current_alliance_id` / `current_alliance_name` on
//! `enemy_guilds`; `name` / `current_enemy_guild_id` on `enemy_players`)
//! still needs a defined winner when two different battles report different
//! values for the same enemy.
//!
//! Battle hydration is not guaranteed to run in chronological order: a
//! background sync, or an officer manually re-opening a battle from weeks
//! ago, can process an old battle well after strictly newer battles were
//! already ingested. If the identity snapshot were simply overwritten by
//! whichever battle happens to be hydrated last, that late re-sync of an old
//! battle would silently roll a guild's — or a player's — dossier back to a
//! stale name. So the rule here is:
//!
//! * `first_seen_at` / `last_seen_at` always widen (min/max) to cover every
//!   observation ever made, regardless of the order battles are hydrated in.
//! * The "current" identity snapshot is overwritten **only** when the
//!   incoming observation's `occurred_at` is at least as recent as anything
//!   already on file (`occurred_at >= existing.last_seen_at`, checked before
//!   `last_seen_at` itself is widened). An older observation only ever widens
//!   the envelope; it never overwrites a newer identity snapshot.
//! * Alias history (`enemy_guild_aliases`) is exempt from that guard: a name
//!   or alliance value is worth recording in history the moment it is
//!   observed, even on a battle that is too old to become "current".
//!
//! `enemy_player_battles` has no such concern — it is scoped uniquely to
//! `(battle_id, enemy_player_id)`, so re-hydrating one battle's rows is a
//! plain "delete this battle's rows, then insert fresh", the same idiom
//! `evidence_writer::persist_evidence` already uses for
//! `battle_guild_stats` / `battle_player_stats`.

use std::collections::HashMap;

use sea_orm::entity::prelude::DateTimeWithTimeZone;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseConnection, EntityTrait, QueryFilter,
    Set, TransactionTrait,
};

use crate::errors::AppError;

use super::aggregate::{BattleEnemyFacts, EnemyGuildFact, EnemyPlayerFact};
use super::entities::{enemy_guild, enemy_guild_alias, enemy_player, enemy_player_battle};

/// Persists one battle's enemy facts into the identity tables, in one
/// transaction. See the [module docs](self) for the full "current pointer
/// vs. envelope widening" rule this implements.
///
/// Order of operations, matching the policy this function exists to
/// implement:
/// 1. Upsert every [`EnemyGuildFact`] into `enemy_guilds` +
///    `enemy_guild_aliases`.
/// 2. Upsert every [`EnemyPlayerFact`] into `enemy_players`, resolving
///    `current_enemy_guild_id` via the guild ids step 1 just produced;
///    a player whose `guild_key` has no resolved guild id is skipped (with a
///    warning) rather than failing the whole transaction.
/// 3. Delete this `battle_id`'s existing `enemy_player_battles` rows, then
///    insert fresh ones for every successfully-resolved player fact.
pub async fn persist_enemy_facts(
    db: &DatabaseConnection,
    battle_id: i64,
    occurred_at: DateTimeWithTimeZone,
    facts: &BattleEnemyFacts,
) -> Result<(), AppError> {
    let txn = db.begin().await?;
    let now = chrono::Utc::now();

    // --- Step 1: upsert enemy_guilds + enemy_guild_aliases, keeping the
    // guild_key -> enemy_guilds.id mapping we need to resolve players below. ---
    let mut guild_ids: HashMap<String, i64> = HashMap::new();
    for guild in &facts.guilds {
        let id = upsert_enemy_guild(&txn, guild, occurred_at, now).await?;
        guild_ids.insert(guild.guild_key.clone(), id);
    }

    // --- Step 2: upsert enemy_players, resolving current_enemy_guild_id. ---
    let mut player_ids: HashMap<String, (i64, i64)> = HashMap::new();
    for player in &facts.players {
        let Some(&enemy_guild_id) = guild_ids.get(&player.guild_key) else {
            // Should not happen structurally: aggregate_battle always emits a
            // guild fact for every guild that fields an enemy player. Skip
            // rather than fail the whole transaction or insert a row that
            // would violate the NOT NULL FK constraint.
            tracing::warn!(
                guild_key = %player.guild_key,
                player_key = %player.player_key,
                "enemy player fact references a guild_key with no resolved enemy_guilds row, skipping"
            );
            continue;
        };
        let enemy_player_id =
            upsert_enemy_player(&txn, player, enemy_guild_id, occurred_at, now).await?;
        player_ids.insert(player.player_key.clone(), (enemy_player_id, enemy_guild_id));
    }

    // --- Step 3: enemy_player_battles — delete this battle's rows, then
    // insert fresh ones. No cross-battle uniqueness concern for this table
    // (unlike the identity tables above), same idiom as
    // evidence_writer::persist_evidence's battle_guild_stats/battle_player_stats. ---
    enemy_player_battle::Entity::delete_many()
        .filter(enemy_player_battle::Column::BattleId.eq(battle_id))
        .exec(&txn)
        .await?;

    let rows: Vec<enemy_player_battle::ActiveModel> = facts
        .players
        .iter()
        .filter_map(|player| {
            let (enemy_player_id, enemy_guild_id) = *player_ids.get(&player.player_key)?;
            Some(enemy_player_battle::ActiveModel {
                battle_id: Set(battle_id),
                enemy_player_id: Set(enemy_player_id),
                enemy_guild_id: Set(enemy_guild_id),
                occurred_at: Set(occurred_at),
                role: Set(player.role.clone()),
                main_hand_item_id: Set(player.main_hand_item_id.clone()),
                item_power: Set(player.item_power),
                our_kills_on_them: Set(player.our_kills_on_them),
                their_kills_on_us: Set(player.their_kills_on_us),
                created_at: Set(now.into()),
                ..Default::default()
            })
        })
        .collect();

    if !rows.is_empty() {
        enemy_player_battle::Entity::insert_many(rows)
            .exec(&txn)
            .await?;
    }

    txn.commit().await?;
    Ok(())
}

/// Upserts one [`EnemyGuildFact`] into `enemy_guilds`, then upserts its alias
/// history rows. Returns the resolved `enemy_guilds.id`.
async fn upsert_enemy_guild<C: ConnectionTrait>(
    txn: &C,
    fact: &EnemyGuildFact,
    occurred_at: DateTimeWithTimeZone,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<i64, AppError> {
    let existing = enemy_guild::Entity::find()
        .filter(enemy_guild::Column::GuildKey.eq(fact.guild_key.clone()))
        .one(txn)
        .await?;

    let enemy_guild_id = match existing {
        None => {
            let inserted = enemy_guild::ActiveModel {
                guild_key: Set(fact.guild_key.clone()),
                albion_guild_id: Set(fact.albion_guild_id.clone()),
                name: Set(fact.name.clone()),
                current_alliance_id: Set(fact.alliance_id.clone()),
                current_alliance_name: Set(fact.alliance_name.clone()),
                first_seen_at: Set(occurred_at),
                last_seen_at: Set(occurred_at),
                is_watchlisted: Set(false),
                notes: Set(None),
                created_at: Set(now.into()),
                updated_at: Set(now.into()),
                ..Default::default()
            }
            .insert(txn)
            .await?;
            inserted.id
        }
        Some(existing) => {
            let is_at_least_as_recent = occurred_at >= existing.last_seen_at;
            let mut row: enemy_guild::ActiveModel = existing.clone().into();
            row.first_seen_at = Set(existing.first_seen_at.min(occurred_at));
            row.last_seen_at = Set(existing.last_seen_at.max(occurred_at));
            if is_at_least_as_recent {
                row.name = Set(fact.name.clone());
                row.current_alliance_id = Set(fact.alliance_id.clone());
                row.current_alliance_name = Set(fact.alliance_name.clone());
                row.updated_at = Set(now.into());
            }
            let saved = row.update(txn).await?;
            saved.id
        }
    };

    // Alias history is independent of the recency guard above: a value is
    // worth recording the moment it's observed, even if it doesn't become
    // "current".
    upsert_alias(txn, enemy_guild_id, "name", &fact.name, occurred_at).await?;
    if let Some(alliance_name) = fact.alliance_name.as_deref() {
        upsert_alias(txn, enemy_guild_id, "alliance", alliance_name, occurred_at).await?;
    }

    Ok(enemy_guild_id)
}

/// Upserts one `(enemy_guild_id, kind, value)` alias row: widens
/// `first_seen_at`/`last_seen_at` if the row already exists, else inserts a
/// fresh one.
async fn upsert_alias<C: ConnectionTrait>(
    txn: &C,
    enemy_guild_id: i64,
    kind: &str,
    value: &str,
    occurred_at: DateTimeWithTimeZone,
) -> Result<(), AppError> {
    let existing = enemy_guild_alias::Entity::find()
        .filter(enemy_guild_alias::Column::EnemyGuildId.eq(enemy_guild_id))
        .filter(enemy_guild_alias::Column::Kind.eq(kind))
        .filter(enemy_guild_alias::Column::Value.eq(value))
        .one(txn)
        .await?;

    match existing {
        None => {
            enemy_guild_alias::ActiveModel {
                enemy_guild_id: Set(enemy_guild_id),
                kind: Set(kind.to_string()),
                value: Set(value.to_string()),
                first_seen_at: Set(occurred_at),
                last_seen_at: Set(occurred_at),
                ..Default::default()
            }
            .insert(txn)
            .await?;
        }
        Some(existing) => {
            let mut row: enemy_guild_alias::ActiveModel = existing.clone().into();
            row.first_seen_at = Set(existing.first_seen_at.min(occurred_at));
            row.last_seen_at = Set(existing.last_seen_at.max(occurred_at));
            row.update(txn).await?;
        }
    }

    Ok(())
}

/// Upserts one [`EnemyPlayerFact`] into `enemy_players`. Identical shape to
/// [`upsert_enemy_guild`], substituting `current_enemy_guild_id` for
/// `enemy_guilds`' alliance fields, and with no alias table — only guild
/// identity churns enough in this schema to warrant history. Returns the
/// resolved `enemy_players.id`.
async fn upsert_enemy_player<C: ConnectionTrait>(
    txn: &C,
    fact: &EnemyPlayerFact,
    current_enemy_guild_id: i64,
    occurred_at: DateTimeWithTimeZone,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<i64, AppError> {
    let existing = enemy_player::Entity::find()
        .filter(enemy_player::Column::PlayerKey.eq(fact.player_key.clone()))
        .one(txn)
        .await?;

    let enemy_player_id = match existing {
        None => {
            let inserted = enemy_player::ActiveModel {
                player_key: Set(fact.player_key.clone()),
                albion_player_id: Set(fact.player_id.clone()),
                name: Set(fact.name.clone()),
                identity_source: Set(fact.identity_source.to_string()),
                current_enemy_guild_id: Set(Some(current_enemy_guild_id)),
                first_seen_at: Set(occurred_at),
                last_seen_at: Set(occurred_at),
                is_watchlisted: Set(false),
                notes: Set(None),
                created_at: Set(now.into()),
                updated_at: Set(now.into()),
                ..Default::default()
            }
            .insert(txn)
            .await?;
            inserted.id
        }
        Some(existing) => {
            let is_at_least_as_recent = occurred_at >= existing.last_seen_at;
            let mut row: enemy_player::ActiveModel = existing.clone().into();
            row.first_seen_at = Set(existing.first_seen_at.min(occurred_at));
            row.last_seen_at = Set(existing.last_seen_at.max(occurred_at));
            if is_at_least_as_recent {
                row.name = Set(fact.name.clone());
                row.current_enemy_guild_id = Set(Some(current_enemy_guild_id));
                row.updated_at = Set(now.into());
            }
            let saved = row.update(txn).await?;
            saved.id
        }
    };

    Ok(enemy_player_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migration::MigratorTrait;
    use crate::modules::enemies::aggregate::EnemyGuildFact;
    use sea_orm::Database;

    async fn seed_db() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("connect to in-memory SQLite");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("run database migrations");
        db
    }

    fn ts(rfc3339: &str) -> DateTimeWithTimeZone {
        chrono::DateTime::parse_from_rfc3339(rfc3339).expect("valid RFC3339 timestamp")
    }

    fn guild_fact(
        guild_key: &str,
        albion_guild_id: Option<&str>,
        name: &str,
        alliance_name: Option<&str>,
    ) -> EnemyGuildFact {
        EnemyGuildFact {
            guild_key: guild_key.to_string(),
            albion_guild_id: albion_guild_id.map(ToString::to_string),
            name: name.to_string(),
            alliance_id: alliance_name.map(|_| "alliance-1".to_string()),
            alliance_name: alliance_name.map(ToString::to_string),
        }
    }

    fn player_fact(
        player_key: &str,
        name: &str,
        guild_key: &str,
        our_kills_on_them: i32,
        their_kills_on_us: i32,
    ) -> EnemyPlayerFact {
        EnemyPlayerFact {
            player_key: player_key.to_string(),
            player_id: Some(player_key.to_string()),
            name: name.to_string(),
            identity_source: "player_id",
            guild_key: guild_key.to_string(),
            role: Some("healer".to_string()),
            main_hand_item_id: Some("T8_2H_HOLYSTAFF".to_string()),
            item_power: 1350.0,
            our_kills_on_them,
            their_kills_on_us,
        }
    }

    #[tokio::test]
    async fn basic_persistence_writes_identity_and_battle_rows() {
        let db = seed_db().await;
        let facts = BattleEnemyFacts {
            guilds: vec![guild_fact("id:foe-1", Some("foe-1"), "Foe One", None)],
            players: vec![player_fact("id:foe-p1", "FoeGuy", "id:foe-1", 2, 1)],
        };
        let occurred_at = ts("2026-08-01T12:00:00Z");

        persist_enemy_facts(&db, 100, occurred_at, &facts)
            .await
            .expect("persist should succeed");

        let guild = enemy_guild::Entity::find()
            .filter(enemy_guild::Column::GuildKey.eq("id:foe-1"))
            .one(&db)
            .await
            .unwrap()
            .expect("guild row must exist");
        assert_eq!(guild.name, "Foe One");
        assert_eq!(guild.albion_guild_id.as_deref(), Some("foe-1"));
        assert_eq!(guild.first_seen_at, occurred_at);
        assert_eq!(guild.last_seen_at, occurred_at);

        let player = enemy_player::Entity::find()
            .filter(enemy_player::Column::PlayerKey.eq("id:foe-p1"))
            .one(&db)
            .await
            .unwrap()
            .expect("player row must exist");
        assert_eq!(player.name, "FoeGuy");
        assert_eq!(player.current_enemy_guild_id, Some(guild.id));

        let battle_row = enemy_player_battle::Entity::find()
            .filter(enemy_player_battle::Column::BattleId.eq(100))
            .one(&db)
            .await
            .unwrap()
            .expect("battle bridge row must exist");
        assert_eq!(battle_row.enemy_player_id, player.id);
        assert_eq!(battle_row.enemy_guild_id, guild.id);
        assert_eq!(battle_row.our_kills_on_them, 2);
        assert_eq!(battle_row.their_kills_on_us, 1);
        assert_eq!(battle_row.role.as_deref(), Some("healer"));
    }

    #[tokio::test]
    async fn re_hydrating_the_same_facts_does_not_duplicate_rows() {
        let db = seed_db().await;
        let facts = BattleEnemyFacts {
            guilds: vec![guild_fact("id:foe-1", Some("foe-1"), "Foe One", None)],
            players: vec![player_fact("id:foe-p1", "FoeGuy", "id:foe-1", 2, 1)],
        };
        let occurred_at = ts("2026-08-01T12:00:00Z");

        persist_enemy_facts(&db, 100, occurred_at, &facts)
            .await
            .unwrap();
        persist_enemy_facts(&db, 100, occurred_at, &facts)
            .await
            .unwrap();

        assert_eq!(enemy_guild::Entity::find().all(&db).await.unwrap().len(), 1);
        assert_eq!(
            enemy_player::Entity::find().all(&db).await.unwrap().len(),
            1
        );
        assert_eq!(
            enemy_guild_alias::Entity::find()
                .all(&db)
                .await
                .unwrap()
                .len(),
            1,
            "one alias row for the single observed name"
        );
        let battle_rows = enemy_player_battle::Entity::find()
            .filter(enemy_player_battle::Column::BattleId.eq(100))
            .all(&db)
            .await
            .unwrap();
        assert_eq!(battle_rows.len(), 1);
        assert_eq!(battle_rows[0].our_kills_on_them, 2);
        assert_eq!(battle_rows[0].their_kills_on_us, 1);
    }

    #[tokio::test]
    async fn a_rename_at_a_later_battle_updates_current_name_and_records_both_aliases() {
        let db = seed_db().await;
        let t1 = ts("2026-08-01T00:00:00Z");
        let t2 = ts("2026-08-02T00:00:00Z");

        let first = BattleEnemyFacts {
            guilds: vec![guild_fact("id:foe-1", Some("foe-1"), "Foe One", None)],
            players: vec![],
        };
        persist_enemy_facts(&db, 100, t1, &first).await.unwrap();

        let second = BattleEnemyFacts {
            guilds: vec![guild_fact(
                "id:foe-1",
                Some("foe-1"),
                "Foe One Renamed",
                None,
            )],
            players: vec![],
        };
        persist_enemy_facts(&db, 200, t2, &second).await.unwrap();

        let guild = enemy_guild::Entity::find()
            .filter(enemy_guild::Column::GuildKey.eq("id:foe-1"))
            .one(&db)
            .await
            .unwrap()
            .expect("guild row must exist");
        assert_eq!(guild.name, "Foe One Renamed");
        assert_eq!(guild.first_seen_at, t1);
        assert_eq!(guild.last_seen_at, t2);

        let aliases = enemy_guild_alias::Entity::find()
            .filter(enemy_guild_alias::Column::EnemyGuildId.eq(guild.id))
            .filter(enemy_guild_alias::Column::Kind.eq("name"))
            .all(&db)
            .await
            .unwrap();
        assert_eq!(aliases.len(), 2, "both names must be recorded in history");
        let old = aliases
            .iter()
            .find(|a| a.value == "Foe One")
            .expect("old name alias must exist");
        assert_eq!(old.first_seen_at, t1);
        assert_eq!(old.last_seen_at, t1);
        let new = aliases
            .iter()
            .find(|a| a.value == "Foe One Renamed")
            .expect("new name alias must exist");
        assert_eq!(new.first_seen_at, t2);
        assert_eq!(new.last_seen_at, t2);
    }

    #[tokio::test]
    async fn an_older_battle_must_not_overwrite_a_newer_identity_snapshot() {
        let db = seed_db().await;
        let t1 = ts("2026-08-01T00:00:00Z");
        let t2 = ts("2026-08-02T00:00:00Z");

        // First, persist the *newer* observation.
        let newer = BattleEnemyFacts {
            guilds: vec![guild_fact("id:foe-1", Some("foe-1"), "Current Name", None)],
            players: vec![],
        };
        persist_enemy_facts(&db, 200, t2, &newer).await.unwrap();

        // Then, simulate a late re-sync of an older battle reporting a stale name.
        let older = BattleEnemyFacts {
            guilds: vec![guild_fact(
                "id:foe-1",
                Some("foe-1"),
                "Stale Old Name",
                None,
            )],
            players: vec![],
        };
        persist_enemy_facts(&db, 100, t1, &older).await.unwrap();

        let guild = enemy_guild::Entity::find()
            .filter(enemy_guild::Column::GuildKey.eq("id:foe-1"))
            .one(&db)
            .await
            .unwrap()
            .expect("guild row must exist");
        assert_eq!(
            guild.name, "Current Name",
            "the older observation must not overwrite the newer identity snapshot"
        );
        assert_eq!(
            guild.first_seen_at, t1,
            "first_seen_at must still widen to cover the older battle"
        );
        assert_eq!(guild.last_seen_at, t2);

        let stale_alias = enemy_guild_alias::Entity::find()
            .filter(enemy_guild_alias::Column::EnemyGuildId.eq(guild.id))
            .filter(enemy_guild_alias::Column::Kind.eq("name"))
            .filter(enemy_guild_alias::Column::Value.eq("Stale Old Name"))
            .one(&db)
            .await
            .unwrap();
        assert!(
            stale_alias.is_some(),
            "history must record the stale name even though it never became current"
        );
    }

    #[tokio::test]
    async fn player_current_guild_pointer_follows_the_chronologically_latest_battle() {
        let db = seed_db().await;
        let t1 = ts("2026-08-01T00:00:00Z");
        let t2 = ts("2026-08-02T00:00:00Z");

        let old_guild_facts = BattleEnemyFacts {
            guilds: vec![
                guild_fact("id:foe-1", Some("foe-1"), "Foe One", None),
                guild_fact("id:foe-2", Some("foe-2"), "Foe Two", None),
            ],
            players: vec![player_fact("id:foe-p1", "FoeGuy", "id:foe-1", 0, 0)],
        };
        persist_enemy_facts(&db, 100, t1, &old_guild_facts)
            .await
            .unwrap();

        // The player transferred to a different guild in a chronologically
        // later battle.
        let new_guild_facts = BattleEnemyFacts {
            guilds: vec![guild_fact("id:foe-2", Some("foe-2"), "Foe Two", None)],
            players: vec![player_fact("id:foe-p1", "FoeGuy", "id:foe-2", 0, 0)],
        };
        persist_enemy_facts(&db, 200, t2, &new_guild_facts)
            .await
            .unwrap();

        let foe_two = enemy_guild::Entity::find()
            .filter(enemy_guild::Column::GuildKey.eq("id:foe-2"))
            .one(&db)
            .await
            .unwrap()
            .expect("foe-2 guild row must exist");

        let player = enemy_player::Entity::find()
            .filter(enemy_player::Column::PlayerKey.eq("id:foe-p1"))
            .one(&db)
            .await
            .unwrap()
            .expect("player row must exist");
        assert_eq!(
            player.current_enemy_guild_id,
            Some(foe_two.id),
            "the pointer must reflect the chronologically latest battle's guild"
        );

        // Now replay the *older* battle again (e.g. a re-sync): the pointer
        // must not roll back to foe-1.
        persist_enemy_facts(&db, 100, t1, &old_guild_facts)
            .await
            .unwrap();
        let player_after_replay = enemy_player::Entity::find()
            .filter(enemy_player::Column::PlayerKey.eq("id:foe-p1"))
            .one(&db)
            .await
            .unwrap()
            .expect("player row must still exist");
        assert_eq!(
            player_after_replay.current_enemy_guild_id,
            Some(foe_two.id),
            "replaying an older battle must not roll the current guild pointer back"
        );
    }

    #[tokio::test]
    async fn a_player_with_an_unresolvable_guild_key_is_skipped_not_failed() {
        let db = seed_db().await;
        // No guild fact at all for "id:ghost-guild" — structurally shouldn't
        // happen, but the writer must be defensive about it.
        let facts = BattleEnemyFacts {
            guilds: vec![],
            players: vec![player_fact(
                "id:orphan",
                "OrphanGuy",
                "id:ghost-guild",
                0,
                0,
            )],
        };

        persist_enemy_facts(&db, 100, ts("2026-08-01T00:00:00Z"), &facts)
            .await
            .expect("must not fail the whole transaction");

        let player = enemy_player::Entity::find()
            .filter(enemy_player::Column::PlayerKey.eq("id:orphan"))
            .one(&db)
            .await
            .unwrap();
        assert!(
            player.is_none(),
            "the orphaned player fact must be skipped, not inserted"
        );
    }
}
