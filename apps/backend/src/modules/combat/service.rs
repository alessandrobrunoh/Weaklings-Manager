//! Database-facing layer over the pure Item Power calculator.
//!
//! Everything arithmetic lives in [`super::ip`]; this module only turns rows into the plain structs
//! that calculator takes — a build's `build_items` into [`EquippedItem`]s, and a member's
//! `user_specializations` into [`SpecLevels`].

use std::collections::HashMap;

use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseConnection, EntityTrait,
    PaginatorTrait, QueryFilter, QueryOrder, Set, TransactionTrait,
};

use super::dataset::{combat_items, combat_rules, combat_spells, dataset_version, spec_node};
use super::entities::combat_run;
use super::entities::combat_run::Column as CombatRunColumn;
use super::entities::combat_scenario;
use super::entities::combat_scenario::Column as CombatScenarioColumn;
use super::fit;
use super::ip::{self, EquippedItem, SpecLevels};
use super::models::{
    BlockingNode, BuildRosterFitView, CombatDatasetView, CreateScenarioRequest, ItemPowerRequest,
    ItemPowerView, LoadoutItemRequest, MemberItemPowerView, RunDetail, RunSummary,
    ScenarioDefinition, ScenarioDetail, ScenarioSummary, ScenarioVersionRef, SpecSource,
    UpdateScenarioRequest,
};
use crate::errors::AppError;
use crate::modules::comps::entities::build_item::{
    Column as BuildItemColumn, Entity as BuildItemEntity,
};
use crate::modules::comps::entities::{build, comp};
use crate::modules::comps::status::{
    BuildLoadout, BuildSlot, DEFAULT_ITEM_QUALITY, parse_item_quality,
};
use crate::modules::openalbion::service::{base_identifier, base_identifier_for_stored_item};
use crate::modules::users::specializations;

/// The tier assumed when a caller supplies an identifier with no tier prefix.
///
/// Eight, because every guild loadout is T8 in practice and a bare `2H_POLEHAMMER` from a client
/// almost certainly means the one being flown, not a T4.
const ASSUMED_TIER: u8 = 8;

/// How many members a build-fit listing returns at most, so a large guild cannot produce an
/// unbounded response.
const MAX_FIT_MEMBERS: usize = 200;

/// Item Power and, later, the rest of the combat mathematics.
#[derive(Clone, Copy, Default)]
pub struct CombatService;

impl CombatService {
    /// Creates a new service handle.
    #[must_use]
    pub const fn new() -> Self {
        Self
    }

    /// What the bundled dataset contains and which dumps commit produced it.
    ///
    /// An associated function rather than a method: the dataset is compiled into the binary, so
    /// reading it needs no handle.
    #[must_use]
    pub fn dataset() -> CombatDatasetView {
        CombatDatasetView {
            dataset_version: dataset_version().clone(),
            items: combat_items().len(),
            spells: combat_spells().len(),
            destiny_nodes: combat_rules().spec_nodes.len(),
        }
    }

    /// Every equippable base identifier that has a Destiny Board specialization, mapped to the
    /// family mastery node above it — `"2H_POLEHAMMER" -> "COMBAT_HAMMERS"`.
    ///
    /// An associated function: the mapping is derived entirely from the compiled-in dataset. It
    /// exists so a client can attach a family-mastery level control to *one specific item's* entry
    /// rather than needing to reconcile its own weapon/armor grouping against the game's — capes,
    /// bags and gathering gear are simply absent, matching [`super::ip::EquippedItem::spec_node_id`].
    #[must_use]
    pub fn mastery_groups() -> std::collections::BTreeMap<String, String> {
        combat_items()
            .iter()
            .filter_map(|(base, item)| {
                let parent = spec_node(item.spec_node.as_deref()?)?.parent.as_deref()?;
                Some((base.clone(), parent.to_string()))
            })
            .collect()
    }

    /// Item Power for a loadout the caller describes inline.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::Validation`] when the request names a specialization source it does not
    /// supply the input for, or an item with a tier or quality outside the game's range.
    pub async fn item_power(
        &self,
        db: &DatabaseConnection,
        request: &ItemPowerRequest,
    ) -> Result<ItemPowerView, AppError> {
        let items = request
            .items
            .iter()
            .map(parse_loadout_item)
            .collect::<Result<Vec<_>, _>>()?;
        let specs = self
            .resolve_spec_levels(db, request.spec, request.user_id, request.level)
            .await?;
        Ok(view_for(&items, &specs))
    }

    /// Item Power for a stored build, optionally scored with one member's specialization.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::NotFound`] when the build does not exist, and [`AppError::Validation`]
    /// for an unusable specialization source.
    pub async fn build_item_power(
        &self,
        db: &DatabaseConnection,
        build_id: i64,
        loadout: BuildLoadout,
        spec: SpecSource,
        user_id: Option<i64>,
        level: Option<i32>,
    ) -> Result<ItemPowerView, AppError> {
        let items = Self::build_loadout(db, build_id, loadout).await?;
        let specs = self.resolve_spec_levels(db, spec, user_id, level).await?;
        Ok(view_for(&items, &specs))
    }

    /// Every member with a recorded specialization, scored against one build.
    ///
    /// Members are sorted by Item Power descending, so the first row is the best available pilot.
    /// A member with no relevant specialization still appears — at the build's unspecialised
    /// value — because "nobody is trained for this" is exactly what the caller needs to see.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::NotFound`] when the build does not exist.
    pub async fn build_roster_fit(
        &self,
        db: &DatabaseConnection,
        build_id: i64,
        loadout: BuildLoadout,
    ) -> Result<BuildRosterFitView, AppError> {
        let build = build::Entity::find_by_id(build_id)
            .one(db)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Build {build_id} not found")))?;
        let items = Self::build_loadout(db, build_id, loadout).await?;

        let ceiling = ip::character_ip(&items, &SpecLevels::all_at(100)).average;
        let levels_by_user = specializations::Entity::find()
            .all(db)
            .await
            .map_err(AppError::Database)?
            .into_iter()
            .fold(HashMap::<i64, Vec<(String, i32)>>::new(), |mut acc, row| {
                acc.entry(row.user_id).or_default().push((
                    specializations::canonical_node_key(&row.node_key),
                    row.level,
                ));
                acc
            });

        let mut members = Vec::with_capacity(levels_by_user.len());
        for (user_id, rows) in levels_by_user {
            let Some(user) = crate::modules::users::entities::Entity::find_by_id(user_id)
                .one(db)
                .await
                .map_err(AppError::Database)?
            else {
                continue; // The row outlived its user; nothing to report.
            };
            let specs =
                SpecLevels::from_rows(rows.iter().map(|(key, level)| (key.as_str(), *level)));
            let breakdown = ip::character_ip(&items, &specs);
            members.push(MemberItemPowerView {
                user_id,
                username: crate::modules::users::display_name::resolve(db, &user).await?,
                item_power: breakdown.average,
                at_max_spec: ceiling,
                readiness: readiness_of(breakdown.average, ceiling),
                blocking_nodes: blocking_nodes(&items, &specs),
                mastery_levels_known: breakdown.mastery_levels_known,
            });
        }

        members.sort_by(|a, b| {
            b.item_power
                .partial_cmp(&a.item_power)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.username.cmp(&b.username))
        });
        members.truncate(MAX_FIT_MEMBERS);

        Ok(BuildRosterFitView {
            build_id,
            build_name: build.name,
            at_max_spec: ceiling,
            members,
            dataset_version: dataset_version().clone(),
        })
    }

    /// Whether this composition could actually be fielded tonight, and where it is weakest.
    ///
    /// The candidate pool is the participants of `event_id` when given, otherwise every user with
    /// any recorded specialization — the difference between "can we field this for the mass at
    /// 21:00" and "who in the guild could ever fly this comp at all".
    ///
    /// # Errors
    ///
    /// Returns [`AppError::NotFound`] when the comp, or the given event, does not exist.
    pub async fn comp_readiness(
        &self,
        db: &DatabaseConnection,
        comp_id: i64,
        event_id: Option<i64>,
    ) -> Result<super::readiness::CompReadiness, AppError> {
        use crate::modules::events::entities::event_participation;
        use crate::modules::events::service::EventService;

        let seat_views = EventService::new()
            .canonical_roster_seats(db, comp_id)
            .await?;
        if seat_views.is_empty() {
            comp::Entity::find_by_id(comp_id)
                .one(db)
                .await
                .map_err(AppError::Database)?
                .ok_or_else(|| AppError::NotFound(format!("Comp {comp_id} not found")))?;
        }
        let build_names: HashMap<i64, String> = seat_views
            .iter()
            .map(|seat| (seat.build_id, seat.build_name.clone()))
            .collect();

        let mut items_by_build: HashMap<i64, Vec<EquippedItem>> = HashMap::new();
        let mut seats = Vec::with_capacity(seat_views.len());
        for seat in &seat_views {
            let items = if let Some(items) = items_by_build.get(&seat.build_id) {
                items.clone()
            } else {
                let items = Self::build_loadout(db, seat.build_id, BuildLoadout::Main).await?;
                items_by_build.insert(seat.build_id, items.clone());
                items
            };
            seats.push(fit::Seat {
                seat_key: seat.key.clone(),
                build_id: seat.build_id,
                items,
            });
        }

        let candidate_ids: Vec<i64> = match event_id {
            Some(event_id) => event_participation::Entity::find()
                .filter(event_participation::Column::EventId.eq(event_id))
                .all(db)
                .await
                .map_err(AppError::Database)?
                .into_iter()
                .map(|row| row.user_id)
                .collect(),
            None => specializations::Entity::find()
                .all(db)
                .await
                .map_err(AppError::Database)?
                .into_iter()
                .map(|row| row.user_id)
                .collect::<std::collections::BTreeSet<_>>()
                .into_iter()
                .collect(),
        };
        let levels_by_user = specializations::load_levels_for_users(db, &candidate_ids).await?;
        let members: Vec<fit::Member> = candidate_ids
            .iter()
            .map(|&user_id| fit::Member {
                user_id,
                specs: SpecLevels::from_rows(
                    levels_by_user
                        .get(&user_id)
                        .into_iter()
                        .flatten()
                        .map(|(key, level)| (key.as_str(), *level)),
                ),
                primary_build_id: None,
                secondary_build_id: None,
            })
            .collect();

        let mut readiness = super::readiness::evaluate(&seats, &members);

        // Only the handful of seats actually shown need a resolved name, not every candidate in
        // the pool — `readiness::evaluate` already capped `weakest_seats` for this reason.
        let mut usernames: HashMap<i64, String> = HashMap::new();
        for user_id in readiness
            .weakest_seats
            .iter()
            .filter_map(|seat| seat.best_candidate_user_id)
        {
            if let std::collections::hash_map::Entry::Vacant(entry) = usernames.entry(user_id)
                && let Some(user) = crate::modules::users::entities::Entity::find_by_id(user_id)
                    .one(db)
                    .await
                    .map_err(AppError::Database)?
            {
                entry.insert(crate::modules::users::display_name::resolve(db, &user).await?);
            }
        }

        for seat in &mut readiness.weakest_seats {
            seat.build_name = build_names.get(&seat.build_id).cloned().unwrap_or_default();
            if let Some(user_id) = seat.best_candidate_user_id {
                seat.best_candidate_username = usernames.get(&user_id).cloned().unwrap_or_default();
            }
        }
        for build in &mut readiness.bench_coverage {
            build.build_name = build_names
                .get(&build.build_id)
                .cloned()
                .unwrap_or_default();
        }
        Ok(readiness)
    }

    /// Reads one loadout of a build into the calculator's item shape.
    ///
    /// Rows whose base identifier cannot be recovered are kept rather than dropped: the calculator
    /// flags them as unknown, which surfaces a broken item instead of quietly inflating the mean.
    ///
    /// Generic over [`ConnectionTrait`] rather than tied to [`DatabaseConnection`] so a caller
    /// already inside a transaction — `auto_fill_roster`'s Item-Power-aware assignment, in
    /// particular — can read a build's items without leaving it.
    pub async fn build_loadout<C: ConnectionTrait>(
        db: &C,
        build_id: i64,
        loadout: BuildLoadout,
    ) -> Result<Vec<EquippedItem>, AppError> {
        let rows = BuildItemEntity::find()
            .filter(BuildItemColumn::BuildId.eq(build_id))
            .filter(BuildItemColumn::Loadout.eq(loadout.to_string()))
            .all(db)
            .await
            .map_err(AppError::Database)?;

        Ok(rows
            .into_iter()
            .filter_map(|row| {
                let slot = row.slot.parse::<BuildSlot>().ok()?;
                let base = base_identifier_for_stored_item(
                    row.openalbion_item_id,
                    row.openalbion_item_icon.as_deref(),
                )
                .unwrap_or_default();
                Some(EquippedItem {
                    slot,
                    base,
                    tier: tier_from_stored(row.openalbion_item_tier.as_deref()),
                    enchantment: u8::try_from(row.openalbion_item_enchantment.max(0))
                        .unwrap_or(0)
                        .min(4),
                    quality: row.openalbion_item_quality,
                })
            })
            .collect())
    }

    /// Turns a specialization source into concrete Destiny Board levels.
    async fn resolve_spec_levels(
        &self,
        db: &DatabaseConnection,
        spec: SpecSource,
        user_id: Option<i64>,
        level: Option<i32>,
    ) -> Result<SpecLevels, AppError> {
        match spec {
            SpecSource::Max => Ok(SpecLevels::all_at(100)),
            SpecSource::Fixed => {
                let level = level.ok_or_else(|| {
                    AppError::Validation("spec=fixed requires a level".to_string())
                })?;
                if !(0..=100).contains(&level) {
                    return Err(AppError::Validation(format!(
                        "specialization level must be between 0 and 100, got {level}"
                    )));
                }
                Ok(SpecLevels::all_at(level))
            }
            SpecSource::Current => {
                let user_id = user_id.ok_or_else(|| {
                    AppError::Validation("spec=current requires a user_id".to_string())
                })?;
                let mut by_user = specializations::load_levels_for_users(db, &[user_id]).await?;
                let rows = by_user.remove(&user_id).unwrap_or_default();
                Ok(SpecLevels::from_rows(
                    rows.iter().map(|(key, level)| (key.as_str(), *level)),
                ))
            }
        }
    }

    /// Creates a new combat test scenario at version 1.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::Validation`] for an empty name, or [`AppError::Conflict`] when the name
    /// is already taken.
    pub async fn create_scenario(
        &self,
        db: &DatabaseConnection,
        creator_id: i64,
        request: &CreateScenarioRequest,
    ) -> Result<ScenarioDetail, AppError> {
        let name = request.name.trim();
        if name.is_empty() {
            return Err(AppError::Validation("scenario name is required".to_string()));
        }
        ensure_scenario_name_free(db, name, None).await?;
        let now: sea_orm::prelude::DateTimeWithTimeZone = chrono::Utc::now().into();
        let definition_json = serde_json::to_string(&request.definition)
            .map_err(|error| AppError::Validation(error.to_string()))?;
        let inserted = combat_scenario::ActiveModel {
            name: Set(name.to_string()),
            version: Set(1),
            definition_json: Set(definition_json),
            created_by: Set(creator_id),
            created_at: Set(now),
            updated_at: Set(now),
            ..Default::default()
        }
        .insert(db)
        .await
        .map_err(AppError::Database)?;
        self.scenario_detail(db, inserted).await
    }

    /// Edits a scenario version's name and/or definition in place.
    ///
    /// Unlike a build or a comp, a test scenario is a scratch document an officer iterates on
    /// constantly — every tweak to a group or the timeline does not need its own version. Renaming
    /// moves every version sharing the old name, matching how build/comp renames already work.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::NotFound`] when the scenario does not exist.
    pub async fn update_scenario(
        &self,
        db: &DatabaseConnection,
        id: i64,
        request: &UpdateScenarioRequest,
    ) -> Result<ScenarioDetail, AppError> {
        let model = combat_scenario::Entity::find_by_id(id)
            .one(db)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Scenario {id} not found")))?;

        let txn = db.begin().await.map_err(AppError::Database)?;
        if let Some(name) = request.name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
            ensure_scenario_name_free(&txn, name, Some(&model.name)).await?;
            let siblings = scenario_version_group(&txn, &model.name).await?;
            for sibling in siblings {
                let mut active: combat_scenario::ActiveModel = sibling.into();
                active.name = Set(name.to_string());
                active.updated_at = Set(chrono::Utc::now().into());
                active.update(&txn).await.map_err(AppError::Database)?;
            }
        }
        if let Some(definition) = &request.definition {
            let definition_json = serde_json::to_string(definition)
                .map_err(|error| AppError::Validation(error.to_string()))?;
            let mut active: combat_scenario::ActiveModel =
                combat_scenario::Entity::find_by_id(id)
                    .one(&txn)
                    .await
                    .map_err(AppError::Database)?
                    .ok_or_else(|| AppError::NotFound(format!("Scenario {id} not found")))?
                    .into();
            active.definition_json = Set(definition_json);
            active.updated_at = Set(chrono::Utc::now().into());
            active.update(&txn).await.map_err(AppError::Database)?;
        }
        txn.commit().await.map_err(AppError::Database)?;

        let updated = combat_scenario::Entity::find_by_id(id)
            .one(db)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Scenario {id} not found")))?;
        self.scenario_detail(db, updated).await
    }

    /// Creates a new version by cloning the given one's current definition — for keeping a state
    /// around to compare against, deliberately separate from [`Self::update_scenario`]'s in-place
    /// editing.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::NotFound`] when the source scenario does not exist.
    pub async fn create_scenario_version(
        &self,
        db: &DatabaseConnection,
        id: i64,
        creator_id: i64,
    ) -> Result<ScenarioDetail, AppError> {
        let source = combat_scenario::Entity::find_by_id(id)
            .one(db)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Scenario {id} not found")))?;

        let siblings = scenario_version_group(db, &source.name).await?;
        let next_version = siblings.iter().map(|sibling| sibling.version).max().unwrap_or(0) + 1;
        let now: sea_orm::prelude::DateTimeWithTimeZone = chrono::Utc::now().into();
        let inserted = combat_scenario::ActiveModel {
            name: Set(source.name),
            version: Set(next_version),
            definition_json: Set(source.definition_json),
            created_by: Set(creator_id),
            created_at: Set(now),
            updated_at: Set(now),
            ..Default::default()
        }
        .insert(db)
        .await
        // Another request could only collide here by creating this exact version number between
        // the read above and this insert — rare enough for a single-officer editing tool that a
        // surfaced database error is an acceptable "try again", without a retry loop's complexity.
        .map_err(AppError::Database)?;
        self.scenario_detail(db, inserted).await
    }

    /// Lists scenario versions, newest-updated first.
    pub async fn list_scenarios(
        &self,
        db: &DatabaseConnection,
        include_archived: bool,
    ) -> Result<Vec<ScenarioSummary>, AppError> {
        let mut query = combat_scenario::Entity::find();
        if !include_archived {
            query = query.filter(CombatScenarioColumn::ArchivedAt.is_null());
        }
        let models = query
            .order_by_desc(CombatScenarioColumn::UpdatedAt)
            .all(db)
            .await
            .map_err(AppError::Database)?;
        let mut summaries = Vec::with_capacity(models.len());
        for model in models {
            summaries.push(self.scenario_summary(db, model).await?);
        }
        Ok(summaries)
    }

    /// Reads one scenario version, with its definition and its version siblings.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::NotFound`] when the scenario does not exist.
    pub async fn get_scenario(&self, db: &DatabaseConnection, id: i64) -> Result<ScenarioDetail, AppError> {
        let model = combat_scenario::Entity::find_by_id(id)
            .one(db)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Scenario {id} not found")))?;
        self.scenario_detail(db, model).await
    }

    /// Archives (or unarchives) a scenario version. Never deletes: a past run stays reachable.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::NotFound`] when the scenario does not exist.
    pub async fn set_scenario_archived(
        &self,
        db: &DatabaseConnection,
        id: i64,
        archived: bool,
    ) -> Result<ScenarioDetail, AppError> {
        let model = combat_scenario::Entity::find_by_id(id)
            .one(db)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Scenario {id} not found")))?;
        let mut active: combat_scenario::ActiveModel = model.into();
        active.archived_at = Set(archived.then(|| chrono::Utc::now().into()));
        active.updated_at = Set(chrono::Utc::now().into());
        let updated = active.update(db).await.map_err(AppError::Database)?;
        self.scenario_detail(db, updated).await
    }

    /// Runs a scenario version now, pins the result, and returns it.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::NotFound`] when the scenario does not exist, or
    /// [`AppError::Validation`] when its stored definition cannot be parsed (should not happen for
    /// a definition this same service wrote, but the column has no schema of its own to enforce
    /// it).
    pub async fn run_scenario(
        &self,
        db: &DatabaseConnection,
        id: i64,
        actor_id: i64,
    ) -> Result<RunDetail, AppError> {
        let model = combat_scenario::Entity::find_by_id(id)
            .one(db)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Scenario {id} not found")))?;
        let definition: ScenarioDefinition = serde_json::from_str(&model.definition_json)
            .map_err(|error| AppError::Validation(format!("stored scenario is unreadable: {error}")))?;

        let result = super::scenario::run(&definition.groups, &definition.casts);
        let result_json =
            serde_json::to_string(&result).map_err(|error| AppError::Validation(error.to_string()))?;

        let inserted = combat_run::ActiveModel {
            scenario_id: Set(id),
            engine_version: Set(SCENARIO_ENGINE_VERSION),
            dataset_commit: Set(dataset_version().dumps_commit.clone()),
            result_json: Set(result_json),
            ran_by: Set(actor_id),
            ran_at: Set(chrono::Utc::now().into()),
            ..Default::default()
        }
        .insert(db)
        .await
        .map_err(AppError::Database)?;

        Ok(RunDetail { summary: self.run_summary(db, inserted).await?, result })
    }

    /// Lists a scenario's past runs, most recent first.
    pub async fn list_runs(
        &self,
        db: &DatabaseConnection,
        scenario_id: i64,
    ) -> Result<Vec<RunSummary>, AppError> {
        let models = combat_run::Entity::find()
            .filter(CombatRunColumn::ScenarioId.eq(scenario_id))
            .order_by_desc(CombatRunColumn::RanAt)
            .all(db)
            .await
            .map_err(AppError::Database)?;
        let mut summaries = Vec::with_capacity(models.len());
        for model in models {
            summaries.push(self.run_summary(db, model).await?);
        }
        Ok(summaries)
    }

    /// Reads one pinned run, with its full resolved result.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::NotFound`] when the run does not exist, or [`AppError::Validation`]
    /// when its stored result cannot be parsed.
    pub async fn get_run(&self, db: &DatabaseConnection, run_id: i64) -> Result<RunDetail, AppError> {
        let model = combat_run::Entity::find_by_id(run_id)
            .one(db)
            .await
            .map_err(AppError::Database)?
            .ok_or_else(|| AppError::NotFound(format!("Run {run_id} not found")))?;
        let result: super::scenario::ScenarioResult = serde_json::from_str(&model.result_json)
            .map_err(|error| AppError::Validation(format!("stored run is unreadable: {error}")))?;
        Ok(RunDetail { summary: self.run_summary(db, model).await?, result })
    }

    async fn scenario_summary(
        &self,
        db: &DatabaseConnection,
        model: combat_scenario::Model,
    ) -> Result<ScenarioSummary, AppError> {
        let created_by_username = self.resolve_username(db, model.created_by).await?;
        let run_count = combat_run::Entity::find()
            .filter(CombatRunColumn::ScenarioId.eq(model.id))
            .count(db)
            .await
            .map_err(AppError::Database)?;
        let run_count = i64::try_from(run_count).unwrap_or(i64::MAX);
        Ok(ScenarioSummary {
            id: model.id,
            name: model.name,
            version: model.version,
            created_by: model.created_by,
            created_by_username,
            created_at: model.created_at.to_rfc3339(),
            updated_at: model.updated_at.to_rfc3339(),
            archived_at: model.archived_at.map(|value| value.to_rfc3339()),
            run_count,
        })
    }

    async fn scenario_detail(
        &self,
        db: &DatabaseConnection,
        model: combat_scenario::Model,
    ) -> Result<ScenarioDetail, AppError> {
        let definition: ScenarioDefinition = serde_json::from_str(&model.definition_json)
            .map_err(|error| AppError::Validation(format!("stored scenario is unreadable: {error}")))?;
        let mut versions = scenario_version_group(db, &model.name).await?;
        versions.sort_by_key(|sibling| sibling.version);
        let versions = versions
            .into_iter()
            .map(|sibling| ScenarioVersionRef { id: sibling.id, version: sibling.version })
            .collect();
        let summary = self.scenario_summary(db, model).await?;
        Ok(ScenarioDetail { summary, definition, versions })
    }

    async fn run_summary(
        &self,
        db: &DatabaseConnection,
        model: combat_run::Model,
    ) -> Result<RunSummary, AppError> {
        let ran_by_username = self.resolve_username(db, model.ran_by).await?;
        Ok(RunSummary {
            id: model.id,
            scenario_id: model.scenario_id,
            engine_version: model.engine_version,
            dataset_commit: model.dataset_commit,
            ran_by: model.ran_by,
            ran_by_username,
            ran_at: model.ran_at.to_rfc3339(),
        })
    }

    async fn resolve_username(&self, db: &DatabaseConnection, user_id: i64) -> Result<String, AppError> {
        let Some(user) = crate::modules::users::entities::Entity::find_by_id(user_id)
            .one(db)
            .await
            .map_err(AppError::Database)?
        else {
            return Ok(format!("#{user_id}"));
        };
        crate::modules::users::display_name::resolve(db, &user).await
    }
}

/// Bumped whenever [`super::scenario::ScenarioResult`]'s shape changes, so a pinned run stays
/// legible even after the engine itself changes.
const SCENARIO_ENGINE_VERSION: i32 = 1;

/// Every version sharing `name` (case/whitespace-insensitive), unsorted.
async fn scenario_version_group<C: ConnectionTrait>(
    db: &C,
    name: &str,
) -> Result<Vec<combat_scenario::Model>, AppError> {
    let key = name.trim().to_lowercase();
    Ok(combat_scenario::Entity::find()
        .all(db)
        .await
        .map_err(AppError::Database)?
        .into_iter()
        .filter(|candidate| candidate.name.trim().to_lowercase() == key)
        .collect())
}

/// Refuses a scenario name already held by another scenario group.
///
/// `exclude_name` is the group's own current name, when renaming it in place — every version in a
/// group shares one name, so a rename onto its own unchanged name must not be treated as taken.
async fn ensure_scenario_name_free<C: ConnectionTrait>(
    db: &C,
    name: &str,
    exclude_name: Option<&str>,
) -> Result<(), AppError> {
    let key = name.trim().to_lowercase();
    if exclude_name.is_some_and(|existing| existing.trim().to_lowercase() == key) {
        return Ok(());
    }
    let taken = !scenario_version_group(db, name).await?.is_empty();
    if taken {
        return Err(AppError::Conflict(format!(
            "A test named {:?} already exists",
            name.trim()
        )));
    }
    Ok(())
}

/// Reads the `loadout` query parameter, defaulting to the main set.
///
/// # Errors
///
/// Returns [`AppError::Validation`] for anything that is neither `main` nor `swap`.
pub fn parse_loadout(value: Option<&str>) -> Result<BuildLoadout, AppError> {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        None => Ok(BuildLoadout::Main),
        Some(value) => value.parse::<BuildLoadout>().map_err(AppError::Validation),
    }
}

/// Assembles the response shape shared by the ad-hoc and stored-build endpoints.
fn view_for(items: &[EquippedItem], specs: &SpecLevels) -> ItemPowerView {
    let breakdown = ip::character_ip(items, specs);
    let ceiling = ip::character_ip(items, &SpecLevels::all_at(100)).average;
    ItemPowerView {
        at_max_spec: ceiling,
        readiness: readiness_of(breakdown.average, ceiling),
        breakdown,
        dataset_version: dataset_version().clone(),
    }
}

/// `current / ceiling`, clamped, and `0.0` when the ceiling is zero.
fn readiness_of(current: f64, ceiling: f64) -> f64 {
    if ceiling <= 0.0 {
        return 0.0;
    }
    (current / ceiling).clamp(0.0, 1.0)
}

/// The nodes this loadout needs where the member is furthest from the ceiling.
///
/// Computed by re-scoring the loadout with each relevant node raised to its own maximum, so the
/// gap reported is the Item Power actually recoverable rather than a proxy for it.
fn blocking_nodes(items: &[EquippedItem], specs: &SpecLevels) -> Vec<BlockingNode> {
    let current = ip::character_ip(items, specs).average;
    let mut gaps: Vec<BlockingNode> = items
        .iter()
        .filter_map(EquippedItem::spec_node_id)
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .filter_map(|node_id| {
            let node = spec_node(&node_id)?;
            let level = specs.level(&node_id);
            if level >= node.max_level {
                return None;
            }
            let raised = specs.with_level(&node_id, node.max_level);
            let gap = ip::character_ip(items, &raised).average - current;
            (gap > 0.0).then_some(BlockingNode {
                node: node_id,
                level,
                max_level: node.max_level,
                item_power_gap: gap,
            })
        })
        .collect();

    gaps.sort_by(|a, b| {
        b.item_power_gap
            .partial_cmp(&a.item_power_gap)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.node.cmp(&b.node))
    });
    gaps
}

/// Turns a request item into the calculator's shape, validating tier, enchantment and quality.
fn parse_loadout_item(request: &LoadoutItemRequest) -> Result<EquippedItem, AppError> {
    let identifier = request.identifier.trim();
    if identifier.is_empty() {
        return Err(AppError::Validation(
            "item identifier is required".to_string(),
        ));
    }

    let tier = request
        .tier
        .or_else(|| tier_prefix_of(identifier))
        .unwrap_or(ASSUMED_TIER);
    if !(1..=8).contains(&tier) {
        return Err(AppError::Validation(format!(
            "item tier must be between 1 and 8, got {tier}"
        )));
    }

    let enchantment = request
        .enchantment
        .or_else(|| enchantment_suffix_of(identifier))
        .unwrap_or(0);
    if enchantment > 4 {
        return Err(AppError::Validation(format!(
            "item enchantment must be between 0 and 4, got {enchantment}"
        )));
    }

    let quality = parse_item_quality(request.quality.or(Some(DEFAULT_ITEM_QUALITY)))
        .map_err(AppError::Validation)?;

    Ok(EquippedItem {
        slot: request.slot,
        base: base_identifier(identifier),
        tier,
        enchantment,
        quality,
    })
}

/// Reads the tier out of `T8_2H_POLEHAMMER`, or `None` when the identifier carries no prefix.
fn tier_prefix_of(identifier: &str) -> Option<u8> {
    let trimmed = identifier.trim().to_ascii_uppercase();
    let (prefix, _) = trimmed.split_once('_')?;
    let digits = prefix.strip_prefix('T')?;
    digits.parse::<u8>().ok()
}

/// Reads the enchantment out of `T8_2H_POLEHAMMER@2`.
fn enchantment_suffix_of(identifier: &str) -> Option<u8> {
    identifier.trim().rsplit_once('@')?.1.parse::<u8>().ok()
}

/// Reads the tier a build item stored, tolerating `"8"`, `"T8"` and the legacy `"4.1"`.
///
/// The decimal in a legacy tier is dropped: enchantment now has its own column, and reading it
/// from two places at once is how the two would drift apart.
fn tier_from_stored(tier: Option<&str>) -> u8 {
    tier.and_then(|value| {
        let cleaned = value.trim().trim_start_matches(['T', 't']);
        cleaned.split('.').next()?.parse::<u8>().ok()
    })
    .filter(|tier| (1..=8).contains(tier))
    .unwrap_or(ASSUMED_TIER)
}

#[cfg(test)]
mod service_tests {
    use super::{
        CombatService, enchantment_suffix_of, parse_loadout_item, readiness_of, tier_from_stored,
        tier_prefix_of,
    };
    use crate::modules::combat::dataset::{combat_items, spec_node};
    use crate::modules::combat::models::LoadoutItemRequest;
    use crate::modules::comps::status::BuildSlot;

    #[test]
    fn mastery_groups_maps_a_known_weapon_to_its_family() {
        let groups = CombatService::mastery_groups();
        assert_eq!(
            groups.get("2H_POLEHAMMER").map(String::as_str),
            Some("COMBAT_HAMMERS")
        );
    }

    #[test]
    fn mastery_groups_covers_every_item_that_has_a_specialization() {
        let groups = CombatService::mastery_groups();
        for (base, item) in combat_items() {
            let Some(node) = item.spec_node.as_deref() else {
                continue;
            };
            let Some(node) = spec_node(node) else {
                continue;
            };
            let Some(parent) = node.parent.as_deref() else {
                continue;
            };
            assert_eq!(
                groups.get(base).map(String::as_str),
                Some(parent),
                "{base}: mastery_groups disagrees with the dataset's own parent link"
            );
        }
    }

    #[test]
    fn every_mapped_mastery_id_is_actually_a_mastery_node() {
        for node_id in CombatService::mastery_groups().values() {
            let node = spec_node(node_id).unwrap_or_else(|| panic!("{node_id} does not exist"));
            assert_eq!(node.kind, "mastery", "{node_id} is not a mastery node");
        }
    }

    #[test]
    fn capes_and_bags_have_no_mastery_group() {
        let groups = CombatService::mastery_groups();
        assert!(!groups.contains_key("CAPE"));
        assert!(!groups.contains_key("BAG"));
    }

    fn request(identifier: &str) -> LoadoutItemRequest {
        LoadoutItemRequest {
            slot: BuildSlot::Weapon,
            identifier: identifier.to_string(),
            tier: None,
            enchantment: None,
            quality: None,
        }
    }

    #[test]
    fn a_tier_prefixed_identifier_carries_its_own_tier() {
        let item = parse_loadout_item(&request("T6_2H_POLEHAMMER")).unwrap();
        assert_eq!(item.tier, 6);
        assert_eq!(item.base, "2H_POLEHAMMER");
    }

    #[test]
    fn an_enchantment_suffix_is_read_from_the_identifier() {
        let item = parse_loadout_item(&request("T8_2H_POLEHAMMER@3")).unwrap();
        assert_eq!(item.enchantment, 3);
        assert_eq!(item.base, "2H_POLEHAMMER");
    }

    #[test]
    fn an_explicit_field_beats_the_identifier() {
        let mut req = request("T4_2H_POLEHAMMER@1");
        req.tier = Some(8);
        req.enchantment = Some(2);
        let item = parse_loadout_item(&req).unwrap();
        assert_eq!((item.tier, item.enchantment), (8, 2));
    }

    #[test]
    fn a_bare_base_identifier_assumes_the_tier_the_guild_flies() {
        let item = parse_loadout_item(&request("2H_POLEHAMMER")).unwrap();
        assert_eq!(item.tier, 8);
        assert_eq!(item.enchantment, 0);
    }

    #[test]
    fn quality_defaults_to_excellent() {
        assert_eq!(
            parse_loadout_item(&request("T8_2H_POLEHAMMER"))
                .unwrap()
                .quality,
            4
        );
    }

    #[test]
    fn an_impossible_enchantment_is_refused() {
        let mut req = request("T8_2H_POLEHAMMER");
        req.enchantment = Some(9);
        assert!(parse_loadout_item(&req).is_err());
    }

    #[test]
    fn an_empty_identifier_is_refused() {
        assert!(parse_loadout_item(&request("   ")).is_err());
    }

    #[test]
    fn a_stored_tier_is_read_in_every_form_the_column_has_held() {
        assert_eq!(tier_from_stored(Some("8")), 8);
        assert_eq!(tier_from_stored(Some("T8")), 8);
        assert_eq!(tier_from_stored(Some("4.1")), 4);
        assert_eq!(tier_from_stored(Some(" t6 ")), 6);
    }

    #[test]
    fn an_unreadable_stored_tier_falls_back_rather_than_failing() {
        assert_eq!(tier_from_stored(None), 8);
        assert_eq!(tier_from_stored(Some("")), 8);
        assert_eq!(tier_from_stored(Some("nonsense")), 8);
        assert_eq!(tier_from_stored(Some("99")), 8);
    }

    #[test]
    fn identifier_parts_are_read_independently() {
        assert_eq!(tier_prefix_of("T5_MAIN_SWORD"), Some(5));
        assert_eq!(tier_prefix_of("MAIN_SWORD"), None);
        assert_eq!(enchantment_suffix_of("T5_MAIN_SWORD@4"), Some(4));
        assert_eq!(enchantment_suffix_of("T5_MAIN_SWORD"), None);
    }

    #[test]
    fn readiness_is_a_clamped_ratio_that_survives_a_zero_ceiling() {
        assert!((readiness_of(50.0, 100.0) - 0.5).abs() < f64::EPSILON);
        assert!((readiness_of(0.0, 0.0) - 0.0).abs() < f64::EPSILON);
        assert!((readiness_of(150.0, 100.0) - 1.0).abs() < f64::EPSILON);
    }
}

#[cfg(test)]
mod comp_readiness_tests {
    use sea_orm::{ActiveModelTrait, Database, DatabaseConnection, Set};
    use sea_orm_migration::MigratorTrait;

    use super::CombatService;
    use crate::modules::comps::entities::{
        build, build_category, build_item, comp, comp_build, comp_category,
    };
    use crate::modules::users::entities::ActiveModel as UserActiveModel;
    use crate::modules::users::specializations;

    async fn seed_db() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("failed to connect to test database");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("failed to run migrations");
        db
    }

    /// One comp with a single seat requiring a Polehammer.
    async fn seed_polehammer_comp(db: &DatabaseConnection) -> (i64, i64) {
        let owner = UserActiveModel {
            username: Set("owner".to_string()),
            email: Set("owner@example.com".to_string()),
            role: Set("Admin".to_string()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("failed to insert owner");

        let category = build_category::ActiveModel {
            name: Set("readiness-builds".to_string()),
            slug: Set("readiness-builds".to_string()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("failed to insert build category");
        let built = build::ActiveModel {
            name: Set("readiness-build".to_string()),
            role: Set("dps".to_string()),
            category_id: Set(category.id),
            created_by: Set(owner.id),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("failed to insert build");
        build_item::ActiveModel {
            build_id: Set(built.id),
            loadout: Set("main".to_string()),
            slot: Set("weapon".to_string()),
            openalbion_item_type: Set("weapon".to_string()),
            openalbion_item_id: Set(0),
            openalbion_item_name: Set("T8_2H_POLEHAMMER".to_string()),
            openalbion_item_icon: Set(Some(
                "https://render.albiononline.com/v1/item/T8_2H_POLEHAMMER.png?quality=1&size=64"
                    .to_string(),
            )),
            openalbion_item_tier: Set(Some("8".to_string())),
            openalbion_item_quality: Set(4),
            openalbion_item_enchantment: Set(0),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("failed to insert build item");

        let comp_cat = comp_category::ActiveModel {
            name: Set("readiness-comps".to_string()),
            slug: Set("readiness-comps".to_string()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("failed to insert comp category");
        let comp = comp::ActiveModel {
            name: Set("readiness-comp".to_string()),
            category_id: Set(comp_cat.id),
            created_by: Set(owner.id),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("failed to insert comp");
        comp_build::ActiveModel {
            comp_id: Set(comp.id),
            build_id: Set(built.id),
            quantity: Set(1),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("failed to insert comp build");

        (comp.id, built.id)
    }

    #[tokio::test]
    async fn an_untrained_guild_leaves_every_seat_uncovered() {
        let db = seed_db().await;
        let (comp_id, build_id) = seed_polehammer_comp(&db).await;

        let readiness = CombatService::new()
            .comp_readiness(&db, comp_id, None)
            .await
            .expect("readiness should compute with no candidates");

        assert_eq!(readiness.seat_count, 1);
        assert_eq!(
            readiness.uncovered_seats,
            vec![format!("build:{build_id}:1")]
        );
        assert_eq!(readiness.weakest_seats[0].build_name, "readiness-build");
        assert!((readiness.avg_item_power_now - 0.0).abs() < f64::EPSILON);
        assert!(readiness.avg_item_power_at_max > 0.0);
    }

    #[tokio::test]
    async fn a_trained_member_is_surfaced_as_the_best_candidate() {
        let db = seed_db().await;
        let (comp_id, _) = seed_polehammer_comp(&db).await;
        let trained = UserActiveModel {
            username: Set("trained".to_string()),
            email: Set("trained@example.com".to_string()),
            role: Set("User".to_string()),
            ..Default::default()
        }
        .insert(&db)
        .await
        .expect("failed to insert trained member");
        specializations::ActiveModel {
            user_id: Set(trained.id),
            node_key: Set("weapon:2H_POLEHAMMER".to_string()),
            node_name: Set("Great Polehammer".to_string()),
            category: Set("weapon".to_string()),
            level: Set(100),
            ..Default::default()
        }
        .insert(&db)
        .await
        .expect("failed to insert specialization");

        let readiness = CombatService::new()
            .comp_readiness(&db, comp_id, None)
            .await
            .expect("readiness should compute");

        assert!(readiness.uncovered_seats.is_empty());
        assert_eq!(
            readiness.weakest_seats[0].best_candidate_user_id,
            Some(trained.id)
        );
        assert_eq!(
            readiness.weakest_seats[0].best_candidate_username,
            "trained"
        );
        assert_eq!(readiness.bench_coverage[0].build_name, "readiness-build");
        assert_eq!(readiness.bench_coverage[0].qualified_members, 1);
    }

    #[tokio::test]
    async fn a_comp_with_no_such_id_is_not_found() {
        let db = seed_db().await;
        let error = CombatService::new()
            .comp_readiness(&db, 999_999, None)
            .await
            .expect_err("a nonexistent comp should not compute readiness");
        assert!(matches!(error, crate::errors::AppError::NotFound(_)));
    }
}

#[cfg(test)]
mod scenario_tests {
    use sea_orm::{ActiveModelTrait, Database, DatabaseConnection, Set};
    use sea_orm_migration::MigratorTrait;

    use super::CombatService;
    use crate::modules::combat::models::{CreateScenarioRequest, ScenarioDefinition, UpdateScenarioRequest};
    use crate::modules::combat::scenario::{DeclaredCast, Side, UnitGroup};
    use crate::modules::combat::sim::AttackerStyle;
    use crate::modules::users::entities::ActiveModel as UserActiveModel;

    async fn seed_db() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("failed to connect to test database");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("failed to run migrations");
        db
    }

    async fn seed_user(db: &DatabaseConnection, username: &str) -> i64 {
        UserActiveModel {
            username: Set(username.to_string()),
            email: Set(format!("{username}@example.com")),
            role: Set("Officer".to_string()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("failed to insert user")
        .id
    }

    fn lethal_definition() -> ScenarioDefinition {
        ScenarioDefinition {
            groups: vec![
                UnitGroup {
                    id: "ally-hammer".to_string(),
                    side: Side::Ally,
                    label: "Polehammer".to_string(),
                    item_id: None,
                    count: 1,
                    hit_points: 1200.0,
                },
                UnitGroup {
                    id: "enemy-plate".to_string(),
                    side: Side::Enemy,
                    label: "Plate".to_string(),
                    item_id: None,
                    count: 1,
                    hit_points: 50.0,
                },
            ],
            casts: vec![DeclaredCast {
                caster_group_id: "ally-hammer".to_string(),
                spell_id: "HAMMERWHIRLWIND2".to_string(),
                cast_at: 0.0,
                target_ids: vec!["enemy-plate#0".to_string()],
                attacker_style: AttackerStyle::Melee,
            }],
        }
    }

    #[tokio::test]
    async fn creating_a_scenario_starts_at_version_one() {
        let db = seed_db().await;
        let creator = seed_user(&db, "officer").await;

        let created = CombatService::new()
            .create_scenario(
                &db,
                creator,
                &CreateScenarioRequest {
                    name: "Opening burst".to_string(),
                    definition: ScenarioDefinition::default(),
                },
            )
            .await
            .expect("scenario should be created");

        assert_eq!(created.summary.version, 1);
        assert_eq!(created.summary.name, "Opening burst");
        assert_eq!(created.summary.created_by, creator);
        assert_eq!(created.summary.created_by_username, "officer");
        assert_eq!(created.summary.run_count, 0);
        assert!(created.summary.archived_at.is_none());
        assert_eq!(created.versions.len(), 1);
    }

    #[tokio::test]
    async fn an_empty_name_is_refused() {
        let db = seed_db().await;
        let creator = seed_user(&db, "officer").await;

        let error = CombatService::new()
            .create_scenario(
                &db,
                creator,
                &CreateScenarioRequest { name: "   ".to_string(), definition: ScenarioDefinition::default() },
            )
            .await
            .expect_err("a blank name should be refused");
        assert!(matches!(error, crate::errors::AppError::Validation(_)));
    }

    #[tokio::test]
    async fn a_taken_name_is_a_conflict() {
        let db = seed_db().await;
        let creator = seed_user(&db, "officer").await;
        let request = CreateScenarioRequest {
            name: "Opening burst".to_string(),
            definition: ScenarioDefinition::default(),
        };
        CombatService::new()
            .create_scenario(&db, creator, &request)
            .await
            .expect("first scenario should be created");

        let error = CombatService::new()
            .create_scenario(&db, creator, &request)
            .await
            .expect_err("a duplicate name should conflict");
        assert!(matches!(error, crate::errors::AppError::Conflict(_)));
    }

    #[tokio::test]
    async fn renaming_moves_every_sibling_version() {
        let db = seed_db().await;
        let creator = seed_user(&db, "officer").await;
        let created = CombatService::new()
            .create_scenario(
                &db,
                creator,
                &CreateScenarioRequest { name: "Draft".to_string(), definition: ScenarioDefinition::default() },
            )
            .await
            .expect("scenario should be created");
        let v2 = CombatService::new()
            .create_scenario_version(&db, created.summary.id, creator)
            .await
            .expect("version 2 should be created");

        let renamed = CombatService::new()
            .update_scenario(
                &db,
                v2.summary.id,
                &UpdateScenarioRequest { name: Some("Renamed".to_string()), definition: None },
            )
            .await
            .expect("rename should succeed");
        assert_eq!(renamed.summary.name, "Renamed");
        assert_eq!(renamed.versions.len(), 2);

        let original = CombatService::new()
            .get_scenario(&db, created.summary.id)
            .await
            .expect("original version should still exist");
        assert_eq!(original.summary.name, "Renamed");
    }

    #[tokio::test]
    async fn editing_the_definition_leaves_the_name_and_version_alone() {
        let db = seed_db().await;
        let creator = seed_user(&db, "officer").await;
        let created = CombatService::new()
            .create_scenario(
                &db,
                creator,
                &CreateScenarioRequest { name: "Draft".to_string(), definition: ScenarioDefinition::default() },
            )
            .await
            .expect("scenario should be created");

        let updated = CombatService::new()
            .update_scenario(
                &db,
                created.summary.id,
                &UpdateScenarioRequest { name: None, definition: Some(lethal_definition()) },
            )
            .await
            .expect("definition update should succeed");
        assert_eq!(updated.summary.name, "Draft");
        assert_eq!(updated.summary.version, 1);
        assert_eq!(updated.definition.groups.len(), 2);
    }

    #[tokio::test]
    async fn creating_a_version_clones_the_current_definition() {
        let db = seed_db().await;
        let creator = seed_user(&db, "officer").await;
        let created = CombatService::new()
            .create_scenario(
                &db,
                creator,
                &CreateScenarioRequest { name: "Draft".to_string(), definition: lethal_definition() },
            )
            .await
            .expect("scenario should be created");

        let v2 = CombatService::new()
            .create_scenario_version(&db, created.summary.id, creator)
            .await
            .expect("version 2 should be created");
        assert_eq!(v2.summary.version, 2);
        assert_eq!(v2.summary.name, "Draft");
        assert_eq!(v2.definition.groups.len(), 2);
        assert_eq!(v2.versions.len(), 2);
    }

    #[tokio::test]
    async fn archiving_hides_a_scenario_from_the_default_list() {
        let db = seed_db().await;
        let creator = seed_user(&db, "officer").await;
        let created = CombatService::new()
            .create_scenario(
                &db,
                creator,
                &CreateScenarioRequest { name: "Draft".to_string(), definition: ScenarioDefinition::default() },
            )
            .await
            .expect("scenario should be created");

        let archived = CombatService::new()
            .set_scenario_archived(&db, created.summary.id, true)
            .await
            .expect("archiving should succeed");
        assert!(archived.summary.archived_at.is_some());

        let visible = CombatService::new()
            .list_scenarios(&db, false)
            .await
            .expect("listing should succeed");
        assert!(visible.is_empty());

        let all = CombatService::new()
            .list_scenarios(&db, true)
            .await
            .expect("listing with archived should succeed");
        assert_eq!(all.len(), 1);

        let unarchived = CombatService::new()
            .set_scenario_archived(&db, created.summary.id, false)
            .await
            .expect("unarchiving should succeed");
        assert!(unarchived.summary.archived_at.is_none());
    }

    #[tokio::test]
    async fn running_a_scenario_pins_a_result_and_is_listed() {
        let db = seed_db().await;
        let creator = seed_user(&db, "officer").await;
        let created = CombatService::new()
            .create_scenario(
                &db,
                creator,
                &CreateScenarioRequest { name: "Lethal".to_string(), definition: lethal_definition() },
            )
            .await
            .expect("scenario should be created");

        let run = CombatService::new()
            .run_scenario(&db, created.summary.id, creator)
            .await
            .expect("run should succeed");
        assert_eq!(run.result.deaths, 1);
        assert_eq!(run.summary.scenario_id, created.summary.id);
        assert_eq!(run.summary.ran_by, creator);
        assert_eq!(run.summary.ran_by_username, "officer");

        let runs = CombatService::new()
            .list_runs(&db, created.summary.id)
            .await
            .expect("listing runs should succeed");
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].id, run.summary.id);

        let refetched = CombatService::new()
            .get_run(&db, run.summary.id)
            .await
            .expect("run should be re-readable");
        assert_eq!(refetched.result.deaths, 1);

        let with_run_count = CombatService::new()
            .get_scenario(&db, created.summary.id)
            .await
            .expect("scenario should still exist");
        assert_eq!(with_run_count.summary.run_count, 1);
    }

    #[tokio::test]
    async fn a_scenario_with_no_such_id_is_not_found() {
        let db = seed_db().await;
        let error = CombatService::new()
            .get_scenario(&db, 999_999)
            .await
            .expect_err("a nonexistent scenario should not resolve");
        assert!(matches!(error, crate::errors::AppError::NotFound(_)));
    }

    #[tokio::test]
    async fn a_run_with_no_such_id_is_not_found() {
        let db = seed_db().await;
        let error = CombatService::new()
            .get_run(&db, 999_999)
            .await
            .expect_err("a nonexistent run should not resolve");
        assert!(matches!(error, crate::errors::AppError::NotFound(_)));
    }
}
