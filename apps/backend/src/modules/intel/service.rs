//! Intel service: persistence and orchestration for enemy scouting.

use std::collections::{BTreeMap, HashMap};

use sea_orm::{
    ActiveModelTrait, ColumnTrait, Condition, DatabaseConnection, EntityTrait, PaginatorTrait,
    QueryFilter, QueryOrder, Set, TransactionTrait,
};

use crate::errors::AppError;
use crate::modules::battles::entities as snapshot_entity;
use crate::modules::comps::entities::{build, build_item, comp, comp_build};
use crate::modules::comps::status::BuildSlot;
use crate::modules::events::service::BattleLinkingContext;
use crate::modules::intel::entities::{scouted_comp, scouted_comp_battle};
use crate::modules::intel::matchups::{best_counter, matchups, threat_score, MatchupReport};
use crate::modules::intel::models::{
    CounterSuggestion, ScoutFilters, ScoutOutcome, ScoutedCompDetail, ScoutedCompSummary,
    SimilarityHit, UpdateScoutRequest,
};
use crate::modules::intel::roles::{normalize_item_id, RoleClassifier};
use crate::modules::intel::scout::{is_same_comp, scout_from_snapshot, ScoutDraft, ScoutedPlayer};
use crate::modules::intel::similarity::{similarity, CompProfile};
use crate::modules::intel::status::IntelScoutCategory;
use crate::pagination::{PaginatedData, PaginationParams};

/// Persistence and orchestration for scouted enemy compositions.
#[derive(Debug, Clone, Default)]
pub struct IntelService;

impl IntelService {
    /// Creates a new service handle. Stateless; cheap to construct per request.
    #[must_use]
    pub fn new() -> Self {
        Self
    }

    /// Lists scouts, filtered and paginated.
    pub async fn list_scouts(
        &self,
        db: &DatabaseConnection,
        pagination: &PaginationParams,
        filters: &ScoutFilters,
    ) -> Result<PaginatedData<ScoutedCompSummary>, AppError> {
        let mut condition = Condition::all();
        if !filters.include_archived.unwrap_or(false) {
            condition = condition.add(scouted_comp::Column::IsArchived.eq(false));
        }
        if let Some(category) = filters.category.as_deref().filter(|s| !s.is_empty()) {
            // Reject unknown brackets rather than silently returning nothing.
            let parsed: IntelScoutCategory = category
                .parse()
                .map_err(|err: String| AppError::Validation(err))?;
            condition = condition.add(scouted_comp::Column::Category.eq(parsed.as_str()));
        }
        if let Some(guild_id) = filters.guild_id.as_deref().filter(|s| !s.is_empty()) {
            condition = condition.add(scouted_comp::Column::OpponentGuildId.eq(guild_id));
        }
        if let Some(q) = filters.q.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            let pattern = format!("%{q}%");
            condition = condition.add(
                Condition::any()
                    .add(scouted_comp::Column::Name.like(&pattern))
                    .add(scouted_comp::Column::OpponentGuildName.like(&pattern)),
            );
        }

        let query = scouted_comp::Entity::find().filter(condition);
        let query = match filters.sort.as_deref() {
            Some("threat") => query.order_by_desc(scouted_comp::Column::ThreatScore),
            Some("battles") => query.order_by_desc(scouted_comp::Column::SourceBattleCount),
            _ => query.order_by_desc(scouted_comp::Column::SavedAt),
        };

        let limit = pagination.limit();
        let paginator = query.paginate(db, limit);
        let total_items = paginator.num_items().await?;
        let total_pages = paginator.num_pages().await?;
        let page = pagination.offset_page();
        let rows = paginator.fetch_page(page.saturating_sub(1)).await?;

        let items = rows.iter().map(summary_from_model).collect();
        Ok(PaginatedData::new(
            items,
            total_items,
            total_pages,
            page,
            limit,
        ))
    }

    /// Loads one scout with its roster, source battles and matchup record.
    pub async fn get_scout(
        &self,
        db: &DatabaseConnection,
        id: i64,
    ) -> Result<ScoutedCompDetail, AppError> {
        let model = load_scout(db, id).await?;
        let battle_ids = source_battle_ids(db, id).await?;
        let players: Vec<ScoutedPlayer> = serde_json::from_str(&model.players_json)
            .map_err(|err| AppError::Internal(format!("malformed players_json on scout {id}: {err}")))?;
        let MatchupReport { rows, coverage } = matchups(db, &[id]).await?;
        let recommended_counter = best_counter(&rows, id).map(|best| CounterSuggestion {
            comp_id: best.our_comp_id,
            comp_name: best.our_comp_name.clone(),
            // Resemblance is not meaningful here: this is the comp that has
            // actually beaten the scout, which is a stronger signal.
            similarity: 0,
            battles: best.battles,
            wins: best.wins,
            losses: best.losses,
            win_rate: best.win_rate,
            tested: true,
        });

        Ok(ScoutedCompDetail {
            summary: summary_from_model(&model),
            players,
            source_battle_ids: battle_ids,
            fingerprint: model.fingerprint.clone(),
            matchups: rows,
            matchup_coverage: coverage,
            recommended_counter,
        })
    }

    /// Updates the officer-editable fields of a scout.
    pub async fn update_scout(
        &self,
        db: &DatabaseConnection,
        id: i64,
        req: &UpdateScoutRequest,
    ) -> Result<ScoutedCompDetail, AppError> {
        let model = load_scout(db, id).await?;
        let mut active: scouted_comp::ActiveModel = model.into();

        if let Some(name) = req.name.as_deref().map(str::trim) {
            if name.is_empty() {
                return Err(AppError::Validation("name must not be empty".to_string()));
            }
            active.name = Set(name.to_string());
        }
        if let Some(notes) = &req.notes {
            active.notes = Set(Some(notes.clone()));
        }
        if let Some(category) = req.category.as_deref() {
            let parsed: IntelScoutCategory = category
                .parse()
                .map_err(|err: String| AppError::Validation(err))?;
            active.category = Set(parsed.as_str().to_string());
        }
        if let Some(archived) = req.is_archived {
            active.is_archived = Set(archived);
        }
        active.updated_at = Set(chrono::Utc::now().into());
        active.update(db).await?;

        self.get_scout(db, id).await
    }

    /// Deletes a scout. Its battle links cascade away with it.
    pub async fn delete_scout(&self, db: &DatabaseConnection, id: i64) -> Result<(), AppError> {
        let model = load_scout(db, id).await?;
        scouted_comp::Entity::delete_by_id(model.id).exec(db).await?;
        Ok(())
    }

    /// Scouts one battle, creating or merging one comp per opposing guild.
    ///
    /// With `dry_run` the drafts are computed and returned but nothing is
    /// written, which is what the UI uses to preview before an officer commits.
    ///
    /// Re-scouting a battle already linked to a scout is a no-op for that
    /// scout: the unique index on `(scouted_comp_id, battle_id)` makes the
    /// whole operation idempotent, so the background worker can retry freely.
    pub async fn scout_battle(
        &self,
        db: &DatabaseConnection,
        guild_ctx: &BattleLinkingContext,
        battle_id: i64,
        dry_run: bool,
        created_by: Option<i64>,
    ) -> Result<Vec<ScoutOutcome>, AppError> {
        let snapshot = snapshot_entity::Entity::find()
            .filter(snapshot_entity::Column::BattleId.eq(battle_id))
            .one(db)
            .await?
            .ok_or_else(|| {
                AppError::NotFound(format!("no stored snapshot for battle {battle_id}"))
            })?;

        let classifier = RoleClassifier::load(db).await?;
        let drafts = scout_from_snapshot(&snapshot, guild_ctx, &classifier)?;
        if drafts.is_empty() {
            return Ok(Vec::new());
        }
        if dry_run {
            return Ok(drafts.iter().map(|d| outcome_from_draft(d, None, false, false)).collect());
        }

        let existing = scouted_comp::Entity::find().all(db).await?;
        let mut outcomes = Vec::with_capacity(drafts.len());

        for draft in &drafts {
            let matched = existing.iter().find(|row| is_same_comp(row, draft));
            let outcome = match matched {
                Some(row) => self.merge_draft(db, row, draft).await?,
                None => self.insert_draft(db, draft, created_by).await?,
            };
            outcomes.push(outcome);
        }
        Ok(outcomes)
    }

    /// Creates a new scout from a draft.
    async fn insert_draft(
        &self,
        db: &DatabaseConnection,
        draft: &ScoutDraft,
        created_by: Option<i64>,
    ) -> Result<ScoutOutcome, AppError> {
        let now = chrono::Utc::now().into();
        let txn = db.begin().await?;

        let active = scouted_comp::ActiveModel {
            name: Set(draft.name.clone()),
            opponent_guild_id: Set(draft.opponent_guild_id.clone()),
            opponent_guild_name: Set(draft.opponent_guild_name.clone()),
            opponent_alliance_name: Set(draft.opponent_alliance_name.clone()),
            category: Set(draft.category.as_str().to_string()),
            player_count: Set(draft.player_count as i32),
            weapon_sample_size: Set(draft.weapon_sample_size as i32),
            avg_ip: Set(draft.avg_ip),
            roles_json: Set(to_json(&draft.profile.roles)?),
            weapons_json: Set(to_json(&draft.profile.weapons)?),
            players_json: Set(to_json(&draft.players)?),
            fingerprint: Set(draft.fingerprint.clone()),
            source_battle_count: Set(1),
            threat_score: Set(draft.player_count as i32),
            notes: Set(None),
            is_archived: Set(false),
            first_seen_at: Set(draft.observed_at),
            saved_at: Set(draft.observed_at),
            created_by_user_id: Set(created_by),
            created_at: Set(now),
            updated_at: Set(now),
            ..Default::default()
        };
        let inserted = active.insert(&txn).await?;

        scouted_comp_battle::ActiveModel {
            scouted_comp_id: Set(inserted.id),
            battle_id: Set(draft.battle_id),
            linked_at: Set(now),
            ..Default::default()
        }
        .insert(&txn)
        .await?;

        txn.commit().await?;
        Ok(outcome_from_draft(draft, Some(inserted.id), false, false))
    }

    /// Folds a draft into an existing scout.
    ///
    /// Merge rules, matching the reference implementation: source battles are
    /// unioned, `saved_at` moves forward only, and the **larger** roster wins.
    /// That last rule is what makes partial kill-feed coverage self-correcting
    /// — each new sighting can only ever improve the picture, never degrade it.
    async fn merge_draft(
        &self,
        db: &DatabaseConnection,
        existing: &scouted_comp::Model,
        draft: &ScoutDraft,
    ) -> Result<ScoutOutcome, AppError> {
        let now: sea_orm::prelude::DateTimeWithTimeZone = chrono::Utc::now().into();
        let txn = db.begin().await?;

        let already_linked = scouted_comp_battle::Entity::find()
            .filter(scouted_comp_battle::Column::ScoutedCompId.eq(existing.id))
            .filter(scouted_comp_battle::Column::BattleId.eq(draft.battle_id))
            .one(&txn)
            .await?
            .is_some();

        if !already_linked {
            scouted_comp_battle::ActiveModel {
                scouted_comp_id: Set(existing.id),
                battle_id: Set(draft.battle_id),
                linked_at: Set(now),
                ..Default::default()
            }
            .insert(&txn)
            .await?;
        }

        let link_count = scouted_comp_battle::Entity::find()
            .filter(scouted_comp_battle::Column::ScoutedCompId.eq(existing.id))
            .count(&txn)
            .await?;

        let takes_roster = draft.player_count as i32 >= existing.player_count;
        let mut active: scouted_comp::ActiveModel = existing.clone().into();
        active.source_battle_count = Set(link_count as i32);
        active.updated_at = Set(now);
        if draft.observed_at > existing.saved_at {
            active.saved_at = Set(draft.observed_at);
        }
        if draft.observed_at < existing.first_seen_at {
            active.first_seen_at = Set(draft.observed_at);
        }
        if takes_roster {
            active.players_json = Set(to_json(&draft.players)?);
            active.roles_json = Set(to_json(&draft.profile.roles)?);
            active.weapons_json = Set(to_json(&draft.profile.weapons)?);
            active.fingerprint = Set(draft.fingerprint.clone());
            active.player_count = Set(draft.player_count as i32);
            active.weapon_sample_size = Set(draft.weapon_sample_size as i32);
            active.avg_ip = Set(draft.avg_ip);
            active.category = Set(draft.category.as_str().to_string());
        }
        active.update(&txn).await?;
        txn.commit().await?;

        // Threat depends on the matchup tally, which is outside this
        // transaction's scope; refresh it separately and tolerate failure.
        let _ = self.refresh_threat_score(db, existing.id).await;

        Ok(outcome_from_draft(
            draft,
            Some(existing.id),
            true,
            already_linked,
        ))
    }

    /// Recomputes and stores a scout's denormalized threat score.
    pub async fn refresh_threat_score(
        &self,
        db: &DatabaseConnection,
        scout_id: i64,
    ) -> Result<(), AppError> {
        let model = load_scout(db, scout_id).await?;
        let report = matchups(db, &[scout_id]).await?;
        let score = threat_score(&report.rows, scout_id, i64::from(model.player_count));
        let mut active: scouted_comp::ActiveModel = model.into();
        active.threat_score = Set(score as i32);
        active.update(db).await?;
        Ok(())
    }

    /// Ranks other scouts by how closely they resemble this one.
    pub async fn similar_scouts(
        &self,
        db: &DatabaseConnection,
        id: i64,
        limit: usize,
    ) -> Result<Vec<SimilarityHit>, AppError> {
        let target = load_scout(db, id).await?;
        let target_profile = profile_from_model(&target)?;
        let target_full = target.weapon_sample_size >= target.player_count;

        let mut hits: Vec<SimilarityHit> = Vec::new();
        for row in scouted_comp::Entity::find()
            .filter(scouted_comp::Column::Id.ne(id))
            .filter(scouted_comp::Column::IsArchived.eq(false))
            .all(db)
            .await?
        {
            let profile = profile_from_model(&row)?;
            hits.push(SimilarityHit {
                id: row.id,
                name: row.name.clone(),
                score: similarity(&target_profile, &profile),
                full_weapon_coverage: target_full
                    && row.weapon_sample_size >= row.player_count,
            });
        }
        hits.sort_by_key(|hit| std::cmp::Reverse(hit.score));
        hits.truncate(limit);
        Ok(hits)
    }

    /// Ranks our own comps against a scout, blending resemblance with record.
    ///
    /// Similarity alone cannot answer "what should we field": a comp that looks
    /// nothing like the enemy may still beat it. So both numbers are returned
    /// and `tested` marks whether the pairing has actually been fought, letting
    /// the UI distinguish evidence from inference.
    pub async fn counters(
        &self,
        db: &DatabaseConnection,
        id: i64,
        limit: usize,
    ) -> Result<Vec<CounterSuggestion>, AppError> {
        let target = load_scout(db, id).await?;
        let target_profile = profile_from_model(&target)?;
        let report = matchups(db, &[id]).await?;

        let comps = comp::Entity::find().all(db).await?;
        let profiles = our_comp_profiles(db).await?;

        let mut out: Vec<CounterSuggestion> = comps
            .into_iter()
            .map(|row| {
                let profile = profiles.get(&row.id).cloned().unwrap_or_default();
                let record = report
                    .rows
                    .iter()
                    .find(|m| m.our_comp_id == row.id && m.scouted_comp_id == id);
                CounterSuggestion {
                    comp_id: row.id,
                    comp_name: row.name,
                    similarity: similarity(&target_profile, &profile),
                    battles: record.map_or(0, |m| m.battles),
                    wins: record.map_or(0, |m| m.wins),
                    losses: record.map_or(0, |m| m.losses),
                    win_rate: record.map_or(0.0, |m| m.win_rate),
                    tested: record.is_some(),
                }
            })
            .collect();

        // Proven performance first, then resemblance for the untested ones.
        out.sort_by(|a, b| {
            b.tested
                .cmp(&a.tested)
                .then_with(|| {
                    b.win_rate
                        .partial_cmp(&a.win_rate)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .then_with(|| b.similarity.cmp(&a.similarity))
        });
        out.truncate(limit);
        Ok(out)
    }

    /// Ranks scouts by how much they threaten a given comp of ours.
    pub async fn threats_to_comp(
        &self,
        db: &DatabaseConnection,
        comp_id: i64,
        limit: usize,
    ) -> Result<Vec<SimilarityHit>, AppError> {
        let profiles = our_comp_profiles(db).await?;
        let profile = profiles.get(&comp_id).cloned().ok_or_else(|| {
            AppError::NotFound(format!("comp {comp_id} not found or has no builds"))
        })?;

        let mut hits: Vec<SimilarityHit> = Vec::new();
        for row in scouted_comp::Entity::find()
            .filter(scouted_comp::Column::IsArchived.eq(false))
            .all(db)
            .await?
        {
            let scout_profile = profile_from_model(&row)?;
            hits.push(SimilarityHit {
                id: row.id,
                name: row.name.clone(),
                score: similarity(&profile, &scout_profile),
                full_weapon_coverage: row.weapon_sample_size >= row.player_count,
            });
        }
        hits.sort_by_key(|hit| std::cmp::Reverse(hit.score));
        hits.truncate(limit);
        Ok(hits)
    }
}

/// Loads a scout or reports a clean 404.
async fn load_scout(
    db: &DatabaseConnection,
    id: i64,
) -> Result<scouted_comp::Model, AppError> {
    scouted_comp::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("scouted comp {id} not found")))
}

/// Battle ids a scout was built from, newest first.
async fn source_battle_ids(db: &DatabaseConnection, id: i64) -> Result<Vec<i64>, AppError> {
    Ok(scouted_comp_battle::Entity::find()
        .filter(scouted_comp_battle::Column::ScoutedCompId.eq(id))
        .order_by_desc(scouted_comp_battle::Column::LinkedAt)
        .all(db)
        .await?
        .into_iter()
        .map(|row| row.battle_id)
        .collect())
}

/// Expands every comp into the histogram shape similarity operates on.
///
/// A comp's `quantity` is expanded into that many virtual players, so our comps
/// and enemy scouts become directly comparable. Loaded in three bulk queries
/// with no N+1.
///
/// Comp variants (`comps.parent_id`) do **not** inherit their parent's builds:
/// a variant is defined by its own `comp_builds` rows, and inheriting would
/// double-count whenever a variant restates part of its parent.
pub async fn our_comp_profiles(
    db: &DatabaseConnection,
) -> Result<HashMap<i64, CompProfile>, AppError> {
    let comp_builds = comp_build::Entity::find().all(db).await?;
    if comp_builds.is_empty() {
        return Ok(HashMap::new());
    }

    let build_ids: Vec<i64> = {
        let mut ids: Vec<i64> = comp_builds.iter().map(|row| row.build_id).collect();
        ids.sort_unstable();
        ids.dedup();
        ids
    };

    let roles_by_build: HashMap<i64, String> = build::Entity::find()
        .filter(build::Column::Id.is_in(build_ids.clone()))
        .all(db)
        .await?
        .into_iter()
        .map(|row| (row.id, row.role))
        .collect();

    let weapon_by_build: HashMap<i64, String> = build_item::Entity::find()
        .filter(build_item::Column::BuildId.is_in(build_ids))
        .filter(build_item::Column::Slot.eq(BuildSlot::Weapon.to_string()))
        .all(db)
        .await?
        .into_iter()
        .map(|row| (row.build_id, normalize_item_id(&row.openalbion_item_name)))
        .collect();

    let mut profiles: HashMap<i64, CompProfile> = HashMap::new();
    for row in comp_builds {
        let Some(role) = roles_by_build.get(&row.build_id) else {
            continue;
        };
        let weapon = weapon_by_build.get(&row.build_id).map(String::as_str);
        let profile = profiles.entry(row.comp_id).or_default();
        for _ in 0..row.quantity.max(0) {
            profile.push_player(role, weapon);
        }
    }
    Ok(profiles)
}

/// Rebuilds the similarity profile stored on a scout row.
fn profile_from_model(model: &scouted_comp::Model) -> Result<CompProfile, AppError> {
    let roles: BTreeMap<String, i64> = serde_json::from_str(&model.roles_json).map_err(|err| {
        AppError::Internal(format!("malformed roles_json on scout {}: {err}", model.id))
    })?;
    let weapons: BTreeMap<String, i64> =
        serde_json::from_str(&model.weapons_json).map_err(|err| {
            AppError::Internal(format!("malformed weapons_json on scout {}: {err}", model.id))
        })?;
    Ok(CompProfile { roles, weapons })
}

/// Projects a stored scout into its list representation.
fn summary_from_model(model: &scouted_comp::Model) -> ScoutedCompSummary {
    let profile = profile_from_model(model).unwrap_or_default();
    ScoutedCompSummary {
        id: model.id,
        name: model.name.clone(),
        opponent_guild_id: model.opponent_guild_id.clone(),
        opponent_guild_name: model.opponent_guild_name.clone(),
        opponent_alliance_name: model.opponent_alliance_name.clone(),
        category: model.category.clone(),
        player_count: model.player_count,
        weapon_sample_size: model.weapon_sample_size,
        full_weapon_coverage: model.weapon_sample_size >= model.player_count,
        avg_ip: model.avg_ip,
        roles: profile.roles,
        weapons: profile.weapons,
        source_battle_count: model.source_battle_count,
        threat_score: model.threat_score,
        is_archived: model.is_archived,
        notes: model.notes.clone(),
        first_seen_at: model.first_seen_at.to_rfc3339(),
        saved_at: model.saved_at.to_rfc3339(),
    }
}

/// Builds the API view of a scouting result.
fn outcome_from_draft(
    draft: &ScoutDraft,
    id: Option<i64>,
    merged: bool,
    already_linked: bool,
) -> ScoutOutcome {
    ScoutOutcome {
        scouted_comp_id: id,
        name: draft.name.clone(),
        opponent_guild_name: draft.opponent_guild_name.clone(),
        category: draft.category.as_str().to_string(),
        player_count: draft.player_count,
        weapon_sample_size: draft.weapon_sample_size,
        merged,
        already_linked,
    }
}

/// Serializes a value into a JSON column, naming the failure clearly.
fn to_json<T: serde::Serialize>(value: &T) -> Result<String, AppError> {
    serde_json::to_string(value)
        .map_err(|err| AppError::Internal(format!("failed to serialize intel payload: {err}")))
}
