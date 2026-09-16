//! Persists computed equipment fingerprints into the `loadout_fingerprints`
//! and `battle_loadout_observations` tables for one battle.
//!
//! # Idiom this matches
//!
//! Same "read the already-persisted evidence tables for one battle, compute,
//! then upsert" shape as `battles::evidence_writer` and
//! `enemies::writer::persist_enemy_facts`, in one `db.begin()` /
//! `txn.commit()` transaction.
//!
//! `loadout_fingerprints` persists across every battle a given equipment
//! identity has ever been seen in — an immutable identity, exactly like
//! `enemies::writer`'s `enemy_guilds`/`enemy_players` — but simpler: there is
//! no "current snapshot" concept here at all. A fingerprint's match
//! (`matched_build_id`/`matched_build_loadout`/`match_status`) and its other
//! derived fields (`mode`/`main_hand_base_item_id`/`slots_json`) are set
//! once, at creation, and never touched again; only `first_seen_at`/
//! `last_seen_at` ever widen (min/max) on re-observation, with `updated_at`
//! following. See `m20260908_000007_create_fingerprint_tables` for the full
//! identity-vs-rollup and immutable-match rationale.
//!
//! `battle_loadout_observations` is scoped uniquely to `(battle_id,
//! player_key)`, so re-hydrating one battle is the same "delete this
//! battle's rows, then insert fresh" idiom already used by
//! `evidence_writer::persist_evidence`'s `battle_guild_stats`/
//! `battle_player_stats` and `enemies::writer`'s `enemy_player_battles`.

use std::collections::{BTreeMap, HashMap};

use sea_orm::entity::prelude::DateTimeWithTimeZone;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseConnection, EntityTrait, QueryFilter,
    QueryOrder, Set, TransactionTrait,
};

use crate::errors::AppError;
use crate::modules::battles::evidence_entities::{
    battle_kill, battle_kill_item, battle_player_stat,
};
use crate::modules::comps::entities::{build, build_item};
use crate::modules::intel::roles::RoleClassifier;

use super::compute::{
    BuildCandidate, ComputedFingerprint, FingerprintMode, KillItemSource, MatchStatus,
    compute_and_match,
};
use super::entities::{battle_loadout_observation, fingerprint};

/// Persists one battle's equipment fingerprints, in one transaction:
///
/// 1. Load every non-archived build's `(build_id, loadout)` candidates once
///    (see [`load_build_candidates`]).
/// 2. For each `battle_player_stats` row in this battle, determine whether
///    they died (via `battle_kills.victim_player_key`) and load that kill's
///    `battle_kill_items` if so, then call [`compute_and_match`]. A player
///    who appears as a victim more than once (should not normally happen)
///    uses only the first such kill found (by ascending `battle_kills.id`).
///    A player with no evidence at all is skipped — nothing to persist.
/// 3. Upsert the resulting fingerprint per the identity/match-immutability
///    policy described in the [module docs](self), and stage a
///    `battle_loadout_observations` row.
/// 4. Replace this battle's `battle_loadout_observations` rows wholesale
///    (safe: that table has no cross-battle uniqueness concern, unlike
///    `loadout_fingerprints`).
pub async fn persist_battle_fingerprints(
    db: &DatabaseConnection,
    battle_id: i64,
    occurred_at: DateTimeWithTimeZone,
    classifier: &RoleClassifier,
) -> Result<(), AppError> {
    let txn = db.begin().await?;
    let now = chrono::Utc::now();

    let candidates = load_build_candidates(&txn).await?;

    let players = battle_player_stat::Entity::find()
        .filter(battle_player_stat::Column::BattleId.eq(battle_id))
        .all(&txn)
        .await?;

    let kills = battle_kill::Entity::find()
        .filter(battle_kill::Column::BattleId.eq(battle_id))
        .order_by_asc(battle_kill::Column::Id)
        .all(&txn)
        .await?;

    // Keyed by victim_player_key: first kill found (ascending id) wins if a
    // victim somehow appears more than once, per the module docs above.
    let mut victim_items: HashMap<String, Vec<battle_kill_item::Model>> = HashMap::new();
    for kill in &kills {
        if victim_items.contains_key(&kill.victim_player_key) {
            continue;
        }
        let items = battle_kill_item::Entity::find()
            .filter(battle_kill_item::Column::KillId.eq(kill.id))
            .all(&txn)
            .await?;
        victim_items.insert(kill.victim_player_key.clone(), items);
    }

    let mut observations: Vec<battle_loadout_observation::ActiveModel> = Vec::new();

    for player in &players {
        let kill_items: Option<Vec<KillItemSource>> =
            victim_items.get(&player.player_key).map(|items| {
                items
                    .iter()
                    .map(|item| KillItemSource {
                        upstream_slot: item.slot.clone(),
                        item_type_id: item.item_type_id.clone(),
                    })
                    .collect()
            });

        let Some(computed) = compute_and_match(
            kill_items.as_deref(),
            player.main_hand_item_id.as_deref(),
            classifier,
            &candidates,
        ) else {
            // No evidence at all for this player: nothing to persist.
            continue;
        };

        let fingerprint_id = upsert_fingerprint(&txn, &computed, occurred_at, now).await?;

        observations.push(battle_loadout_observation::ActiveModel {
            battle_id: Set(battle_id),
            player_key: Set(player.player_key.clone()),
            is_friendly: Set(player.is_friendly),
            fingerprint_id: Set(fingerprint_id),
            occurred_at: Set(occurred_at),
            created_at: Set(now.into()),
            ..Default::default()
        });
    }

    // battle_loadout_observations: full replace, same idiom as
    // evidence_writer::persist_evidence's battle_guild_stats/
    // battle_player_stats and enemies::writer's enemy_player_battles — no
    // cross-battle uniqueness concern for this table.
    battle_loadout_observation::Entity::delete_many()
        .filter(battle_loadout_observation::Column::BattleId.eq(battle_id))
        .exec(&txn)
        .await?;

    if !observations.is_empty() {
        battle_loadout_observation::Entity::insert_many(observations)
            .exec(&txn)
            .await?;
    }

    txn.commit().await?;
    Ok(())
}

/// Loads one [`BuildCandidate`] per `(build_id, loadout)` pair across every
/// non-archived build, grouping that loadout's `build_items` rows by slot
/// (`build_item.slot` -> `build_item.openalbion_item_name`, used verbatim —
/// already tier/enchantment-stripped, per that column's own contract, so it
/// must not be re-normalized here). A build with zero items for a given
/// loadout simply never produces an entry — an empty `slots` map would never
/// overlap with anything.
async fn load_build_candidates<C: ConnectionTrait>(
    txn: &C,
) -> Result<Vec<BuildCandidate>, AppError> {
    let active_build_ids: Vec<i64> = build::Entity::find()
        .filter(build::Column::ArchivedAt.is_null())
        .all(txn)
        .await?
        .into_iter()
        .map(|active_build| active_build.id)
        .collect();

    if active_build_ids.is_empty() {
        return Ok(Vec::new());
    }

    let items = build_item::Entity::find()
        .filter(build_item::Column::BuildId.is_in(active_build_ids))
        .all(txn)
        .await?;

    let mut grouped: BTreeMap<(i64, String), BTreeMap<String, String>> = BTreeMap::new();
    for item in items {
        grouped
            .entry((item.build_id, item.loadout))
            .or_default()
            .insert(item.slot, item.openalbion_item_name);
    }

    Ok(grouped
        .into_iter()
        .map(|((build_id, loadout), slots)| BuildCandidate {
            build_id,
            loadout,
            slots,
        })
        .collect())
}

/// Upserts one computed fingerprint per the identity/match-immutability
/// policy: when the `fingerprint` string is new, inserts every field fresh
/// from `computed` (the match is decided once, right here, at creation).
/// When it already exists, `matched_build_id`/`matched_build_loadout`/
/// `match_status`/`mode`/`main_hand_base_item_id`/`slots_json` are left
/// completely untouched — only `first_seen_at`/`last_seen_at` widen
/// (min/max) and `updated_at` follows.
async fn upsert_fingerprint<C: ConnectionTrait>(
    txn: &C,
    computed: &ComputedFingerprint,
    occurred_at: DateTimeWithTimeZone,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<i64, AppError> {
    let existing = fingerprint::Entity::find()
        .filter(fingerprint::Column::Fingerprint.eq(computed.fingerprint.clone()))
        .one(txn)
        .await?;

    let id = match existing {
        None => {
            let slots_json = serde_json::to_string(&computed.slots).map_err(|error| {
                AppError::Internal(format!("failed to serialize fingerprint slots: {error}"))
            })?;
            let inserted = fingerprint::ActiveModel {
                fingerprint: Set(computed.fingerprint.clone()),
                mode: Set(mode_str(&computed.mode).to_string()),
                main_hand_base_item_id: Set(computed.main_hand_base_item_id.clone()),
                primary_role: Set(computed.primary_role.clone()),
                slots_json: Set(slots_json),
                matched_build_id: Set(computed.matched_build_id),
                matched_build_loadout: Set(computed.matched_build_loadout.clone()),
                match_status: Set(match_status_str(&computed.match_status).to_string()),
                first_seen_at: Set(occurred_at),
                last_seen_at: Set(occurred_at),
                created_at: Set(now.into()),
                updated_at: Set(now.into()),
                ..Default::default()
            }
            .insert(txn)
            .await?;
            inserted.id
        }
        Some(existing) => {
            let mut row: fingerprint::ActiveModel = existing.clone().into();
            row.first_seen_at = Set(existing.first_seen_at.min(occurred_at));
            row.last_seen_at = Set(existing.last_seen_at.max(occurred_at));
            row.updated_at = Set(now.into());
            let saved = row.update(txn).await?;
            saved.id
        }
    };

    Ok(id)
}

/// Renders [`FingerprintMode`] as the plain-text form stored in
/// `loadout_fingerprints.mode` (see that column's own doc comment).
fn mode_str(mode: &FingerprintMode) -> &'static str {
    match mode {
        FingerprintMode::Full => "full",
        FingerprintMode::WeaponOnly => "weapon_only",
    }
}

/// Renders [`MatchStatus`] as the plain-text form stored in
/// `loadout_fingerprints.match_status`.
fn match_status_str(status: &MatchStatus) -> &'static str {
    match status {
        MatchStatus::Matched => "matched",
        MatchStatus::Ambiguous => "ambiguous",
        MatchStatus::Unmatched => "unmatched",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migration::MigratorTrait;
    use crate::modules::comps::entities::build_category;
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

    async fn insert_player(
        db: &DatabaseConnection,
        battle_id: i64,
        player_key: &str,
        is_friendly: bool,
        main_hand_item_id: Option<&str>,
    ) {
        battle_player_stat::ActiveModel {
            battle_id: Set(battle_id),
            player_key: Set(player_key.to_string()),
            player_id: Set(Some(player_key.to_string())),
            player_name: Set(player_key.to_string()),
            identity_source: Set("player_id".to_string()),
            guild_id: Set("g1".to_string()),
            guild_name: Set("Guild".to_string()),
            alliance_name: Set(None),
            is_friendly: Set(is_friendly),
            kills: Set(0),
            deaths: Set(0),
            kill_fame: Set(0),
            death_fame: Set(0),
            item_power: Set(1300.0),
            main_hand_item_id: Set(main_hand_item_id.map(ToString::to_string)),
            role: Set(None),
            role_confidence: Set(None),
            created_at: Set(chrono::Utc::now().into()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert battle_player_stat");
    }

    /// Inserts a `battle_kills` row plus its `battle_kill_items`, returning
    /// the inserted kill's id.
    async fn insert_kill(
        db: &DatabaseConnection,
        battle_id: i64,
        source_event_id: i64,
        victim_player_key: &str,
        items: &[(&str, &str)],
    ) -> i64 {
        let kill = battle_kill::ActiveModel {
            battle_id: Set(battle_id),
            source_event_id: Set(source_event_id),
            occurred_at: Set(ts("2026-08-01T00:00:00Z")),
            killer_player_key: Set("id:killer".to_string()),
            killer_name: Set("Killer".to_string()),
            killer_guild_id: Set(None),
            killer_guild_name: Set(None),
            victim_player_key: Set(victim_player_key.to_string()),
            victim_name: Set(victim_player_key.to_string()),
            victim_guild_id: Set(None),
            victim_guild_name: Set(None),
            killer_item_power: Set(1300.0),
            victim_item_power: Set(1300.0),
            total_kill_fame: Set(100),
            created_at: Set(chrono::Utc::now().into()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert battle_kill");

        for (slot, item_type_id) in items {
            battle_kill_item::ActiveModel {
                kill_id: Set(kill.id),
                slot: Set((*slot).to_string()),
                item_type_id: Set((*item_type_id).to_string()),
                quantity: Set(1),
                created_at: Set(chrono::Utc::now().into()),
                ..Default::default()
            }
            .insert(db)
            .await
            .expect("insert battle_kill_item");
        }

        kill.id
    }

    async fn insert_user(db: &DatabaseConnection) -> i64 {
        crate::modules::users::entities::ActiveModel {
            username: Set("officer".into()),
            email: Set("officer@example.com".into()),
            role: Set("User".into()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("user")
        .id
    }

    /// Inserts one build with one loadout's items, returning the build id.
    async fn insert_build(
        db: &DatabaseConnection,
        creator: i64,
        name: &str,
        loadout: &str,
        slots: &[(&str, &str)],
        archived: bool,
    ) -> i64 {
        let category = build_category::ActiveModel {
            name: Set(format!("Category for {name}")),
            slug: Set(format!("category-{name}")),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("category")
        .id;

        let build_id = build::ActiveModel {
            name: Set(name.to_string()),
            role: Set("dps".to_string()),
            category_id: Set(category),
            version: Set(1),
            created_by: Set(creator),
            archived_at: Set(if archived {
                Some(ts("2026-01-01T00:00:00Z"))
            } else {
                None
            }),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("build")
        .id;

        for (slot, item_name) in slots {
            build_item::ActiveModel {
                build_id: Set(build_id),
                loadout: Set(loadout.to_string()),
                slot: Set((*slot).to_string()),
                openalbion_item_type: Set("weapon".to_string()),
                openalbion_item_id: Set(1),
                openalbion_item_name: Set((*item_name).to_string()),
                openalbion_item_icon: Set(None),
                openalbion_item_tier: Set(None),
                openalbion_item_quality: Set(4),
                openalbion_item_enchantment: Set(0),
                ..Default::default()
            }
            .insert(db)
            .await
            .expect("build item");
        }

        build_id
    }

    #[tokio::test]
    async fn a_player_who_died_gets_a_full_fingerprint_and_observation() {
        let db = seed_db().await;
        let battle_id = 100;
        // Deliberately different from the death equipment's weapon, to prove
        // full death evidence is preferred over the weapon-only fallback.
        insert_player(&db, battle_id, "id:victim", true, Some("T4_MAIN_MACE")).await;
        insert_kill(
            &db,
            battle_id,
            1,
            "id:victim",
            &[
                ("MainHand", "T8_2H_HOLYSTAFF_MORGANA@3"),
                ("Head", "T8_HEAD_PLATE_SET1@2"),
            ],
        )
        .await;

        let occurred_at = ts("2026-08-01T12:00:00Z");
        persist_battle_fingerprints(&db, battle_id, occurred_at, &RoleClassifier::default())
            .await
            .expect("persist should succeed");

        let fingerprints = fingerprint::Entity::find().all(&db).await.unwrap();
        assert_eq!(fingerprints.len(), 1);
        assert_eq!(fingerprints[0].mode, "full");
        assert_eq!(
            fingerprints[0].main_hand_base_item_id,
            "2H_HOLYSTAFF_MORGANA"
        );
        assert_eq!(fingerprints[0].first_seen_at, occurred_at);
        assert_eq!(fingerprints[0].last_seen_at, occurred_at);

        let observations = battle_loadout_observation::Entity::find()
            .filter(battle_loadout_observation::Column::BattleId.eq(battle_id))
            .all(&db)
            .await
            .unwrap();
        assert_eq!(observations.len(), 1);
        assert_eq!(observations[0].player_key, "id:victim");
        assert_eq!(observations[0].fingerprint_id, fingerprints[0].id);
        assert!(observations[0].is_friendly);
    }

    #[tokio::test]
    async fn a_player_who_never_died_gets_a_weapon_only_fingerprint() {
        let db = seed_db().await;
        let battle_id = 200;
        insert_player(&db, battle_id, "id:survivor", true, Some("T4_MAIN_MACE@1")).await;

        persist_battle_fingerprints(
            &db,
            battle_id,
            ts("2026-08-01T00:00:00Z"),
            &RoleClassifier::default(),
        )
        .await
        .expect("persist should succeed");

        let fingerprints = fingerprint::Entity::find().all(&db).await.unwrap();
        assert_eq!(fingerprints.len(), 1);
        assert_eq!(fingerprints[0].mode, "weapon_only");
        assert_eq!(fingerprints[0].main_hand_base_item_id, "MAIN_MACE");
    }

    #[tokio::test]
    async fn a_player_with_no_evidence_gets_nothing_and_the_call_still_succeeds() {
        let db = seed_db().await;
        let battle_id = 300;
        insert_player(&db, battle_id, "id:nobody", true, None).await;

        persist_battle_fingerprints(
            &db,
            battle_id,
            ts("2026-08-01T00:00:00Z"),
            &RoleClassifier::default(),
        )
        .await
        .expect("must succeed even when no player has any fingerprint evidence");

        assert_eq!(fingerprint::Entity::find().all(&db).await.unwrap().len(), 0);
        assert_eq!(
            battle_loadout_observation::Entity::find()
                .all(&db)
                .await
                .unwrap()
                .len(),
            0
        );
    }

    #[tokio::test]
    async fn re_hydrating_the_same_battle_does_not_duplicate_rows() {
        let db = seed_db().await;
        let battle_id = 400;
        insert_player(&db, battle_id, "id:p1", true, Some("T4_MAIN_MACE@1")).await;
        let occurred_at = ts("2026-08-01T00:00:00Z");

        persist_battle_fingerprints(&db, battle_id, occurred_at, &RoleClassifier::default())
            .await
            .unwrap();
        persist_battle_fingerprints(&db, battle_id, occurred_at, &RoleClassifier::default())
            .await
            .unwrap();

        assert_eq!(fingerprint::Entity::find().all(&db).await.unwrap().len(), 1);
        assert_eq!(
            battle_loadout_observation::Entity::find()
                .filter(battle_loadout_observation::Column::BattleId.eq(battle_id))
                .all(&db)
                .await
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn an_existing_fingerprints_match_is_never_touched_after_creation() {
        let db = seed_db().await;
        let creator = insert_user(&db).await;
        // A build that would have matched the observed weapon, seeded so the
        // history-simulating fingerprint row below can reference a real id.
        let build_id = insert_build(
            &db,
            creator,
            "Old Mace Build",
            "main",
            &[("weapon", "MAIN_MACE")],
            false,
        )
        .await;

        let seeded_at = ts("2026-08-01T00:00:00Z");
        let existing = fingerprint::ActiveModel {
            fingerprint: Set("weapon:MAIN_MACE".to_string()),
            mode: Set("weapon_only".to_string()),
            main_hand_base_item_id: Set("MAIN_MACE".to_string()),
            primary_role: Set(Some("tank".to_string())),
            slots_json: Set(r#"{"weapon":"MAIN_MACE"}"#.to_string()),
            matched_build_id: Set(Some(build_id)),
            matched_build_loadout: Set(Some("main".to_string())),
            match_status: Set("matched".to_string()),
            first_seen_at: Set(seeded_at),
            last_seen_at: Set(seeded_at),
            created_at: Set(chrono::Utc::now().into()),
            updated_at: Set(chrono::Utc::now().into()),
            ..Default::default()
        }
        .insert(&db)
        .await
        .expect("seed existing fingerprint");

        // Simulate the candidate builds having changed since: the
        // previously-matching build is archived, so if the match were
        // recomputed now it would come back Unmatched instead of Matched.
        let mut archive: build::ActiveModel = build::Entity::find_by_id(build_id)
            .one(&db)
            .await
            .unwrap()
            .unwrap()
            .into();
        archive.archived_at = Set(Some(ts("2026-08-02T00:00:00Z")));
        archive.update(&db).await.unwrap();

        let battle_id = 500;
        insert_player(&db, battle_id, "id:p1", true, Some("T4_MAIN_MACE@1")).await;
        let later = ts("2026-08-05T00:00:00Z");

        persist_battle_fingerprints(&db, battle_id, later, &RoleClassifier::default())
            .await
            .unwrap();

        let fingerprints = fingerprint::Entity::find().all(&db).await.unwrap();
        assert_eq!(
            fingerprints.len(),
            1,
            "the same fingerprint string must be reused, not duplicated"
        );
        let row = &fingerprints[0];
        assert_eq!(row.id, existing.id);
        assert_eq!(
            row.matched_build_id,
            Some(build_id),
            "an existing fingerprint's match must never be recomputed"
        );
        assert_eq!(row.matched_build_loadout.as_deref(), Some("main"));
        assert_eq!(row.match_status, "matched");
        assert_eq!(row.mode, "weapon_only");
        assert_eq!(row.main_hand_base_item_id, "MAIN_MACE");
        assert_eq!(row.slots_json, r#"{"weapon":"MAIN_MACE"}"#);
        assert_eq!(
            row.first_seen_at, seeded_at,
            "first_seen_at must not move when the new observation is later"
        );
        assert_eq!(
            row.last_seen_at, later,
            "last_seen_at must widen to the new, later observation"
        );
    }

    #[tokio::test]
    async fn an_archived_build_is_excluded_from_matching_candidates() {
        let db = seed_db().await;
        let creator = insert_user(&db).await;
        insert_build(
            &db,
            creator,
            "Archived Mace Build",
            "main",
            &[("weapon", "MAIN_MACE")],
            true,
        )
        .await;
        let active_build_id = insert_build(
            &db,
            creator,
            "Active Mace Build",
            "main",
            &[("weapon", "MAIN_MACE")],
            false,
        )
        .await;

        let battle_id = 600;
        insert_player(&db, battle_id, "id:p1", true, Some("T4_MAIN_MACE@1")).await;

        persist_battle_fingerprints(
            &db,
            battle_id,
            ts("2026-08-01T00:00:00Z"),
            &RoleClassifier::default(),
        )
        .await
        .unwrap();

        let fingerprints = fingerprint::Entity::find().all(&db).await.unwrap();
        assert_eq!(fingerprints.len(), 1);
        assert_eq!(
            fingerprints[0].matched_build_id,
            Some(active_build_id),
            "must match the non-archived build only — if the archived one were still a \
             candidate, two equally-scoring candidates would make this Ambiguous instead"
        );
        assert_eq!(fingerprints[0].match_status, "matched");
    }

    #[tokio::test]
    async fn friendly_and_enemy_players_both_get_fingerprints_with_correct_side_flag() {
        let db = seed_db().await;
        let battle_id = 700;
        insert_player(&db, battle_id, "id:friend", true, Some("T4_MAIN_MACE@1")).await;
        insert_player(&db, battle_id, "id:foe", false, Some("T8_2H_HOLYSTAFF@2")).await;

        persist_battle_fingerprints(
            &db,
            battle_id,
            ts("2026-08-01T00:00:00Z"),
            &RoleClassifier::default(),
        )
        .await
        .unwrap();

        assert_eq!(fingerprint::Entity::find().all(&db).await.unwrap().len(), 2);

        let observations = battle_loadout_observation::Entity::find()
            .filter(battle_loadout_observation::Column::BattleId.eq(battle_id))
            .all(&db)
            .await
            .unwrap();
        assert_eq!(observations.len(), 2);
        let friend = observations
            .iter()
            .find(|o| o.player_key == "id:friend")
            .expect("friendly observation must exist");
        let foe = observations
            .iter()
            .find(|o| o.player_key == "id:foe")
            .expect("enemy observation must exist");
        assert!(friend.is_friendly);
        assert!(!foe.is_friendly);
    }
}
