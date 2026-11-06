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
/// Thin wrapper over [`upsert_discord_login`] for callers that already hold a trusted address
/// (fan-out and event-sync pass internal placeholders). Deprecated for new code: login passes
/// the verified-or-nothing address straight to [`upsert_discord_login`].
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
    upsert_discord_login(db, discord_id, username, Some(email), role, update_role).await
}

/// Finds or creates the local `users` row for this Discord account.
///
/// `verified_email` is only ever an address Discord marked verified, or `None`. An unverified
/// address can be typed by anyone, so it must neither claim a row nor be stored.
///
/// Lookup order:
/// 1. `discord_id` — the stable identity.
/// 2. `verified_email` only when that row has no `discord_id` yet (first login onto a
///    pre-provisioned member).
/// 3. otherwise insert a new row. If the address is missing or already taken by someone else,
///    the new row gets the unique `<discord_id>@discord.invalid` placeholder so the other
///    account is left untouched.
///
/// # Errors
///
/// Returns `AppError::Database` if a lookup or write fails.
pub async fn upsert_discord_login(
    db: &DatabaseConnection,
    discord_id: &str,
    username: &str,
    verified_email: Option<&str>,
    role: &str,
    update_role: bool,
) -> Result<i64, AppError> {
    let email = verified_email
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if let Some(existing) = UserEntity::find()
        .filter(user_entities::Column::DiscordId.eq(discord_id))
        .one(db)
        .await?
    {
        return persist_login(db, existing, username, email, role, update_role).await;
    }

    let Some(email) = email else {
        return insert_user(db, discord_id, username, &fallback_email(discord_id), role).await;
    };

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
    email: Option<&str>,
    role: &str,
    update_role: bool,
) -> Result<i64, AppError> {
    let id = existing.id;
    let mut active: user_entities::ActiveModel = existing.into();
    active.username = Set(username.to_string());
    if update_role {
        active.role = Set(role.to_string());
    }
    if let Some(email) = email
        && let Some(next_email) = email_to_store(db, email).await?
    {
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
    async fn two_discord_ids_with_the_same_email_make_two_rows_and_the_first_keeps_its_id() {
        let db = setup_db().await;

        let first =
            upsert_discord_login(&db, "111", "first", Some("same@example.com"), "User", true)
                .await
                .expect("first login");
        let second =
            upsert_discord_login(&db, "222", "second", Some("same@example.com"), "User", true)
                .await
                .expect("second login");

        assert_ne!(first, second);
        let first_row = UserEntity::find_by_id(first)
            .one(&db)
            .await
            .expect("load")
            .expect("exists");
        assert_eq!(first_row.discord_id.as_deref(), Some("111"));
        assert_eq!(first_row.email, "same@example.com");
        let second_row = UserEntity::find_by_id(second)
            .one(&db)
            .await
            .expect("load")
            .expect("exists");
        assert_eq!(second_row.discord_id.as_deref(), Some("222"));
        assert_eq!(second_row.email, "222@discord.invalid");
        assert_eq!(UserEntity::find().all(&db).await.expect("list").len(), 2);

        // The first account logging in again is still the first row.
        let again =
            upsert_discord_login(&db, "111", "first", Some("same@example.com"), "User", true)
                .await
                .expect("relogin");
        assert_eq!(again, first);
    }

    #[tokio::test]
    async fn an_unverified_login_never_claims_or_stores_an_email() {
        let db = setup_db().await;
        // An admin-provisioned row waiting for its owner, and an identified member.
        let pending = insert_fixture(&db, "pending", "victim@example.com", None).await;
        let member = insert_fixture(&db, "member", "member@example.com", Some("111")).await;

        // Login passes `None` for an unverified address: it cannot claim the pending row.
        let attacker = upsert_discord_login(&db, "999", "attacker", None, "User", true)
            .await
            .expect("login without verified email");
        assert_ne!(attacker, pending);
        let pending_row = UserEntity::find_by_id(pending)
            .one(&db)
            .await
            .expect("load")
            .expect("exists");
        assert_eq!(pending_row.discord_id, None);
        let attacker_row = UserEntity::find_by_id(attacker)
            .one(&db)
            .await
            .expect("load")
            .expect("exists");
        assert_eq!(attacker_row.email, "999@discord.invalid");

        // An existing identified member logging in without a verified email keeps their email.
        let again = upsert_discord_login(&db, "111", "member", None, "User", true)
            .await
            .expect("relogin");
        assert_eq!(again, member);
        let member_row = UserEntity::find_by_id(member)
            .one(&db)
            .await
            .expect("load")
            .expect("exists");
        assert_eq!(member_row.email, "member@example.com");
        assert_eq!(member_row.discord_id.as_deref(), Some("111"));
    }

    #[tokio::test]
    async fn login_replaces_the_placeholder_with_a_verified_email_unless_taken() {
        let db = setup_db().await;
        let created = insert_fixture(&db, "nelly", "111@discord.invalid", Some("111")).await;

        let id = upsert_discord_login(&db, "111", "Nelly", Some("nelly@example.com"), "User", true)
            .await
            .expect("login");
        assert_eq!(id, created);
        let row = UserEntity::find_by_id(id)
            .one(&db)
            .await
            .expect("load")
            .expect("exists");
        assert_eq!(row.email, "nelly@example.com");
        assert_eq!(row.username, "Nelly");

        // A real address already held by another account is not taken over.
        insert_fixture(&db, "other", "taken@example.com", Some("999")).await;
        upsert_discord_login(&db, "111", "Nelly", Some("taken@example.com"), "User", true)
            .await
            .expect("login");
        let row = UserEntity::find_by_id(id)
            .one(&db)
            .await
            .expect("load")
            .expect("exists");
        assert_eq!(row.email, "nelly@example.com");
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
