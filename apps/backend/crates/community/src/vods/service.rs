//! VOD review claims: forum checks, unique URL per season, then XP award.

use std::future::Future;

use chrono::{DateTime, Duration, FixedOffset, Utc};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, DatabaseConnection, EntityTrait,
    PaginatorTrait, QueryFilter, QueryOrder,
};

use backend_core::errors::AppError;
use backend_entities::status::progression::XpSource;
use backend_progression::models::AwardSpec;
use backend_progression::service::ProgressionService;

use super::models::{SubmitVodRequest, VodReviewView};
use backend_entities::vods::{
    VodReviewActiveModel, VodReviewColumn, VodReviewEntity, VodReviewModel,
};

/// Hosts a claimed VOD URL may point at (the host itself or any of its subdomains).
pub const VOD_HOST_ALLOWLIST: &[&str] = &[
    "youtube.com",
    "youtu.be",
    "twitch.tv",
    "medal.tv",
    "streamable.com",
    "vimeo.com",
];

/// Maximum VOD claims one member may make in a rolling 24 hours.
pub const DAILY_VOD_CAP: u64 = 5;

/// Discord channel type of a public thread (every forum post is one).
const DISCORD_PUBLIC_THREAD: u64 = 11;

/// What Discord itself reports about the thread a claim refers to.
///
/// Built from `GET /channels/{id}` with the bot token, never from the request body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedThread {
    /// Thread snowflake.
    pub id: String,
    /// Guild the thread lives in.
    pub guild_id: String,
    /// Parent channel (the forum).
    pub parent_id: String,
    /// Snowflake of the member who opened the thread.
    pub owner_id: String,
}

/// Stateless VOD operations.
pub struct VodService;

impl Default for VodService {
    fn default() -> Self {
        Self
    }
}

impl VodService {
    /// Creates a new instance.
    #[must_use]
    pub fn new() -> Self {
        Self
    }

    /// Claims a VOD URL for the caller in the covering season and awards XP.
    ///
    /// The thread is verified with the bot token: it must exist, live in `guild_id` (the
    /// current tenant's Discord server), sit under the configured VOD forum and be owned by
    /// the claimer. The request body's forum/owner fields are not trusted on their own.
    ///
    /// # Errors
    ///
    /// See [`Self::submit_with`]; additionally `502` when Discord cannot be reached.
    pub async fn submit(
        &self,
        db: &DatabaseConnection,
        bot_token: Option<&str>,
        guild_id: &str,
        claimer_user_id: i64,
        claimer_discord_id: &str,
        req: &SubmitVodRequest,
    ) -> Result<VodReviewView, AppError> {
        self.submit_with(
            db,
            guild_id,
            claimer_user_id,
            claimer_discord_id,
            req,
            |thread_id| async move { fetch_thread(bot_token, &thread_id).await },
        )
        .await
    }

    /// [`Self::submit`] with the Discord lookup injected, so tests need no network.
    ///
    /// `verify` is called only after every cheap check passed, with the thread id to look up.
    ///
    /// # Errors
    ///
    /// * `400` if the VOD forum is not configured, the post is in the wrong forum, the thread
    ///   does not exist or lives in another server, there is no covering season, or the URL is
    ///   empty, invalid or not on the host allowlist.
    /// * `403` if the thread owner is not the claimer.
    /// * `409` if the normalized URL is already claimed this season (no XP).
    /// * `429` once the claimer has made [`DAILY_VOD_CAP`] claims in the last 24 hours.
    pub async fn submit_with<F, Fut>(
        &self,
        db: &DatabaseConnection,
        guild_id: &str,
        claimer_user_id: i64,
        claimer_discord_id: &str,
        req: &SubmitVodRequest,
        verify: F,
    ) -> Result<VodReviewView, AppError>
    where
        F: FnOnce(String) -> Fut,
        Fut: Future<Output = Result<VerifiedThread, AppError>>,
    {
        let settings = ProgressionService::new().get_settings(db).await?;
        let Some(configured_forum) = settings
            .vod_forum_channel_id
            .as_ref()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
        else {
            return Err(AppError::Validation("VOD forum is not configured".into()));
        };
        if req.forum_channel_id.trim() != configured_forum {
            return Err(AppError::Validation(
                "must be posted in the configured VOD forum".into(),
            ));
        }
        if req.thread_owner_discord_id.trim() != claimer_discord_id {
            return Err(AppError::Forbidden(
                "only the thread owner can claim this VOD".into(),
            ));
        }

        let url = normalize_vod_url(&req.url)?;
        ensure_allowed_host(&url)?;
        let thread_id = req.discord_thread_id.trim();
        let message_id = req.discord_message_id.trim();
        if !is_snowflake(thread_id) {
            return Err(AppError::Validation("invalid Discord thread id".into()));
        }
        if !message_id.is_empty() && !is_snowflake(message_id) {
            return Err(AppError::Validation("invalid Discord message id".into()));
        }

        let now: DateTime<FixedOffset> = Utc::now().into();
        let Some(season) = ProgressionService::new().covering_season(db).await? else {
            return Err(AppError::Validation("no active covering season".into()));
        };

        let window_start: DateTime<FixedOffset> = (Utc::now() - Duration::hours(24)).into();
        if count_recent_claims(db, claimer_user_id, window_start, None).await? >= DAILY_VOD_CAP {
            return Err(daily_cap_error());
        }

        let thread = verify(thread_id.to_string()).await?;
        check_thread(
            &thread,
            thread_id,
            guild_id,
            &configured_forum,
            claimer_discord_id,
        )?;

        let existing = VodReviewEntity::find()
            .filter(VodReviewColumn::SeasonId.eq(season.id))
            .filter(VodReviewColumn::Url.eq(&url))
            .one(db)
            .await?;
        if existing.is_some() {
            return Err(AppError::Conflict(
                "this VOD URL has already been claimed this season".into(),
            ));
        }

        let row = VodReviewActiveModel {
            user_id: Set(claimer_user_id),
            season_id: Set(season.id),
            url: Set(url.clone()),
            discord_thread_id: Set(thread.id.clone()),
            discord_message_id: Set(message_id.to_string()),
            created_at: Set(now),
            ..Default::default()
        }
        .insert(db)
        .await?;

        // Re-check the cap counting only claims up to and including this row: two concurrent
        // requests that both passed the read above cannot both stay under the cap.
        if count_recent_claims(db, claimer_user_id, window_start, Some(row.id)).await?
            > DAILY_VOD_CAP
        {
            VodReviewEntity::delete_by_id(row.id).exec(db).await?;
            return Err(daily_cap_error());
        }

        if let Err(error) = ProgressionService::new()
            .award(
                db,
                AwardSpec {
                    user_id: claimer_user_id,
                    source: XpSource::Vod,
                    base_amount: Some(i64::from(settings.xp_vod)),
                    idempotency_key: format!("vod:{url}"),
                    actor_user_id: None,
                },
            )
            .await
        {
            tracing::warn!(
                user_id = claimer_user_id,
                url = %url,
                error = %error,
                "failed to award VOD XP"
            );
        }

        Ok(vod_view(&row))
    }

    /// Lists VOD reviews claimed by `user_id`, newest first.
    ///
    /// # Errors
    ///
    /// Database errors.
    pub async fn list_mine(
        &self,
        db: &DatabaseConnection,
        user_id: i64,
    ) -> Result<Vec<VodReviewView>, AppError> {
        let rows = VodReviewEntity::find()
            .filter(VodReviewColumn::UserId.eq(user_id))
            .order_by_desc(VodReviewColumn::CreatedAt)
            .all(db)
            .await?;
        Ok(rows.iter().map(vod_view).collect())
    }
}

fn vod_view(row: &VodReviewModel) -> VodReviewView {
    VodReviewView {
        id: row.id,
        user_id: row.user_id,
        season_id: row.season_id,
        url: row.url.clone(),
        discord_thread_id: row.discord_thread_id.clone(),
        discord_message_id: row.discord_message_id.clone(),
        created_at: row.created_at.to_rfc3339(),
    }
}

fn daily_cap_error() -> AppError {
    AppError::TooManyRequests(format!(
        "VOD claim limit reached ({DAILY_VOD_CAP} per 24 hours); try again later"
    ))
}

/// Claims by `user_id` since `since`, optionally only rows with `id <= up_to_id`.
async fn count_recent_claims(
    db: &DatabaseConnection,
    user_id: i64,
    since: DateTime<FixedOffset>,
    up_to_id: Option<i64>,
) -> Result<u64, AppError> {
    let mut query = VodReviewEntity::find()
        .filter(VodReviewColumn::UserId.eq(user_id))
        .filter(VodReviewColumn::CreatedAt.gte(since));
    if let Some(id) = up_to_id {
        query = query.filter(VodReviewColumn::Id.lte(id));
    }
    Ok(query.count(db).await?)
}

/// Discord snowflakes are 1-20 ASCII digits; anything else must never reach a URL path.
fn is_snowflake(value: &str) -> bool {
    !value.is_empty() && value.len() <= 20 && value.bytes().all(|b| b.is_ascii_digit())
}

/// Compares what Discord reported about the thread with what the claim needs.
fn check_thread(
    thread: &VerifiedThread,
    requested_thread_id: &str,
    guild_id: &str,
    configured_forum: &str,
    claimer_discord_id: &str,
) -> Result<(), AppError> {
    if thread.id != requested_thread_id || thread.guild_id != guild_id {
        return Err(AppError::Validation(
            "the thread does not belong to this server".into(),
        ));
    }
    if thread.parent_id != configured_forum {
        return Err(AppError::Validation(
            "must be posted in the configured VOD forum".into(),
        ));
    }
    if thread.owner_id != claimer_discord_id {
        return Err(AppError::Forbidden(
            "only the thread owner can claim this VOD".into(),
        ));
    }
    Ok(())
}

/// Reads the thread the claim refers to from Discord with the bot token.
///
/// # Errors
///
/// `400` when the thread does not exist (or the bot cannot see it) or is not a forum thread,
/// `502` when no bot token is configured or Discord fails.
async fn fetch_thread(
    bot_token: Option<&str>,
    thread_id: &str,
) -> Result<VerifiedThread, AppError> {
    let Some(token) = bot_token
        .map(str::trim)
        .filter(|token| !token.is_empty() && *token != "your_discord_bot_token")
    else {
        return Err(AppError::UpstreamService(
            "cannot verify the VOD thread: Discord bot token is not configured".into(),
        ));
    };
    let response = backend_core::http_client::shared()
        .get(format!("https://discord.com/api/v10/channels/{thread_id}"))
        .header("Authorization", format!("Bot {token}"))
        .header("User-Agent", "WeaklingsBackend (0.0.3)")
        .send()
        .await
        .map_err(|err| AppError::UpstreamService(format!("Discord thread lookup failed: {err}")))?;
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND || status == reqwest::StatusCode::FORBIDDEN {
        return Err(AppError::Validation("the thread could not be found".into()));
    }
    if !status.is_success() {
        return Err(AppError::UpstreamService(format!(
            "Discord thread lookup returned {status}"
        )));
    }
    let body: serde_json::Value = response.json().await.map_err(|err| {
        AppError::UpstreamService(format!("Discord thread response unreadable: {err}"))
    })?;
    parse_thread(&body)
}

/// Extracts the verification fields from a Discord channel object.
fn parse_thread(body: &serde_json::Value) -> Result<VerifiedThread, AppError> {
    let text = |key: &str| {
        body.get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    };
    let is_thread =
        body.get("type").and_then(serde_json::Value::as_u64) == Some(DISCORD_PUBLIC_THREAD);
    match (
        text("id"),
        text("guild_id"),
        text("parent_id"),
        text("owner_id"),
    ) {
        (Some(id), Some(guild_id), Some(parent_id), Some(owner_id)) if is_thread => {
            Ok(VerifiedThread {
                id,
                guild_id,
                parent_id,
                owner_id,
            })
        }
        _ => Err(AppError::Validation(
            "the channel is not a forum thread".into(),
        )),
    }
}

/// Rejects a normalized URL whose host is not on [`VOD_HOST_ALLOWLIST`].
///
/// The host must be plain `[a-z0-9.-]` (optionally `:port`): userinfo (`@`), backslashes and
/// other separators that make browsers and parsers disagree on the real host are refused.
///
/// # Errors
///
/// Returns `AppError::Validation` when the host is malformed or not allowed.
pub fn ensure_allowed_host(normalized_url: &str) -> Result<(), AppError> {
    let rest = normalized_url
        .split_once("://")
        .map_or(normalized_url, |(_, rest)| rest);
    let authority = rest.split(['/', '?']).next().unwrap_or_default();
    let host = match authority.split_once(':') {
        Some((host, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => host,
        Some(_) => return Err(AppError::Validation("url host is invalid".into())),
        None => authority,
    };
    let well_formed = !host.is_empty()
        && host
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-');
    if !well_formed {
        return Err(AppError::Validation("url host is invalid".into()));
    }
    let allowed = VOD_HOST_ALLOWLIST.iter().any(|domain| {
        host == *domain || host.strip_suffix(domain).is_some_and(|p| p.ends_with('.'))
    });
    if allowed {
        Ok(())
    } else {
        Err(AppError::Validation(format!(
            "VOD links must be on one of: {}",
            VOD_HOST_ALLOWLIST.join(", ")
        )))
    }
}

/// Trim, drop any `#fragment`, lowercase the host, strip a trailing slash on the path.
///
/// # Errors
///
/// Returns `AppError::Validation` when the URL is empty or has no scheme/host.
pub fn normalize_vod_url(raw: &str) -> Result<String, AppError> {
    // A fragment never changes which video is meant; keeping it would let one VOD be claimed
    // again as `...#t=1`, `...#t=2`.
    let trimmed = raw.split('#').next().unwrap_or_default().trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("url is required".into()));
    }
    let Some((scheme, rest)) = trimmed.split_once("://") else {
        return Err(AppError::Validation(
            "url must include a scheme (https://...)".into(),
        ));
    };
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err(AppError::Validation(
            "url scheme must be http or https".into(),
        ));
    }
    let (host_port, remainder) = if let Some(slash) = rest.find('/') {
        (&rest[..slash], &rest[slash..])
    } else if let Some(query) = rest.find('?') {
        (&rest[..query], &rest[query..])
    } else {
        (rest, "")
    };
    if host_port.is_empty() {
        return Err(AppError::Validation("url host is required".into()));
    }
    let host_port = host_port.to_ascii_lowercase();
    let remainder = remainder.trim_end_matches('/');
    if remainder.is_empty() {
        Ok(format!("{scheme}://{host_port}"))
    } else {
        Ok(format!("{scheme}://{host_port}{remainder}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use backend_entities::progression::ProgressionSeasonActiveModel;
    use backend_entities::users::ActiveModel as UserActiveModel;
    use backend_progression::models::UpdateProgressionSettingsRequest;

    async fn seed_db() -> DatabaseConnection {
        backend_migration::testkit::migrated_sqlite().await
    }

    async fn insert_user(db: &DatabaseConnection, username: &str, email: &str) -> i64 {
        UserActiveModel {
            username: Set(username.to_string()),
            email: Set(email.to_string()),
            role: Set("User".to_string()),
            discord_id: Set(Some(format!("discord-{username}"))),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert user")
        .id
    }

    async fn insert_covering_season(db: &DatabaseConnection) -> i64 {
        let now = Utc::now();
        let starts: DateTime<FixedOffset> = (now - Duration::days(1)).into();
        let ends: DateTime<FixedOffset> = (now + Duration::days(30)).into();
        ProgressionSeasonActiveModel {
            name: Set("s25".into()),
            starts_at: Set(starts),
            ends_at: Set(ends),
            is_active: Set(true),
            updated_at: Set(now.into()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("season")
        .id
    }

    const GUILD: &str = "900";
    const FORUM: &str = "forum-1";

    fn req(url: &str, forum: &str) -> SubmitVodRequest {
        SubmitVodRequest {
            url: url.to_string(),
            discord_thread_id: "111".into(),
            discord_message_id: "222".into(),
            forum_channel_id: forum.to_string(),
            thread_owner_discord_id: "discord-alice".into(),
        }
    }

    fn thread() -> VerifiedThread {
        VerifiedThread {
            id: "111".into(),
            guild_id: GUILD.into(),
            parent_id: FORUM.into(),
            owner_id: "discord-alice".into(),
        }
    }

    async fn submit_as(
        db: &DatabaseConnection,
        user_id: i64,
        request: &SubmitVodRequest,
        found: VerifiedThread,
    ) -> Result<VodReviewView, AppError> {
        VodService::new()
            .submit_with(db, GUILD, user_id, "discord-alice", request, |_| async {
                Ok(found)
            })
            .await
    }

    async fn configure_forum(db: &DatabaseConnection, editor: i64) {
        ProgressionService::new()
            .update_settings(
                db,
                editor,
                &UpdateProgressionSettingsRequest {
                    vod_forum_channel_id: Some(FORUM.into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
    }

    /// Database with a covering season, a configured forum and one member (`alice`).
    async fn ready() -> (DatabaseConnection, i64) {
        let db = seed_db().await;
        let editor = insert_user(&db, "admin", "admin@example.com").await;
        let user_id = insert_user(&db, "alice", "alice@example.com").await;
        insert_covering_season(&db).await;
        configure_forum(&db, editor).await;
        (db, user_id)
    }

    async fn insert_claim(db: &DatabaseConnection, user_id: i64, url: &str, age: Duration) {
        let season = ProgressionService::new()
            .covering_season(db)
            .await
            .unwrap()
            .expect("season");
        VodReviewActiveModel {
            user_id: Set(user_id),
            season_id: Set(season.id),
            url: Set(url.to_string()),
            discord_thread_id: Set("111".into()),
            discord_message_id: Set(String::new()),
            created_at: Set((Utc::now() - age).into()),
            ..Default::default()
        }
        .insert(db)
        .await
        .unwrap();
    }

    async fn xp_of(db: &DatabaseConnection, user_id: i64) -> i64 {
        ProgressionService::new()
            .get_me(db, user_id)
            .await
            .unwrap()
            .xp
    }

    #[test]
    fn normalize_lowercases_host_and_strips_slash() {
        assert_eq!(
            normalize_vod_url(" HTTPS://YouTube.com/watch?v=AbC/ ").unwrap(),
            "https://youtube.com/watch?v=AbC"
        );
    }

    #[test]
    fn normalize_drops_the_fragment() {
        assert_eq!(
            normalize_vod_url("https://youtu.be/a#t=30").unwrap(),
            normalize_vod_url("https://youtu.be/a").unwrap()
        );
    }

    #[test]
    fn host_allowlist_accepts_listed_hosts_and_subdomains() {
        for url in [
            "https://youtube.com/watch?v=a",
            "https://www.youtube.com/watch?v=a",
            "https://youtu.be/a",
            "https://clips.twitch.tv/x",
            "https://medal.tv/clips/1",
            "https://youtube.com:443/watch?v=a",
        ] {
            ensure_allowed_host(&normalize_vod_url(url).unwrap())
                .unwrap_or_else(|e| panic!("{url} should pass: {e}"));
        }
    }

    #[test]
    fn host_allowlist_rejects_other_hosts_and_parser_tricks() {
        for url in [
            "https://evil.example/a",
            "https://notyoutube.com/a",
            "https://youtube.com.evil.example/a",
            "https://youtube.com@evil.example/a",
            "https://evil.example@youtube.com/a",
            "https://evil.example\\@youtube.com/a",
            "https://evil.example#@youtube.com/a",
            "https://youtube.com:8080x/a",
            "https://127.0.0.1/a",
        ] {
            let err = normalize_vod_url(url)
                .and_then(|normalized| ensure_allowed_host(&normalized))
                .unwrap_err();
            assert!(matches!(err, AppError::Validation(_)), "{url}: {err:?}");
        }
    }

    #[test]
    fn parse_thread_reads_the_discord_channel_object() {
        let body = serde_json::json!({
            "id": "111", "type": 11, "guild_id": "900",
            "parent_id": "forum-1", "owner_id": "discord-alice"
        });
        assert_eq!(parse_thread(&body).unwrap(), thread());
    }

    #[test]
    fn parse_thread_rejects_non_threads_and_incomplete_objects() {
        for body in [
            serde_json::json!({"id": "1", "type": 0, "guild_id": "900", "parent_id": "f", "owner_id": "o"}),
            serde_json::json!({"id": "1", "type": 11, "guild_id": "900", "parent_id": "f"}),
            serde_json::json!({"id": "1", "type": 11, "parent_id": "f", "owner_id": "o"}),
        ] {
            assert!(matches!(parse_thread(&body), Err(AppError::Validation(_))));
        }
    }

    #[test]
    fn snowflakes_are_digits_only() {
        assert!(is_snowflake("1234567890123456789"));
        for bad in ["", "12a", "../x", "1 2", "123456789012345678901"] {
            assert!(!is_snowflake(bad), "{bad:?}");
        }
    }

    #[tokio::test]
    async fn submit_rejects_missing_forum_config() {
        let db = seed_db().await;
        let user_id = insert_user(&db, "alice", "alice@example.com").await;
        insert_covering_season(&db).await;
        let err = submit_as(&db, user_id, &req("https://youtu.be/a", "forum"), thread())
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Validation(msg) if msg.contains("not configured")));
    }

    #[tokio::test]
    async fn submit_rejects_wrong_forum() {
        let (db, user_id) = ready().await;
        let err = submit_as(
            &db,
            user_id,
            &req("https://youtu.be/a", "wrong-forum"),
            thread(),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::Validation(msg) if msg.contains("configured VOD forum")));
    }

    #[tokio::test]
    async fn submit_unique_url_per_season() {
        let (db, user_id) = ready().await;
        let first = submit_as(
            &db,
            user_id,
            &req("HTTPS://YouTube.com/watch?v=AbC/", FORUM),
            thread(),
        )
        .await
        .unwrap();
        assert_eq!(first.url, "https://youtube.com/watch?v=AbC");

        let dup = submit_as(
            &db,
            user_id,
            &req("https://youtube.com/watch?v=AbC#t=9", FORUM),
            thread(),
        )
        .await
        .unwrap_err();
        assert!(matches!(dup, AppError::Conflict(_)));
        assert_eq!(xp_of(&db, user_id).await, 40);
    }

    #[tokio::test]
    async fn submit_rejects_a_thread_that_is_not_in_this_guild() {
        let (db, user_id) = ready().await;
        let foreign = VerifiedThread {
            guild_id: "other-guild".into(),
            ..thread()
        };
        let err = submit_as(&db, user_id, &req("https://youtu.be/a", FORUM), foreign)
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Validation(msg) if msg.contains("this server")));
        assert!(
            VodService::new()
                .list_mine(&db, user_id)
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(xp_of(&db, user_id).await, 0);
    }

    #[tokio::test]
    async fn submit_trusts_discord_over_the_request_body() {
        let (db, user_id) = ready().await;
        // The body claims the right forum and owner, but Discord says otherwise.
        let wrong_parent = VerifiedThread {
            parent_id: "some-other-channel".into(),
            ..thread()
        };
        let err = submit_as(
            &db,
            user_id,
            &req("https://youtu.be/a", FORUM),
            wrong_parent,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::Validation(msg) if msg.contains("configured VOD forum")));

        let wrong_owner = VerifiedThread {
            owner_id: "discord-bob".into(),
            ..thread()
        };
        let err = submit_as(&db, user_id, &req("https://youtu.be/a", FORUM), wrong_owner)
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Forbidden(_)));

        let other_thread = VerifiedThread {
            id: "999".into(),
            ..thread()
        };
        let err = submit_as(
            &db,
            user_id,
            &req("https://youtu.be/a", FORUM),
            other_thread,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
        assert_eq!(xp_of(&db, user_id).await, 0);
    }

    #[tokio::test]
    async fn submit_surfaces_a_missing_thread_and_skips_discord_on_cheap_failures() {
        let (db, user_id) = ready().await;
        let err = VodService::new()
            .submit_with(
                &db,
                GUILD,
                user_id,
                "discord-alice",
                &req("https://youtu.be/a", FORUM),
                |_| async { Err(AppError::Validation("the thread could not be found".into())) },
            )
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Validation(msg) if msg.contains("could not be found")));

        let calls = std::sync::atomic::AtomicUsize::new(0);
        for bad in [
            req("https://evil.example/a", FORUM),
            SubmitVodRequest {
                discord_thread_id: "../channels".into(),
                ..req("https://youtu.be/a", FORUM)
            },
            SubmitVodRequest {
                discord_message_id: "x".into(),
                ..req("https://youtu.be/a", FORUM)
            },
        ] {
            let err = VodService::new()
                .submit_with(&db, GUILD, user_id, "discord-alice", &bad, |_| async {
                    calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Ok(thread())
                })
                .await
                .unwrap_err();
            assert!(matches!(err, AppError::Validation(_)), "{bad:?}: {err:?}");
        }
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn submit_without_bot_token_fails_closed() {
        let (db, user_id) = ready().await;
        let err = VodService::new()
            .submit(
                &db,
                None,
                GUILD,
                user_id,
                "discord-alice",
                &req("https://youtu.be/a", FORUM),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::UpstreamService(_)));
        assert!(
            VodService::new()
                .list_mine(&db, user_id)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn daily_cap_is_enforced_and_old_claims_do_not_count() {
        let (db, user_id) = ready().await;
        // Claims older than 24 hours are outside the window.
        for n in 0..3 {
            insert_claim(
                &db,
                user_id,
                &format!("https://youtu.be/old{n}"),
                Duration::hours(30),
            )
            .await;
        }
        for n in 0..DAILY_VOD_CAP {
            submit_as(
                &db,
                user_id,
                &req(&format!("https://youtu.be/new{n}"), FORUM),
                thread(),
            )
            .await
            .unwrap_or_else(|e| panic!("claim {n} within the cap: {e:?}"));
        }
        let err = submit_as(
            &db,
            user_id,
            &req("https://youtu.be/one-too-many", FORUM),
            thread(),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::TooManyRequests(_)), "{err:?}");
        assert_eq!(
            xp_of(&db, user_id).await,
            40 * i64::try_from(DAILY_VOD_CAP).unwrap()
        );
    }

    #[tokio::test]
    async fn claims_racing_past_the_cap_check_are_rolled_back() {
        let (db, user_id) = ready().await;
        // Simulates concurrent requests: the cap read passes, then other claims land while
        // Discord is being asked, so this insert is over the cap.
        let err = VodService::new()
            .submit_with(
                &db,
                GUILD,
                user_id,
                "discord-alice",
                &req("https://youtu.be/late", FORUM),
                |_| async {
                    for n in 0..DAILY_VOD_CAP {
                        insert_claim(
                            &db,
                            user_id,
                            &format!("https://youtu.be/race{n}"),
                            Duration::zero(),
                        )
                        .await;
                    }
                    Ok(thread())
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::TooManyRequests(_)), "{err:?}");
        let mine = VodService::new().list_mine(&db, user_id).await.unwrap();
        assert_eq!(u64::try_from(mine.len()).unwrap(), DAILY_VOD_CAP);
        assert!(mine.iter().all(|row| !row.url.ends_with("/late")));
        assert_eq!(xp_of(&db, user_id).await, 0);
    }
}
