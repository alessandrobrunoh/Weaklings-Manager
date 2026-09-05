//! User service logic module.
//!
//! Provides structures and logic to fetch and manage user data from the database.

use crate::errors::AppError;
use crate::pagination::{PaginatedData, PaginationParams, SortOrder, resolve_sort_key};
use sea_orm::{
    ColumnTrait, DatabaseConnection, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder, Set,
    TransactionTrait,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use utoipa::ToSchema;

use crate::modules::albion::service::AlbionLinkService;
use crate::modules::combat::dataset::spec_node;
use crate::modules::battles::entities::Entity as GuildBattleSnapshotEntity;
use crate::modules::battles::models::BattleLossEstimate;
use crate::modules::comps::entities::build::Entity as BuildEntity;
use crate::modules::events::entities::event_participation::{
    Column as EventParticipationColumn, Entity as EventParticipationEntity,
};

/// The profile of a user containing identification and authorization details.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct UserProfile {
    /// The unique identifier of the user.
    #[schema(example = 42)]
    pub id: u64,
    /// The screen name or username of the user.
    #[schema(example = "rust_developer")]
    pub username: String,
    /// The registered email address of the user.
    #[schema(example = "dev@example.com")]
    pub email: String,
    /// The authorization role of the user (e.g. Admin, User).
    #[schema(example = "Admin")]
    pub role: String,
}

/// The aggregated metrics for a user's profile.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct UserMetrics {
    /// Events the guild ran in total, so attendance reads as a rate rather
    /// than a bare count that means nothing on its own.
    pub events_total: i64,
    /// Share of guild events this member signed up for, 0-100.
    pub attendance_rate: f64,
    /// Consecutive most-recent events signed up for.
    pub attendance_streak: i64,
    /// The member's next scheduled event, if any.
    pub next_event_title: Option<String>,
    /// When that event starts, RFC 3339.
    pub next_event_at: Option<String>,
    /// Battles the member appeared in.
    pub battles_fought: i64,
    /// Kills across those battles.
    pub kills: i64,
    /// Deaths across those battles.
    pub deaths: i64,
    /// Kill fame earned.
    pub kill_fame: i64,
    /// Regear requests raised, in any state.
    pub regears_claimed: i64,
    /// Regear requests still awaiting a decision.
    pub regears_pending: i64,
    /// Regear requests approved.
    pub regears_approved: i64,
    /// Silver actually reimbursed through approved regears.
    pub regear_silver: i64,
    /// Loot splits the member took part in.
    pub splits_joined: i64,
    /// Silver received from split payouts.
    pub split_earnings: i64,
    /// The name of the build the user signed up with the most.
    pub most_played_build: Option<String>,
    /// The number of events the user has attended/signed up for.
    pub events_attended: i64,
    /// Total estimated silver loss across all battles.
    pub total_estimated_loss: i64,
    /// Highest estimated silver loss in a single battle.
    pub top_estimated_loss: i64,
}

impl UserProfile {
    /// Builds a `UserProfile` from a user row, resolving `username` to the user's linked
    /// Albion Online character name if they have one, falling back to their Discord username.
    async fn from_model(
        db: &sea_orm::DatabaseConnection,
        model: super::entities::Model,
    ) -> Result<Self, AppError> {
        let username = super::display_name::resolve(db, &model).await?;
        Ok(Self {
            id: model.id as u64,
            username,
            email: model.email,
            role: model.role,
        })
    }
}

/// Filters that can be applied when listing users.
#[derive(Debug, Clone, Deserialize, ToSchema, Default)]
pub struct UserFilters {
    /// Filter users whose username contains the given string (case-insensitive).
    #[schema(example = "rust")]
    pub username: Option<String>,
    /// Filter users with the exact email address.
    #[schema(example = "dev@example.com")]
    pub email: Option<String>,
    /// Filter users by their exact resolved role name.
    #[schema(example = "Officer")]
    pub role: Option<String>,
    /// Sort column. Allowed: `username`, `role`. Omitted uses insertion/`id` order.
    pub sort: Option<String>,
    /// Sort direction: `asc` or `desc`. Defaults to `desc` when `sort` is set.
    pub order: Option<String>,
}

/// Service for executing business logic operations related to users.
pub struct UserService;

impl UserService {
    /// Creates a new instance of the `UserService`.
    #[must_use]
    pub fn new() -> Self {
        Self
    }

    /// Fetches the profile of a user by their user ID.
    ///
    /// Returns `Some(UserProfile)` if the user is found, or `None` otherwise.
    pub async fn get_profile(
        &self,
        db: &DatabaseConnection,
        user_id: u64,
    ) -> Result<Option<UserProfile>, AppError> {
        use super::entities::Entity as UserEntity;
        let user = UserEntity::find_by_id(user_id as i64).one(db).await?;
        match user {
            Some(model) => Ok(Some(UserProfile::from_model(db, model).await?)),
            None => Ok(None),
        }
    }

    /// Lists all saved specialization levels for a user.
    pub async fn list_specializations(
        &self,
        db: &DatabaseConnection,
        user_id: u64,
    ) -> Result<Vec<super::specializations::UserSpecializationView>, AppError> {
        let rows = super::specializations::Entity::find()
            .filter(super::specializations::Column::UserId.eq(user_id as i64))
            .order_by_asc(super::specializations::Column::Category)
            .order_by_asc(super::specializations::Column::NodeName)
            .all(db)
            .await?;
        let mut by_key = HashMap::new();
        for row in rows {
            let mut view = super::specializations::UserSpecializationView::from(row);
            view.node_key = super::specializations::canonical_node_key(&view.node_key);
            let replace = by_key.get(&view.node_key).is_none_or(
                |current: &super::specializations::UserSpecializationView| {
                    view.level > current.level
                },
            );
            if replace {
                by_key.insert(view.node_key.clone(), view);
            }
        }
        let mut views: Vec<_> = by_key.into_values().collect();
        views.sort_by(|left, right| {
            left.category
                .cmp(&right.category)
                .then_with(|| left.node_name.cmp(&right.node_name))
        });
        Ok(views)
    }

    /// Validates and upserts specialization levels without deleting omitted rows.
    pub async fn update_specializations(
        &self,
        db: &DatabaseConnection,
        target_user_id: u64,
        editor_user_id: i64,
        request: &super::specializations::UpdateSpecializationsRequest,
    ) -> Result<Vec<super::specializations::UserSpecializationView>, AppError> {
        if request.specializations.len() > 500 {
            return Err(AppError::Validation(
                "At most 500 specializations can be updated at once".to_string(),
            ));
        }
        let mut keys = HashSet::new();
        let now: sea_orm::prelude::DateTimeWithTimeZone = chrono::Utc::now().into();
        let rows = request
            .specializations
            .iter()
            .map(|item| {
                let key = super::specializations::canonical_node_key(&item.node_key);
                let category = item.category.trim().to_lowercase();
                let name = item.node_name.trim();
                if key.is_empty() || name.is_empty() || key.len() > 128 || name.len() > 160 {
                    return Err(AppError::Validation(
                        "Specialization key and name are required and within size limits"
                            .to_string(),
                    ));
                }
                // `weapon`/`armor` rows name a catalog item (`weapon:2H_POLEHAMMER`), capped at
                // Albion's 120-level specialization scale. `mastery` rows name a Destiny Board
                // family node directly (`mastery:COMBAT_HAMMERS`) — verified against the bundled
                // combat dataset rather than trusted from the client, since an invalid id here
                // would silently vanish from every Item Power figure that reads it — and capped at
                // the dataset's own 100-level mastery scale rather than the weapon/armor one.
                let max_level = match category.as_str() {
                    "weapon" | "armor" => 120,
                    "mastery" => 100,
                    _ => {
                        return Err(AppError::Validation(
                            "Invalid or duplicated combat specialization".to_string(),
                        ));
                    }
                };
                let valid_key = key.strip_prefix(&format!("{category}:")).is_some_and(|id| {
                    if category == "mastery" {
                        spec_node(id).is_some_and(|node| node.kind == "mastery")
                    } else {
                        !id.is_empty() && !id.contains(':')
                    }
                });
                if !valid_key || !keys.insert(key.clone()) {
                    return Err(AppError::Validation(
                        "Invalid or duplicated combat specialization".to_string(),
                    ));
                }
                if !(0..=max_level).contains(&item.level) {
                    return Err(AppError::Validation(format!(
                        "Specialization level must be between 0 and {max_level}"
                    )));
                }
                Ok(super::specializations::ActiveModel {
                    user_id: Set(target_user_id as i64),
                    node_key: Set(key),
                    node_name: Set(name.to_string()),
                    category: Set(category),
                    level: Set(item.level),
                    updated_at: Set(now.clone()),
                    updated_by_user_id: Set(Some(editor_user_id)),
                    ..Default::default()
                })
            })
            .collect::<Result<Vec<_>, AppError>>()?;

        if !rows.is_empty() {
            let txn = db.begin().await.map_err(AppError::Database)?;
            super::specializations::Entity::insert_many(rows)
                .on_conflict(
                    sea_orm::sea_query::OnConflict::columns([
                        super::specializations::Column::UserId,
                        super::specializations::Column::NodeKey,
                    ])
                    .update_columns([
                        super::specializations::Column::NodeName,
                        super::specializations::Column::Category,
                        super::specializations::Column::Level,
                        super::specializations::Column::UpdatedAt,
                        super::specializations::Column::UpdatedByUserId,
                    ])
                    .to_owned(),
                )
                .exec(&txn)
                .await
                .map_err(AppError::Database)?;
            txn.commit().await.map_err(AppError::Database)?;
        }

        let _ = crate::modules::audit::service::AuditService::log(
            db,
            "USER_SPECIALIZATIONS_UPDATED",
            Some("USER_SPECIALIZATIONS"),
            Some(target_user_id as i64),
            Some(editor_user_id),
            Some(serde_json::json!({
                "target_user_id": target_user_id,
                "nodes_updated": request.specializations.len(),
                "node_keys": request.specializations.iter().map(|item| item.node_key.trim()).collect::<Vec<_>>(),
            })),
        )
        .await;

        self.list_specializations(db, target_user_id).await
    }

    /// Computes and returns the metrics for a given user.
    pub async fn get_metrics(
        &self,
        db: &DatabaseConnection,
        user_id: u64,
        discord_id: &str,
    ) -> Result<UserMetrics, AppError> {
        let participations = EventParticipationEntity::find()
            .filter(EventParticipationColumn::UserId.eq(user_id as i64))
            .all(db)
            .await?;

        let events_attended = participations.len() as i64;
        let mut build_counts = HashMap::new();
        for build_id in participations
            .iter()
            .filter_map(|participation| participation.primary_build_id)
        {
            *build_counts.entry(build_id).or_insert(0) += 1;
        }
        let most_played_build_id = build_counts
            .into_iter()
            .max_by_key(|&(_, count)| count)
            .map(|(id, _)| id);

        let most_played_build = if let Some(id) = most_played_build_id {
            BuildEntity::find_by_id(id).one(db).await?.map(|b| b.name)
        } else {
            None
        };

        let mut total_estimated_loss = 0;
        let mut top_estimated_loss = 0;

        if let Some(link) = AlbionLinkService::new()
            .get_link_for_discord_user(db, discord_id)
            .await?
        {
            let albion_name = link.albion_player_name;
            let snapshots = GuildBattleSnapshotEntity::find().all(db).await?;
            for snap in snapshots {
                if let Ok(losses) = serde_json::from_str::<BattleLossEstimate>(&snap.losses_json) {
                    for player in losses.players {
                        if player.player_name.eq_ignore_ascii_case(&albion_name) {
                            total_estimated_loss += player.estimated_loss;
                            top_estimated_loss = top_estimated_loss.max(player.estimated_loss);
                        }
                    }
                }
            }
        }

        let extras = self
            .personal_activity(db, user_id as i64, &participations)
            .await?;

        Ok(UserMetrics {
            events_attended,
            most_played_build,
            total_estimated_loss,
            top_estimated_loss,
            ..extras
        })
    }

    /// Attendance, combat, regear and split figures for one member.
    ///
    /// Loaded in bulk — one query per table, then folded in memory — because
    /// this runs on every profile view. Combat figures resolve through the
    /// member's linked Albion character, so an unlinked member sees zeroes
    /// there while their regear and split figures, which key off real foreign
    /// keys, remain correct.
    async fn personal_activity(
        &self,
        db: &DatabaseConnection,
        user_id: i64,
        participations: &[crate::modules::events::entities::event_participation::Model],
    ) -> Result<UserMetrics, AppError> {
        use crate::modules::events::entities::event;
        use crate::modules::regear::entities::regear_death;
        use crate::modules::splits::entities::split_participant;
        use rust_decimal::prelude::ToPrimitive;

        let events = event::Entity::find().all(db).await?;
        let joined: std::collections::HashSet<i64> =
            participations.iter().map(|p| p.event_id).collect();

        // Newest first, so the streak is simply how far back attendance runs
        // unbroken from the most recent event.
        let mut ordered: Vec<&event::Model> = events.iter().collect();
        ordered.sort_by_key(|e| std::cmp::Reverse(e.event_date_utc));
        let attendance_streak = ordered
            .iter()
            .take_while(|e| joined.contains(&e.id))
            .count() as i64;

        let now: sea_orm::prelude::DateTimeWithTimeZone = chrono::Utc::now().into();
        let next = ordered
            .iter()
            .rev()
            .find(|e| e.event_date_utc > now && joined.contains(&e.id));

        let regears = regear_death::Entity::find()
            .filter(regear_death::Column::UserId.eq(user_id))
            .all(db)
            .await?;
        let regear_silver = regears
            .iter()
            .filter(|r| r.status == "approved")
            .map(|r| {
                r.final_amount
                    .unwrap_or(r.auto_estimate_total)
                    .to_i64()
                    .unwrap_or(0)
            })
            .sum();

        let splits_joined = split_participant::Entity::find()
            .filter(split_participant::Column::UserId.eq(user_id))
            .count(db)
            .await? as i64;

        // Split payouts reach a member as bank transactions tagged with the
        // split, which is the only place the actual paid amount lives.
        let split_earnings = crate::modules::bank::entities::Entity::find()
            .filter(crate::modules::bank::entities::Column::ToUserId.eq(user_id))
            .filter(crate::modules::bank::entities::Column::SplitId.is_not_null())
            .all(db)
            .await?
            .iter()
            .map(|tx| tx.amount.to_i64().unwrap_or(0))
            .sum();

        let mut battles_fought = 0;
        let mut kills = 0;
        let mut deaths = 0;
        let mut kill_fame = 0;
        if let Some(name) = self.linked_character(db, user_id).await? {
            let snapshots = GuildBattleSnapshotEntity::find().all(db).await?;
            for snap in snapshots {
                let Ok(players) = serde_json::from_str::<
                    Vec<crate::modules::battles::models::BattlePlayer>,
                >(&snap.players_json) else {
                    continue;
                };
                if let Some(me) = players.iter().find(|p| p.name.eq_ignore_ascii_case(&name)) {
                    battles_fought += 1;
                    kills += me.kills;
                    deaths += me.deaths;
                    kill_fame += me.kill_fame;
                }
            }
        }

        let events_total = events.len() as i64;
        Ok(UserMetrics {
            events_attended: 0,
            most_played_build: None,
            total_estimated_loss: 0,
            top_estimated_loss: 0,
            events_total,
            attendance_rate: if events_total > 0 {
                (participations.len() as f64 / events_total as f64) * 100.0
            } else {
                0.0
            },
            attendance_streak,
            next_event_title: next.map(|e| e.title.clone()),
            next_event_at: next.map(|e| e.event_date_utc.to_rfc3339()),
            battles_fought,
            kills,
            deaths,
            kill_fame,
            regears_claimed: regears.len() as i64,
            regears_pending: regears.iter().filter(|r| r.status == "pending").count() as i64,
            regears_approved: regears.iter().filter(|r| r.status == "approved").count() as i64,
            regear_silver,
            splits_joined,
            split_earnings,
        })
    }

    /// The Albion character name linked to a user, if any.
    async fn linked_character(
        &self,
        db: &DatabaseConnection,
        user_id: i64,
    ) -> Result<Option<String>, AppError> {
        use super::entities::Entity as UserEntity;

        let Some(user) = UserEntity::find_by_id(user_id).one(db).await? else {
            return Ok(None);
        };
        let Some(discord_id) = user.discord_id.as_deref() else {
            return Ok(None);
        };
        Ok(AlbionLinkService::new()
            .get_link_for_discord_user(db, discord_id)
            .await?
            .map(|link| link.albion_player_name))
    }

    /// Lists paginated and filtered users from the database.
    ///
    /// # Errors
    ///
    /// Returns `AppError::Database` if the query fails.
    pub async fn list_users(
        &self,
        db: &DatabaseConnection,
        pagination: &PaginationParams,
        filters: &UserFilters,
    ) -> Result<PaginatedData<UserProfile>, AppError> {
        use super::entities::{Column as UserColumn, Entity as UserEntity};

        let mut query = UserEntity::find();

        if let Some(ref username) = filters.username {
            query = query.filter(UserColumn::Username.contains(username));
        }
        if let Some(ref email) = filters.email {
            query = query.filter(UserColumn::Email.eq(email.clone()));
        }
        if let Some(ref role) = filters.role {
            query = query.filter(UserColumn::Role.eq(role.clone()));
        }

        let sort_column = resolve_sort_key(
            filters.sort.as_deref(),
            &[
                ("username", UserColumn::Username),
                ("role", UserColumn::Role),
            ],
            UserColumn::Id,
        )?;
        let sort_requested = filters
            .sort
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_some();
        let order = if sort_requested {
            SortOrder::from_query(filters.order.as_deref())
        } else {
            SortOrder::Asc
        };
        query = match order {
            SortOrder::Asc => query.order_by_asc(sort_column),
            SortOrder::Desc => query.order_by_desc(sort_column),
        };

        let limit = pagination.limit();
        let page = pagination.offset_page();

        let paginator = query.paginate(db, limit);
        let total_items = paginator.num_items().await?;
        let total_pages = paginator.num_pages().await?;
        let models = paginator.fetch_page(page).await?;

        let user_ids: Vec<i64> = models.iter().map(|m| m.id).collect();
        let mut names = super::display_name::resolve_by_ids(db, &user_ids).await?;
        let items = models
            .into_iter()
            .map(|m| UserProfile {
                username: names.remove(&m.id).unwrap_or_else(|| m.username.clone()),
                id: m.id as u64,
                email: m.email,
                role: m.role,
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
}

impl Default for UserService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migration::MigratorTrait;
    use sea_orm::{ActiveModelTrait, ActiveValue::Set, Database};

    #[tokio::test]
    async fn test_pagination_and_filtering() {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("Failed to connect to test database");

        crate::migration::Migrator::up(&db, None)
            .await
            .expect("Failed to run database migrations");

        use super::super::entities::ActiveModel;

        let user_a = ActiveModel {
            username: Set("alice".to_string()),
            email: Set("alice@example.com".to_string()),
            role: Set("Admin".to_string()),
            ..Default::default()
        };
        user_a.insert(&db).await.expect("Failed to insert user A");

        let user_b = ActiveModel {
            username: Set("bob".to_string()),
            email: Set("bob@example.com".to_string()),
            role: Set("User".to_string()),
            ..Default::default()
        };
        user_b.insert(&db).await.expect("Failed to insert user B");

        let user_c = ActiveModel {
            username: Set("charlie".to_string()),
            email: Set("charlie@example.com".to_string()),
            role: Set("User".to_string()),
            ..Default::default()
        };
        user_c.insert(&db).await.expect("Failed to insert user C");

        let service = UserService::new();

        let page_1 = service
            .list_users(
                &db,
                &PaginationParams {
                    page: Some(1),
                    limit: Some(2),
                },
                &UserFilters::default(),
            )
            .await
            .expect("Failed to list users");

        assert_eq!(page_1.items.len(), 2);
        assert_eq!(page_1.total_items, 3);
        assert_eq!(page_1.total_pages, 2);
        assert_eq!(page_1.current_page, 1);
        assert_eq!(page_1.items[0].username, "alice");
        assert_eq!(page_1.items[1].username, "bob");

        let page_2 = service
            .list_users(
                &db,
                &PaginationParams {
                    page: Some(2),
                    limit: Some(2),
                },
                &UserFilters::default(),
            )
            .await
            .expect("Failed to list users page 2");

        assert_eq!(page_2.items.len(), 1);
        assert_eq!(page_2.items[0].username, "charlie");

        let role_filter = service
            .list_users(
                &db,
                &PaginationParams {
                    page: Some(1),
                    limit: Some(10),
                },
                &UserFilters {
                    role: Some("User".to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("Failed to filter users by role");

        assert_eq!(role_filter.items.len(), 2);
        assert_eq!(role_filter.total_items, 2);
        assert_eq!(role_filter.items[0].username, "bob");
        assert_eq!(role_filter.items[1].username, "charlie");

        let name_filter = service
            .list_users(
                &db,
                &PaginationParams {
                    page: Some(1),
                    limit: Some(10),
                },
                &UserFilters {
                    username: Some("li".to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("Failed to filter users by name");

        assert_eq!(name_filter.items.len(), 2);
        assert_eq!(name_filter.items[0].username, "alice");
        assert_eq!(name_filter.items[1].username, "charlie");

        let sorted = service
            .list_users(
                &db,
                &PaginationParams {
                    page: Some(1),
                    limit: Some(10),
                },
                &UserFilters {
                    sort: Some("username".to_string()),
                    order: Some("desc".to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("Failed to sort users by username");
        let names: Vec<_> = sorted
            .items
            .iter()
            .map(|user| user.username.as_str())
            .collect();
        assert_eq!(names, vec!["charlie", "bob", "alice"]);

        let by_role = service
            .list_users(
                &db,
                &PaginationParams {
                    page: Some(1),
                    limit: Some(10),
                },
                &UserFilters {
                    sort: Some("role".to_string()),
                    order: Some("asc".to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("Failed to sort users by role");
        assert_eq!(by_role.items[0].role, "Admin");
        assert_eq!(by_role.items[0].username, "alice");

        let error = service
            .list_users(
                &db,
                &PaginationParams {
                    page: Some(1),
                    limit: Some(10),
                },
                &UserFilters {
                    sort: Some("email".to_string()),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        match error {
            AppError::Validation(message) => assert!(message.contains("email")),
            other => panic!("expected validation, got {other:?}"),
        }
    }

    async fn seed_specializations_user() -> (DatabaseConnection, i64) {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("Failed to connect to test database");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("Failed to run database migrations");

        use super::super::entities::ActiveModel;
        let user = ActiveModel {
            username: Set("specializer".to_string()),
            email: Set("specializer@example.com".to_string()),
            role: Set("User".to_string()),
            ..Default::default()
        }
        .insert(&db)
        .await
        .expect("Failed to insert user");
        (db, user.id)
    }

    fn specialization_input(
        node_key: &str,
        category: &str,
        level: i32,
    ) -> super::super::specializations::UserSpecializationInput {
        super::super::specializations::UserSpecializationInput {
            node_key: node_key.to_string(),
            node_name: node_key.to_string(),
            category: category.to_string(),
            level,
        }
    }

    #[tokio::test]
    async fn a_mastery_row_names_a_destiny_board_family_node_directly() {
        let (db, user_id) = seed_specializations_user().await;
        let service = UserService::new();

        let request = super::super::specializations::UpdateSpecializationsRequest {
            specializations: vec![specialization_input("mastery:COMBAT_HAMMERS", "mastery", 87)],
        };

        let saved = service
            .update_specializations(&db, user_id as u64, user_id, &request)
            .await
            .expect("a real mastery node should be accepted");
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].node_key, "mastery:COMBAT_HAMMERS");
        assert_eq!(saved[0].level, 87);
    }

    #[tokio::test]
    async fn a_mastery_row_naming_an_unknown_node_is_rejected() {
        let (db, user_id) = seed_specializations_user().await;
        let service = UserService::new();

        let request = super::super::specializations::UpdateSpecializationsRequest {
            specializations: vec![specialization_input("mastery:NOT_A_REAL_NODE", "mastery", 50)],
        };

        let error = service
            .update_specializations(&db, user_id as u64, user_id, &request)
            .await
            .expect_err("an unknown mastery node should be rejected");
        assert!(matches!(error, AppError::Validation(_)));
    }

    #[tokio::test]
    async fn a_mastery_row_naming_a_leaf_specialization_is_rejected() {
        // `COMBAT_HAMMERS_POLE` is a real node, but it is a leaf spec, not the family mastery
        // node above it — a client sending it under `category: "mastery"` almost certainly meant
        // the weapon category instead, and should be told so rather than silently accepted.
        let (db, user_id) = seed_specializations_user().await;
        let service = UserService::new();

        let request = super::super::specializations::UpdateSpecializationsRequest {
            specializations: vec![specialization_input(
                "mastery:COMBAT_HAMMERS_POLE",
                "mastery",
                50,
            )],
        };

        let error = service
            .update_specializations(&db, user_id as u64, user_id, &request)
            .await
            .expect_err("a leaf spec node under category mastery should be rejected");
        assert!(matches!(error, AppError::Validation(_)));
    }

    #[tokio::test]
    async fn a_mastery_level_above_a_hundred_is_rejected_even_though_weapon_allows_more() {
        let (db, user_id) = seed_specializations_user().await;
        let service = UserService::new();

        let request = super::super::specializations::UpdateSpecializationsRequest {
            specializations: vec![specialization_input("mastery:COMBAT_HAMMERS", "mastery", 110)],
        };

        let error = service
            .update_specializations(&db, user_id as u64, user_id, &request)
            .await
            .expect_err("mastery caps at 100, unlike the 120 weapon/armor scale");
        match error {
            AppError::Validation(message) => assert!(message.contains('0')),
            other => panic!("expected validation, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn weapon_and_armor_rows_are_unaffected_by_the_mastery_addition() {
        let (db, user_id) = seed_specializations_user().await;
        let service = UserService::new();

        let request = super::super::specializations::UpdateSpecializationsRequest {
            specializations: vec![
                specialization_input("weapon:2H_POLEHAMMER", "weapon", 120),
                specialization_input("armor:ARMOR_PLATE_SET1", "armor", 100),
            ],
        };

        let saved = service
            .update_specializations(&db, user_id as u64, user_id, &request)
            .await
            .expect("existing weapon/armor rows should still validate");
        assert_eq!(saved.len(), 2);
    }

    #[tokio::test]
    async fn an_unknown_category_is_still_rejected() {
        let (db, user_id) = seed_specializations_user().await;
        let service = UserService::new();

        let request = super::super::specializations::UpdateSpecializationsRequest {
            specializations: vec![specialization_input("potion:HEAL", "potion", 1)],
        };

        let error = service
            .update_specializations(&db, user_id as u64, user_id, &request)
            .await
            .expect_err("an unrecognised category should be rejected");
        assert!(matches!(error, AppError::Validation(_)));
    }
}
