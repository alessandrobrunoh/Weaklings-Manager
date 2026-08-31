//! Inbox list/read plus guild-wide broadcast fan-out.

use chrono::{DateTime, FixedOffset, Utc};
use sea_orm::sea_query::OnConflict;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseConnection, EntityTrait,
    PaginatorTrait, QueryFilter, QueryOrder, Set, TransactionTrait,
};

use crate::errors::AppError;
use crate::modules::users::entities::Entity as UserEntity;
use crate::pagination::{PaginatedData, PaginationParams};

use super::entities::{
    NotificationActiveModel, NotificationBroadcastActiveModel, NotificationColumn,
    NotificationEntity, NotificationModel,
};
use super::models::{
    BroadcastRequest, BroadcastResult, NotificationFilters, NotificationView, NotifySpec,
    ReadAllResult, UnreadCountView,
};
use super::status::{DiscordDmStatus, NotificationKind};

const TITLE_MAX: usize = 120;
const BODY_MAX: usize = 2000;
const LINK_PATH_MAX: usize = 512;
const SOURCE_BROADCAST: &str = "broadcast";

/// Stateless notification operations.
pub struct NotificationService;

impl Default for NotificationService {
    fn default() -> Self {
        Self
    }
}

impl NotificationService {
    /// Creates a new instance.
    #[must_use]
    pub fn new() -> Self {
        Self
    }

    /// Lists the caller's inbox, newest first.
    ///
    /// # Errors
    ///
    /// Database errors.
    pub async fn list(
        &self,
        db: &DatabaseConnection,
        user_id: i64,
        pagination: &PaginationParams,
        filters: &NotificationFilters,
    ) -> Result<PaginatedData<NotificationView>, AppError> {
        let mut query = NotificationEntity::find().filter(NotificationColumn::UserId.eq(user_id));
        if filters.unread == Some(true) {
            query = query.filter(NotificationColumn::ReadAt.is_null());
        }
        query = query
            .order_by_desc(NotificationColumn::CreatedAt)
            .order_by_desc(NotificationColumn::Id);

        let limit = pagination.limit();
        let page = pagination.offset_page();
        let paginator = query.paginate(db, limit);
        let total_items = paginator.num_items().await?;
        let total_pages = paginator.num_pages().await?;
        let models = paginator.fetch_page(page).await?;
        Ok(PaginatedData::new(
            models
                .iter()
                .map(notification_view)
                .collect::<Result<Vec<_>, _>>()?,
            total_items,
            total_pages,
            page + 1,
            limit,
        ))
    }

    /// Unread count for the badge. Cheap path: no row payload.
    ///
    /// # Errors
    ///
    /// Database errors.
    pub async fn unread_count(
        &self,
        db: &DatabaseConnection,
        user_id: i64,
    ) -> Result<UnreadCountView, AppError> {
        let count = NotificationEntity::find()
            .filter(NotificationColumn::UserId.eq(user_id))
            .filter(NotificationColumn::ReadAt.is_null())
            .count(db)
            .await?;
        Ok(UnreadCountView { count })
    }

    /// Marks one of the caller's rows read. Idempotent if already read.
    ///
    /// # Errors
    ///
    /// `404` if the row does not exist or belongs to someone else.
    pub async fn mark_read(
        &self,
        db: &DatabaseConnection,
        user_id: i64,
        notification_id: i64,
    ) -> Result<NotificationView, AppError> {
        let existing = NotificationEntity::find_by_id(notification_id)
            .filter(NotificationColumn::UserId.eq(user_id))
            .one(db)
            .await?
            .ok_or_else(|| {
                AppError::NotFound(format!("notification {notification_id} not found"))
            })?;

        if existing.read_at.is_some() {
            return notification_view(&existing);
        }

        let now: DateTime<FixedOffset> = Utc::now().into();
        let mut active: NotificationActiveModel = existing.into();
        active.read_at = Set(Some(now));
        let updated = active.update(db).await?;
        notification_view(&updated)
    }

    /// Marks every unread row of the caller as read.
    ///
    /// # Errors
    ///
    /// Database errors.
    pub async fn mark_all_read(
        &self,
        db: &DatabaseConnection,
        user_id: i64,
    ) -> Result<ReadAllResult, AppError> {
        let unread = NotificationEntity::find()
            .filter(NotificationColumn::UserId.eq(user_id))
            .filter(NotificationColumn::ReadAt.is_null())
            .all(db)
            .await?;
        let now: DateTime<FixedOffset> = Utc::now().into();
        let updated = unread.len() as u64;
        for row in unread {
            let mut active: NotificationActiveModel = row.into();
            active.read_at = Set(Some(now));
            active.update(db).await?;
        }
        Ok(ReadAllResult { updated })
    }

    /// Composes a guild announcement and fans it out to every user.
    ///
    /// The HTTP handler waits for this fan-out. Discord DMs stay `pending` for the worker.
    ///
    /// # Errors
    ///
    /// `400` on empty/overlong title or body.
    pub async fn broadcast(
        &self,
        db: &DatabaseConnection,
        actor_user_id: i64,
        req: &BroadcastRequest,
    ) -> Result<BroadcastResult, AppError> {
        let title = validate_title(&req.title)?;
        let body = validate_body(&req.body)?;

        let txn = db.begin().await?;
        let broadcast = NotificationBroadcastActiveModel {
            title: Set(title.clone()),
            body: Set(body.clone()),
            created_by_user_id: Set(actor_user_id),
            ..Default::default()
        }
        .insert(&txn)
        .await?;

        let user_ids: Vec<i64> = UserEntity::find()
            .all(&txn)
            .await?
            .into_iter()
            .map(|user| user.id)
            .collect();

        insert_many(
            &txn,
            &NotifySpec {
                kind: NotificationKind::Broadcast,
                user_ids: &user_ids,
                title,
                body,
                link_path: None,
                source_type: SOURCE_BROADCAST,
                source_id: broadcast.id,
                created_by_user_id: Some(actor_user_id),
            },
        )
        .await?;

        txn.commit().await?;
        Ok(BroadcastResult {
            id: broadcast.id,
            recipient_count: user_ids.len() as u64,
        })
    }

    /// Inserts one inbox row per recipient. Unique-source conflicts are ignored.
    ///
    /// Domain callers should treat the `Result` as best-effort: log and continue.
    ///
    /// # Errors
    ///
    /// `400` on invalid title/body/link; database errors otherwise.
    pub async fn notify(
        &self,
        db: &DatabaseConnection,
        spec: NotifySpec<'_>,
    ) -> Result<u64, AppError> {
        let title = validate_title(&spec.title)?;
        let body = validate_body(&spec.body)?;
        let link_path = validate_link_path(spec.link_path.as_deref())?;
        let spec = NotifySpec {
            kind: spec.kind,
            user_ids: spec.user_ids,
            title,
            body,
            link_path,
            source_type: spec.source_type,
            source_id: spec.source_id,
            created_by_user_id: spec.created_by_user_id,
        };
        insert_many(db, &spec).await
    }
}

/// Writes inbox rows without failing the surrounding domain mutation.
pub async fn notify_best_effort(db: &DatabaseConnection, spec: NotifySpec<'_>) {
    if spec.user_ids.is_empty() {
        return;
    }
    if let Err(error) = NotificationService::new().notify(db, spec).await {
        tracing::warn!(error = %error, "failed to write inbox notification");
    }
}

async fn insert_many<C: ConnectionTrait>(conn: &C, spec: &NotifySpec<'_>) -> Result<u64, AppError> {
    let dm_status = if spec.kind.queues_discord_dm() {
        DiscordDmStatus::Pending
    } else {
        DiscordDmStatus::Skipped
    };
    let mut inserted = 0_u64;
    for user_id in spec.user_ids {
        let model = NotificationActiveModel {
            user_id: Set(*user_id),
            kind: Set(spec.kind.as_str().to_string()),
            title: Set(spec.title.clone()),
            body: Set(spec.body.clone()),
            link_path: Set(spec.link_path.clone()),
            source_type: Set(spec.source_type.to_string()),
            source_id: Set(spec.source_id),
            created_by_user_id: Set(spec.created_by_user_id),
            discord_dm_status: Set(dm_status.as_str().to_string()),
            discord_dm_attempts: Set(0),
            ..Default::default()
        };
        let result = NotificationEntity::insert(model)
            .on_conflict(
                OnConflict::columns([
                    NotificationColumn::UserId,
                    NotificationColumn::Kind,
                    NotificationColumn::SourceType,
                    NotificationColumn::SourceId,
                ])
                .do_nothing()
                .to_owned(),
            )
            .exec(conn)
            .await;
        match result {
            Ok(_) => inserted += 1,
            Err(err) if is_empty_insert(&err) => {}
            Err(err) => return Err(err.into()),
        }
    }
    Ok(inserted)
}

/// `SeaORM` reports a unique-conflict do-nothing as an empty insert on some backends.
fn is_empty_insert(err: &sea_orm::DbErr) -> bool {
    matches!(err, sea_orm::DbErr::RecordNotInserted)
}

fn validate_title(raw: &str) -> Result<String, AppError> {
    let title = raw.trim();
    if title.is_empty() {
        return Err(AppError::Validation("title is required".into()));
    }
    if title.chars().count() > TITLE_MAX {
        return Err(AppError::Validation(format!(
            "title must be at most {TITLE_MAX} characters"
        )));
    }
    Ok(title.to_string())
}

fn validate_body(raw: &str) -> Result<String, AppError> {
    let body = raw.trim();
    if body.is_empty() {
        return Err(AppError::Validation("body is required".into()));
    }
    if body.chars().count() > BODY_MAX {
        return Err(AppError::Validation(format!(
            "body must be at most {BODY_MAX} characters"
        )));
    }
    Ok(body.to_string())
}

fn validate_link_path(raw: Option<&str>) -> Result<Option<String>, AppError> {
    let Some(value) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    if !value.starts_with('/') {
        return Err(AppError::Validation(
            "link_path must be an in-app path starting with /".into(),
        ));
    }
    if value.chars().count() > LINK_PATH_MAX {
        return Err(AppError::Validation(format!(
            "link_path must be at most {LINK_PATH_MAX} characters"
        )));
    }
    Ok(Some(value.to_string()))
}

fn notification_view(row: &NotificationModel) -> Result<NotificationView, AppError> {
    let kind = row
        .kind
        .parse::<NotificationKind>()
        .map_err(AppError::Internal)?;
    Ok(NotificationView {
        id: row.id,
        kind,
        title: row.title.clone(),
        body: row.body.clone(),
        link_path: row.link_path.clone(),
        source_type: row.source_type.clone(),
        source_id: row.source_id,
        read_at: row.read_at.map(|ts| ts.to_rfc3339()),
        created_at: row.created_at.to_rfc3339(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migration::MigratorTrait;
    use crate::modules::users::entities::ActiveModel as UserActiveModel;
    use sea_orm::Database;

    async fn seed_db() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:").await.expect("connect");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("migrate");
        db
    }

    async fn insert_user(db: &DatabaseConnection, username: &str, email: &str) -> i64 {
        UserActiveModel {
            username: Set(username.to_string()),
            email: Set(email.to_string()),
            role: Set("User".to_string()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("user")
        .id
    }

    fn pagination() -> PaginationParams {
        PaginationParams {
            page: Some(1),
            limit: Some(20),
        }
    }

    #[tokio::test]
    async fn broadcast_fans_out_to_every_user() {
        let db = seed_db().await;
        let officer = insert_user(&db, "officer", "officer@example.com").await;
        let alice = insert_user(&db, "alice", "alice@example.com").await;
        let bob = insert_user(&db, "bob", "bob@example.com").await;
        let service = NotificationService::new();

        let result = service
            .broadcast(
                &db,
                officer,
                &BroadcastRequest {
                    title: "  CTA tonight  ".into(),
                    body: "Be online.".into(),
                },
            )
            .await
            .unwrap();
        assert_eq!(result.recipient_count, 3);

        for user_id in [officer, alice, bob] {
            let page = service
                .list(&db, user_id, &pagination(), &NotificationFilters::default())
                .await
                .unwrap();
            assert_eq!(page.total_items, 1);
            assert_eq!(page.items[0].title, "CTA tonight");
            assert_eq!(page.items[0].kind, NotificationKind::Broadcast);
            assert!(page.items[0].read_at.is_none());
        }
    }

    #[tokio::test]
    async fn mark_read_is_isolated_per_user() {
        let db = seed_db().await;
        let officer = insert_user(&db, "officer", "officer@example.com").await;
        let alice = insert_user(&db, "alice", "alice@example.com").await;
        let bob = insert_user(&db, "bob", "bob@example.com").await;
        let service = NotificationService::new();
        service
            .broadcast(
                &db,
                officer,
                &BroadcastRequest {
                    title: "Ping".into(),
                    body: "Hello".into(),
                },
            )
            .await
            .unwrap();

        let alice_inbox = service
            .list(&db, alice, &pagination(), &NotificationFilters::default())
            .await
            .unwrap();
        let alice_id = alice_inbox.items[0].id;
        service.mark_read(&db, alice, alice_id).await.unwrap();

        assert_eq!(service.unread_count(&db, alice).await.unwrap().count, 0);
        assert_eq!(service.unread_count(&db, bob).await.unwrap().count, 1);

        let err = service.mark_read(&db, bob, alice_id).await.unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[tokio::test]
    async fn mark_read_is_idempotent() {
        let db = seed_db().await;
        let user = insert_user(&db, "solo", "solo@example.com").await;
        let service = NotificationService::new();
        service
            .broadcast(
                &db,
                user,
                &BroadcastRequest {
                    title: "Once".into(),
                    body: "Only".into(),
                },
            )
            .await
            .unwrap();
        let id = service
            .list(&db, user, &pagination(), &NotificationFilters::default())
            .await
            .unwrap()
            .items[0]
            .id;
        let first = service.mark_read(&db, user, id).await.unwrap();
        let second = service.mark_read(&db, user, id).await.unwrap();
        assert_eq!(first.read_at, second.read_at);
        assert!(first.read_at.is_some());
    }

    #[tokio::test]
    async fn mark_all_read_clears_the_badge() {
        let db = seed_db().await;
        let user = insert_user(&db, "solo", "solo@example.com").await;
        let service = NotificationService::new();
        service
            .broadcast(
                &db,
                user,
                &BroadcastRequest {
                    title: "A".into(),
                    body: "one".into(),
                },
            )
            .await
            .unwrap();
        service
            .broadcast(
                &db,
                user,
                &BroadcastRequest {
                    title: "B".into(),
                    body: "two".into(),
                },
            )
            .await
            .unwrap();
        assert_eq!(service.unread_count(&db, user).await.unwrap().count, 2);
        let result = service.mark_all_read(&db, user).await.unwrap();
        assert_eq!(result.updated, 2);
        assert_eq!(service.unread_count(&db, user).await.unwrap().count, 0);
        let again = service.mark_all_read(&db, user).await.unwrap();
        assert_eq!(again.updated, 0);
    }

    #[tokio::test]
    async fn broadcast_rejects_empty_and_overlong_fields() {
        let db = seed_db().await;
        let user = insert_user(&db, "solo", "solo@example.com").await;
        let service = NotificationService::new();

        let empty = service
            .broadcast(
                &db,
                user,
                &BroadcastRequest {
                    title: "   ".into(),
                    body: "ok".into(),
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(empty, AppError::Validation(_)));

        let long_title = "x".repeat(121);
        let too_long = service
            .broadcast(
                &db,
                user,
                &BroadcastRequest {
                    title: long_title,
                    body: "ok".into(),
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(too_long, AppError::Validation(_)));

        let long_body = "y".repeat(2001);
        let body_err = service
            .broadcast(
                &db,
                user,
                &BroadcastRequest {
                    title: "ok".into(),
                    body: long_body,
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(body_err, AppError::Validation(_)));
    }

    #[tokio::test]
    async fn second_broadcast_is_a_new_source() {
        let db = seed_db().await;
        let user = insert_user(&db, "solo", "solo@example.com").await;
        let service = NotificationService::new();
        service
            .broadcast(
                &db,
                user,
                &BroadcastRequest {
                    title: "First".into(),
                    body: "a".into(),
                },
            )
            .await
            .unwrap();
        service
            .broadcast(
                &db,
                user,
                &BroadcastRequest {
                    title: "Second".into(),
                    body: "b".into(),
                },
            )
            .await
            .unwrap();
        let page = service
            .list(&db, user, &pagination(), &NotificationFilters::default())
            .await
            .unwrap();
        assert_eq!(page.total_items, 2);
        assert_eq!(page.items[0].title, "Second");
    }

    #[tokio::test]
    async fn notify_is_idempotent_on_the_same_source() {
        let db = seed_db().await;
        let user = insert_user(&db, "solo", "solo@example.com").await;
        let service = NotificationService::new();
        let spec = |title: &str| NotifySpec {
            kind: NotificationKind::RegearAccepted,
            user_ids: std::slice::from_ref(&user),
            title: title.into(),
            body: "Your regear was approved.".into(),
            link_path: Some("/regears/9".into()),
            source_type: "regear_death",
            source_id: 9,
            created_by_user_id: None,
        };
        assert_eq!(service.notify(&db, spec("ok")).await.unwrap(), 1);
        assert_eq!(service.notify(&db, spec("ok")).await.unwrap(), 0);
        let page = service
            .list(&db, user, &pagination(), &NotificationFilters::default())
            .await
            .unwrap();
        assert_eq!(page.total_items, 1);
        let row = NotificationEntity::find()
            .one(&db)
            .await
            .unwrap()
            .expect("row");
        assert_eq!(row.discord_dm_status, DiscordDmStatus::Pending.as_str());
    }

    #[tokio::test]
    async fn event_kinds_skip_discord_dm() {
        let db = seed_db().await;
        let user = insert_user(&db, "solo", "solo@example.com").await;
        NotificationService::new()
            .notify(
                &db,
                NotifySpec {
                    kind: NotificationKind::EventCreated,
                    user_ids: std::slice::from_ref(&user),
                    title: "New event".into(),
                    body: "CTA".into(),
                    link_path: Some("/events/1".into()),
                    source_type: "event",
                    source_id: 1,
                    created_by_user_id: None,
                },
            )
            .await
            .unwrap();
        let row = NotificationEntity::find()
            .one(&db)
            .await
            .unwrap()
            .expect("row");
        assert_eq!(row.discord_dm_status, DiscordDmStatus::Skipped.as_str());
    }

    #[tokio::test]
    async fn unread_filter_hides_read_rows() {
        let db = seed_db().await;
        let user = insert_user(&db, "solo", "solo@example.com").await;
        let service = NotificationService::new();
        service
            .broadcast(
                &db,
                user,
                &BroadcastRequest {
                    title: "Keep".into(),
                    body: "unread".into(),
                },
            )
            .await
            .unwrap();
        service
            .broadcast(
                &db,
                user,
                &BroadcastRequest {
                    title: "Drop".into(),
                    body: "read".into(),
                },
            )
            .await
            .unwrap();
        let all = service
            .list(&db, user, &pagination(), &NotificationFilters::default())
            .await
            .unwrap();
        service.mark_read(&db, user, all.items[0].id).await.unwrap();
        let unread = service
            .list(
                &db,
                user,
                &pagination(),
                &NotificationFilters { unread: Some(true) },
            )
            .await
            .unwrap();
        assert_eq!(unread.total_items, 1);
        assert_eq!(unread.items[0].title, "Keep");
    }
}
