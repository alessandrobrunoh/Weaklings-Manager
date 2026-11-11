//! Discord identity for local `users` rows (MS-S2).
//!
//! The Discord snowflake is the account, not the email. Every path that first meets a Discord
//! user (web login, a bot interaction, a member mentioned by an officer, a cross-tenant copy)
//! creates or updates its row through [`ensure_member`]. Email is contact data: only an address
//! Discord marked verified may claim a legacy row that has no `discord_id` yet, and an email is
//! never copied across tenants. Matching a row that already belongs to a different Discord user
//! must not steal that person's splits, bank, or display name.

use chrono::{DateTime, Utc};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter,
    sea_query::OnConflict,
};

use crate::modules::users::entities::{self as user_entities, Entity as UserEntity};
use crate::errors::AppError;

/// Suffix of the placeholder address derived from a Discord snowflake.
const PLACEHOLDER_EMAIL_SUFFIX: &str = "@discord.invalid";

/// Role given to rows created by `ensure_member`; callers that know the role set it afterwards.
const DEFAULT_ROLE: &str = "User";

/// The single source of the placeholder address: `<discord_id>@discord.invalid`.
#[must_use]
pub fn provisional_discord_email(discord_id: &str) -> String {
    format!("{discord_id}{PLACEHOLDER_EMAIL_SUFFIX}")
}

fn is_placeholder_email(email: &str) -> bool {
    email.ends_with(PLACEHOLDER_EMAIL_SUFFIX)
}

/// Whether Discord shows the member in this tenant's server right now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Presence {
    /// Proven by Discord (login, an interaction, a gateway or reconcile signal).
    Present,
    /// Cross-tenant copy or a reference from another member; no Discord proof here.
    Unknown,
}

/// What caused the row to be written. Stored as `users.provisioned_via` when the row is created.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Via {
    Web,
    Bot,
    Gateway,
    Reconcile,
    Admin,
    AllianceSync,
    EventSync,
}

impl Via {
    /// Value stored in `users.provisioned_via`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Web => "web",
            Self::Bot => "bot",
            Self::Gateway => "gateway",
            Self::Reconcile => "reconcile",
            Self::Admin => "admin",
            Self::AllianceSync => "alliance_sync",
            Self::EventSync => "event_sync",
        }
    }
}

/// Everything [`ensure_member`] needs to know about one Discord member.
#[derive(Clone, Copy, Debug)]
pub struct MemberSeed<'a> {
    /// Discord snowflake. Required.
    pub discord_id: &'a str,
    /// Discord username. `None` keeps the stored name (or `user-<last6>` for new rows).
    pub username: Option<&'a str>,
    /// Only a Discord-verified address. Login passes it; everything else passes `None`.
    pub verified_email: Option<&'a str>,
    /// Discord role snowflakes from a trusted source. `None` leaves the snapshot untouched.
    pub role_ids: Option<&'a [String]>,
    pub presence: Presence,
    pub via: Via,
    /// When the fact was observed. An event older than the stored `member_event_at` is ignored.
    pub event_at: DateTime<Utc>,
}

/// Outcome of [`ensure_member`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ensured {
    pub user_id: i64,
    /// A new row was inserted by this call.
    pub created: bool,
    /// An existing inactive row became active by this call.
    pub reactivated: bool,
}

/// Creates or updates the local `users` row for one Discord member.
///
/// Rules:
/// - Lookup by `discord_id` first. A verified email may claim a row without `discord_id`
///   (first login onto a pre-provisioned member); no other email-based identity rule exists.
/// - Insert uses `ON CONFLICT DO NOTHING` and re-reads by `discord_id`, so concurrent first
///   contacts converge on one row. The placeholder address is derived from the snowflake, so
///   the email unique index cannot collide between two Discord ids.
/// - `Present` sets `active = true` and clears `left_at`/`left_reason`. `Unknown` on a new row
///   inserts an inactive `not_joined` row; on an existing row it never changes `active`.
/// - A verified address replaces the stored one only when that one is a placeholder, and only
///   if no other row holds it.
/// - An event older than `member_event_at` changes nothing.
///
/// # Errors
///
/// Returns `AppError::Validation` for an empty snowflake and `AppError::Database` if a lookup or
/// write fails.
pub async fn ensure_member(
    db: &DatabaseConnection,
    seed: MemberSeed<'_>,
) -> Result<Ensured, AppError> {
    let discord_id = seed.discord_id.trim();
    if discord_id.is_empty() {
        return Err(AppError::Validation("discord_id is required".to_string()));
    }
    let verified = seed
        .verified_email
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let username = seed
        .username
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if let Some(existing) = find_by_discord_id(db, discord_id).await? {
        return apply_to_existing(db, existing, discord_id, &seed, verified, username).await;
    }

    // A legacy row with no Discord id claims by verified email, or by the placeholder that
    // carries this exact snowflake. Neither can belong to someone else.
    let mut claim_emails = vec![provisional_discord_email(discord_id)];
    if let Some(email) = verified {
        claim_emails.insert(0, email.to_string());
    }
    for email in claim_emails {
        if let Some(legacy) = UserEntity::find()
            .filter(user_entities::Column::Email.eq(email.as_str()))
            .filter(user_entities::Column::DiscordId.is_null())
            .one(db)
            .await?
        {
            return apply_to_existing(db, legacy, discord_id, &seed, verified, username).await;
        }
    }

    let email = match verified {
        Some(email) => {
            if email_taken(db, email, None).await? {
                provisional_discord_email(discord_id)
            } else {
                email.to_string()
            }
        }
        None => provisional_discord_email(discord_id),
    };
    let now = seed.event_at.fixed_offset();
    let model = user_entities::ActiveModel {
        username: Set(username.map_or_else(|| default_username(discord_id), str::to_string)),
        email: Set(email),
        role: Set(DEFAULT_ROLE.to_string()),
        discord_id: Set(Some(discord_id.to_string())),
        active: Set(seed.presence == Presence::Present),
        left_reason: Set(match seed.presence {
            Presence::Present => None,
            Presence::Unknown => Some("not_joined".to_string()),
        }),
        discord_role_ids: Set(roles_json(seed.role_ids)),
        roles_checked_at: Set(seed.role_ids.map(|_| now)),
        member_event_at: Set(Some(now)),
        provisioned_via: Set(seed.via.as_str().to_string()),
        ..Default::default()
    };
    let inserted = user_entities::Entity::insert(model)
        .on_conflict(OnConflict::new().do_nothing().to_owned())
        .exec_without_returning(db)
        .await?;

    let row = find_by_discord_id(db, discord_id)
        .await?
        .ok_or_else(|| AppError::Internal(format!("member {discord_id} could not be created")))?;
    if inserted == 0 {
        // A concurrent first contact won the insert: converge on its row.
        return apply_to_existing(db, row, discord_id, &seed, verified, username).await;
    }
    Ok(Ensured {
        user_id: row.id,
        created: true,
        reactivated: false,
    })
}

/// Sets `users.role` for a row. Callers that carry a role (web login, legacy fan-out) use this
/// after [`ensure_member`]; the role is not part of the membership seed.
///
/// # Errors
///
/// Returns `AppError::Database` if the update fails.
pub async fn set_role(db: &DatabaseConnection, user_id: i64, role: &str) -> Result<(), AppError> {
    if let Some(existing) = UserEntity::find_by_id(user_id).one(db).await?
        && existing.role != role
    {
        let mut active: user_entities::ActiveModel = existing.into();
        active.role = Set(role.to_string());
        active.update(db).await?;
    }
    Ok(())
}

/// Deprecated wrapper over [`ensure_member`] for legacy fan-out callers.
///
/// The address argument is ignored: fan-out placeholders are no longer stored, and the row is
/// created from the snowflake (`<discord_id>@discord.invalid`) as a member Discord has not
/// confirmed in this tenant (`active = false`, `not_joined`). New code calls [`ensure_member`].
///
/// # Errors
///
/// Returns `AppError::Database` if a lookup or write fails.
pub async fn upsert_discord_user(
    db: &DatabaseConnection,
    discord_id: &str,
    username: &str,
    _email: &str,
    role: &str,
    update_role: bool,
) -> Result<i64, AppError> {
    let ensured = ensure_member(
        db,
        MemberSeed {
            discord_id,
            username: Some(username),
            verified_email: None,
            role_ids: None,
            presence: Presence::Unknown,
            via: Via::EventSync,
            event_at: Utc::now(),
        },
    )
    .await?;
    if update_role || ensured.created {
        set_role(db, ensured.user_id, role).await?;
    }
    Ok(ensured.user_id)
}

/// The row for this Discord snowflake, if one exists in this tenant.
///
/// # Errors
///
/// Returns `AppError::Database` if the lookup fails.
pub async fn find_by_discord_id(
    db: &DatabaseConnection,
    discord_id: &str,
) -> Result<Option<user_entities::Model>, AppError> {
    let discord_id = discord_id.trim();
    if discord_id.is_empty() {
        return Ok(None);
    }
    Ok(UserEntity::find()
        .filter(user_entities::Column::DiscordId.eq(discord_id))
        .one(db)
        .await?)
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
    Ok(find_by_discord_id(db, discord_id)
        .await?
        .map(|user| user.id))
}

async fn apply_to_existing(
    db: &DatabaseConnection,
    existing: user_entities::Model,
    discord_id: &str,
    seed: &MemberSeed<'_>,
    verified: Option<&str>,
    username: Option<&str>,
) -> Result<Ensured, AppError> {
    let user_id = existing.id;
    if existing
        .member_event_at
        .is_some_and(|at| seed.event_at < at.with_timezone(&Utc))
    {
        return Ok(Ensured {
            user_id,
            created: false,
            reactivated: false,
        });
    }

    let was_active = existing.active;
    let replace_email =
        verified.filter(|email| existing.email != *email && is_placeholder_email(&existing.email));
    let mut next_email = None;
    if let Some(email) = replace_email
        && !email_taken(db, email, Some(user_id)).await?
    {
        next_email = Some(email.to_string());
    }
    let now = seed.event_at.fixed_offset();

    let mut active: user_entities::ActiveModel = existing.clone().into();
    active.discord_id = Set(Some(discord_id.to_string()));
    if let Some(name) = username
        && name != existing.username
    {
        active.username = Set(name.to_string());
    }
    if let Some(email) = next_email {
        active.email = Set(email);
    }
    if seed.presence == Presence::Present {
        active.active = Set(true);
        active.left_at = Set(None);
        active.left_reason = Set(None);
    }
    if let Some(role_ids) = seed.role_ids {
        active.discord_role_ids = Set(roles_json(Some(role_ids)));
        active.roles_checked_at = Set(Some(now));
    }
    active.member_event_at = Set(Some(now));
    let updated = active.update(db).await?;

    Ok(Ensured {
        user_id,
        created: false,
        reactivated: !was_active && updated.active,
    })
}

async fn email_taken(
    db: &DatabaseConnection,
    email: &str,
    except_user_id: Option<i64>,
) -> Result<bool, AppError> {
    let mut query = UserEntity::find().filter(user_entities::Column::Email.eq(email));
    if let Some(id) = except_user_id {
        query = query.filter(user_entities::Column::Id.ne(id));
    }
    Ok(query.one(db).await?.is_some())
}

/// Username for a row created without one: `user-` plus the last six digits of the snowflake.
fn default_username(discord_id: &str) -> String {
    let tail: String = discord_id
        .chars()
        .rev()
        .take(6)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("user-{tail}")
}

/// JSON array of role snowflakes, sorted and unique. Empty input gives `[]`.
fn roles_json(role_ids: Option<&[String]>) -> String {
    let mut ids: Vec<&str> = role_ids
        .unwrap_or_default()
        .iter()
        .map(|id| id.trim())
        .filter(|id| !id.is_empty())
        .collect();
    ids.sort_unstable();
    ids.dedup();
    serde_json::to_string(&ids).unwrap_or_else(|_| "[]".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn setup_db() -> DatabaseConnection {
        crate::testkit::tenant_schema::migrated_sqlite().await
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

    fn seed<'a>(
        discord_id: &'a str,
        username: &'a str,
        verified: Option<&'a str>,
    ) -> MemberSeed<'a> {
        MemberSeed {
            discord_id,
            username: Some(username),
            verified_email: verified,
            role_ids: None,
            presence: Presence::Present,
            via: Via::Web,
            event_at: Utc::now(),
        }
    }

    async fn row(db: &DatabaseConnection, id: i64) -> user_entities::Model {
        UserEntity::find_by_id(id)
            .one(db)
            .await
            .expect("load")
            .expect("exists")
    }

    #[tokio::test]
    async fn discord_id_match_returns_that_row_even_when_emails_collide() {
        let db = setup_db().await;
        let alice = insert_fixture(&db, "alice", "shared@example.com", Some("111")).await;
        let bob = insert_fixture(&db, "bob", "bob@example.com", Some("222")).await;

        let resolved = ensure_member(&db, seed("222", "bob", Some("shared@example.com")))
            .await
            .expect("ensure")
            .user_id;

        assert_eq!(resolved, bob);
        assert_ne!(resolved, alice);
        assert_eq!(row(&db, alice).await.email, "shared@example.com");
        let bob_row = row(&db, bob).await;
        assert_eq!(bob_row.discord_id.as_deref(), Some("222"));
        assert_eq!(bob_row.username, "bob");
        assert_eq!(bob_row.email, "bob@example.com");
    }

    #[tokio::test]
    async fn first_login_does_not_steal_another_users_email() {
        let db = setup_db().await;
        let alice = insert_fixture(&db, "alice", "alice@example.com", Some("111")).await;

        let bob = ensure_member(&db, seed("222", "bob", Some("alice@example.com")))
            .await
            .expect("ensure bob")
            .user_id;

        assert_ne!(bob, alice);
        assert_eq!(row(&db, alice).await.discord_id.as_deref(), Some("111"));
        let bob_row = row(&db, bob).await;
        assert_eq!(bob_row.discord_id.as_deref(), Some("222"));
        assert_eq!(bob_row.email, "222@discord.invalid");
    }

    #[tokio::test]
    async fn unclaimed_email_row_is_linked_on_first_discord_login() {
        let db = setup_db().await;
        let pending = insert_fixture(&db, "pending", "new@example.com", None).await;

        let resolved = ensure_member(&db, seed("333", "nelly", Some("new@example.com")))
            .await
            .expect("claim")
            .user_id;

        assert_eq!(resolved, pending);
        let claimed = row(&db, pending).await;
        assert_eq!(claimed.discord_id.as_deref(), Some("333"));
        assert_eq!(claimed.username, "nelly");
        assert_eq!(claimed.email, "new@example.com");
    }

    #[tokio::test]
    async fn two_discord_ids_with_the_same_email_make_two_rows_and_the_first_keeps_its_id() {
        let db = setup_db().await;

        let first = ensure_member(&db, seed("111", "first", Some("same@example.com")))
            .await
            .expect("first login")
            .user_id;
        let second = ensure_member(&db, seed("222", "second", Some("same@example.com")))
            .await
            .expect("second login")
            .user_id;

        assert_ne!(first, second);
        assert_eq!(row(&db, first).await.email, "same@example.com");
        assert_eq!(row(&db, second).await.email, "222@discord.invalid");
        assert_eq!(UserEntity::find().all(&db).await.expect("list").len(), 2);

        let again = ensure_member(&db, seed("111", "first", Some("same@example.com")))
            .await
            .expect("relogin")
            .user_id;
        assert_eq!(again, first);
    }

    #[tokio::test]
    async fn an_unverified_login_never_claims_or_stores_an_email() {
        let db = setup_db().await;
        let pending = insert_fixture(&db, "pending", "victim@example.com", None).await;
        let member = insert_fixture(&db, "member", "member@example.com", Some("111")).await;

        let attacker = ensure_member(&db, seed("999", "attacker", None))
            .await
            .expect("login without verified email")
            .user_id;
        assert_ne!(attacker, pending);
        assert_eq!(row(&db, pending).await.discord_id, None);
        assert_eq!(row(&db, attacker).await.email, "999@discord.invalid");

        let again = ensure_member(&db, seed("111", "member", None))
            .await
            .expect("relogin")
            .user_id;
        assert_eq!(again, member);
        let member_row = row(&db, member).await;
        assert_eq!(member_row.email, "member@example.com");
        assert_eq!(member_row.discord_id.as_deref(), Some("111"));
    }

    #[tokio::test]
    async fn verified_email_replaces_only_a_placeholder_and_only_when_free() {
        let db = setup_db().await;
        let created = insert_fixture(&db, "nelly", "111@discord.invalid", Some("111")).await;

        let id = ensure_member(&db, seed("111", "Nelly", Some("nelly@example.com")))
            .await
            .expect("login")
            .user_id;
        assert_eq!(id, created);
        let replaced = row(&db, id).await;
        assert_eq!(replaced.email, "nelly@example.com");
        assert_eq!(replaced.username, "Nelly");

        // A real address already held by another account is not taken over.
        insert_fixture(&db, "other", "taken@example.com", Some("999")).await;
        ensure_member(&db, seed("111", "Nelly", Some("taken@example.com")))
            .await
            .expect("login");
        assert_eq!(row(&db, id).await.email, "nelly@example.com");

        // A real, different address is not replaced either: only placeholders are.
        ensure_member(&db, seed("111", "Nelly", Some("other-real@example.com")))
            .await
            .expect("login");
        assert_eq!(row(&db, id).await.email, "nelly@example.com");
    }

    #[tokio::test]
    async fn user_id_lookup_follows_discord_id_not_a_stale_cookie() {
        let db = setup_db().await;
        let alice = insert_fixture(&db, "alice", "alice@example.com", Some("111")).await;
        let bob = insert_fixture(&db, "bob", "bob@example.com", Some("222")).await;

        let found = user_id_for_discord_id(&db, "222")
            .await
            .expect("lookup")
            .expect("found");
        assert_eq!(found, bob);
        assert_ne!(found, alice);
        assert!(
            user_id_for_discord_id(&db, "  ")
                .await
                .expect("lookup")
                .is_none()
        );
    }

    #[tokio::test]
    async fn unknown_presence_creates_an_inactive_row_and_never_reactivates_it() {
        let db = setup_db().await;
        let unknown = MemberSeed {
            presence: Presence::Unknown,
            via: Via::AllianceSync,
            ..seed("444", "copy", None)
        };
        let created = ensure_member(&db, unknown).await.expect("unknown create");
        assert!(created.created);
        let stored = row(&db, created.user_id).await;
        assert!(!stored.active);
        assert_eq!(stored.left_reason.as_deref(), Some("not_joined"));
        assert_eq!(stored.provisioned_via, "alliance_sync");

        let again = ensure_member(&db, unknown).await.expect("unknown again");
        assert!(!again.created && !again.reactivated);
        assert!(!row(&db, created.user_id).await.active);

        let present = ensure_member(&db, seed("444", "copy", None))
            .await
            .expect("present");
        assert_eq!(present.user_id, created.user_id);
        assert!(present.reactivated);
        let active = row(&db, created.user_id).await;
        assert!(active.active);
        assert_eq!(active.left_reason, None);
        assert_eq!(active.left_at, None);
    }

    #[tokio::test]
    async fn concurrent_first_contacts_converge_on_one_row() {
        let db = setup_db().await;
        let (a, b) = tokio::join!(
            ensure_member(&db, seed("555", "racer", None)),
            ensure_member(&db, seed("555", "racer", None)),
        );
        let a = a.expect("first racer").user_id;
        let b = b.expect("second racer").user_id;
        assert_eq!(a, b);
        assert_eq!(UserEntity::find().all(&db).await.expect("list").len(), 1);
    }

    #[tokio::test]
    async fn a_stale_event_changes_nothing() {
        let db = setup_db().await;
        let now = Utc::now();
        let fresh = MemberSeed {
            username: Some("fresh"),
            event_at: now,
            ..seed("666", "fresh", None)
        };
        let id = ensure_member(&db, fresh).await.expect("fresh").user_id;

        let stale = MemberSeed {
            username: Some("stale"),
            presence: Presence::Unknown,
            event_at: now - chrono::Duration::minutes(5),
            ..seed("666", "stale", None)
        };
        assert_eq!(ensure_member(&db, stale).await.expect("stale").user_id, id);
        assert_eq!(row(&db, id).await.username, "fresh");
    }

    #[tokio::test]
    async fn role_snapshot_is_sorted_unique_and_unknown_roles_leave_it_alone() {
        let db = setup_db().await;
        let roles = vec!["30".to_string(), "10".to_string(), "30".to_string()];
        let with_roles = MemberSeed {
            role_ids: Some(&roles),
            ..seed("777", "roled", None)
        };
        let id = ensure_member(&db, with_roles).await.expect("roles").user_id;
        assert_eq!(row(&db, id).await.discord_role_ids, r#"["10","30"]"#);

        ensure_member(&db, seed("777", "roled", None))
            .await
            .expect("no roles");
        assert_eq!(row(&db, id).await.discord_role_ids, r#"["10","30"]"#);
    }

    #[tokio::test]
    async fn placeholder_is_derived_from_the_snowflake_and_names_default_from_it() {
        assert_eq!(provisional_discord_email("123"), "123@discord.invalid");
        let db = setup_db().await;
        let anonymous = MemberSeed {
            username: None,
            ..seed("1234567890", "x", None)
        };
        let id = ensure_member(&db, anonymous).await.expect("anon").user_id;
        let stored = row(&db, id).await;
        assert_eq!(stored.username, "user-567890");
        assert_eq!(stored.email, "1234567890@discord.invalid");
    }

    #[tokio::test]
    async fn a_placeholder_row_without_discord_id_is_claimed_by_its_snowflake() {
        let db = setup_db().await;
        let legacy = insert_fixture(&db, "legacy", "888@discord.invalid", None).await;
        let id = ensure_member(&db, seed("888", "legacy", None))
            .await
            .expect("claim")
            .user_id;
        assert_eq!(id, legacy);
        assert_eq!(row(&db, id).await.discord_id.as_deref(), Some("888"));
    }

    #[tokio::test]
    async fn deprecated_wrapper_ignores_the_fan_out_address_and_creates_an_unknown_member() {
        let db = setup_db().await;
        let id = upsert_discord_user(&db, "7", "seven", "discord-7@alliance.local", "User", true)
            .await
            .expect("wrapper");
        let stored = row(&db, id).await;
        assert_eq!(stored.email, "7@discord.invalid");
        assert!(!stored.active);
        assert_eq!(stored.role, "User");

        let again = upsert_discord_user(&db, "7", "seven", "x@example.com", "Officer", true)
            .await
            .expect("wrapper again");
        assert_eq!(again, id);
        assert_eq!(row(&db, id).await.role, "Officer");
    }
}
