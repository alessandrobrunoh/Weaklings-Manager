//! Read-only queries backing the equipment fingerprint endpoints.
//!
//! `loadout_fingerprints` carries no observation-count rollup (see
//! `entities.rs`'s module doc comment) — every tally here (`observations`,
//! `friendly_observations`, `enemy_observations`) is computed from
//! `battle_loadout_observations` at read time.
//!
//! Rollups are folded in Rust from the matching `battle_loadout_observations`
//! rows rather than pushed into a conditional-count SQL aggregate, mirroring
//! the technique `enemies::service` already established for this exact class
//! of problem: plain, portable queries with no backend-specific casts or
//! window functions. For a list page, only the rows for that page's
//! fingerprint ids are fetched (never N+1); for a single detail view the
//! full observation history is already needed for the response, so the same
//! fetched rows are folded again for the rollup rather than queried twice.

use std::collections::{BTreeMap, HashMap};

use sea_orm::{
    ColumnTrait, DatabaseConnection, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect,
};

use crate::errors::AppError;
use crate::modules::comps::entities::build;
use crate::pagination::{PaginatedData, PaginationParams, SortOrder, resolve_sort_key};

use super::entities::{battle_loadout_observation, fingerprint};
use super::models::{
    BuildObservationSummary, FingerprintDetail, FingerprintObservationEntry, FingerprintRollup,
    FingerprintSummary, MetaEntry,
};

/// Stateless equipment-fingerprint read operations.
pub struct FingerprintsService;

impl Default for FingerprintsService {
    fn default() -> Self {
        Self
    }
}

impl FingerprintsService {
    /// Creates a new instance.
    #[must_use]
    pub fn new() -> Self {
        Self
    }

    /// Paginated list of fingerprints, most-recently-seen first by default.
    ///
    /// # Errors
    ///
    /// `400` for an unknown `sort` column; database errors otherwise.
    #[allow(clippy::too_many_arguments)]
    pub async fn list_fingerprints(
        &self,
        db: &DatabaseConnection,
        pagination: &PaginationParams,
        mode: Option<&str>,
        role: Option<&str>,
        match_status: Option<&str>,
        sort: Option<&str>,
        order: SortOrder,
    ) -> Result<PaginatedData<FingerprintSummary>, AppError> {
        let mut query = fingerprint::Entity::find();
        if let Some(mode) = non_blank(mode) {
            query = query.filter(fingerprint::Column::Mode.eq(mode));
        }
        if let Some(role) = non_blank(role) {
            query = query.filter(fingerprint::Column::PrimaryRole.eq(role));
        }
        if let Some(match_status) = non_blank(match_status) {
            query = query.filter(fingerprint::Column::MatchStatus.eq(match_status));
        }

        let sort_column = resolve_sort_key(
            sort,
            &[
                ("last_seen_at", fingerprint::Column::LastSeenAt),
                (
                    "main_hand_base_item_id",
                    fingerprint::Column::MainHandBaseItemId,
                ),
            ],
            fingerprint::Column::LastSeenAt,
        )?;
        query = match order {
            SortOrder::Asc => query
                .order_by_asc(sort_column)
                .order_by_asc(fingerprint::Column::Id),
            SortOrder::Desc => query
                .order_by_desc(sort_column)
                .order_by_desc(fingerprint::Column::Id),
        };

        let limit = pagination.limit();
        let page = pagination.offset_page();
        let paginator = query.paginate(db, limit);
        let total_items = paginator.num_items().await?;
        let total_pages = paginator.num_pages().await?;
        let models = paginator.fetch_page(page).await?;

        let ids: Vec<i64> = models.iter().map(|m| m.id).collect();
        let rollups = rollups_by_fingerprint(db, &ids).await?;

        let build_ids: Vec<i64> = models.iter().filter_map(|m| m.matched_build_id).collect();
        let build_names = build_names_by_id(db, &build_ids).await?;

        let items = models
            .into_iter()
            .map(|m| {
                let rollup = rollups.get(&m.id).cloned().unwrap_or_default();
                let matched_build_name = m
                    .matched_build_id
                    .and_then(|bid| build_names.get(&bid).cloned());
                FingerprintSummary {
                    id: m.id,
                    fingerprint: m.fingerprint,
                    mode: m.mode,
                    main_hand_base_item_id: m.main_hand_base_item_id,
                    primary_role: m.primary_role,
                    matched_build_id: m.matched_build_id,
                    matched_build_name,
                    matched_build_loadout: m.matched_build_loadout,
                    match_status: m.match_status,
                    first_seen_at: m.first_seen_at.to_rfc3339(),
                    last_seen_at: m.last_seen_at.to_rfc3339(),
                    rollup,
                }
            })
            .collect();

        Ok(PaginatedData::new(
            items,
            total_items,
            total_pages,
            page + 1,
            limit,
        ))
    }

    /// Full detail view for one fingerprint: identity, parsed slots, matched
    /// build name, observation-derived tallies, and its full observation
    /// history (newest first).
    ///
    /// # Errors
    ///
    /// `404` if `id` does not exist; `500` if `slots_json` fails to parse
    /// (should never happen — only this codebase's own writer produces it);
    /// database errors otherwise.
    pub async fn get_fingerprint(
        &self,
        db: &DatabaseConnection,
        id: i64,
    ) -> Result<FingerprintDetail, AppError> {
        let model = fingerprint::Entity::find_by_id(id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("fingerprint {id} not found")))?;

        let slots: BTreeMap<String, String> =
            serde_json::from_str(&model.slots_json).map_err(|err| {
                AppError::Internal(format!(
                    "fingerprint {id} has unparseable slots_json: {err}"
                ))
            })?;

        let matched_build_name = match model.matched_build_id {
            Some(build_id) => build::Entity::find_by_id(build_id)
                .one(db)
                .await?
                .map(|b| b.name),
            None => None,
        };

        let observation_models = battle_loadout_observation::Entity::find()
            .filter(battle_loadout_observation::Column::FingerprintId.eq(id))
            .order_by_desc(battle_loadout_observation::Column::OccurredAt)
            .order_by_desc(battle_loadout_observation::Column::Id)
            .all(db)
            .await?;
        let rollup = rollup_from_observations(&observation_models);

        let observations = observation_models
            .into_iter()
            .map(|o| FingerprintObservationEntry {
                battle_id: o.battle_id,
                player_key: o.player_key,
                is_friendly: o.is_friendly,
                occurred_at: o.occurred_at.to_rfc3339(),
            })
            .collect();

        Ok(FingerprintDetail {
            id: model.id,
            fingerprint: model.fingerprint,
            mode: model.mode,
            main_hand_base_item_id: model.main_hand_base_item_id,
            primary_role: model.primary_role,
            matched_build_id: model.matched_build_id,
            matched_build_name,
            matched_build_loadout: model.matched_build_loadout,
            match_status: model.match_status,
            first_seen_at: model.first_seen_at.to_rfc3339(),
            last_seen_at: model.last_seen_at.to_rfc3339(),
            slots,
            rollup,
            observations,
        })
    }

    /// One internal build's observed usage: every fingerprint ever matched to
    /// it, plus aggregate observation tallies across all of them. Never
    /// having been observed is a valid, meaningful answer — a zeroed rollup,
    /// not a 404.
    ///
    /// # Errors
    ///
    /// `404` if `build_id` does not exist; database errors otherwise.
    pub async fn get_build_observations(
        &self,
        db: &DatabaseConnection,
        build_id: i64,
    ) -> Result<BuildObservationSummary, AppError> {
        let build_model = build::Entity::find_by_id(build_id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("build {build_id} not found")))?;

        let matched_fingerprints = fingerprint::Entity::find()
            .filter(fingerprint::Column::MatchedBuildId.eq(build_id))
            .order_by_asc(fingerprint::Column::Id)
            .all(db)
            .await?;
        let matched_fingerprint_ids: Vec<i64> = matched_fingerprints.iter().map(|m| m.id).collect();

        let rollup = if matched_fingerprint_ids.is_empty() {
            FingerprintRollup::default()
        } else {
            let observations = battle_loadout_observation::Entity::find()
                .filter(
                    battle_loadout_observation::Column::FingerprintId
                        .is_in(matched_fingerprint_ids.clone()),
                )
                .all(db)
                .await?;
            rollup_from_observations(&observations)
        };

        Ok(BuildObservationSummary {
            build_id: build_model.id,
            build_name: build_model.name,
            fingerprints_matched: i64::try_from(matched_fingerprint_ids.len()).unwrap_or(i64::MAX),
            rollup,
            matched_fingerprint_ids,
        })
    }

    /// Current meta for one side: fingerprints ranked by observation count on
    /// just that side, descending, capped at `limit`. A fingerprint with zero
    /// observations on the requested side never appears.
    ///
    /// # Errors
    ///
    /// `400` (`AppError::Validation`) if `side` is not exactly `"friendly"` or
    /// `"enemy"`; database errors otherwise.
    pub async fn meta(
        &self,
        db: &DatabaseConnection,
        side: &str,
        limit: u64,
    ) -> Result<Vec<MetaEntry>, AppError> {
        let is_friendly = match side {
            "friendly" => true,
            "enemy" => false,
            other => {
                return Err(AppError::Validation(format!(
                    "invalid side '{other}': expected 'friendly' or 'enemy'"
                )));
            }
        };

        let fingerprint_ids: Vec<i64> = battle_loadout_observation::Entity::find()
            .select_only()
            .column(battle_loadout_observation::Column::FingerprintId)
            .filter(battle_loadout_observation::Column::IsFriendly.eq(is_friendly))
            .into_tuple::<i64>()
            .all(db)
            .await?;

        let mut counts: HashMap<i64, i64> = HashMap::new();
        for id in fingerprint_ids {
            *counts.entry(id).or_insert(0) += 1;
        }

        let mut ranked: Vec<(i64, i64)> = counts.into_iter().collect();
        ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        let limit_usize = usize::try_from(limit).unwrap_or(usize::MAX);
        ranked.truncate(limit_usize);

        let top_ids: Vec<i64> = ranked.iter().map(|(id, _)| *id).collect();
        if top_ids.is_empty() {
            return Ok(Vec::new());
        }

        let models = fingerprint::Entity::find()
            .filter(fingerprint::Column::Id.is_in(top_ids))
            .all(db)
            .await?;
        let models_by_id: HashMap<i64, fingerprint::Model> =
            models.into_iter().map(|m| (m.id, m)).collect();

        let build_ids: Vec<i64> = models_by_id
            .values()
            .filter_map(|m| m.matched_build_id)
            .collect();
        let build_names = build_names_by_id(db, &build_ids).await?;

        Ok(ranked
            .into_iter()
            .filter_map(|(id, count)| {
                let model = models_by_id.get(&id)?;
                let matched_build_name = model
                    .matched_build_id
                    .and_then(|bid| build_names.get(&bid).cloned());
                Some(MetaEntry {
                    fingerprint_id: model.id,
                    fingerprint: model.fingerprint.clone(),
                    main_hand_base_item_id: model.main_hand_base_item_id.clone(),
                    primary_role: model.primary_role.clone(),
                    matched_build_name,
                    observations: count,
                    last_seen_at: model.last_seen_at.to_rfc3339(),
                })
            })
            .collect())
    }
}

/// Normalizes an optional filter value: `None` for absent/blank input, so
/// callers can skip filtering entirely.
fn non_blank(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|s| !s.is_empty())
}

/// Folds a slice of observation rows into the summary tallies.
fn rollup_from_observations(
    observations: &[battle_loadout_observation::Model],
) -> FingerprintRollup {
    let mut friendly = 0_i64;
    let mut enemy = 0_i64;
    for o in observations {
        if o.is_friendly {
            friendly += 1;
        } else {
            enemy += 1;
        }
    }
    FingerprintRollup {
        observations: friendly + enemy,
        friendly_observations: friendly,
        enemy_observations: enemy,
    }
}

/// Observation-derived tallies for a page of fingerprint ids, computed by
/// fetching every matching `battle_loadout_observations` row and folding in
/// Rust. A fingerprint with no observations simply has no entry in the
/// returned map. Empty input short-circuits to no query.
async fn rollups_by_fingerprint(
    db: &DatabaseConnection,
    fingerprint_ids: &[i64],
) -> Result<HashMap<i64, FingerprintRollup>, AppError> {
    if fingerprint_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let observations = battle_loadout_observation::Entity::find()
        .filter(battle_loadout_observation::Column::FingerprintId.is_in(fingerprint_ids.to_vec()))
        .all(db)
        .await?;

    let mut grouped: HashMap<i64, Vec<battle_loadout_observation::Model>> = HashMap::new();
    for o in observations {
        grouped.entry(o.fingerprint_id).or_default().push(o);
    }

    Ok(grouped
        .into_iter()
        .map(|(id, rows)| (id, rollup_from_observations(&rows)))
        .collect())
}

/// Display names for the given build ids, keyed by id. Empty input
/// short-circuits to no query; a deleted build is simply absent from the map.
async fn build_names_by_id(
    db: &DatabaseConnection,
    build_ids: &[i64],
) -> Result<HashMap<i64, String>, AppError> {
    if build_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let mut ids = build_ids.to_vec();
    ids.sort_unstable();
    ids.dedup();
    let builds = build::Entity::find()
        .filter(build::Column::Id.is_in(ids))
        .all(db)
        .await?;
    Ok(builds.into_iter().map(|b| (b.id, b.name)).collect())
}

#[cfg(test)]
mod tests {
    use chrono::{DateTime, FixedOffset};
    use sea_orm::{ActiveModelTrait, ActiveValue::Set, Database};

    use super::*;
    use crate::migration::MigratorTrait;
    use crate::modules::comps::entities::build_category;
    use crate::modules::users::entities as user_entities;
    use crate::pagination::PaginationParams;

    async fn seed_db() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:").await.expect("connect");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("migrate");
        db
    }

    fn ts(s: &str) -> DateTime<FixedOffset> {
        DateTime::parse_from_rfc3339(s).expect("hard-coded timestamp")
    }

    fn default_pagination() -> PaginationParams {
        PaginationParams {
            page: None,
            limit: None,
        }
    }

    /// Minimal fixture chain (user -> build category -> build) so tests can
    /// exercise `matched_build_id` joins without depending on the comps
    /// module's own test helpers.
    async fn insert_build(db: &DatabaseConnection, name: &str, role: &str) -> i64 {
        let user_id = user_entities::ActiveModel {
            username: Set(format!("creator-{name}")),
            email: Set(format!("creator-{name}@example.com")),
            role: Set("member".to_string()),
            discord_id: Set(Some(format!("discord-{name}"))),
            created_at: Set(ts("2026-01-01T00:00:00Z")),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert user")
        .id;

        let category_id = build_category::ActiveModel {
            name: Set("Category".to_string()),
            slug: Set(format!("category-{name}")),
            description: Set(None),
            created_at: Set(ts("2026-01-01T00:00:00Z")),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert category")
        .id;

        build::ActiveModel {
            name: Set(name.to_string()),
            description: Set(None),
            role: Set(role.to_string()),
            category_id: Set(category_id),
            version: Set(1),
            created_by: Set(user_id),
            created_at: Set(ts("2026-01-01T00:00:00Z")),
            updated_at: Set(ts("2026-01-01T00:00:00Z")),
            archived_at: Set(None),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert build")
        .id
    }

    #[allow(clippy::too_many_arguments)]
    async fn insert_fingerprint(
        db: &DatabaseConnection,
        fp: &str,
        mode: &str,
        main_hand_base_item_id: &str,
        primary_role: Option<&str>,
        slots_json: &str,
        matched_build_id: Option<i64>,
        matched_build_loadout: Option<&str>,
        match_status: &str,
        first_seen_at: &str,
        last_seen_at: &str,
    ) -> i64 {
        fingerprint::ActiveModel {
            fingerprint: Set(fp.to_string()),
            mode: Set(mode.to_string()),
            main_hand_base_item_id: Set(main_hand_base_item_id.to_string()),
            primary_role: Set(primary_role.map(str::to_string)),
            slots_json: Set(slots_json.to_string()),
            matched_build_id: Set(matched_build_id),
            matched_build_loadout: Set(matched_build_loadout.map(str::to_string)),
            match_status: Set(match_status.to_string()),
            first_seen_at: Set(ts(first_seen_at)),
            last_seen_at: Set(ts(last_seen_at)),
            created_at: Set(ts(first_seen_at)),
            updated_at: Set(ts(last_seen_at)),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert fingerprint")
        .id
    }

    #[allow(clippy::too_many_arguments)]
    async fn insert_observation(
        db: &DatabaseConnection,
        battle_id: i64,
        player_key: &str,
        is_friendly: bool,
        fingerprint_id: i64,
        occurred_at: &str,
    ) {
        battle_loadout_observation::ActiveModel {
            battle_id: Set(battle_id),
            player_key: Set(player_key.to_string()),
            is_friendly: Set(is_friendly),
            fingerprint_id: Set(fingerprint_id),
            occurred_at: Set(ts(occurred_at)),
            created_at: Set(ts(occurred_at)),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert observation");
    }

    #[tokio::test]
    async fn list_fingerprints_sorts_by_last_seen_desc_by_default_and_computes_rollups() {
        let db = seed_db().await;
        let old_fp = insert_fingerprint(
            &db,
            "weapon:T4_MAIN",
            "weapon_only",
            "T4_MAIN",
            None,
            "{\"weapon\":\"T4_MAIN\"}",
            None,
            None,
            "unmatched",
            "2026-01-01T00:00:00Z",
            "2026-01-02T00:00:00Z",
        )
        .await;
        let new_fp = insert_fingerprint(
            &db,
            "weapon:T8_MAIN",
            "full",
            "T8_MAIN",
            Some("dps"),
            "{\"weapon\":\"T8_MAIN\"}",
            None,
            None,
            "unmatched",
            "2026-02-01T00:00:00Z",
            "2026-02-05T00:00:00Z",
        )
        .await;
        insert_observation(&db, 100, "id:p1", true, new_fp, "2026-02-01T00:00:00Z").await;
        insert_observation(&db, 101, "id:p2", false, new_fp, "2026-02-05T00:00:00Z").await;

        let service = FingerprintsService::new();
        let page = service
            .list_fingerprints(
                &db,
                &default_pagination(),
                None,
                None,
                None,
                None,
                SortOrder::Desc,
            )
            .await
            .expect("list");

        assert_eq!(page.total_items, 2);
        assert_eq!(page.items[0].id, new_fp, "newest last_seen_at first");
        assert_eq!(page.items[0].rollup.observations, 2);
        assert_eq!(page.items[0].rollup.friendly_observations, 1);
        assert_eq!(page.items[0].rollup.enemy_observations, 1);
        assert_eq!(page.items[1].id, old_fp);
        assert_eq!(
            page.items[1].rollup.observations, 0,
            "no observations => zeroed rollup, not absent"
        );
    }

    #[tokio::test]
    async fn list_fingerprints_filters_by_mode_role_and_match_status() {
        let db = seed_db().await;
        insert_fingerprint(
            &db,
            "weapon:A",
            "full",
            "A",
            Some("dps"),
            "{}",
            None,
            None,
            "matched",
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
        )
        .await;
        insert_fingerprint(
            &db,
            "weapon:B",
            "weapon_only",
            "B",
            Some("healer"),
            "{}",
            None,
            None,
            "unmatched",
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
        )
        .await;

        let service = FingerprintsService::new();

        let by_mode = service
            .list_fingerprints(
                &db,
                &default_pagination(),
                Some("full"),
                None,
                None,
                None,
                SortOrder::Desc,
            )
            .await
            .expect("list");
        assert_eq!(by_mode.total_items, 1);
        assert_eq!(by_mode.items[0].main_hand_base_item_id, "A");

        let by_role = service
            .list_fingerprints(
                &db,
                &default_pagination(),
                None,
                Some("healer"),
                None,
                None,
                SortOrder::Desc,
            )
            .await
            .expect("list");
        assert_eq!(by_role.total_items, 1);
        assert_eq!(by_role.items[0].main_hand_base_item_id, "B");

        let by_status = service
            .list_fingerprints(
                &db,
                &default_pagination(),
                None,
                None,
                Some("matched"),
                None,
                SortOrder::Desc,
            )
            .await
            .expect("list");
        assert_eq!(by_status.total_items, 1);
        assert_eq!(by_status.items[0].main_hand_base_item_id, "A");
    }

    #[tokio::test]
    async fn list_fingerprints_includes_matched_build_name() {
        let db = seed_db().await;
        let build_id = insert_build(&db, "Holy Healer", "healer").await;
        insert_fingerprint(
            &db,
            "weapon:T8_HOLY",
            "full",
            "T8_HOLY",
            Some("healer"),
            "{}",
            Some(build_id),
            Some("main"),
            "matched",
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
        )
        .await;

        let service = FingerprintsService::new();
        let page = service
            .list_fingerprints(
                &db,
                &default_pagination(),
                None,
                None,
                None,
                None,
                SortOrder::Desc,
            )
            .await
            .expect("list");
        assert_eq!(
            page.items[0].matched_build_name.as_deref(),
            Some("Holy Healer")
        );
    }

    #[tokio::test]
    async fn list_fingerprints_sort_by_main_hand_base_item_id_ascending() {
        let db = seed_db().await;
        insert_fingerprint(
            &db,
            "weapon:Zulu",
            "full",
            "Z_ITEM",
            None,
            "{}",
            None,
            None,
            "unmatched",
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
        )
        .await;
        insert_fingerprint(
            &db,
            "weapon:Alpha",
            "full",
            "A_ITEM",
            None,
            "{}",
            None,
            None,
            "unmatched",
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
        )
        .await;

        let service = FingerprintsService::new();
        let page = service
            .list_fingerprints(
                &db,
                &default_pagination(),
                None,
                None,
                None,
                Some("main_hand_base_item_id"),
                SortOrder::Asc,
            )
            .await
            .expect("list");
        assert_eq!(page.items[0].main_hand_base_item_id, "A_ITEM");
        assert_eq!(page.items[1].main_hand_base_item_id, "Z_ITEM");
    }

    #[tokio::test]
    async fn list_fingerprints_rejects_unknown_sort_column() {
        let db = seed_db().await;
        let service = FingerprintsService::new();
        let err = service
            .list_fingerprints(
                &db,
                &default_pagination(),
                None,
                None,
                None,
                Some("fame"),
                SortOrder::Desc,
            )
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[tokio::test]
    async fn list_fingerprints_paginates() {
        let db = seed_db().await;
        for i in 0..3 {
            insert_fingerprint(
                &db,
                &format!("weapon:{i}"),
                "full",
                &format!("ITEM_{i}"),
                None,
                "{}",
                None,
                None,
                "unmatched",
                "2026-01-01T00:00:00Z",
                &format!("2026-01-0{}T00:00:00Z", i + 1),
            )
            .await;
        }
        let service = FingerprintsService::new();
        let pagination = PaginationParams {
            page: Some(1),
            limit: Some(2),
        };
        let page = service
            .list_fingerprints(&db, &pagination, None, None, None, None, SortOrder::Desc)
            .await
            .expect("list");
        assert_eq!(page.items.len(), 2);
        assert_eq!(page.total_items, 3);
        assert_eq!(page.total_pages, 2);
    }

    #[tokio::test]
    async fn get_fingerprint_returns_detail_with_slots_history_and_rollup() {
        let db = seed_db().await;
        let build_id = insert_build(&db, "Test Build", "dps").await;
        let fp = insert_fingerprint(
            &db,
            "weapon:T8_MAIN|head:T8_HEAD",
            "full",
            "T8_MAIN",
            Some("dps"),
            "{\"weapon\":\"T8_MAIN\",\"head\":\"T8_HEAD\"}",
            Some(build_id),
            Some("main"),
            "matched",
            "2026-01-01T00:00:00Z",
            "2026-02-01T00:00:00Z",
        )
        .await;
        insert_observation(&db, 100, "id:p1", true, fp, "2026-01-01T00:00:00Z").await;
        insert_observation(&db, 101, "id:p2", false, fp, "2026-02-01T00:00:00Z").await;

        let service = FingerprintsService::new();
        let detail = service.get_fingerprint(&db, fp).await.expect("detail");

        assert_eq!(detail.matched_build_name.as_deref(), Some("Test Build"));
        assert_eq!(
            detail.slots.get("weapon").map(String::as_str),
            Some("T8_MAIN")
        );
        assert_eq!(
            detail.slots.get("head").map(String::as_str),
            Some("T8_HEAD")
        );
        assert_eq!(detail.rollup.observations, 2);
        assert_eq!(detail.rollup.friendly_observations, 1);
        assert_eq!(detail.rollup.enemy_observations, 1);
        assert_eq!(detail.observations.len(), 2);
        assert_eq!(
            detail.observations[0].battle_id, 101,
            "newest observation first"
        );
        assert_eq!(detail.observations[1].battle_id, 100);
    }

    #[tokio::test]
    async fn get_fingerprint_returns_not_found_for_unknown_id() {
        let db = seed_db().await;
        let service = FingerprintsService::new();
        let err = service.get_fingerprint(&db, 999).await.unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[tokio::test]
    async fn get_fingerprint_returns_internal_error_for_unparseable_slots_json() {
        let db = seed_db().await;
        let fp = insert_fingerprint(
            &db,
            "weapon:T8_MAIN",
            "full",
            "T8_MAIN",
            None,
            "not valid json",
            None,
            None,
            "unmatched",
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
        )
        .await;
        let service = FingerprintsService::new();
        let err = service.get_fingerprint(&db, fp).await.unwrap_err();
        assert!(matches!(err, AppError::Internal(_)));
    }

    #[tokio::test]
    async fn get_build_observations_aggregates_across_every_matched_fingerprint() {
        let db = seed_db().await;
        let build_id = insert_build(&db, "Meta Build", "dps").await;
        let fp1 = insert_fingerprint(
            &db,
            "weapon:A",
            "full",
            "A",
            Some("dps"),
            "{}",
            Some(build_id),
            Some("main"),
            "matched",
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
        )
        .await;
        let fp2 = insert_fingerprint(
            &db,
            "weapon:A_swap",
            "full",
            "A",
            Some("dps"),
            "{}",
            Some(build_id),
            Some("swap"),
            "matched",
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
        )
        .await;
        insert_observation(&db, 1, "id:p1", true, fp1, "2026-01-01T00:00:00Z").await;
        insert_observation(&db, 2, "id:p2", false, fp1, "2026-01-01T00:00:00Z").await;
        insert_observation(&db, 3, "id:p3", true, fp2, "2026-01-01T00:00:00Z").await;

        let service = FingerprintsService::new();
        let summary = service
            .get_build_observations(&db, build_id)
            .await
            .expect("summary");

        assert_eq!(summary.build_name, "Meta Build");
        assert_eq!(summary.fingerprints_matched, 2);
        assert_eq!(summary.rollup.observations, 3);
        assert_eq!(summary.rollup.friendly_observations, 2);
        assert_eq!(summary.rollup.enemy_observations, 1);
        assert_eq!(summary.matched_fingerprint_ids.len(), 2);
        assert!(summary.matched_fingerprint_ids.contains(&fp1));
        assert!(summary.matched_fingerprint_ids.contains(&fp2));
    }

    #[tokio::test]
    async fn get_build_observations_returns_zeroed_rollup_when_never_observed() {
        let db = seed_db().await;
        let build_id = insert_build(&db, "Unused Build", "dps").await;

        let service = FingerprintsService::new();
        let summary = service
            .get_build_observations(&db, build_id)
            .await
            .expect("summary");

        assert_eq!(summary.fingerprints_matched, 0);
        assert_eq!(summary.rollup.observations, 0);
        assert!(summary.matched_fingerprint_ids.is_empty());
    }

    #[tokio::test]
    async fn get_build_observations_returns_not_found_for_unknown_build() {
        let db = seed_db().await;
        let service = FingerprintsService::new();
        let err = service.get_build_observations(&db, 999).await.unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[tokio::test]
    async fn meta_ranks_by_observation_count_scoped_to_side() {
        let db = seed_db().await;
        let popular_enemy = insert_fingerprint(
            &db,
            "weapon:Popular",
            "full",
            "POPULAR",
            None,
            "{}",
            None,
            None,
            "unmatched",
            "2026-01-01T00:00:00Z",
            "2026-01-05T00:00:00Z",
        )
        .await;
        let rare_enemy = insert_fingerprint(
            &db,
            "weapon:Rare",
            "full",
            "RARE",
            None,
            "{}",
            None,
            None,
            "unmatched",
            "2026-01-01T00:00:00Z",
            "2026-01-05T00:00:00Z",
        )
        .await;
        let friendly_only = insert_fingerprint(
            &db,
            "weapon:FriendlyOnly",
            "full",
            "FRIENDLY_ONLY",
            None,
            "{}",
            None,
            None,
            "unmatched",
            "2026-01-01T00:00:00Z",
            "2026-01-05T00:00:00Z",
        )
        .await;

        insert_observation(
            &db,
            1,
            "id:p1",
            false,
            popular_enemy,
            "2026-01-01T00:00:00Z",
        )
        .await;
        insert_observation(
            &db,
            2,
            "id:p2",
            false,
            popular_enemy,
            "2026-01-02T00:00:00Z",
        )
        .await;
        insert_observation(
            &db,
            3,
            "id:p3",
            false,
            popular_enemy,
            "2026-01-03T00:00:00Z",
        )
        .await;
        insert_observation(&db, 4, "id:p4", false, rare_enemy, "2026-01-04T00:00:00Z").await;
        insert_observation(&db, 5, "id:p5", true, friendly_only, "2026-01-05T00:00:00Z").await;

        let service = FingerprintsService::new();
        let meta = service.meta(&db, "enemy", 20).await.expect("meta");

        assert_eq!(meta.len(), 2, "friendly-only fingerprint excluded");
        assert_eq!(meta[0].fingerprint_id, popular_enemy);
        assert_eq!(meta[0].observations, 3);
        assert_eq!(meta[1].fingerprint_id, rare_enemy);
        assert_eq!(meta[1].observations, 1);
        assert!(
            !meta
                .iter()
                .any(|entry| entry.fingerprint_id == friendly_only),
            "zero enemy observations => never appears in enemy meta"
        );
    }

    #[tokio::test]
    async fn meta_respects_limit() {
        let db = seed_db().await;
        for i in 0..5 {
            let fp = insert_fingerprint(
                &db,
                &format!("weapon:{i}"),
                "full",
                &format!("ITEM_{i}"),
                None,
                "{}",
                None,
                None,
                "unmatched",
                "2026-01-01T00:00:00Z",
                "2026-01-01T00:00:00Z",
            )
            .await;
            insert_observation(
                &db,
                i,
                &format!("id:p{i}"),
                false,
                fp,
                "2026-01-01T00:00:00Z",
            )
            .await;
        }

        let service = FingerprintsService::new();
        let meta = service.meta(&db, "enemy", 2).await.expect("meta");
        assert_eq!(meta.len(), 2);
    }

    #[tokio::test]
    async fn meta_rejects_invalid_side() {
        let db = seed_db().await;
        let service = FingerprintsService::new();
        let err = service.meta(&db, "nope", 20).await.unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }
}
