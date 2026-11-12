//! Blocking a member from the manager.
//!
//! A block is a flag on the tenant's `users` row (`blocked_at`, `blocked_by`, `blocked_reason`).
//! It is enforced where a request becomes a [`UserContext`](crate::auth::UserContext) (web
//! session and bot headers), at login/tenant entry and on `GET /api/auth/me`, so a cached
//! session cannot outlive it. It never touches Discord: the member keeps their server roles and
//! can still chat; they just cannot use the manager.
//!
//! The row is scoped to one tenant, while a login session is shared across tenants, so blocking
//! does not revoke sessions: that would also sign the member out of their other servers.

use backend_core::errors::AppError;
use backend_entities::users::{ActiveModel, Entity as UserEntity, Model};
use sea_orm::{ActiveModelTrait, DatabaseConnection, EntityTrait, Set};

use crate::audit::service::AuditService;

/// Audit action for a block.
pub const AUDIT_BLOCK: &str = "USER_BLOCK";
/// Audit action for an unblock.
pub const AUDIT_UNBLOCK: &str = "USER_UNBLOCK";

/// Longest reason an officer may leave, in characters.
pub const MAX_REASON_CHARS: usize = 500;

/// Message of the `403 account_blocked` problem every blocked request gets.
pub const BLOCKED_MESSAGE: &str = "Your access to the manager has been blocked by an officer.";

/// Trims the reason and drops it when empty.
///
/// # Errors
///
/// Returns `AppError::Validation` when it is longer than [`MAX_REASON_CHARS`].
pub fn normalize_reason(raw: Option<String>) -> Result<Option<String>, AppError> {
    let Some(reason) = raw
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    if reason.chars().count() > MAX_REASON_CHARS {
        return Err(AppError::Validation(format!(
            "the reason must be at most {MAX_REASON_CHARS} characters"
        )));
    }
    Ok(Some(reason))
}

/// Fails with [`AppError::AccountBlocked`] when `user` is blocked.
///
/// # Errors
///
/// Returns `AppError::AccountBlocked` for a blocked row.
pub fn ensure_not_blocked(user: &Model) -> Result<(), AppError> {
    if user.blocked_at.is_some() {
        return Err(AppError::AccountBlocked);
    }
    Ok(())
}

/// Blocks `target_user_id` and records `USER_BLOCK`. Blocking a member who is already blocked
/// changes nothing (the first block's author, time and reason stand).
///
/// The caller has already checked the permission and that the target is not the caller, the
/// tenant owner or a platform admin.
///
/// # Errors
///
/// `NotFound` when the member does not exist, `Database` on a failed write.
pub async fn block_member(
    db: &DatabaseConnection,
    actor_user_id: i64,
    target_user_id: i64,
    reason: Option<String>,
) -> Result<Model, AppError> {
    let target = UserEntity::find_by_id(target_user_id)
        .one(db)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("user {target_user_id} not found")))?;
    if target.blocked_at.is_some() {
        return Ok(target);
    }
    let mut active: ActiveModel = target.into();
    active.blocked_at = Set(Some(chrono::Utc::now().fixed_offset()));
    active.blocked_by = Set(Some(actor_user_id));
    active.blocked_reason = Set(reason.clone());
    let saved = active.update(db).await?;
    let _ = AuditService::log(
        db,
        AUDIT_BLOCK,
        Some("USER"),
        Some(saved.id),
        Some(actor_user_id),
        Some(serde_json::json!({ "reason": reason })),
    )
    .await;
    Ok(saved)
}

/// Lifts the block on `target_user_id` and records `USER_UNBLOCK`. Idempotent: a member who is
/// not blocked is returned untouched, with no audit row.
///
/// # Errors
///
/// `NotFound` when the member does not exist, `Database` on a failed write.
pub async fn unblock_member(
    db: &DatabaseConnection,
    actor_user_id: i64,
    target_user_id: i64,
) -> Result<Model, AppError> {
    let target = UserEntity::find_by_id(target_user_id)
        .one(db)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("user {target_user_id} not found")))?;
    if target.blocked_at.is_none() {
        return Ok(target);
    }
    let previous_reason = target.blocked_reason.clone();
    let mut active: ActiveModel = target.into();
    active.blocked_at = Set(None);
    active.blocked_by = Set(None);
    active.blocked_reason = Set(None);
    let saved = active.update(db).await?;
    let _ = AuditService::log(
        db,
        AUDIT_UNBLOCK,
        Some("USER"),
        Some(saved.id),
        Some(actor_user_id),
        Some(serde_json::json!({ "previous_reason": previous_reason })),
    )
    .await;
    Ok(saved)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn member(db: &DatabaseConnection, name: &str) -> Model {
        ActiveModel {
            username: Set(name.to_owned()),
            email: Set(format!("{name}@example.test")),
            role: Set("User".to_owned()),
            discord_id: Set(Some(format!("discord_{name}"))),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert member")
    }

    #[test]
    fn a_blank_reason_is_dropped_and_a_long_one_refused() {
        assert_eq!(normalize_reason(None).unwrap(), None);
        assert_eq!(normalize_reason(Some("   ".to_owned())).unwrap(), None);
        assert_eq!(
            normalize_reason(Some("  spam  ".to_owned())).unwrap(),
            Some("spam".to_owned())
        );
        let long = "x".repeat(MAX_REASON_CHARS + 1);
        assert!(matches!(
            normalize_reason(Some(long)),
            Err(AppError::Validation(_))
        ));
    }

    #[tokio::test]
    async fn blocking_marks_the_row_and_is_audited() {
        let db = backend_migration::testkit::migrated_sqlite().await;
        let officer = member(&db, "officer").await;
        let target = member(&db, "target").await;

        let blocked = block_member(&db, officer.id, target.id, Some("spam".to_owned()))
            .await
            .unwrap();
        assert!(blocked.blocked_at.is_some());
        assert_eq!(blocked.blocked_by, Some(officer.id));
        assert_eq!(blocked.blocked_reason.as_deref(), Some("spam"));
        assert!(matches!(
            ensure_not_blocked(&blocked),
            Err(AppError::AccountBlocked)
        ));

        let audit = backend_entities::audit::Entity::find()
            .all(&db)
            .await
            .unwrap();
        assert_eq!(audit.len(), 1);
        assert_eq!(audit[0].action, AUDIT_BLOCK);
        assert_eq!(audit[0].entity_id, Some(target.id));
        assert_eq!(audit[0].user_id, Some(officer.id));
    }

    #[tokio::test]
    async fn blocking_twice_keeps_the_first_block() {
        let db = backend_migration::testkit::migrated_sqlite().await;
        let officer = member(&db, "officer").await;
        let target = member(&db, "target").await;

        let first = block_member(&db, officer.id, target.id, Some("first".to_owned()))
            .await
            .unwrap();
        let second = block_member(&db, officer.id, target.id, Some("second".to_owned()))
            .await
            .unwrap();
        assert_eq!(second.blocked_reason.as_deref(), Some("first"));
        assert_eq!(second.blocked_at, first.blocked_at);
        let audit = backend_entities::audit::Entity::find()
            .all(&db)
            .await
            .unwrap();
        assert_eq!(audit.len(), 1);
    }

    #[tokio::test]
    async fn unblocking_clears_the_block_and_is_audited_once() {
        let db = backend_migration::testkit::migrated_sqlite().await;
        let officer = member(&db, "officer").await;
        let target = member(&db, "target").await;
        block_member(&db, officer.id, target.id, Some("spam".to_owned()))
            .await
            .unwrap();

        let lifted = unblock_member(&db, officer.id, target.id).await.unwrap();
        assert!(lifted.blocked_at.is_none());
        assert!(lifted.blocked_by.is_none());
        assert!(lifted.blocked_reason.is_none());
        assert!(ensure_not_blocked(&lifted).is_ok());

        // Unblocking someone who is not blocked is a silent no-op.
        unblock_member(&db, officer.id, target.id).await.unwrap();
        let actions: Vec<String> = backend_entities::audit::Entity::find()
            .all(&db)
            .await
            .unwrap()
            .into_iter()
            .map(|row| row.action)
            .collect();
        assert_eq!(actions, [AUDIT_BLOCK, AUDIT_UNBLOCK]);
    }

    #[tokio::test]
    async fn an_unknown_member_is_not_found() {
        let db = backend_migration::testkit::migrated_sqlite().await;
        assert!(matches!(
            block_member(&db, 1, 999, None).await,
            Err(AppError::NotFound(_))
        ));
        assert!(matches!(
            unblock_member(&db, 1, 999).await,
            Err(AppError::NotFound(_))
        ));
    }
}
