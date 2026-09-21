//! Discord identity for local `users` rows.
//!
//! Login, alliance fan-out, and event sync all need the same rule: the Discord snowflake is the
//! account, not the email. Email may only *claim* a row that has no `discord_id` yet. Matching a
//! row that already belongs to a different Discord user must not steal that person's splits,
//! bank, or display name.

use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter,
};

use super::entities::{self as user_entities, Entity as UserEntity};
use crate::errors::AppError;

/// Email stored when the Discord address is already owned by a different local user.
fn fallback_email(discord_id: &str) -> String {
    format!("{discord_id}@discord.invalid")
}

fn discord_id_is_blank(value: Option<&str>) -> bool {
    value.is_none_or(|id| id.trim().is_empty())
}

/// Local `users.id` for this Discord snowflake, if one exists in this tenant.
///
/// # Errors
///
/// Returns `AppError::Database` if the lookup fails.
pub async fn user_id_for_discord_id(
    db: &DatabaseConnection,
    discord_id: &str,
) -> Result<Option<i64>, AppError> {
    if discord_id.trim().is_empty() {
        return Ok(None);
    }
    Ok(UserEntity::find()
        .filter(user_entities::Column::DiscordId.eq(discord_id))
        .one(db)
        .await?
        .map(|user| user.id))
}

/// Finds or creates the local `users` row for this Discord account.
///
/// Lookup order:
/// 1. `discord_id` — the stable identity.
/// 2. `email` only when that row has no `discord_id` yet (first login onto a pre-provisioned member).
/// 3. otherwise insert a new row. If the Discord email is already taken by someone else, the new
///    row gets a unique placeholder email so the other account is left untouched.
///
/// # Errors
///
/// Returns `AppError::Database` if a lookup or write fails.
pub async fn upsert_discord_user(
    db: &DatabaseConnection,
    discord_id: &str,
    username: &str,
    email: &str,
    role: &str,
    update_role: bool,
) -> Result<i64, AppError> {
    if let Some(existing) = UserEntity::find()
        .filter(user_entities::Column::DiscordId.eq(discord_id))
        .one(db)
        .await?
    {
        return persist_login(db, existing, username, email, role, update_role).await;
    }

    if let Some(existing) = UserEntity::find()
        .filter(user_entities::Column::Email.eq(email))
        .one(db)
        .await?
    {
        if discord_id_is_blank(existing.discord_id.as_deref()) {
            let mut active: user_entities::ActiveModel = existing.into();
            active.discord_id = Set(Some(discord_id.to_string()));
            active.username = Set(username.to_string());
            if update_role {
                active.role = Set(role.to_string());
            }
            let updated = active.update(db).await?;
            return Ok(updated.id);
        }
        return insert_user(db, discord_id, username, &fallback_email(discord_id), role).await;
    }

    insert_user(db, discord_id, username, email, role).await
}

async fn persist_login(
    db: &DatabaseConnection,
    existing: user_entities::Model,
    username: &str,
    email: &str,
    role: &str,
    update_role: bool,
) -> Result<i64, AppError> {
    let id = existing.id;
    let mut active: user_entities::ActiveModel = existing.into();
    active.username = Set(username.to_string());
    if update_role {
        active.role = Set(role.to_string());
    }
    if let Some(next_email) = email_to_store(db, email).await? {
        active.email = Set(next_email);
    }
    active.update(db).await?;
    Ok(id)
}

async fn email_to_store(db: &DatabaseConnection, email: &str) -> Result<Option<String>, AppError> {
    let taken = UserEntity::find()
        .filter(user_entities::Column::Email.eq(email))
        .one(db)
        .await?
        .is_some();
    if taken {
        // Either this row already has the address, or another user does. Don't steal it.
        return Ok(None);
    }
    Ok(Some(email.to_string()))
}

async fn insert_user(
    db: &DatabaseConnection,
    discord_id: &str,
    username: &str,
    email: &str,
    role: &str,
) -> Result<i64, AppError> {
    let inserted = user_entities::ActiveModel {
        username: Set(username.to_string()),
        email: Set(email.to_string()),
        role: Set(role.to_string()),
        discord_id: Set(Some(discord_id.to_string())),
        ..Default::default()
    }
    .insert(db)
    .await?;
    Ok(inserted.id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migration::MigratorTrait;
    use sea_orm::Database;

    async fn setup_db() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:").await.expect("connect");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("migrate");
        db
    }

    async fn insert_fixture(
        db: &DatabaseConnection,
        username: &str,
        email: &str,
        discord_id: Option<&str>,
    ) -> i64 {
        user_entities::ActiveModel {
            username: Set(username.to_string()),
            email: Set(email.to_string()),
            role: Set("User".to_string()),
            discord_id: Set(discord_id.map(str::to_string)),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert fixture")
        .id
    }

    #[tokio::test]
    async fn discord_id_match_returns_that_row_even_when_emails_collide() {
        let db = setup_db().await;
        let alice = insert_fixture(&db, "alice", "shared@example.com", Some("111")).await;
        let bob = insert_fixture(&db, "bob", "bob@example.com", Some("222")).await;

        let resolved =
            upsert_discord_user(&db, "222", "bob", "shared@example.com", "Officer", true)
                .await
                .expect("upsert");

        assert_eq!(resolved, bob);
        assert_ne!(resolved, alice);

        let alice_row = UserEntity::find_by_id(alice)
            .one(&db)
            .await
            .expect("load alice")
            .expect("alice exists");
        assert_eq!(alice_row.discord_id.as_deref(), Some("111"));
        assert_eq!(alice_row.email, "shared@example.com");

        let bob_row = UserEntity::find_by_id(bob)
            .one(&db)
            .await
            .expect("load bob")
            .expect("bob exists");
        assert_eq!(bob_row.discord_id.as_deref(), Some("222"));
        assert_eq!(bob_row.username, "bob");
        assert_eq!(bob_row.role, "Officer");
        assert_eq!(bob_row.email, "bob@example.com");
    }

    #[tokio::test]
    async fn first_login_does_not_steal_another_users_email() {
        let db = setup_db().await;
        let alice = insert_fixture(&db, "alice", "alice@example.com", Some("111")).await;

        let bob = upsert_discord_user(&db, "222", "bob", "alice@example.com", "User", true)
            .await
            .expect("upsert bob");

        assert_ne!(bob, alice);

        let alice_row = UserEntity::find_by_id(alice)
            .one(&db)
            .await
            .expect("load alice")
            .expect("alice exists");
        assert_eq!(alice_row.discord_id.as_deref(), Some("111"));
        assert_eq!(alice_row.email, "alice@example.com");

        let bob_row = UserEntity::find_by_id(bob)
            .one(&db)
            .await
            .expect("load bob")
            .expect("bob exists");
        assert_eq!(bob_row.discord_id.as_deref(), Some("222"));
        assert_eq!(bob_row.username, "bob");
        assert_eq!(bob_row.email, "222@discord.invalid");
    }

    #[tokio::test]
    async fn unclaimed_email_row_is_linked_on_first_discord_login() {
        let db = setup_db().await;
        let pending = insert_fixture(&db, "pending", "new@example.com", None).await;

        let resolved = upsert_discord_user(&db, "333", "nelly", "new@example.com", "Raider", true)
            .await
            .expect("claim");

        assert_eq!(resolved, pending);
        let row = UserEntity::find_by_id(pending)
            .one(&db)
            .await
            .expect("load")
            .expect("exists");
        assert_eq!(row.discord_id.as_deref(), Some("333"));
        assert_eq!(row.username, "nelly");
        assert_eq!(row.role, "Raider");
    }

    #[tokio::test]
    async fn user_id_lookup_follows_discord_id_not_a_stale_cookie() {
        let db = setup_db().await;
        let alice = insert_fixture(&db, "alice", "alice@example.com", Some("111")).await;
        let bob = insert_fixture(&db, "bob", "bob@example.com", Some("222")).await;

        assert_eq!(
            user_id_for_discord_id(&db, "222")
                .await
                .expect("lookup")
                .expect("found"),
            bob
        );
        assert_ne!(
            user_id_for_discord_id(&db, "222")
                .await
                .expect("lookup")
                .expect("found"),
            alice
        );
        assert_eq!(
            user_id_for_discord_id(&db, "missing")
                .await
                .expect("lookup"),
            None
        );
    }
}
