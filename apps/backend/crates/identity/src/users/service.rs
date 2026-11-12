//! User service logic module.
//!
//! Provides structures and logic to fetch and manage user data from the database.

use backend_core::errors::AppError;
use backend_core::pagination::{PaginatedData, PaginationParams, SortOrder, resolve_sort_key};
use sea_orm::Condition;
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, PaginatorTrait, QueryFilter,
    QueryOrder, Set, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use utoipa::ToSchema;

use crate::albion::service::AlbionLinkService;
use backend_entities::battles::{BattleLossEstimate, Entity as GuildBattleSnapshotEntity};
use backend_entities::comps::build::Entity as BuildEntity;
use backend_entities::events::event_participation::{
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
    /// The registered email address of the user. Only present for the user themselves and for
    /// viewers holding `users.create` or `roles.manage` (or the tenant owner); everyone else gets
    /// the field omitted.
    #[schema(example = "dev@example.com")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
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
        model: backend_entities::users::Model,
    ) -> Result<Self, AppError> {
        let username = super::display_name::resolve(db, &model).await?;
        Ok(Self {
            id: model.id as u64,
            username,
            email: Some(model.email),
            role: model.role,
        })
    }

    /// Drops the email unless `viewer_user_id` is this profile or `can_see_emails` is set.
    #[must_use]
    pub fn redacted_for(mut self, viewer_user_id: i64, can_see_emails: bool) -> Self {
        let is_self = viewer_user_id > 0 && u64::try_from(viewer_user_id) == Ok(self.id);
        if !is_self && !can_see_emails {
            self.email = None;
        }
        self
    }
}

/// Filters that can be applied when listing users.
#[derive(Debug, Clone, Deserialize, ToSchema, Default)]
pub struct UserFilters {
    /// Filter users whose username contains the given string (case-insensitive).
    #[schema(example = "rust")]
    pub username: Option<String>,
    /// Filter users by their exact resolved role name.
    #[schema(example = "Officer")]
    pub role: Option<String>,
    /// Sort column. Allowed: `username`, `role`. Omitted uses insertion/`id` order.
    pub sort: Option<String>,
    /// Sort direction: `asc` or `desc`. Defaults to `desc` when `sort` is set.
    pub order: Option<String>,
}

/// Request body for `POST /api/users` — provision a Discord member and link an Albion character.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct CreateUserRequest {
    /// Discord user snowflake selected from `GET /api/admin/discord/members`.
    #[schema(example = "123456789012345678")]
    pub discord_id: String,
    /// Albion player id from the configured guild roster. Preferred when present.
    #[schema(example = "aPngkjfLT2CGiZoWXLr8UQ")]
    pub albion_player_id: Option<String>,
    /// Albion in-game name, resolved uniquely against the configured guild roster.
    #[schema(example = "Kay")]
    pub albion_player_name: Option<String>,
}

/// Fields needed to insert a local user already resolved from Discord + Albion.
pub struct CreateLinkedMember {
    /// Discord user snowflake.
    pub discord_id: String,
    /// Discord username (or nick) stored until an Albion name is linked.
    pub username: String,
    /// Highest gestionale role resolved from the member's Discord roles.
    pub role: String,
    /// Albion Online player id.
    pub albion_player_id: String,
    /// Albion Online character name.
    pub albion_player_name: String,
    /// Internal `users.id` of the manager provisioning the member, for the audit log.
    pub actor_user_id: Option<i64>,
}

/// Placeholder email for members provisioned before they log in with Discord OAuth.
///
/// Delegates to [`crate::users::identity::provisional_discord_email`], the single source.
#[must_use]
pub fn provisional_discord_email(discord_id: &str) -> String {
    crate::users::identity::provisional_discord_email(discord_id)
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
        use backend_entities::users::Entity as UserEntity;
        let user = UserEntity::find_by_id(user_id as i64).one(db).await?;
        match user {
            Some(model) => Ok(Some(UserProfile::from_model(db, model).await?)),
            None => Ok(None),
        }
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
            most_played_build,
            events_attended,
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
        participations: &[backend_entities::events::event_participation::Model],
    ) -> Result<UserMetrics, AppError> {
        use backend_entities::events::event;
        use backend_entities::regear::regear_death;
        use backend_entities::splits::split_participant;
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
        let split_earnings = backend_entities::bank::Entity::find()
            .filter(backend_entities::bank::Column::ToUserId.eq(user_id))
            .filter(backend_entities::bank::Column::SplitId.is_not_null())
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
                    Vec<backend_entities::battles::BattlePlayer>,
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
        use backend_entities::users::Entity as UserEntity;

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
        use backend_entities::users::{Column as UserColumn, Entity as UserEntity};

        let mut query = UserEntity::find();

        if let Some(username) = filters
            .username
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            // The UI displays a linked Albion character name, while the
            // users row keeps the Discord username. Search both identities so
            // every member picker and the users table use the same name.
            let pattern = format!("%{}%", username.to_lowercase());
            let linked_discord_ids = backend_entities::albion::albion_link::Entity::find()
                .filter(
                    Expr::expr(Func::lower(Expr::col(
                        backend_entities::albion::albion_link::Column::AlbionPlayerName,
                    )))
                    .like(pattern.clone()),
                )
                .all(db)
                .await?
                .into_iter()
                .map(|link| link.discord_id)
                .collect::<Vec<_>>();

            let mut name_filter = Condition::any()
                .add(Expr::expr(Func::lower(Expr::col(UserColumn::Username))).like(pattern));
            if !linked_discord_ids.is_empty() {
                name_filter = name_filter.add(UserColumn::DiscordId.is_in(linked_discord_ids));
            }
            query = query.filter(name_filter);
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
            .as_ref()
            .is_some_and(|value| !value.is_empty());
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
                email: Some(m.email),
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

    /// Inserts a local user for a Discord member and links their Albion character.
    ///
    /// The Discord snowflake is the stable identity: later OAuth login must reuse this row
    /// instead of creating a second account keyed only by email.
    pub async fn create_linked_member(
        &self,
        db: &DatabaseConnection,
        input: CreateLinkedMember,
    ) -> Result<UserProfile, AppError> {
        use backend_entities::albion::albion_link;
        use backend_entities::users::{Column as UserColumn, Entity as UserEntity};

        let discord_id = input.discord_id.trim();
        if discord_id.is_empty() {
            return Err(AppError::Validation("discord_id is required".to_owned()));
        }
        if input.albion_player_id.trim().is_empty() || input.albion_player_name.trim().is_empty() {
            return Err(AppError::Validation(
                "albion_player_id and albion_player_name are required".to_owned(),
            ));
        }

        let txn = db.begin().await?;

        if UserEntity::find()
            .filter(UserColumn::DiscordId.eq(discord_id))
            .one(&txn)
            .await?
            .is_some()
        {
            return Err(AppError::Conflict(
                "This Discord member already has an account".to_owned(),
            ));
        }

        if albion_link::Entity::find()
            .filter(albion_link::Column::AlbionPlayerId.eq(&input.albion_player_id))
            .one(&txn)
            .await?
            .is_some()
        {
            return Err(AppError::Conflict(
                "This Albion character is already linked to another member".to_owned(),
            ));
        }

        if albion_link::Entity::find()
            .filter(albion_link::Column::DiscordId.eq(discord_id))
            .one(&txn)
            .await?
            .is_some()
        {
            return Err(AppError::Conflict(
                "This Discord account is already linked to an Albion character".to_owned(),
            ));
        }

        let inserted = backend_entities::users::ActiveModel {
            username: Set(input.username.clone()),
            email: Set(provisional_discord_email(discord_id)),
            role: Set(input.role.clone()),
            discord_id: Set(Some(discord_id.to_string())),
            ..Default::default()
        }
        .insert(&txn)
        .await?;

        let link = albion_link::ActiveModel {
            discord_id: Set(discord_id.to_string()),
            albion_player_id: Set(input.albion_player_id.clone()),
            albion_player_name: Set(input.albion_player_name.clone()),
            linked_at: Set(chrono::Utc::now().into()),
            ..Default::default()
        }
        .insert(&txn)
        .await?;
        crate::audit::service::AuditService::record_in(
            &txn,
            crate::albion::service::AUDIT_LINK,
            Some(crate::albion::service::AUDIT_ENTITY),
            Some(link.id),
            input.actor_user_id,
            Some(serde_json::json!({
                "via": "provision",
                "link": {
                    "discord_id": link.discord_id,
                    "albion_player_id": link.albion_player_id,
                    "albion_player_name": link.albion_player_name,
                },
            })),
        )
        .await?;

        txn.commit().await?;
        UserProfile::from_model(db, inserted).await
    }
}

impl Default for UserService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    fn profile(id: u64, email: &str) -> UserProfile {
        UserProfile {
            id,
            username: format!("user-{id}"),
            email: Some(email.to_string()),
            role: "User".to_string(),
        }
    }

    #[test]
    fn a_plain_member_sees_only_their_own_email() {
        // Another member: no email. Self: kept. A privileged viewer: kept.
        assert_eq!(profile(7, "a@x.io").redacted_for(3, false).email, None);
        assert_eq!(
            profile(7, "a@x.io").redacted_for(7, false).email.as_deref(),
            Some("a@x.io")
        );
        assert_eq!(
            profile(7, "a@x.io").redacted_for(3, true).email.as_deref(),
            Some("a@x.io")
        );
        // An unresolved viewer (user_id 0) never matches a row.
        assert_eq!(profile(0, "a@x.io").redacted_for(0, false).email, None);
    }

    #[test]
    fn a_redacted_profile_serializes_without_an_email_key() {
        let json = serde_json::to_value(profile(7, "a@x.io").redacted_for(3, false)).unwrap();
        assert!(json.get("email").is_none(), "{json}");
        let json = serde_json::to_value(profile(7, "a@x.io")).unwrap();
        assert_eq!(json["email"], "a@x.io");
    }

    #[test]
    fn the_email_query_parameter_is_not_a_filter() {
        let filters: UserFilters =
            serde_urlencoded::from_str("email=alice%40example.com&role=Admin").unwrap();
        assert_eq!(filters.role.as_deref(), Some("Admin"));
    }

    #[tokio::test]
    async fn listing_ignores_an_email_probe() {
        use backend_entities::users::ActiveModel;
        let db = backend_migration::testkit::migrated_sqlite().await;
        for (name, email) in [("alice", "alice@example.com"), ("bob", "bob@example.com")] {
            ActiveModel {
                username: Set(name.to_string()),
                email: Set(email.to_string()),
                role: Set("User".to_string()),
                ..Default::default()
            }
            .insert(&db)
            .await
            .expect("insert");
        }
        let filters: UserFilters = serde_urlencoded::from_str("email=alice%40example.com").unwrap();
        let page = UserService::new()
            .list_users(
                &db,
                &PaginationParams {
                    page: Some(1),
                    limit: Some(10),
                },
                &filters,
            )
            .await
            .expect("list");
        // The probe filters nothing, so it cannot be used to test whether an address exists.
        assert_eq!(page.items.len(), 2);
    }

    use super::*;
    use sea_orm::{ActiveModelTrait, ActiveValue::Set};

    #[tokio::test]
    async fn test_pagination_and_filtering() {
        let db = backend_migration::testkit::migrated_sqlite().await;

        use backend_entities::users::ActiveModel;

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

    #[tokio::test]
    async fn create_linked_member_inserts_user_and_albion_link() {
        let db = backend_migration::testkit::migrated_sqlite().await;
        let service = UserService::new();

        let profile = service
            .create_linked_member(
                &db,
                CreateLinkedMember {
                    discord_id: "111".into(),
                    username: "nelly".into(),
                    role: "Member".into(),
                    albion_player_id: "player_1".into(),
                    albion_player_name: "Kay".into(),
                    actor_user_id: None,
                },
            )
            .await
            .expect("create");

        assert_eq!(profile.username, "Kay");
        assert_eq!(profile.role, "Member");
        assert_eq!(profile.email, Some(provisional_discord_email("111")));

        let found_by_albion_name = service
            .list_users(
                &db,
                &PaginationParams {
                    page: Some(1),
                    limit: Some(10),
                },
                &UserFilters {
                    username: Some("kay".into()),
                    ..Default::default()
                },
            )
            .await
            .expect("search by linked Albion name");
        assert_eq!(found_by_albion_name.total_items, 1);
        assert_eq!(found_by_albion_name.items[0].username, "Kay");

        let again = service
            .create_linked_member(
                &db,
                CreateLinkedMember {
                    discord_id: "111".into(),
                    username: "nelly".into(),
                    role: "Member".into(),
                    albion_player_id: "player_2".into(),
                    albion_player_name: "Other".into(),
                    actor_user_id: None,
                },
            )
            .await;
        assert!(matches!(again, Err(AppError::Conflict(_))));
    }

    #[tokio::test]
    async fn create_linked_member_rejects_claimed_albion_character() {
        let db = backend_migration::testkit::migrated_sqlite().await;
        let service = UserService::new();
        service
            .create_linked_member(
                &db,
                CreateLinkedMember {
                    discord_id: "111".into(),
                    username: "one".into(),
                    role: "Member".into(),
                    albion_player_id: "player_1".into(),
                    albion_player_name: "Kay".into(),
                    actor_user_id: None,
                },
            )
            .await
            .expect("first");

        let result = service
            .create_linked_member(
                &db,
                CreateLinkedMember {
                    discord_id: "222".into(),
                    username: "two".into(),
                    role: "Member".into(),
                    albion_player_id: "player_1".into(),
                    albion_player_name: "Kay".into(),
                    actor_user_id: None,
                },
            )
            .await;
        assert!(matches!(result, Err(AppError::Conflict(_))));
    }
}
