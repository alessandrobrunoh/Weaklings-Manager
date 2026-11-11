//! Auth service logic module.
//!
//! Handles communication with Discord API for token exchange and profile retrieval.

use crate::config::Config;
use crate::errors::AppError;
use crate::modules::admin::models::BrandColorsView;
use crate::modules::discord_api::{DiscordError, DiscordRest, LiveDiscordRest};
use sea_orm::{DatabaseConnection, EntityTrait};
use serde::{Deserialize, Serialize};

/// Token response returned from Discord's token exchange endpoint.
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct DiscordTokenResponse {
    /// The access token to authenticate API requests.
    pub access_token: String,
    /// The type of token returned (typically "Bearer").
    pub token_type: String,
    /// The number of seconds until the access token expires.
    pub expires_in: u64,
    /// An optional token used to refresh expired access tokens.
    pub refresh_token: Option<String>,
    /// The scopes granted by the user.
    pub scope: String,
}

/// Discord user profile details retrieved from `/users/@me` and enriched with guild roles.
#[derive(Debug, Deserialize, Serialize, Clone, utoipa::ToSchema)]
pub struct DiscordUserProfile {
    /// The unique Snowflake ID of the Discord user.
    #[schema(example = "123456789012345678")]
    pub id: String,
    /// The username of the user.
    #[schema(example = "discord_user")]
    pub username: String,
    /// The registered email address of the user (requires `email` scope).
    ///
    /// Only ever the address Discord reports as verified: [`AuthService::fetch_profile`] drops
    /// an unverified one, so nothing downstream can claim a row or store it.
    #[schema(example = "user@example.com")]
    pub email: Option<String>,
    /// Whether Discord has verified `email`. Absent when the `email` scope was not granted and
    /// on cookies issued before this flag existed, which both read as "not verified".
    #[schema(example = true)]
    #[serde(default)]
    pub verified: Option<bool>,
    /// The avatar hash of the user.
    #[schema(example = "a_1234567890abcdef1234567890abcdef")]
    pub avatar: Option<String>,
    /// The Discord role names this user has in the configured guild.
    #[schema(example = r#"["Admin", "Mod"]"#)]
    #[serde(default)]
    pub roles: Vec<String>,
    /// The highest role name of this user in the configured guild.
    #[schema(example = "Admin")]
    #[serde(default)]
    pub highest_role: String,
    /// The internal database primary key of the user, resolved/provisioned on login.
    #[schema(example = 42)]
    #[serde(default)]
    pub user_id: i64,
    /// Capability flag derived from the configured Discord user id, not from guild roles.
    ///
    /// This lets clients expose privileged UI without depending on a Discord role row named
    /// `SuperAdmin`, and `/api/auth/me` recomputes it on every request so env changes do not
    /// require users to clear their cookies.
    #[schema(example = true)]
    #[serde(default)]
    pub is_superadmin: bool,
    /// True when this Discord user holds a control-plane platform role.
    ///
    /// Distinct from guild `SuperAdmin` so the `/platform` UI can gate on the
    /// control-plane assignment even when the session is not yet tenant-scoped.
    #[schema(example = true)]
    #[serde(default)]
    pub is_platform_admin: bool,
    /// True only for the original owner of the currently selected guild tenant.
    /// Distinct from platform administration and recomputed on `/auth/me`.
    #[schema(example = true)]
    #[serde(default)]
    pub is_tenant_owner: bool,
    /// Stable permission keys granted to this session.
    ///
    /// The frontend should render privileged actions from this list instead of duplicating role
    /// checks. Super-admin receives every known permission from the backend permission enum.
    #[schema(example = json!(["splits.manage", "permissions.reload"]))]
    #[serde(default)]
    pub permissions: Vec<String>,
    /// Discord guild / tenant this session is scoped to.
    ///
    /// Absent on cookies issued before multi-tenant login (Stage 4). The tenant
    /// middleware then falls back to `X-Guild-Id` or the sole active tenant.
    #[schema(example = "123456789012345678")]
    #[serde(default)]
    pub tenant_id: Option<String>,
    /// Display name of the tenant this session is scoped to.
    #[schema(example = "Weaklings")]
    #[serde(default)]
    pub tenant_name: Option<String>,
    /// `guild` or `alliance` for the scoped tenant.
    #[serde(default)]
    pub tenant_kind: Option<String>,
    /// Optional modules currently enabled for this tenant (`rank ∩ flags`).
    #[serde(default)]
    pub features: Vec<String>,
    /// This tenant's brand colours, so the app themes itself per server.
    ///
    /// Rides along on the session because every member needs them before the
    /// first paint, not just the admins who can edit them. Absent when the
    /// guild never picked any, which means "use the product defaults".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brand: Option<BrandColorsView>,
}

/// A registered tenant the user may enter after OAuth.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
pub struct TenantChoice {
    /// Discord guild snowflake / `tenants.id`.
    pub id: String,
    /// Display name.
    pub name: String,
    /// URL-ish slug.
    pub slug: String,
    /// Discord guild icon hash, when known.
    #[serde(default)]
    pub icon_hash: Option<String>,
    /// Whether platform configured this tenant as the automatic login target.
    #[serde(default)]
    pub is_default: bool,
}

/// A Discord guild the user may register as a tenant.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
pub struct RegisterableGuild {
    /// Discord guild snowflake.
    pub id: String,
    /// Guild display name.
    pub name: String,
    /// Guild icon hash, when present.
    #[serde(default)]
    pub icon_hash: Option<String>,
    /// Whether this Discord user owns the guild or holds `Manage Server` /
    /// `Administrator` in it.
    ///
    /// Computed once at login from the OAuth `guilds` scope and carried in the
    /// signed `registerable_guilds` cookie, so `POST /api/tenants/register`
    /// can check it as a fast path with no Discord round trip. It is a cache,
    /// not the only guard: that handler also re-verifies live via the bot
    /// token when this is stale, absent, or `false`, so a session older than
    /// the cookie's lifetime — or a brand-new server the bot just joined —
    /// still registers correctly. See [`DiscordGuild::can_manage`].
    #[serde(default)]
    pub can_manage: bool,
}

/// Discord's `MANAGE_GUILD` permission bit.
pub const PERMISSION_MANAGE_GUILD: u64 = 0x0000_0000_0000_0020;
/// Discord's `ADMINISTRATOR` permission bit, which implies every other one.
pub const PERMISSION_ADMINISTRATOR: u64 = 0x0000_0000_0000_0008;

/// Discord guild membership row from `/users/@me/guilds`.
#[derive(Debug, Clone, Deserialize)]
pub struct DiscordGuild {
    /// Guild snowflake.
    pub id: String,
    /// Guild display name.
    pub name: String,
    /// Guild icon hash from Discord.
    #[serde(default)]
    pub icon: Option<String>,
    /// True when the OAuth user owns this guild.
    #[serde(default)]
    pub owner: bool,
    /// The calling user's computed permission bitfield in this guild, as a
    /// decimal string (Discord's own encoding — the value can exceed `i64`).
    /// Present because the `guilds` OAuth scope was requested; absent (never
    /// happens per Discord's docs, but treated as "no permissions" rather than
    /// a parse error) reads as `0`.
    #[serde(default)]
    pub permissions: String,
}

impl DiscordGuild {
    /// Whether this user may register `self` as a tenant: owns it, or holds
    /// `Manage Server` / `Administrator`.
    ///
    /// Registration hands the caller the tenant's owner/SuperAdmin seat, so
    /// this is deliberately narrower than "is a member" — the check
    /// `assert_guild_member` used to make, and the only one left standing
    /// whenever `DISCORD_BOT_TOKEN` was unset.
    #[must_use]
    pub fn can_manage(&self) -> bool {
        if self.owner {
            return true;
        }
        let bits: u64 = self.permissions.parse().unwrap_or(0);
        bits & (PERMISSION_MANAGE_GUILD | PERMISSION_ADMINISTRATOR) != 0
    }
}

/// Encrypted cookie payload while the user picks among several matching tenants.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OauthPending {
    /// Discord user access token, used to finish role resolution after the pick.
    pub access_token: String,
    /// Profile fetched from Discord, not yet tenant-scoped.
    pub profile: DiscordUserProfile,
    /// Tenants that intersect the user's Discord guilds.
    pub tenants: Vec<TenantChoice>,
}

/// Registered tenants whose Discord guild id appears in `user_guilds`.
#[must_use]
pub fn matching_tenants(
    user_guilds: &[DiscordGuild],
    registered: &[TenantChoice],
) -> Vec<TenantChoice> {
    let held: std::collections::HashSet<&str> = user_guilds.iter().map(|g| g.id.as_str()).collect();
    let discord_names: std::collections::HashMap<&str, &str> = user_guilds
        .iter()
        .map(|g| (g.id.as_str(), g.name.as_str()))
        .collect();
    registered
        .iter()
        .filter(|tenant| held.contains(tenant.id.as_str()))
        .map(|tenant| {
            let mut choice = tenant.clone();
            if let Some(discord_name) = discord_names.get(tenant.id.as_str())
                && !discord_name.is_empty()
            {
                choice.name = (*discord_name).to_owned();
            }
            if let Some(guild) = user_guilds.iter().find(|g| g.id == tenant.id) {
                choice.icon_hash = guild.icon.clone();
            }
            choice
        })
        .collect()
}

/// Service for interacting with the Discord `OAuth2` API.
pub struct AuthService;

impl AuthService {
    /// Creates a new instance of the `AuthService`.
    #[must_use]
    pub fn new() -> Self {
        Self
    }

    /// Exchanges the authorization code for an `OAuth2` token from Discord.
    ///
    /// # Errors
    ///
    /// Returns `AppError::Unauthorized` if Discord rejects the code or credentials.
    pub async fn exchange_code(
        &self,
        client_id: &str,
        client_secret: &str,
        code: &str,
        redirect_uri: &str,
    ) -> Result<DiscordTokenResponse, AppError> {
        let client = crate::http_client::shared();

        let params = [
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect_uri),
        ];

        let response = client
            .post("https://discord.com/api/oauth2/token")
            .form(&params)
            .send()
            .await
            .map_err(|e| AppError::Unauthorized(format!("Failed to contact Discord: {e}")))?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            return Err(AppError::Unauthorized(format!(
                "Discord token exchange failed: {error_text}"
            )));
        }

        let token_resp = response
            .json::<DiscordTokenResponse>()
            .await
            .map_err(|e| AppError::Unauthorized(format!("Failed to parse Discord token: {e}")))?;

        Ok(token_resp)
    }

    /// Retrieves the Discord user profile using the access token.
    ///
    /// # Errors
    ///
    /// Returns `AppError::Unauthorized` if the profile request fails.
    pub async fn fetch_profile(&self, access_token: &str) -> Result<DiscordUserProfile, AppError> {
        let client = crate::http_client::shared();

        let response = client
            .get("https://discord.com/api/users/@me")
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|e| {
                AppError::Unauthorized(format!("Failed to request Discord profile: {e}"))
            })?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            return Err(AppError::Unauthorized(format!(
                "Failed to get Discord profile: {error_text}"
            )));
        }

        let mut profile = response
            .json::<DiscordUserProfile>()
            .await
            .map_err(|e| AppError::Unauthorized(format!("Failed to parse Discord profile: {e}")))?;
        drop_unverified_email(&mut profile);

        Ok(profile)
    }

    /// Lists Discord guilds the user belongs to (`guilds` OAuth scope).
    ///
    /// # Errors
    ///
    /// Returns `AppError::Unauthorized` if Discord rejects the token.
    pub async fn fetch_user_guilds(
        &self,
        access_token: &str,
    ) -> Result<Vec<DiscordGuild>, AppError> {
        let client = crate::http_client::shared();
        let response = client
            .get("https://discord.com/api/v10/users/@me/guilds")
            .bearer_auth(access_token)
            .header("User-Agent", "WeaklingsBackend (0.0.1)")
            .send()
            .await
            .map_err(|e| AppError::Unauthorized(format!("failed to list discord guilds: {e}")))?;

        if !response.status().is_success() {
            let error_text = response.text().await.unwrap_or_default();
            return Err(AppError::Unauthorized(format!(
                "failed to list discord guilds: {error_text}"
            )));
        }

        response
            .json::<Vec<DiscordGuild>>()
            .await
            .map_err(|e| AppError::Unauthorized(format!("failed to parse discord guilds: {e}")))
    }

    /// Fetches the member's Discord role snowflakes from the guild.
    ///
    /// [`GuildMemberLookup::Absent`] is a confirmed 404 with Discord code 10007 (removed from
    /// the guild) and must drop cached privileges. [`GuildMemberLookup::Unavailable`] is any
    /// other failure (bot removed, 403, 429, 5xx, network) and must not be treated as a
    /// revocation. Successful lookups are cached briefly so request authorization does not
    /// call Discord on every call.
    pub async fn fetch_guild_member_role_ids(
        &self,
        user_id: &str,
        user_access_token: &str,
        guild_id: &str,
        cfg: &Config,
    ) -> GuildMemberLookup {
        let cache_key = (guild_id.to_owned(), user_id.to_owned());
        if user_access_token.is_empty()
            && let Some(hit) = cached_member_lookup(&cache_key)
        {
            return hit;
        }

        let discord = LiveDiscordRest::new(cfg);
        if discord.has_bot_token() {
            match discord.guild_member(guild_id, user_id).await {
                Ok(member) => {
                    let lookup = GuildMemberLookup::Present(member.roles);
                    remember_member_lookup(&cache_key, &lookup);
                    return lookup;
                }
                Err(DiscordError::MemberNotFound) => {
                    let lookup = GuildMemberLookup::Absent;
                    remember_member_lookup(&cache_key, &lookup);
                    return lookup;
                }
                // No bot path after all, or a transport/payload failure: try the user token.
                Err(
                    DiscordError::NotConfigured
                    | DiscordError::Transport(_)
                    | DiscordError::InvalidPayload(_),
                ) => {}
                // A classified answer (unknown guild, 403, 429, 5xx) is an outage, not absence.
                Err(_) => return GuildMemberLookup::Unavailable,
            }
        }

        if user_access_token.is_empty() {
            return GuildMemberLookup::Unavailable;
        }
        match discord.user_guild_member(user_access_token, guild_id).await {
            Ok(member) => GuildMemberLookup::Present(member.roles),
            Err(DiscordError::MemberNotFound) => GuildMemberLookup::Absent,
            Err(_) => GuildMemberLookup::Unavailable,
        }
    }
}

impl Default for AuthService {
    fn default() -> Self {
        Self::new()
    }
}

/// Outcome of a Discord guild-member read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GuildMemberLookup {
    /// Member exists. `roles` may be empty.
    Present(Vec<String>),
    /// Discord returned 404 with code 10007: the user is not in this guild.
    Absent,
    /// Network error, 5xx, or the bot cannot read the member. Not a revocation.
    Unavailable,
}

/// Roles a member gets at login, or `None` when Discord confirmed they are no longer in the
/// server (web access follows Discord presence, so the caller refuses the session).
///
/// An outage ([`GuildMemberLookup::Unavailable`]) resolves to the default role rather than
/// inventing privileges; `/auth/me` is what keeps a cache across outages.
#[must_use]
pub fn login_roles(
    lookup: &GuildMemberLookup,
    db_roles: &[crate::modules::auth::entities::role::Model],
) -> Option<(Vec<String>, String)> {
    match lookup {
        GuildMemberLookup::Present(ids) => Some(resolve_linked_roles(ids, db_roles)),
        GuildMemberLookup::Unavailable => Some(resolve_linked_roles(&[], db_roles)),
        GuildMemberLookup::Absent => None,
    }
}

/// Keeps an email only when Discord marked it verified. An unverified address can be typed by
/// anyone, so it must never claim an existing row or be stored on a new one.
pub fn drop_unverified_email(profile: &mut DiscordUserProfile) {
    if profile.verified != Some(true) {
        profile.email = None;
    }
}

/// Applies a live lookup to cached session roles.
///
/// Confirmed absence clears linked roles (default role only). An outage keeps
/// the cache. Platform admins are not derived from Discord guild roles.
#[must_use]
pub fn roles_after_member_lookup(
    lookup: &GuildMemberLookup,
    cached_roles: &[String],
    cached_highest: &str,
    db_roles: &[crate::modules::auth::entities::role::Model],
    is_superadmin: bool,
) -> (Vec<String>, String) {
    if is_superadmin {
        return (vec!["SuperAdmin".to_string()], "SuperAdmin".to_string());
    }
    match lookup {
        GuildMemberLookup::Present(ids) => resolve_linked_roles(ids, db_roles),
        GuildMemberLookup::Absent => resolve_linked_roles(&[], db_roles),
        GuildMemberLookup::Unavailable => (cached_roles.to_vec(), cached_highest.to_string()),
    }
}

fn cached_member_lookup(key: &(String, String)) -> Option<GuildMemberLookup> {
    let cache = member_lookup_cache()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let entry = cache.get(key)?;
    if entry.at.elapsed() > std::time::Duration::from_secs(60) {
        return None;
    }
    Some(entry.lookup.clone())
}

fn remember_member_lookup(key: &(String, String), lookup: &GuildMemberLookup) {
    if matches!(lookup, GuildMemberLookup::Unavailable) {
        return;
    }
    let mut cache = member_lookup_cache()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    cache.insert(
        key.clone(),
        CachedMemberLookup {
            lookup: lookup.clone(),
            at: std::time::Instant::now(),
        },
    );
}

struct CachedMemberLookup {
    lookup: GuildMemberLookup,
    at: std::time::Instant,
}

fn member_lookup_cache()
-> &'static std::sync::Mutex<std::collections::HashMap<(String, String), CachedMemberLookup>> {
    static CACHE: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<(String, String), CachedMemberLookup>>,
    > = std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Maps a member's Discord role snowflakes onto gestionale role names.
///
/// Matching is on `discord_role_id`, never on the internal `id`. Unmatched members receive the
/// unique `is_default` role when one exists, otherwise the hardcoded name `"User"`.
#[must_use]
pub fn resolve_linked_roles(
    member_discord_role_ids: &[String],
    db_roles: &[crate::modules::auth::entities::role::Model],
) -> (Vec<String>, String) {
    let held: std::collections::HashSet<&str> =
        member_discord_role_ids.iter().map(String::as_str).collect();

    let mut matched: Vec<&crate::modules::auth::entities::role::Model> = db_roles
        .iter()
        .filter(|role| {
            role.discord_role_id
                .as_deref()
                .is_some_and(|id| held.contains(id))
        })
        .collect();

    if matched.is_empty() {
        return fallback_unmatched_roles(db_roles);
    }

    matched.sort_by(|a, b| {
        b.priority
            .cmp(&a.priority)
            .then_with(|| a.name.cmp(&b.name))
    });
    let names: Vec<String> = matched.iter().map(|role| role.name.clone()).collect();
    let highest = names.first().cloned().unwrap_or_else(|| "User".to_string());
    (names, highest)
}

/// Resolves Discord role IDs supplied by an authenticated bot request to the
/// current tenant's linked role names. Requests from older bot builds keep
/// using the persisted highest-role value until the bot sends the new header.
pub async fn resolve_bot_role_ids(
    db: &DatabaseConnection,
    role_ids_header: Option<&str>,
    fallback_role: &str,
) -> Result<(Vec<String>, String), AppError> {
    let Some(header) = role_ids_header else {
        return Ok((vec![fallback_role.to_string()], fallback_role.to_string()));
    };
    let role_ids = parse_bot_role_ids_header(header)?;
    let db_roles = crate::modules::auth::entities::role::Entity::find()
        .all(db)
        .await
        .map_err(|_| {
            AppError::Internal("Could not load role mappings for bot authorization".into())
        })?;
    Ok(resolve_linked_roles(&role_ids, &db_roles))
}

fn parse_bot_role_ids_header(header: &str) -> Result<Vec<String>, AppError> {
    const MAX_HEADER_BYTES: usize = 8_192;
    const MAX_ROLE_IDS: usize = 250;

    if header.len() > MAX_HEADER_BYTES {
        return Err(AppError::Unauthorized(
            "Discord role ID header is too large".to_string(),
        ));
    }
    if header.is_empty() {
        return Ok(Vec::new());
    }

    let parts: Vec<&str> = header.split(',').map(str::trim).collect();
    if parts.len() > MAX_ROLE_IDS
        || parts.iter().any(|role_id| {
            role_id.is_empty()
                || role_id.len() > 20
                || !role_id.bytes().all(|byte| byte.is_ascii_digit())
        })
    {
        return Err(AppError::Unauthorized(
            "Discord role ID header is invalid".to_string(),
        ));
    }

    let mut role_ids = Vec::with_capacity(parts.len());
    for role_id in parts {
        if !role_ids.iter().any(|existing| existing == role_id) {
            role_ids.push(role_id.to_string());
        }
    }
    Ok(role_ids)
}

fn fallback_unmatched_roles(
    db_roles: &[crate::modules::auth::entities::role::Model],
) -> (Vec<String>, String) {
    if let Some(default) = db_roles.iter().find(|role| role.is_default) {
        return (vec![default.name.clone()], default.name.clone());
    }
    (vec!["User".to_string()], "User".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::auth::entities::role;
    use crate::testkit::discord_stub::{DiscordStub, StubReply};

    fn bot_cfg(base_url: &str) -> Config {
        let mut cfg = Config::for_tests();
        cfg.discord_api_base = base_url.to_owned();
        cfg.discord_bot_token = Some("bot-token".to_owned());
        cfg
    }

    #[tokio::test]
    async fn only_unknown_member_is_absence_for_the_role_lookup() {
        let stub = DiscordStub::start(|request| {
            if request.path.contains("/members/u-absent") {
                StubReply::json(404, r#"{"message":"Unknown Member","code":10007}"#)
            } else if request.path.contains("/members/u-unknown-guild") {
                StubReply::json(404, r#"{"message":"Unknown Guild","code":10004}"#)
            } else {
                StubReply::json(200, r#"{"roles":["r-1"],"nick":null}"#)
            }
        })
        .await;
        let cfg = bot_cfg(&stub.base_url);
        let auth = AuthService::new();

        assert_eq!(
            auth.fetch_guild_member_role_ids("u-present", "", "g-auth-1", &cfg)
                .await,
            GuildMemberLookup::Present(vec!["r-1".to_string()])
        );
        assert_eq!(
            auth.fetch_guild_member_role_ids("u-absent", "", "g-auth-1", &cfg)
                .await,
            GuildMemberLookup::Absent
        );
        assert_eq!(
            auth.fetch_guild_member_role_ids("u-unknown-guild", "", "g-auth-1", &cfg)
                .await,
            GuildMemberLookup::Unavailable
        );
    }

    #[tokio::test]
    async fn a_failed_bot_read_without_a_user_token_is_an_outage() {
        let stub = DiscordStub::start(|_| StubReply::json(429, "{}").with_retry_after("1")).await;
        let cfg = bot_cfg(&stub.base_url);

        assert_eq!(
            AuthService::new()
                .fetch_guild_member_role_ids("u-limited", "", "g-auth-2", &cfg)
                .await,
            GuildMemberLookup::Unavailable
        );
    }

    fn discord_guild(owner: bool, permissions: &str) -> DiscordGuild {
        DiscordGuild {
            id: "1".to_owned(),
            name: "Guild".to_owned(),
            icon: None,
            owner,
            permissions: permissions.to_owned(),
        }
    }

    #[test]
    fn owner_can_manage_regardless_of_permission_bits() {
        assert!(discord_guild(true, "0").can_manage());
    }

    #[test]
    fn manage_guild_bit_grants_can_manage() {
        // 0x20 = MANAGE_GUILD, plus an unrelated bit (VIEW_CHANNEL = 0x400) to
        // confirm this reads the specific bit rather than "nonzero".
        assert!(discord_guild(false, "1056").can_manage());
    }

    #[test]
    fn administrator_bit_grants_can_manage() {
        assert!(discord_guild(false, "8").can_manage());
    }

    #[test]
    fn plain_member_without_either_bit_cannot_manage() {
        // SEND_MESSAGES (0x800) and VIEW_CHANNEL (0x400): an ordinary member,
        // not an officer — the escalation this check exists to close.
        assert!(!discord_guild(false, "3072").can_manage());
    }

    #[test]
    fn unparseable_permissions_field_reads_as_no_permissions() {
        assert!(!discord_guild(false, "").can_manage());
        assert!(!discord_guild(false, "not-a-number").can_manage());
    }

    fn role(
        id: &str,
        name: &str,
        priority: i32,
        discord_role_id: Option<&str>,
        is_default: bool,
    ) -> role::Model {
        role::Model {
            id: id.to_string(),
            name: name.to_string(),
            priority,
            discord_role_id: discord_role_id.map(str::to_string),
            is_default,
            is_staff: false,
            grants_staff: false,
        }
    }

    #[test]
    fn matches_discord_role_id_not_internal_id() {
        let roles = vec![
            role(
                "uuid-raid-lead",
                "Raid Lead",
                80,
                Some("999888777666555444"),
                false,
            ),
            role("222333444555666777", "User", 10, None, true),
        ];
        let (names, highest) = resolve_linked_roles(&["999888777666555444".into()], &roles);
        assert_eq!(names, vec!["Raid Lead".to_string()]);
        assert_eq!(highest, "Raid Lead");
    }

    #[test]
    fn ignores_internal_id_equal_to_a_discord_snowflake() {
        // After the column split, matching must not fall back to `roles.id`. A leftover snowflake
        // sitting in `id` with a cleared link must not grant that role.
        let roles = vec![
            role("999888777666555444", "Stale", 90, None, false),
            role("user-uuid", "Member", 10, None, true),
        ];
        let (names, highest) = resolve_linked_roles(&["999888777666555444".into()], &roles);
        assert_eq!(names, vec!["Member".to_string()]);
        assert_eq!(highest, "Member");
    }

    #[test]
    fn unions_linked_roles_highest_priority_first() {
        let roles = vec![
            role("a", "Officer", 50, Some("111"), false),
            role("b", "Raider", 30, Some("222"), false),
            role("c", "User", 10, None, true),
        ];
        let (names, highest) = resolve_linked_roles(&["222".into(), "111".into()], &roles);
        assert_eq!(names, vec!["Officer".to_string(), "Raider".to_string()]);
        assert_eq!(highest, "Officer");
    }

    #[test]
    fn unmatched_member_gets_default_role() {
        let roles = vec![
            role("a", "Admin", 100, Some("111"), false),
            role("b", "Recruit", 1, None, true),
        ];
        let (names, highest) = resolve_linked_roles(&["nope".into()], &roles);
        assert_eq!(names, vec!["Recruit".to_string()]);
        assert_eq!(highest, "Recruit");
    }

    #[test]
    fn login_refuses_a_confirmed_absent_member() {
        let roles = vec![role("a", "Officer", 50, Some("111"), false)];
        assert!(login_roles(&GuildMemberLookup::Absent, &roles).is_none());
    }

    #[test]
    fn login_resolves_present_roles_and_defaults_on_an_outage() {
        let roles = vec![
            role("a", "Officer", 50, Some("111"), false),
            role("b", "Recruit", 1, None, true),
        ];
        let (names, highest) =
            login_roles(&GuildMemberLookup::Present(vec!["111".to_string()]), &roles)
                .expect("present member logs in");
        assert_eq!(names, vec!["Officer".to_string()]);
        assert_eq!(highest, "Officer");

        // An outage does not invent privileges and does not lock anyone out.
        let (names, highest) =
            login_roles(&GuildMemberLookup::Unavailable, &roles).expect("outage still logs in");
        assert_eq!(names, vec!["Recruit".to_string()]);
        assert_eq!(highest, "Recruit");
    }

    #[test]
    fn an_unverified_email_is_dropped_from_the_profile() {
        let mut unverified = login_profile("1", "a", Some("a@example.com"), Some(false));
        drop_unverified_email(&mut unverified);
        assert_eq!(unverified.email, None);

        // No `verified` flag (email scope not granted, or an old cookie) reads as unverified.
        let mut unknown = login_profile("1", "a", Some("a@example.com"), None);
        drop_unverified_email(&mut unknown);
        assert_eq!(unknown.email, None);

        let mut verified = login_profile("1", "a", Some("a@example.com"), Some(true));
        drop_unverified_email(&mut verified);
        assert_eq!(verified.email.as_deref(), Some("a@example.com"));
    }

    #[test]
    fn a_profile_deserializes_without_the_verified_flag() {
        let profile: DiscordUserProfile = serde_json::from_str(
            r#"{"id":"1","username":"a","email":"a@example.com","avatar":null}"#,
        )
        .expect("discord /users/@me shape");
        assert_eq!(profile.verified, None);
    }

    #[test]
    fn confirmed_absence_drops_cached_officer_role() {
        let roles = vec![
            role("a", "Officer", 50, Some("111"), false),
            role("b", "Recruit", 1, None, true),
        ];
        let (names, highest) = roles_after_member_lookup(
            &GuildMemberLookup::Absent,
            &["Officer".to_string()],
            "Officer",
            &roles,
            false,
        );
        assert_eq!(names, vec!["Recruit".to_string()]);
        assert_eq!(highest, "Recruit");
    }

    #[test]
    fn discord_outage_keeps_cached_roles() {
        let (names, highest) = roles_after_member_lookup(
            &GuildMemberLookup::Unavailable,
            &["Officer".to_string()],
            "Officer",
            &[],
            false,
        );
        assert_eq!(names, vec!["Officer".to_string()]);
        assert_eq!(highest, "Officer");
    }

    #[test]
    fn present_roles_replace_a_revoked_cached_role() {
        let roles = vec![
            role("a", "Officer", 50, Some("111"), false),
            role("b", "Raider", 30, Some("222"), false),
        ];
        let (names, highest) = roles_after_member_lookup(
            &GuildMemberLookup::Present(vec!["222".to_string()]),
            &["Officer".to_string()],
            "Officer",
            &roles,
            false,
        );
        assert_eq!(names, vec!["Raider".to_string()]);
        assert_eq!(highest, "Raider");
    }

    #[test]
    fn unmatched_without_default_falls_back_to_user_name() {
        let roles = vec![role("a", "Admin", 100, Some("111"), false)];
        let (names, highest) = resolve_linked_roles(&[], &roles);
        assert_eq!(names, vec!["User".to_string()]);
        assert_eq!(highest, "User");
    }

    #[test]
    fn parses_and_deduplicates_bot_role_id_header() {
        assert_eq!(
            parse_bot_role_ids_header(" 111111111111111111,222222222222222222,111111111111111111 ")
                .unwrap(),
            vec![
                "111111111111111111".to_string(),
                "222222222222222222".to_string()
            ]
        );
        assert!(parse_bot_role_ids_header("").unwrap().is_empty());
        assert!(matches!(
            parse_bot_role_ids_header("111111111111111111,not-a-snowflake"),
            Err(AppError::Unauthorized(_))
        ));
    }

    fn choice(id: &str, name: &str) -> TenantChoice {
        TenantChoice {
            id: id.to_string(),
            name: name.to_string(),
            slug: id.to_string(),
            icon_hash: None,
            is_default: false,
        }
    }

    fn guild(id: &str, name: &str) -> DiscordGuild {
        DiscordGuild {
            id: id.to_string(),
            name: name.to_string(),
            icon: None,
            owner: false,
            permissions: String::new(),
        }
    }

    fn login_profile(
        id: &str,
        username: &str,
        email: Option<&str>,
        verified: Option<bool>,
    ) -> DiscordUserProfile {
        DiscordUserProfile {
            id: id.to_owned(),
            username: username.to_owned(),
            email: email.map(str::to_owned),
            verified,
            avatar: None,
            roles: vec!["Member".into()],
            highest_role: "Member".into(),
            user_id: 0,
            is_superadmin: false,
            is_platform_admin: false,
            is_tenant_owner: false,
            permissions: vec![],
            tenant_id: None,
            tenant_name: None,
            tenant_kind: None,
            features: vec![],
            brand: None,
        }
    }

    #[test]
    fn matching_tenants_zero_one_and_many() {
        let registered = vec![
            choice("111", "Alpha"),
            choice("222", "Beta"),
            choice("333", "Gamma"),
        ];
        assert!(matching_tenants(&[guild("999", "Other")], &registered).is_empty());
        let one = matching_tenants(&[guild("222", "Beta Discord")], &registered);
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].id, "222");
        assert_eq!(one[0].name, "Beta Discord");
        let many = matching_tenants(
            &[guild("111", "A"), guild("333", "C"), guild("999", "X")],
            &registered,
        );
        assert_eq!(
            many.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
            vec!["111", "333"]
        );
    }
}
