//! Server-side browser sessions.
//!
//! The `session_user` cookie is an encrypted [`SessionCookie`]: the cached Discord profile plus a
//! random session id (`sid`). The cookie alone is no longer a credential: every authenticated
//! request must present a `sid` that still has a live row in the control database's
//! `auth_sessions` table (not revoked, not expired, owned by the same Discord user). Logout and
//! "log out everywhere" revoke rows, so a stolen cookie stops working immediately instead of
//! living out its 7-day max-age.
//!
//! There is deliberately no fallback for cookies without a `sid`: they fail to deserialize and
//! read as "no session", so users log in once more after the deploy.
//!
//! # Cost and staleness
//!
//! A validation is one primary-key lookup. Successful lookups are cached in memory per instance
//! for [`CACHE_TTL`]. Revoking on an instance evicts its cache entry immediately; **other
//! instances** keep honouring a revoked session for at most [`CACHE_TTL`] (30 s). Failed lookups
//! are never cached, so a revoked/unknown `sid` always hits the database.

use axum::http::HeaderMap;
use axum_extra::extract::cookie::{Key, PrivateCookieJar};
use backend_core::errors::AppError;
use base64::Engine;
use chrono::{DateTime, Duration, Utc};
use dashmap::DashMap;
use rand::RngCore;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, Condition, DatabaseConnection, EntityTrait, QueryFilter, Set,
    sea_query::Expr,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Instant;

use super::service::DiscordUserProfile;

/// Name of the encrypted session cookie.
pub const SESSION_COOKIE: &str = "session_user";

/// Lifetime of a session, renewed (at most once a day) by `GET /api/auth/me`.
pub const SESSION_TTL: Duration = Duration::days(7);

/// A session is only re-extended once this much of its lifetime has elapsed since it was last
/// extended; keeps `/me` from writing on every call.
const RENEW_AFTER: Duration = Duration::days(1);

/// How long a successful validation is trusted without asking the database again.
pub const CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(30);

/// Cache size at which expired entries are swept on insert.
const CACHE_SWEEP_AT: usize = 4096;

/// Revoked/expired rows are kept this long (debugging aid) before the opportunistic purge.
const PURGE_GRACE: Duration = Duration::days(1);

/// SeaORM entity for the control-plane `auth_sessions` table.
pub mod entity {
    use sea_orm::entity::prelude::*;

    /// One browser login.
    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "auth_sessions")]
    pub struct Model {
        /// Random session id carried in the encrypted cookie.
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        /// Discord snowflake of the session's owner.
        pub discord_id: String,
        /// When the session was created.
        pub created_at: DateTimeUtc,
        /// Instant after which the session is no longer accepted.
        pub expires_at: DateTimeUtc,
        /// Set when the session was revoked (logout, logout-all).
        pub revoked_at: Option<DateTimeUtc>,
    }

    /// No relations.
    #[derive(Copy, Clone, Debug, DeriveRelation, EnumIter)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

use entity::{ActiveModel, Column, Entity};

/// Contents of the `session_user` cookie: the session id plus the cached profile.
///
/// `sid` is required (no `#[serde(default)]`), so a cookie minted before sessions were
/// server-side fails to parse and is treated as absent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionCookie {
    /// Server-side session id.
    pub sid: String,
    /// Cached Discord profile and tenant scoping.
    #[serde(flatten)]
    pub profile: DiscordUserProfile,
}

impl SessionCookie {
    /// Decrypts and parses the session cookie. `None` for an absent, forged, tampered or
    /// `sid`-less cookie. Does **not** check the server-side record; use
    /// [`SessionStore::authenticate`] for that.
    #[must_use]
    pub fn from_headers(headers: &HeaderMap, key: &Key) -> Option<Self> {
        let jar = PrivateCookieJar::from_headers(headers, key.clone());
        let cookie = jar.get(SESSION_COOKIE)?;
        let parsed: Self = serde_json::from_str(cookie.value()).ok()?;
        (!parsed.sid.is_empty()).then_some(parsed)
    }
}

/// A request's validated session.
#[derive(Debug, Clone)]
pub struct ActiveSession {
    /// Session id (stable for the life of the login, across tenant switches).
    pub sid: String,
    /// Profile cached in the cookie.
    pub profile: DiscordUserProfile,
    /// Server-side expiry.
    pub expires_at: DateTime<Utc>,
}

#[derive(Clone)]
struct CacheEntry {
    discord_id: String,
    expires_at: DateTime<Utc>,
    checked: Instant,
}

/// Control-database backed session registry with a short-TTL validation cache.
#[derive(Clone)]
pub struct SessionStore {
    db: DatabaseConnection,
    cache: Arc<DashMap<String, CacheEntry>>,
}

impl SessionStore {
    /// Builds a store over the control-plane connection.
    #[must_use]
    pub fn new(control: DatabaseConnection) -> Self {
        Self {
            db: control,
            cache: Arc::new(DashMap::new()),
        }
    }

    /// Creates a session for `discord_id` and returns its id.
    ///
    /// Also purges long-expired and long-revoked rows, so the table needs no cron.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::Database`] when the insert fails.
    pub async fn create(&self, discord_id: &str) -> Result<String, AppError> {
        let now = Utc::now();
        // Best effort: a failed purge must not block a login.
        if let Err(error) = Entity::delete_many()
            .filter(
                Condition::any()
                    .add(Column::ExpiresAt.lt(now - PURGE_GRACE))
                    .add(Column::RevokedAt.lt(now - PURGE_GRACE)),
            )
            .exec(&self.db)
            .await
        {
            tracing::warn!(%error, "could not purge old auth sessions");
        }
        let mut raw = [0_u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut raw);
        let sid = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw);
        ActiveModel {
            id: Set(sid.clone()),
            discord_id: Set(discord_id.to_owned()),
            created_at: Set(now),
            expires_at: Set(now + SESSION_TTL),
            revoked_at: Set(None),
        }
        .insert(&self.db)
        .await?;
        Ok(sid)
    }

    /// Reads the session cookie and checks its server-side record.
    ///
    /// `Ok(None)` means "no valid session" (no cookie, undecryptable, no `sid`, unknown,
    /// revoked, expired, or owned by a different Discord id than the cookie claims).
    ///
    /// # Errors
    ///
    /// Returns [`AppError::Database`] when the lookup itself fails; that is not an
    /// authentication answer and must not be reported as a logout.
    pub async fn authenticate(
        &self,
        headers: &HeaderMap,
        key: &Key,
    ) -> Result<Option<ActiveSession>, AppError> {
        let Some(cookie) = SessionCookie::from_headers(headers, key) else {
            return Ok(None);
        };
        let Some(expires_at) = self.live_expiry(&cookie.sid, &cookie.profile.id).await? else {
            return Ok(None);
        };
        Ok(Some(ActiveSession {
            sid: cookie.sid,
            profile: cookie.profile,
            expires_at,
        }))
    }

    /// Expiry of `sid` when it is live and belongs to `discord_id`.
    async fn live_expiry(
        &self,
        sid: &str,
        discord_id: &str,
    ) -> Result<Option<DateTime<Utc>>, AppError> {
        let now = Utc::now();
        if let Some(hit) = self.cache.get(sid) {
            if hit.checked.elapsed() < CACHE_TTL && hit.expires_at > now {
                return Ok((hit.discord_id == discord_id).then_some(hit.expires_at));
            }
            drop(hit);
            self.cache.remove(sid);
        }
        let Some(row) = Entity::find_by_id(sid.to_owned()).one(&self.db).await? else {
            return Ok(None);
        };
        if row.revoked_at.is_some() || row.expires_at <= now || row.discord_id != discord_id {
            return Ok(None);
        }
        if self.cache.len() >= CACHE_SWEEP_AT {
            self.cache
                .retain(|_, entry| entry.checked.elapsed() < CACHE_TTL && entry.expires_at > now);
        }
        self.cache.insert(
            row.id,
            CacheEntry {
                discord_id: row.discord_id,
                expires_at: row.expires_at,
                checked: Instant::now(),
            },
        );
        Ok(Some(row.expires_at))
    }

    /// Slides the expiry forward when the session has spent more than a day of its lifetime.
    /// Returns whether it was extended.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::Database`] when the update fails.
    pub async fn renew(&self, session: &ActiveSession) -> Result<bool, AppError> {
        let now = Utc::now();
        if session.expires_at > now + SESSION_TTL - RENEW_AFTER {
            return Ok(false);
        }
        let result = Entity::update_many()
            .col_expr(Column::ExpiresAt, Expr::value(now + SESSION_TTL))
            .filter(Column::Id.eq(session.sid.as_str()))
            .filter(Column::RevokedAt.is_null())
            .filter(Column::ExpiresAt.gt(now))
            .exec(&self.db)
            .await?;
        self.cache.remove(&session.sid);
        Ok(result.rows_affected > 0)
    }

    /// Revokes one session. Idempotent; an unknown `sid` is a no-op.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::Database`] when the update fails (the session may still be live).
    pub async fn revoke(&self, sid: &str) -> Result<(), AppError> {
        Entity::update_many()
            .col_expr(Column::RevokedAt, Expr::value(Utc::now()))
            .filter(Column::Id.eq(sid))
            .filter(Column::RevokedAt.is_null())
            .exec(&self.db)
            .await?;
        self.cache.remove(sid);
        Ok(())
    }

    /// Revokes every live session of `discord_id`, on every device. Returns how many.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::Database`] when the update fails (sessions may still be live).
    pub async fn revoke_all(&self, discord_id: &str) -> Result<u64, AppError> {
        let result = Entity::update_many()
            .col_expr(Column::RevokedAt, Expr::value(Utc::now()))
            .filter(Column::DiscordId.eq(discord_id))
            .filter(Column::RevokedAt.is_null())
            .exec(&self.db)
            .await?;
        self.cache.retain(|_, entry| entry.discord_id != discord_id);
        Ok(result.rows_affected)
    }
}

/// Resolves the request's session, or `AppError::Unauthorized`.
///
/// # Errors
///
/// * [`AppError::Unauthorized`] when there is no valid session.
/// * [`AppError::Internal`] when the session key or store is not installed.
/// * [`AppError::Database`] when the session lookup fails.
pub async fn require_session(
    headers: &HeaderMap,
    key: &Key,
    store: &SessionStore,
) -> Result<ActiveSession, AppError> {
    store
        .authenticate(headers, key)
        .await?
        .ok_or_else(|| AppError::Unauthorized("No active session".to_owned()))
}

/// Creates the `auth_sessions` table on a non-Postgres test database.
#[cfg(test)]
pub async fn create_test_table(db: &DatabaseConnection) {
    use sea_orm::{ConnectionTrait, Schema};
    let backend = db.get_database_backend();
    let stmt = backend.build(&Schema::new(backend).create_table_from_entity(Entity));
    db.execute(stmt).await.expect("create auth_sessions");
}

/// A [`SessionStore`] over a fresh in-memory database, for tests.
#[cfg(test)]
pub async fn test_store() -> SessionStore {
    let db = sea_orm::Database::connect("sqlite::memory:")
        .await
        .expect("sqlite");
    create_test_table(&db).await;
    SessionStore::new(db)
}

/// Encrypts a [`SessionCookie`] as the browser would send it back: `session_user=<value>`.
#[cfg(test)]
pub fn test_cookie_header(key: &Key, sid: &str, profile: &serde_json::Value) -> String {
    use axum::response::IntoResponse;
    let mut value = profile.clone();
    value["sid"] = serde_json::Value::String(sid.to_owned());
    let response = PrivateCookieJar::new(key.clone())
        .add((SESSION_COOKIE, value.to_string()))
        .into_response();
    response
        .headers()
        .get(axum::http::header::SET_COOKIE)
        .expect("set-cookie")
        .to_str()
        .expect("ascii")
        .split(';')
        .next()
        .expect("pair")
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(id: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id, "username": "u", "email": null, "avatar": null,
            "roles": ["User"], "highest_role": "User", "user_id": 1,
        })
    }

    fn headers(cookie: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(axum::http::header::COOKIE, cookie.parse().expect("cookie"));
        headers
    }

    async fn set_expiry(store: &SessionStore, sid: &str, expires_at: DateTime<Utc>) {
        Entity::update_many()
            .col_expr(Column::ExpiresAt, Expr::value(expires_at))
            .filter(Column::Id.eq(sid))
            .exec(&store.db)
            .await
            .expect("update expiry");
        store.cache.clear();
    }

    #[tokio::test]
    async fn live_session_authenticates() {
        let (store, key) = (test_store().await, Key::generate());
        let sid = store.create("111").await.expect("create");
        let h = headers(&test_cookie_header(&key, &sid, &profile("111")));
        let session = store
            .authenticate(&h, &key)
            .await
            .expect("db")
            .expect("live");
        assert_eq!(session.sid, sid);
        assert_eq!(session.profile.id, "111");
    }

    #[tokio::test]
    async fn revoked_sid_is_rejected_even_after_it_was_cached() {
        let (store, key) = (test_store().await, Key::generate());
        let sid = store.create("111").await.expect("create");
        let h = headers(&test_cookie_header(&key, &sid, &profile("111")));
        assert!(store.authenticate(&h, &key).await.expect("db").is_some());
        store.revoke(&sid).await.expect("revoke");
        assert!(store.authenticate(&h, &key).await.expect("db").is_none());
    }

    #[tokio::test]
    async fn revocation_from_another_instance_is_seen_once_the_cache_entry_ages_out() {
        let (store, key) = (test_store().await, Key::generate());
        let sid = store.create("111").await.expect("create");
        let h = headers(&test_cookie_header(&key, &sid, &profile("111")));
        assert!(store.authenticate(&h, &key).await.expect("db").is_some());
        // Another instance revokes straight in the database; this one still has the cache entry.
        Entity::update_many()
            .col_expr(Column::RevokedAt, Expr::value(Utc::now()))
            .exec(&store.db)
            .await
            .expect("revoke elsewhere");
        assert!(
            store.authenticate(&h, &key).await.expect("db").is_some(),
            "within the TTL the cached verdict stands (documented staleness bound)"
        );
        store.cache.get_mut(&sid).expect("cached").checked = Instant::now() - CACHE_TTL;
        assert!(store.authenticate(&h, &key).await.expect("db").is_none());
    }

    #[tokio::test]
    async fn expired_sid_is_rejected() {
        let (store, key) = (test_store().await, Key::generate());
        let sid = store.create("111").await.expect("create");
        set_expiry(&store, &sid, Utc::now() - Duration::seconds(1)).await;
        let h = headers(&test_cookie_header(&key, &sid, &profile("111")));
        assert!(store.authenticate(&h, &key).await.expect("db").is_none());
    }

    #[tokio::test]
    async fn cached_session_stops_being_honoured_at_its_expiry() {
        let (store, key) = (test_store().await, Key::generate());
        let sid = store.create("111").await.expect("create");
        let h = headers(&test_cookie_header(&key, &sid, &profile("111")));
        assert!(store.authenticate(&h, &key).await.expect("db").is_some());
        store.cache.get_mut(&sid).expect("cached").expires_at = Utc::now() - Duration::seconds(1);
        // The DB row is still live, so this proves the cache entry itself was not trusted.
        assert!(store.authenticate(&h, &key).await.expect("db").is_some());
        set_expiry(&store, &sid, Utc::now() - Duration::seconds(1)).await;
        assert!(store.authenticate(&h, &key).await.expect("db").is_none());
    }

    #[tokio::test]
    async fn unknown_sid_is_rejected() {
        let (store, key) = (test_store().await, Key::generate());
        let h = headers(&test_cookie_header(&key, "not-a-real-sid", &profile("111")));
        assert!(store.authenticate(&h, &key).await.expect("db").is_none());
    }

    #[tokio::test]
    async fn cookie_without_a_sid_is_rejected() {
        use axum::response::IntoResponse;
        let (store, key) = (test_store().await, Key::generate());
        store.create("111").await.expect("create");
        let response = PrivateCookieJar::new(key.clone())
            .add((SESSION_COOKIE, profile("111").to_string()))
            .into_response();
        let pair = response.headers()[axum::http::header::SET_COOKIE]
            .to_str()
            .expect("ascii")
            .split(';')
            .next()
            .expect("pair")
            .to_owned();
        assert!(
            store
                .authenticate(&headers(&pair), &key)
                .await
                .expect("db")
                .is_none()
        );
    }

    #[tokio::test]
    async fn sid_of_another_user_is_rejected() {
        let (store, key) = (test_store().await, Key::generate());
        let sid = store.create("111").await.expect("create");
        let h = headers(&test_cookie_header(&key, &sid, &profile("222")));
        assert!(store.authenticate(&h, &key).await.expect("db").is_none());
    }

    #[tokio::test]
    async fn revoke_all_hits_every_session_of_that_user_and_no_others() {
        let (store, key) = (test_store().await, Key::generate());
        let a1 = store.create("111").await.expect("a1");
        let a2 = store.create("111").await.expect("a2");
        let b = store.create("222").await.expect("b");
        let ha1 = headers(&test_cookie_header(&key, &a1, &profile("111")));
        let ha2 = headers(&test_cookie_header(&key, &a2, &profile("111")));
        let hb = headers(&test_cookie_header(&key, &b, &profile("222")));
        for h in [&ha1, &ha2, &hb] {
            assert!(store.authenticate(h, &key).await.expect("db").is_some());
        }
        assert_eq!(store.revoke_all("111").await.expect("revoke_all"), 2);
        assert!(store.authenticate(&ha1, &key).await.expect("db").is_none());
        assert!(store.authenticate(&ha2, &key).await.expect("db").is_none());
        assert!(store.authenticate(&hb, &key).await.expect("db").is_some());
    }

    #[tokio::test]
    async fn create_purges_long_dead_rows_but_keeps_recent_ones() {
        let store = test_store().await;
        let old_expired = store.create("111").await.expect("old");
        let old_revoked = store.create("111").await.expect("revoked");
        let recent_revoked = store.create("111").await.expect("recent");
        let live = store.create("111").await.expect("live");
        set_expiry(&store, &old_expired, Utc::now() - Duration::days(2)).await;
        let long_ago = Utc::now() - Duration::days(2);
        Entity::update_many()
            .col_expr(Column::RevokedAt, Expr::value(long_ago))
            .filter(Column::Id.eq(old_revoked.as_str()))
            .exec(&store.db)
            .await
            .expect("age revoked");
        store.revoke(&recent_revoked).await.expect("revoke");

        store.create("111").await.expect("trigger purge");
        let ids: Vec<String> = Entity::find()
            .all(&store.db)
            .await
            .expect("rows")
            .into_iter()
            .map(|row| row.id)
            .collect();
        assert!(!ids.contains(&old_expired));
        assert!(!ids.contains(&old_revoked));
        assert!(ids.contains(&recent_revoked));
        assert!(ids.contains(&live));
    }

    #[tokio::test]
    async fn renew_slides_only_sessions_older_than_a_day() {
        let (store, key) = (test_store().await, Key::generate());
        let sid = store.create("111").await.expect("create");
        let h = headers(&test_cookie_header(&key, &sid, &profile("111")));
        let fresh = store
            .authenticate(&h, &key)
            .await
            .expect("db")
            .expect("live");
        assert!(
            !store.renew(&fresh).await.expect("renew"),
            "fresh session is not rewritten"
        );

        set_expiry(&store, &sid, Utc::now() + Duration::days(2)).await;
        let aged = store
            .authenticate(&h, &key)
            .await
            .expect("db")
            .expect("live");
        assert!(store.renew(&aged).await.expect("renew"));
        let renewed = store
            .authenticate(&h, &key)
            .await
            .expect("db")
            .expect("live");
        assert!(renewed.expires_at > Utc::now() + Duration::days(6));
    }

    #[tokio::test]
    async fn renew_does_not_resurrect_a_revoked_session() {
        let (store, key) = (test_store().await, Key::generate());
        let sid = store.create("111").await.expect("create");
        set_expiry(&store, &sid, Utc::now() + Duration::days(2)).await;
        let h = headers(&test_cookie_header(&key, &sid, &profile("111")));
        let aged = store
            .authenticate(&h, &key)
            .await
            .expect("db")
            .expect("live");
        store.revoke(&sid).await.expect("revoke");
        assert!(!store.renew(&aged).await.expect("renew"));
        assert!(store.authenticate(&h, &key).await.expect("db").is_none());
    }
}
