//! Albion service logic module.
//!
//! `AlbionService` wraps the generic Albion Online API client scoped to the operator's
//! configured guild. `AlbionLinkService` manages the `albion_links` table backing the
//! self-service Discord <-> Albion player link feature.

use super::client::{
    AlbionAlliance, AlbionApiClient, AlbionGuild, AlbionGuildMember, AlbionPlayer,
    AlbionPlayerSummary, AlbionRegion, AlbionSearchResult,
};
use crate::modules::albion::entities::{albion_link, albion_link_request};
use crate::errors::AppError;
use crate::modules::audit::service::AuditService;
use crate::pagination::{PaginatedData, PaginationParams};
use crate::ttl_cache::TtlCache;
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter,
    TransactionTrait,
};
use serde::Serialize;
use std::collections::HashSet;
use std::sync::LazyLock;
use std::time::Duration;
use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::is_combining_mark;
use utoipa::ToSchema;

/// How many configured-guild roster hits `GET /albion/search` keeps. Together with Albion's own
/// cap of 10 players per query this bounds the response at 30 players.
const MAX_GUILD_HITS: usize = 20;

/// How long a fetched guild roster is reused by the merged search. Short enough that a new
/// recruit shows up within a minute, long enough that typing in a picker does not hit Albion
/// once per keystroke.
const ROSTER_TTL: Duration = Duration::from_secs(60);

/// Process-wide roster cache, keyed by `(gameinfo base url, guild id)`. Services are built per
/// request, so the cache has to outlive them.
static ROSTER_CACHE: LazyLock<TtlCache<(String, String), Vec<AlbionGuildMember>>> =
    LazyLock::new(|| TtlCache::new(64));

/// Lower-cases `value`, strips diacritics and expands the few Latin letters that do not
/// decompose (`ø`, `ł`, `ß`, ...), so `Gálvdon`, `GALVDON` and `galvdon` compare equal.
#[must_use]
pub fn fold_name(value: &str) -> String {
    value
        .nfd()
        .filter(|c| !is_combining_mark(*c))
        .flat_map(char::to_lowercase)
        .flat_map(|c| match c {
            'ø' => vec!['o'],
            'ł' => vec!['l'],
            'đ' | 'ð' => vec!['d'],
            'ß' => vec!['s', 's'],
            'æ' => vec!['a', 'e'],
            'œ' => vec!['o', 'e'],
            'þ' => vec!['t', 'h'],
            other => vec![other],
        })
        .collect()
}

/// Builds the term sent to Albion: whitespace-collapsed and diacritic-free. Albion answers an
/// empty result for a query with leading/trailing spaces or accented letters, and `400` for an
/// empty one, so those inputs would otherwise look like "player not found".
#[must_use]
pub fn normalize_query(query: &str) -> String {
    fold_name(&query.split_whitespace().collect::<Vec<_>>().join(" "))
}

/// Service exposing Albion Online API operations, scoped to the operator's configured guild.
pub struct AlbionService {
    client: AlbionApiClient,
    guild_id: String,
}

impl AlbionService {
    #[must_use]
    pub fn new(region: AlbionRegion, guild_id: String) -> Self {
        Self {
            client: AlbionApiClient::new(region),
            guild_id,
        }
    }

    /// Builds a service around an arbitrary client (tests point it at a loopback stub).
    #[cfg(test)]
    #[must_use]
    pub fn with_client(client: AlbionApiClient, guild_id: String) -> Self {
        Self { client, guild_id }
    }

    /// The configured guild's roster, reused for [`ROSTER_TTL`] across requests.
    async fn cached_guild_roster(&self) -> Result<Vec<AlbionGuildMember>, AppError> {
        if self.guild_id.trim().is_empty() {
            return Ok(Vec::new());
        }
        let key = (self.client.base_url().to_owned(), self.guild_id.clone());
        ROSTER_CACHE
            .get_or_fetch(key, || async {
                let roster = self.client.get_guild_members(&self.guild_id).await?;
                Ok((roster, ROSTER_TTL))
            })
            .await
    }

    /// Fetches the full roster of the configured guild.
    pub async fn get_configured_guild_roster(&self) -> Result<Vec<AlbionGuildMember>, AppError> {
        self.client.get_guild_members(&self.guild_id).await
    }

    /// Fetches the configured guild's roster, filtered by an optional case-insensitive name
    /// substring and paginated locally (the upstream `/guilds/<id>/members` endpoint has no
    /// query/pagination support and guild rosters are small enough to filter in-memory).
    pub async fn search_configured_guild_roster(
        &self,
        query: Option<&str>,
        pagination: &PaginationParams,
    ) -> Result<PaginatedData<AlbionGuildMember>, AppError> {
        let mut roster = self.get_configured_guild_roster().await?;

        if let Some(q) = query.filter(|q| !q.trim().is_empty()) {
            let needle = normalize_query(q);
            roster.retain(|member| fold_name(&member.name).contains(&needle));
        }

        let total_items = roster.len() as u64;
        let limit = pagination.limit();
        let page = pagination.offset_page();
        let total_pages = if limit == 0 {
            0
        } else {
            total_items.div_ceil(limit)
        };

        let start = (page * limit) as usize;
        let items = roster
            .into_iter()
            .skip(start)
            .take(limit as usize)
            .collect();

        Ok(PaginatedData::new(
            items,
            total_items,
            total_pages,
            page + 1,
            limit,
        ))
    }

    /// Raw Albion global search with the query normalized (see [`normalize_query`]). Blank
    /// queries return an empty result without calling Albion.
    pub async fn search(&self, query: &str) -> Result<AlbionSearchResult, AppError> {
        let term = normalize_query(query);
        if term.is_empty() {
            return Ok(AlbionSearchResult::default());
        }
        self.client.search(&term).await
    }

    /// Player search that always covers every Albion player, not only the configured guild.
    ///
    /// Albion's global search returns at most 10 players per query, ordered by name, so a
    /// common prefix can hide the character being looked for. The configured guild's roster is
    /// therefore matched locally as well (case- and diacritic-insensitive, substring) and
    /// ranked first, followed by everything the global search returned. A player present in
    /// both sources appears once.
    ///
    /// If Albion's global search fails, the roster hits are still returned with
    /// `partial = true`; the call only errors when neither source answered.
    pub async fn search_all_players(&self, query: &str) -> Result<AlbionSearchResult, AppError> {
        let term = normalize_query(query);
        if term.is_empty() {
            return Ok(AlbionSearchResult::default());
        }
        let (upstream, roster) =
            tokio::join!(self.client.search(&term), self.cached_guild_roster());
        merge_search(&term, &self.guild_id, upstream, roster)
    }

    /// Resolves the character to link from an Albion player id or an in-game name.
    ///
    /// The configured guild's roster is tried first, but a character outside the guild is
    /// resolved through Albion itself (`/players/<id>` or the global search), so the result is
    /// never limited to guild members. An id always wins over a name.
    pub async fn resolve_link_target(
        &self,
        albion_player_id: Option<&str>,
        albion_player_name: Option<&str>,
    ) -> Result<AlbionGuildMember, AppError> {
        let roster = self.cached_guild_roster().await.unwrap_or_else(|error| {
            tracing::warn!(error = %error, "guild roster unavailable while resolving a link target");
            Vec::new()
        });
        match pick_roster_member(&roster, albion_player_id, albion_player_name) {
            Ok(member) => return Ok(member.clone()),
            Err(AppError::NotFound(_)) => {}
            Err(other) => return Err(other),
        }
        if let Some(id) = albion_player_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let player = self.client.get_player(id).await?;
            return Ok(AlbionGuildMember {
                id: player.id,
                name: player.name,
                guild_id: player.guild_id,
                guild_name: player.guild_name,
                kill_fame: player.kill_fame,
                death_fame: player.death_fame,
            });
        }
        let name = albion_player_name.unwrap_or_default();
        let found = self.search_all_players(name).await?;
        let hit = pick_exact_player(&found.players, name)?;
        Ok(AlbionGuildMember {
            id: hit.id.clone(),
            name: hit.name.clone(),
            guild_id: hit.guild_id.clone(),
            guild_name: hit.guild_name.clone(),
            kill_fame: hit.kill_fame,
            death_fame: hit.death_fame,
        })
    }

    /// Alliances inferred from guild search hits. The gameinfo search does not list alliances itself.
    pub async fn search_alliances(&self, query: &str) -> Result<Vec<(String, String)>, AppError> {
        let term = normalize_query(query);
        if term.is_empty() {
            return Ok(Vec::new());
        }
        let found = self.client.search(&term).await?;
        let mut alliances = std::collections::BTreeMap::<String, String>::new();
        for guild in found.guilds.into_iter().take(8) {
            if let (Some(id), Some(name)) = (guild.alliance_id, guild.alliance_name)
                && !id.is_empty()
            {
                alliances.entry(id).or_insert(name);
                continue;
            }
            if let Ok(detail) = self.client.get_guild(&guild.id).await
                && let Some(id) = detail.alliance_id.filter(|id| !id.is_empty())
            {
                let name = self
                    .client
                    .get_alliance(&id)
                    .await
                    .ok()
                    .and_then(|alliance| alliance.name)
                    .filter(|name| !name.is_empty())
                    .unwrap_or(id.clone());
                alliances.entry(id).or_insert(name);
            }
        }
        Ok(alliances.into_iter().collect())
    }

    pub async fn get_player(&self, id: &str) -> Result<AlbionPlayer, AppError> {
        self.client.get_player(id).await
    }

    pub async fn get_guild(&self, id: &str) -> Result<AlbionGuild, AppError> {
        self.client.get_guild(id).await
    }

    pub async fn get_alliance(&self, id: &str) -> Result<AlbionAlliance, AppError> {
        self.client.get_alliance(id).await
    }
}

/// Picks the search hit whose name equals `ign` (trimmed, case- and diacritic-insensitive).
///
/// Empty input is validation; zero hits is not-found. Albion names are not globally unique, so
/// when two or more players share the name the one flagged `in_guild` wins if it is the only
/// one; otherwise the call is a validation error so `/register` never guesses.
pub fn pick_exact_player<'a>(
    players: &'a [AlbionPlayerSummary],
    ign: &str,
) -> Result<&'a AlbionPlayerSummary, AppError> {
    let needle = ign.trim();
    if needle.is_empty() {
        return Err(AppError::Validation("ign is required".to_owned()));
    }
    let key = fold_name(needle);
    let matches: Vec<&AlbionPlayerSummary> = players
        .iter()
        .filter(|player| fold_name(&player.name) == key)
        .collect();
    match matches.as_slice() {
        [] => Err(AppError::NotFound(format!(
            "No Albion player named {needle:?}"
        ))),
        [player] => Ok(*player),
        _ => {
            let mut in_guild = matches.iter().filter(|player| player.in_guild);
            match (in_guild.next(), in_guild.next()) {
                (Some(player), None) => Ok(*player),
                _ => Err(AppError::Validation(format!(
                    "ign {needle:?} matches more than one player"
                ))),
            }
        }
    }
}

/// Merges Albion's global search with the configured guild's roster (see
/// [`AlbionService::search_all_players`]). `term` is already normalized.
fn merge_search(
    term: &str,
    guild_id: &str,
    upstream: Result<AlbionSearchResult, AppError>,
    roster: Result<Vec<AlbionGuildMember>, AppError>,
) -> Result<AlbionSearchResult, AppError> {
    let configured_guild = guild_id.trim();
    let roster = match roster {
        Ok(roster) => roster,
        Err(error) => {
            tracing::warn!(error = %error, "guild roster unavailable for player search");
            Vec::new()
        }
    };
    let (mut result, partial) = match upstream {
        Ok(result) => (result, false),
        Err(error) if roster.is_empty() => return Err(error),
        Err(error) => {
            tracing::warn!(error = %error, "Albion global search failed; answering from the guild roster");
            (AlbionSearchResult::default(), true)
        }
    };

    let mut guild_hits: Vec<(u8, AlbionPlayerSummary)> = roster
        .into_iter()
        .filter_map(|member| {
            let folded = fold_name(&member.name);
            let rank = if folded == term {
                0
            } else if folded.starts_with(term) {
                1
            } else if folded.contains(term) {
                2
            } else {
                return None;
            };
            Some((
                rank,
                AlbionPlayerSummary {
                    id: member.id,
                    name: member.name,
                    guild_id: member
                        .guild_id
                        .or_else(|| Some(configured_guild.to_owned())),
                    guild_name: member.guild_name,
                    kill_fame: member.kill_fame,
                    death_fame: member.death_fame,
                    in_guild: true,
                },
            ))
        })
        .collect();
    guild_hits.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then_with(|| fold_name(&a.1.name).cmp(&fold_name(&b.1.name)))
    });

    let mut seen = HashSet::new();
    let mut players = Vec::new();
    for (_, player) in guild_hits.into_iter().take(MAX_GUILD_HITS) {
        if seen.insert(player.id.clone()) {
            players.push(player);
        }
    }
    let mut others = Vec::new();
    for mut player in std::mem::take(&mut result.players) {
        if !seen.insert(player.id.clone()) {
            continue;
        }
        player.in_guild =
            !configured_guild.is_empty() && player.guild_id.as_deref() == Some(configured_guild);
        // Guild members that Albion's own result carried (but the roster missed, e.g. a stale
        // cache) still rank with the guild.
        if player.in_guild {
            players.push(player);
        } else {
            others.push(player);
        }
    }
    players.extend(others);
    result.players = players;
    result.partial = partial;
    Ok(result)
}

/// Picks a configured-guild roster row by Albion player id, or by unique exact name.
///
/// `albion_player_id` wins when present. Name matching is trimmed and case-insensitive;
/// zero hits are not-found and two or more exact hits are validation so create never guesses.
pub fn pick_roster_member<'a>(
    roster: &'a [AlbionGuildMember],
    albion_player_id: Option<&str>,
    albion_player_name: Option<&str>,
) -> Result<&'a AlbionGuildMember, AppError> {
    if let Some(id) = albion_player_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return roster.iter().find(|member| member.id == id).ok_or_else(|| {
            AppError::NotFound(format!("Albion character {id} is not in the guild roster"))
        });
    }
    let name = albion_player_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AppError::Validation("albion_player_id or albion_player_name is required".to_owned())
        })?;
    let key = fold_name(name);
    let matches: Vec<&AlbionGuildMember> = roster
        .iter()
        .filter(|member| fold_name(&member.name) == key)
        .collect();
    match matches.as_slice() {
        [] => Err(AppError::NotFound(format!(
            "No guild roster character named {name:?}"
        ))),
        [member] => Ok(*member),
        _ => Err(AppError::Validation(format!(
            "ign {name:?} matches more than one roster character"
        ))),
    }
}

/// The current Discord-to-Albion-player link status for a user, as returned by
/// `GET /albion/link/me` and `POST /albion/link`.
///
/// When `linked` is `false`, the other three fields are entirely absent from the JSON (not sent
/// as `null`) — check `linked` first before reading them.
#[derive(Debug, Serialize, Clone, ToSchema)]
#[schema(example = json!({
    "linked": true,
    "albion_player_id": "aPngkjfLT2CGiZoWXLr8UQ",
    "albion_player_name": "Kay",
    "linked_at": "2026-07-08T02:15:00.631376+00:00"
}))]
pub struct AlbionLinkStatus {
    /// Whether the caller's Discord account currently has an Albion character linked.
    pub linked: bool,
    /// Present only when `linked` is `true`.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(example = "aPngkjfLT2CGiZoWXLr8UQ")]
    pub albion_player_id: Option<String>,
    /// Present only when `linked` is `true`.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(example = "Kay")]
    pub albion_player_name: Option<String>,
    /// Present only when `linked` is `true`. RFC 3339 timestamp.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(example = "2026-07-08T02:15:00.631376+00:00")]
    pub linked_at: Option<String>,
    /// `true` while a self-service claim waits for an officer. A pending claim is **not** a link:
    /// `linked` stays `false` and nothing keyed on the character (guild role, loot, regears)
    /// applies until it is approved.
    pub pending: bool,
    /// Present only when `pending` is `true`: the character the account asked to link.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(example = "aPngkjfLT2CGiZoWXLr8UQ")]
    pub pending_albion_player_id: Option<String>,
    /// Present only when `pending` is `true`.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(example = "Kay")]
    pub pending_albion_player_name: Option<String>,
    /// Present only when `pending` is `true`. RFC 3339 timestamp.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(example = "2026-07-08T02:15:00.631376+00:00")]
    pub requested_at: Option<String>,
}

impl AlbionLinkStatus {
    /// Status of an account whose self-service claim is waiting for an officer.
    #[must_use]
    pub fn pending(request: albion_link_request::Model) -> Self {
        Self {
            pending: true,
            pending_albion_player_id: Some(request.albion_player_id),
            pending_albion_player_name: Some(request.albion_player_name),
            requested_at: Some(request.requested_at.to_rfc3339()),
            ..Self::from(None)
        }
    }
}

impl From<Option<albion_link::Model>> for AlbionLinkStatus {
    fn from(link: Option<albion_link::Model>) -> Self {
        match link {
            Some(link) => Self {
                linked: true,
                albion_player_id: Some(link.albion_player_id),
                albion_player_name: Some(link.albion_player_name),
                linked_at: Some(link.linked_at.to_rfc3339()),
                pending: false,
                pending_albion_player_id: None,
                pending_albion_player_name: None,
                requested_at: None,
            },
            None => Self {
                linked: false,
                albion_player_id: None,
                albion_player_name: None,
                linked_at: None,
                pending: false,
                pending_albion_player_id: None,
                pending_albion_player_name: None,
                requested_at: None,
            },
        }
    }
}

/// Who caused a link change and through which door, recorded in the audit log.
#[derive(Debug, Clone, Copy)]
pub struct LinkAudit<'a> {
    /// Internal `users.id` of the actor, `None` for system-driven copies (alliance fan-out).
    pub actor_user_id: Option<i64>,
    /// Entry point: `self` (`POST /albion/link`), `register` (`POST /albion/register`),
    /// `admin` (`/albion/link/users/{id}`), `provision` (`POST /api/users`), `fanout`.
    pub via: &'a str,
}

/// Audit action for a new link.
pub const AUDIT_LINK: &str = "ALBION_LINK";
/// Audit action for a removed link.
pub const AUDIT_UNLINK: &str = "ALBION_UNLINK";
/// Audit action for a manager replacing an existing claim (the target's old link, or another
/// account's claim on the character, was removed in the same transaction).
pub const AUDIT_RELINK: &str = "ALBION_RELINK";

/// Audit `entity_type` for every link event.
pub const AUDIT_ENTITY: &str = "ALBION_LINK";

/// Audit action for a self-service claim that now waits for an officer.
pub const AUDIT_REQUEST: &str = "ALBION_LINK_REQUEST";
/// Audit action for a claim its owner withdrew.
pub const AUDIT_REQUEST_CANCEL: &str = "ALBION_LINK_REQUEST_CANCEL";
/// Audit action for an officer rejecting a claim (or a claim superseded by another approval).
pub const AUDIT_REJECT: &str = "ALBION_LINK_REJECT";
/// Audit `entity_type` for the claim events above.
pub const AUDIT_REQUEST_ENTITY: &str = "ALBION_LINK_REQUEST";

fn request_snapshot(request: &albion_link_request::Model) -> serde_json::Value {
    serde_json::json!({
        "discord_id": request.discord_id,
        "albion_player_id": request.albion_player_id,
        "albion_player_name": request.albion_player_name,
        "albion_guild_name": request.albion_guild_name,
        "via": request.via,
        "requested_at": request.requested_at.to_rfc3339(),
    })
}

/// An account that just got a real link has nothing left to claim, so its open request (if any)
/// goes away in the same transaction.
async fn drop_open_request<C: sea_orm::ConnectionTrait>(
    conn: &C,
    discord_id: &str,
) -> Result<(), AppError> {
    albion_link_request::Entity::delete_many()
        .filter(albion_link_request::Column::DiscordId.eq(discord_id))
        .exec(conn)
        .await?;
    Ok(())
}

/// One open claim as an officer sees it.
#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct AlbionLinkRequestView {
    /// Request id, as used by the approve/reject endpoints.
    pub id: i64,
    /// Discord id of the account asking for the link.
    pub discord_id: String,
    /// Internal user id of that account, when it has a row in this tenant.
    pub user_id: Option<i64>,
    /// Username of that account, when it has a row in this tenant.
    pub username: Option<String>,
    /// The character being claimed.
    pub albion_player_id: String,
    /// The character's name when the claim was made.
    pub albion_player_name: String,
    /// The character's Albion guild when the claim was made, if it had one.
    pub albion_guild_name: Option<String>,
    /// RFC 3339 timestamp.
    pub requested_at: String,
    /// How many *other* open claims name the same character; the officer must pick the real owner.
    pub competing_requests: u32,
    /// `true` when the character is already linked to an account, so approving would fail with
    /// `409` until that link is removed.
    pub character_already_linked: bool,
}

fn link_snapshot(link: &albion_link::Model) -> serde_json::Value {
    serde_json::json!({
        "discord_id": link.discord_id,
        "albion_player_id": link.albion_player_id,
        "albion_player_name": link.albion_player_name,
    })
}

/// Result of [`AlbionLinkService::admin_link_user`].
#[derive(Debug)]
pub struct AdminLinkOutcome {
    /// The new link.
    pub link: albion_link::Model,
    /// Discord id of another account whose claim on the character was removed, if any. The
    /// caller should revoke that account's guild role (best effort).
    pub displaced_discord_id: Option<String>,
}

/// Service managing the `albion_links` table backing the Discord <-> Albion player link feature.
///
/// Ownership rules (Albion offers no way to prove who owns a character, so these are the
/// guards that need no external proof):
/// * both `discord_id` and `albion_player_id` are `UNIQUE` in the database;
/// * self-service linking answers `409` when the character is claimed by anyone else — it can
///   only be taken over by a user holding `roles.manage` via [`Self::admin_link_user`];
/// * every link, unlink and relink writes an `audit_logs` row in the same transaction.
pub struct AlbionLinkService;

impl AlbionLinkService {
    #[must_use]
    pub fn new() -> Self {
        Self
    }

    /// Fetches the link (if any) for the given Discord user.
    pub async fn get_link_for_discord_user(
        &self,
        db: &DatabaseConnection,
        discord_id: &str,
    ) -> Result<Option<albion_link::Model>, AppError> {
        Ok(albion_link::Entity::find()
            .filter(albion_link::Column::DiscordId.eq(discord_id))
            .one(db)
            .await?)
    }

    /// Links a Discord account to an Albion player and records `ALBION_LINK` in the audit log.
    ///
    /// # Errors
    ///
    /// Returns `AppError::Conflict` if the Discord account already has a link, or if the
    /// Albion player is already claimed by another Discord account (also when a concurrent
    /// request wins the race: the database unique constraints surface as `409` too).
    pub async fn create_link(
        &self,
        db: &DatabaseConnection,
        discord_id: &str,
        albion_player_id: &str,
        albion_player_name: &str,
        audit: LinkAudit<'_>,
    ) -> Result<albion_link::Model, AppError> {
        let txn = db.begin().await?;
        if albion_link::Entity::find()
            .filter(albion_link::Column::DiscordId.eq(discord_id))
            .one(&txn)
            .await?
            .is_some()
        {
            return Err(AppError::Conflict(
                "Your Discord account is already linked to an Albion player".to_string(),
            ));
        }

        if albion_link::Entity::find()
            .filter(albion_link::Column::AlbionPlayerId.eq(albion_player_id))
            .one(&txn)
            .await?
            .is_some()
        {
            return Err(AppError::Conflict(
                "This Albion player is already linked to another Discord account".to_string(),
            ));
        }

        let active = albion_link::ActiveModel {
            discord_id: Set(discord_id.to_string()),
            albion_player_id: Set(albion_player_id.to_string()),
            albion_player_name: Set(albion_player_name.to_string()),
            linked_at: Set(chrono::Utc::now().into()),
            ..Default::default()
        };

        let inserted = active.insert(&txn).await?;
        drop_open_request(&txn, &inserted.discord_id).await?;
        AuditService::record_in(
            &txn,
            AUDIT_LINK,
            Some(AUDIT_ENTITY),
            Some(inserted.id),
            audit.actor_user_id,
            Some(serde_json::json!({ "via": audit.via, "link": link_snapshot(&inserted) })),
        )
        .await?;
        txn.commit().await?;
        Ok(inserted)
    }

    /// Removes the link for the given Discord account and records `ALBION_UNLINK`.
    ///
    /// # Errors
    ///
    /// Returns `AppError::NotFound` if no link exists for this Discord account.
    pub async fn delete_link(
        &self,
        db: &DatabaseConnection,
        discord_id: &str,
        audit: LinkAudit<'_>,
    ) -> Result<(), AppError> {
        let txn = db.begin().await?;
        let existing = albion_link::Entity::find()
            .filter(albion_link::Column::DiscordId.eq(discord_id))
            .one(&txn)
            .await?
            .ok_or_else(|| {
                AppError::NotFound("No Albion link exists for this account".to_string())
            })?;

        albion_link::Entity::delete_by_id(existing.id)
            .exec(&txn)
            .await?;
        AuditService::record_in(
            &txn,
            AUDIT_UNLINK,
            Some(AUDIT_ENTITY),
            Some(existing.id),
            audit.actor_user_id,
            Some(serde_json::json!({ "via": audit.via, "link": link_snapshot(&existing) })),
        )
        .await?;
        txn.commit().await?;
        Ok(())
    }

    /// Manager helper to link or re-link any user to an Albion player. The caller must already
    /// have checked `roles.manage`.
    ///
    /// Records `ALBION_LINK`, or `ALBION_RELINK` (with both the replaced links) when it had to
    /// remove the target's previous link or another account's claim on the character.
    pub async fn admin_link_user(
        &self,
        db: &DatabaseConnection,
        user_id: i64,
        albion_player_id: &str,
        albion_player_name: &str,
        actor_user_id: i64,
    ) -> Result<AdminLinkOutcome, AppError> {
        let user = crate::modules::users::entities::Entity::find_by_id(user_id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("User {user_id} not found")))?;

        let discord_id = user.discord_id.ok_or_else(|| {
            AppError::Validation(
                "User has no associated Discord ID and cannot be linked to an Albion character"
                    .to_string(),
            )
        })?;

        let txn = db.begin().await?;

        // If the user already has a link, delete it to allow re-assignment
        let previous = albion_link::Entity::find()
            .filter(albion_link::Column::DiscordId.eq(&discord_id))
            .one(&txn)
            .await?;
        if let Some(existing) = &previous {
            albion_link::Entity::delete_by_id(existing.id)
                .exec(&txn)
                .await?;
        }

        // If another account was linked to this character, remove that link as well
        let displaced = albion_link::Entity::find()
            .filter(albion_link::Column::AlbionPlayerId.eq(albion_player_id))
            .one(&txn)
            .await?;
        if let Some(other) = &displaced {
            albion_link::Entity::delete_by_id(other.id)
                .exec(&txn)
                .await?;
        }

        let active = albion_link::ActiveModel {
            discord_id: Set(discord_id),
            albion_player_id: Set(albion_player_id.to_string()),
            albion_player_name: Set(albion_player_name.to_string()),
            linked_at: Set(chrono::Utc::now().into()),
            ..Default::default()
        };

        let inserted = active.insert(&txn).await?;
        drop_open_request(&txn, &inserted.discord_id).await?;
        let action = if previous.is_some() || displaced.is_some() {
            AUDIT_RELINK
        } else {
            AUDIT_LINK
        };
        AuditService::record_in(
            &txn,
            action,
            Some(AUDIT_ENTITY),
            Some(inserted.id),
            Some(actor_user_id),
            Some(serde_json::json!({
                "via": "admin",
                "target_user_id": user_id,
                "link": link_snapshot(&inserted),
                "replaced_target_link": previous.as_ref().map(link_snapshot),
                "displaced_other_link": displaced.as_ref().map(link_snapshot),
            })),
        )
        .await?;
        txn.commit().await?;
        let displaced_discord_id = displaced
            .map(|other| other.discord_id)
            .filter(|other| *other != inserted.discord_id);
        Ok(AdminLinkOutcome {
            link: inserted,
            displaced_discord_id,
        })
    }

    /// Manager helper to unlink any user from their Albion player (caller checked
    /// `roles.manage`); records `ALBION_UNLINK`.
    ///
    /// Returns the unlinked user's Discord ID when a link was actually removed, so the caller can
    /// best-effort revoke the configured Discord guild role — `None` when the user has no Discord
    /// ID or already had no active link.
    pub async fn admin_unlink_user(
        &self,
        db: &DatabaseConnection,
        user_id: i64,
        actor_user_id: i64,
    ) -> Result<Option<String>, AppError> {
        let user = crate::modules::users::entities::Entity::find_by_id(user_id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("User {user_id} not found")))?;

        let Some(discord_id) = user.discord_id else {
            return Ok(None);
        };

        let txn = db.begin().await?;
        let existing = albion_link::Entity::find()
            .filter(albion_link::Column::DiscordId.eq(&discord_id))
            .one(&txn)
            .await?;
        let Some(existing) = existing else {
            return Ok(None);
        };
        albion_link::Entity::delete_by_id(existing.id)
            .exec(&txn)
            .await?;
        AuditService::record_in(
            &txn,
            AUDIT_UNLINK,
            Some(AUDIT_ENTITY),
            Some(existing.id),
            Some(actor_user_id),
            Some(serde_json::json!({
                "via": "admin",
                "target_user_id": user_id,
                "link": link_snapshot(&existing),
            })),
        )
        .await?;
        txn.commit().await?;
        Ok(Some(discord_id))
    }
}

impl AlbionLinkService {
    /// Same as [`Self::status_for_discord_user`] for an internal user id.
    pub async fn status_for_user_id(
        &self,
        db: &DatabaseConnection,
        user_id: i64,
    ) -> Result<AlbionLinkStatus, AppError> {
        let user = crate::modules::users::entities::Entity::find_by_id(user_id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("User {user_id} not found")))?;
        match user.discord_id {
            Some(discord_id) => self.status_for_discord_user(db, &discord_id).await,
            None => Ok(AlbionLinkStatus::from(None)),
        }
    }

    /// Fetches the open claim (if any) for the given Discord user.
    pub async fn get_request_for_discord_user(
        &self,
        db: &DatabaseConnection,
        discord_id: &str,
    ) -> Result<Option<albion_link_request::Model>, AppError> {
        Ok(albion_link_request::Entity::find()
            .filter(albion_link_request::Column::DiscordId.eq(discord_id))
            .one(db)
            .await?)
    }

    /// Link plus open claim for one account, as the status endpoints render them. A link wins:
    /// an account with a link has nothing left to claim.
    pub async fn status_for_discord_user(
        &self,
        db: &DatabaseConnection,
        discord_id: &str,
    ) -> Result<AlbionLinkStatus, AppError> {
        if let Some(link) = self.get_link_for_discord_user(db, discord_id).await? {
            return Ok(AlbionLinkStatus::from(Some(link)));
        }
        Ok(self
            .get_request_for_discord_user(db, discord_id)
            .await?
            .map_or_else(|| AlbionLinkStatus::from(None), AlbionLinkStatus::pending))
    }

    /// Records a claim on an Albion character that an officer still has to approve. Asking
    /// again replaces the account's previous claim. Nothing is linked: no `albion_links` row,
    /// and so no guild role, nickname or alliance copy.
    ///
    /// # Errors
    ///
    /// Returns `AppError::Conflict` if the account already has a link, or if the character is
    /// already linked to an account.
    pub async fn request_link(
        &self,
        db: &DatabaseConnection,
        discord_id: &str,
        albion_player_id: &str,
        albion_player_name: &str,
        albion_guild_name: Option<&str>,
        audit: LinkAudit<'_>,
    ) -> Result<albion_link_request::Model, AppError> {
        let txn = db.begin().await?;
        if albion_link::Entity::find()
            .filter(albion_link::Column::DiscordId.eq(discord_id))
            .one(&txn)
            .await?
            .is_some()
        {
            return Err(AppError::Conflict(
                "Your Discord account is already linked to an Albion player".to_string(),
            ));
        }
        if albion_link::Entity::find()
            .filter(albion_link::Column::AlbionPlayerId.eq(albion_player_id))
            .one(&txn)
            .await?
            .is_some()
        {
            return Err(AppError::Conflict(
                "This Albion player is already linked to another Discord account".to_string(),
            ));
        }

        let replaced = albion_link_request::Entity::find()
            .filter(albion_link_request::Column::DiscordId.eq(discord_id))
            .one(&txn)
            .await?;
        if let Some(previous) = &replaced {
            albion_link_request::Entity::delete_by_id(previous.id)
                .exec(&txn)
                .await?;
        }
        let saved = albion_link_request::ActiveModel {
            discord_id: Set(discord_id.to_string()),
            albion_player_id: Set(albion_player_id.to_string()),
            albion_player_name: Set(albion_player_name.to_string()),
            albion_guild_name: Set(albion_guild_name.map(ToOwned::to_owned)),
            via: Set(audit.via.to_string()),
            requested_at: Set(chrono::Utc::now().into()),
            ..Default::default()
        }
        .insert(&txn)
        .await?;
        AuditService::record_in(
            &txn,
            AUDIT_REQUEST,
            Some(AUDIT_REQUEST_ENTITY),
            Some(saved.id),
            audit.actor_user_id,
            Some(serde_json::json!({
                "via": audit.via,
                "request": request_snapshot(&saved),
                "replaced_request": replaced.as_ref().map(request_snapshot),
            })),
        )
        .await?;
        txn.commit().await?;
        Ok(saved)
    }

    /// Withdraws the account's own open claim.
    ///
    /// # Errors
    ///
    /// Returns `AppError::NotFound` if the account has no open claim.
    pub async fn cancel_request(
        &self,
        db: &DatabaseConnection,
        discord_id: &str,
        audit: LinkAudit<'_>,
    ) -> Result<(), AppError> {
        let txn = db.begin().await?;
        let existing = albion_link_request::Entity::find()
            .filter(albion_link_request::Column::DiscordId.eq(discord_id))
            .one(&txn)
            .await?
            .ok_or_else(|| {
                AppError::NotFound("No Albion link request exists for this account".to_string())
            })?;
        albion_link_request::Entity::delete_by_id(existing.id)
            .exec(&txn)
            .await?;
        AuditService::record_in(
            &txn,
            AUDIT_REQUEST_CANCEL,
            Some(AUDIT_REQUEST_ENTITY),
            Some(existing.id),
            audit.actor_user_id,
            Some(serde_json::json!({ "via": audit.via, "request": request_snapshot(&existing) })),
        )
        .await?;
        txn.commit().await?;
        Ok(())
    }

    /// Every open claim, oldest first, with the requester and the clashes an officer must
    /// settle before approving.
    pub async fn list_requests(
        &self,
        db: &DatabaseConnection,
    ) -> Result<Vec<AlbionLinkRequestView>, AppError> {
        use sea_orm::QueryOrder;

        let requests = albion_link_request::Entity::find()
            .order_by_asc(albion_link_request::Column::RequestedAt)
            .order_by_asc(albion_link_request::Column::Id)
            .all(db)
            .await?;
        if requests.is_empty() {
            return Ok(Vec::new());
        }

        let discord_ids: Vec<String> = requests.iter().map(|r| r.discord_id.clone()).collect();
        let users: std::collections::HashMap<String, crate::modules::users::entities::Model> =
            crate::modules::users::entities::Entity::find()
                .filter(crate::modules::users::entities::Column::DiscordId.is_in(discord_ids))
                .all(db)
                .await?
                .into_iter()
                .filter_map(|user| user.discord_id.clone().map(|id| (id, user)))
                .collect();

        let player_ids: Vec<String> = requests
            .iter()
            .map(|r| r.albion_player_id.clone())
            .collect();
        let linked: HashSet<String> = albion_link::Entity::find()
            .filter(albion_link::Column::AlbionPlayerId.is_in(player_ids))
            .all(db)
            .await?
            .into_iter()
            .map(|link| link.albion_player_id)
            .collect();

        let mut per_player: std::collections::HashMap<&str, u32> = std::collections::HashMap::new();
        for request in &requests {
            *per_player.entry(&request.albion_player_id).or_default() += 1;
        }

        Ok(requests
            .iter()
            .map(|request| {
                let user = users.get(&request.discord_id);
                AlbionLinkRequestView {
                    id: request.id,
                    discord_id: request.discord_id.clone(),
                    user_id: user.map(|u| u.id),
                    username: user.map(|u| u.username.clone()),
                    albion_player_id: request.albion_player_id.clone(),
                    albion_player_name: request.albion_player_name.clone(),
                    albion_guild_name: request.albion_guild_name.clone(),
                    requested_at: request.requested_at.to_rfc3339(),
                    competing_requests: per_player
                        .get(request.albion_player_id.as_str())
                        .copied()
                        .unwrap_or(1)
                        .saturating_sub(1),
                    character_already_linked: linked.contains(&request.albion_player_id),
                }
            })
            .collect())
    }

    /// Fetches one open claim.
    pub async fn get_request(
        &self,
        db: &DatabaseConnection,
        request_id: i64,
    ) -> Result<albion_link_request::Model, AppError> {
        albion_link_request::Entity::find_by_id(request_id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Link request {request_id} not found")))
    }

    /// Turns a claim into a real link. The caller must already have checked `roles.manage`.
    ///
    /// The claim is consumed, and every competing claim on the same character is dropped (each
    /// audited as superseded). Never displaces an existing link: removing someone's link is a
    /// separate, deliberate admin action.
    ///
    /// # Errors
    ///
    /// * `AppError::NotFound` if the claim is gone (already approved, rejected or withdrawn).
    /// * `AppError::Conflict` if the account or the character got linked in the meantime.
    pub async fn approve_request(
        &self,
        db: &DatabaseConnection,
        request_id: i64,
        actor_user_id: i64,
    ) -> Result<albion_link::Model, AppError> {
        let txn = db.begin().await?;
        let request = albion_link_request::Entity::find_by_id(request_id)
            .one(&txn)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Link request {request_id} not found")))?;

        if albion_link::Entity::find()
            .filter(albion_link::Column::DiscordId.eq(&request.discord_id))
            .one(&txn)
            .await?
            .is_some()
        {
            return Err(AppError::Conflict(
                "This account is already linked to an Albion player".to_string(),
            ));
        }
        if albion_link::Entity::find()
            .filter(albion_link::Column::AlbionPlayerId.eq(&request.albion_player_id))
            .one(&txn)
            .await?
            .is_some()
        {
            return Err(AppError::Conflict(
                "This Albion player is already linked to another Discord account; unlink it first"
                    .to_string(),
            ));
        }

        let link = albion_link::ActiveModel {
            discord_id: Set(request.discord_id.clone()),
            albion_player_id: Set(request.albion_player_id.clone()),
            albion_player_name: Set(request.albion_player_name.clone()),
            linked_at: Set(chrono::Utc::now().into()),
            ..Default::default()
        }
        .insert(&txn)
        .await?;
        albion_link_request::Entity::delete_by_id(request.id)
            .exec(&txn)
            .await?;

        let competing = albion_link_request::Entity::find()
            .filter(albion_link_request::Column::AlbionPlayerId.eq(&request.albion_player_id))
            .all(&txn)
            .await?;
        for other in &competing {
            albion_link_request::Entity::delete_by_id(other.id)
                .exec(&txn)
                .await?;
            AuditService::record_in(
                &txn,
                AUDIT_REJECT,
                Some(AUDIT_REQUEST_ENTITY),
                Some(other.id),
                Some(actor_user_id),
                Some(serde_json::json!({
                    "reason": "superseded",
                    "approved_request_id": request.id,
                    "request": request_snapshot(other),
                })),
            )
            .await?;
        }

        AuditService::record_in(
            &txn,
            AUDIT_LINK,
            Some(AUDIT_ENTITY),
            Some(link.id),
            Some(actor_user_id),
            Some(serde_json::json!({
                "via": "approval",
                "request": request_snapshot(&request),
                "link": link_snapshot(&link),
            })),
        )
        .await?;
        txn.commit().await?;
        Ok(link)
    }

    /// Declines a claim. The caller must already have checked `roles.manage`.
    ///
    /// # Errors
    ///
    /// Returns `AppError::NotFound` if the claim is gone.
    pub async fn reject_request(
        &self,
        db: &DatabaseConnection,
        request_id: i64,
        actor_user_id: i64,
    ) -> Result<albion_link_request::Model, AppError> {
        let txn = db.begin().await?;
        let request = albion_link_request::Entity::find_by_id(request_id)
            .one(&txn)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Link request {request_id} not found")))?;
        albion_link_request::Entity::delete_by_id(request.id)
            .exec(&txn)
            .await?;
        AuditService::record_in(
            &txn,
            AUDIT_REJECT,
            Some(AUDIT_REQUEST_ENTITY),
            Some(request.id),
            Some(actor_user_id),
            Some(
                serde_json::json!({ "reason": "rejected", "request": request_snapshot(&request) }),
            ),
        )
        .await?;
        txn.commit().await?;
        Ok(request)
    }
}

impl Default for AlbionLinkService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SELF_AUDIT: LinkAudit<'static> = LinkAudit {
        actor_user_id: None,
        via: "self",
    };

    async fn setup_db() -> DatabaseConnection {
        crate::testkit::migrated_sqlite().await
    }

    #[tokio::test]
    async fn test_create_and_delete_link() {
        let db = setup_db().await;
        let service = AlbionLinkService::new();

        assert!(
            service
                .get_link_for_discord_user(&db, "discord_a")
                .await
                .unwrap()
                .is_none()
        );

        let link = service
            .create_link(&db, "discord_a", "player_1", "PlayerOne", SELF_AUDIT)
            .await
            .expect("Failed to create link");
        assert_eq!(link.albion_player_id, "player_1");

        let fetched = service
            .get_link_for_discord_user(&db, "discord_a")
            .await
            .unwrap();
        assert!(fetched.is_some());

        service
            .delete_link(&db, "discord_a", SELF_AUDIT)
            .await
            .expect("Failed to delete link");
        assert!(
            service
                .get_link_for_discord_user(&db, "discord_a")
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn test_cannot_link_same_discord_user_twice() {
        let db = setup_db().await;
        let service = AlbionLinkService::new();

        service
            .create_link(&db, "discord_a", "player_1", "PlayerOne", SELF_AUDIT)
            .await
            .unwrap();

        let result = service
            .create_link(&db, "discord_a", "player_2", "PlayerTwo", SELF_AUDIT)
            .await;
        assert!(matches!(result, Err(AppError::Conflict(_))));
    }

    #[tokio::test]
    async fn test_cannot_link_same_player_to_two_discord_users() {
        let db = setup_db().await;
        let service = AlbionLinkService::new();

        service
            .create_link(&db, "discord_a", "player_1", "PlayerOne", SELF_AUDIT)
            .await
            .unwrap();

        let result = service
            .create_link(&db, "discord_b", "player_1", "PlayerOne", SELF_AUDIT)
            .await;
        assert!(matches!(result, Err(AppError::Conflict(_))));
    }

    #[tokio::test]
    async fn test_delete_link_without_existing_link_fails() {
        let db = setup_db().await;
        let service = AlbionLinkService::new();

        let result = service.delete_link(&db, "discord_a", SELF_AUDIT).await;
        assert!(matches!(result, Err(AppError::NotFound(_))));
    }

    fn summary(id: &str, name: &str) -> AlbionPlayerSummary {
        AlbionPlayerSummary {
            id: id.to_owned(),
            name: name.to_owned(),
            guild_id: None,
            guild_name: None,
            kill_fame: None,
            death_fame: None,
            in_guild: false,
        }
    }

    #[test]
    fn pick_exact_player_requires_ign() {
        let err = pick_exact_player(&[], "  ").expect_err("blank");
        assert!(matches!(err, AppError::Validation(msg) if msg == "ign is required"));
    }

    #[test]
    fn pick_exact_player_unique_case_insensitive_hit() {
        let players = [summary("1", "Kay"), summary("2", "Kaylen")];
        let hit = pick_exact_player(&players, " kay ").expect("unique");
        assert_eq!(hit.id, "1");
        assert_eq!(hit.name, "Kay");
    }

    #[test]
    fn pick_exact_player_zero_hits_is_not_found() {
        let players = [summary("1", "Kaylen")];
        let err = pick_exact_player(&players, "Kay").expect_err("missing");
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[test]
    fn pick_exact_player_ambiguous_exact_hits() {
        let players = [summary("1", "Kay"), summary("2", "kay")];
        let err = pick_exact_player(&players, "Kay").expect_err("ambiguous");
        assert!(matches!(err, AppError::Validation(msg) if msg.contains("more than one")));
    }

    fn roster_member(id: &str, name: &str) -> AlbionGuildMember {
        AlbionGuildMember {
            id: id.to_owned(),
            name: name.to_owned(),
            guild_id: None,
            guild_name: None,
            kill_fame: None,
            death_fame: None,
        }
    }

    #[test]
    fn pick_roster_member_by_id_ignores_name() {
        let roster = [roster_member("1", "Kay"), roster_member("2", "Other")];
        let hit = pick_roster_member(&roster, Some("2"), Some("Kay")).expect("id");
        assert_eq!(hit.id, "2");
    }

    #[test]
    fn pick_roster_member_by_unique_name() {
        let roster = [roster_member("1", "Kay"), roster_member("2", "Kaylen")];
        let hit = pick_roster_member(&roster, None, Some(" kay ")).expect("name");
        assert_eq!(hit.id, "1");
    }

    #[test]
    fn pick_roster_member_missing_id_is_not_found() {
        let roster = [roster_member("1", "Kay")];
        let err = pick_roster_member(&roster, Some("missing"), None).expect_err("missing");
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[test]
    fn pick_roster_member_requires_id_or_name() {
        let err = pick_roster_member(&[], None, Some("  ")).expect_err("blank");
        assert!(matches!(err, AppError::Validation(_)));
    }

    // ------------------------------------------------------------------ name folding

    #[test]
    fn fold_name_ignores_case_and_diacritics() {
        assert_eq!(fold_name("Gálvdon"), "galvdon");
        assert_eq!(fold_name("GALVDON"), "galvdon");
        assert_eq!(fold_name("Søren"), "soren");
        assert_eq!(fold_name("Łukasz"), "lukasz");
        assert_eq!(fold_name("Straße"), "strasse");
    }

    #[test]
    fn normalize_query_trims_collapses_and_folds() {
        assert_eq!(normalize_query("  Gálvdon "), "galvdon");
        assert_eq!(normalize_query("a   b"), "a b");
        assert_eq!(normalize_query("   "), "");
    }

    #[test]
    fn pick_exact_player_matches_across_diacritics() {
        let players = [summary("1", "Gálvdon")];
        assert_eq!(pick_exact_player(&players, "galvdon").expect("hit").id, "1");
    }

    #[test]
    fn pick_exact_player_prefers_the_single_guild_member_among_namesakes() {
        let mut guild = summary("1", "Galvdon");
        guild.in_guild = true;
        let players = [summary("2", "Galvdon"), guild];
        assert_eq!(
            pick_exact_player(&players, "Galvdon").expect("guild").id,
            "1"
        );
    }

    #[test]
    fn pick_exact_player_rejects_namesakes_when_the_guild_cannot_decide() {
        let players = [summary("1", "Galvdon"), summary("2", "Galvdon")];
        assert!(matches!(
            pick_exact_player(&players, "Galvdon"),
            Err(AppError::Validation(_))
        ));
        let mut a = summary("1", "Galvdon");
        let mut b = summary("2", "Galvdon");
        a.in_guild = true;
        b.in_guild = true;
        assert!(matches!(
            pick_exact_player(&[a, b], "Galvdon"),
            Err(AppError::Validation(_))
        ));
    }

    // ------------------------------------------------------------------ merged search (pure)

    fn upstream_ok(players: Vec<AlbionPlayerSummary>) -> Result<AlbionSearchResult, AppError> {
        Ok(AlbionSearchResult {
            guilds: Vec::new(),
            players,
            partial: false,
        })
    }

    fn upstream_down() -> Result<AlbionSearchResult, AppError> {
        Err(AppError::UpstreamService("down".to_owned()))
    }

    fn ids(result: &AlbionSearchResult) -> Vec<&str> {
        result.players.iter().map(|p| p.id.as_str()).collect()
    }

    #[test]
    fn merge_ranks_guild_members_first_and_keeps_everyone_else() {
        let roster = vec![
            roster_member("g2", "Kayden"),
            roster_member("g1", "Kay"),
            roster_member("g3", "Unrelated"),
        ];
        let outsider = summary("o1", "Kayla");
        let result =
            merge_search("kay", "guild", upstream_ok(vec![outsider]), Ok(roster)).expect("merged");
        // Exact guild match, prefix guild match, then the non-guild player.
        assert_eq!(ids(&result), ["g1", "g2", "o1"]);
        assert!(result.players[0].in_guild && result.players[1].in_guild);
        assert!(!result.players[2].in_guild);
        assert!(!result.partial);
    }

    #[test]
    fn merge_matches_roster_by_substring_and_diacritics() {
        let roster = vec![roster_member("g1", "xGálvdonx")];
        let result =
            merge_search("galvdon", "guild", upstream_ok(vec![]), Ok(roster)).expect("merged");
        assert_eq!(ids(&result), ["g1"]);
    }

    #[test]
    fn merge_dedupes_a_player_present_in_both_sources() {
        let roster = vec![roster_member("p1", "Kay")];
        let mut upstream = summary("p1", "Kay");
        upstream.guild_id = Some("guild".to_owned());
        let result =
            merge_search("kay", "guild", upstream_ok(vec![upstream]), Ok(roster)).expect("merged");
        assert_eq!(ids(&result), ["p1"]);
        assert!(result.players[0].in_guild);
    }

    #[test]
    fn merge_flags_upstream_guild_members_missing_from_a_stale_roster() {
        let mut upstream_member = summary("p2", "Kay2");
        upstream_member.guild_id = Some("guild".to_owned());
        let outsider = summary("o1", "Kay1");
        let result = merge_search(
            "kay",
            "guild",
            upstream_ok(vec![outsider, upstream_member]),
            Ok(vec![]),
        )
        .expect("merged");
        assert_eq!(ids(&result), ["p2", "o1"]);
        assert!(result.players[0].in_guild);
    }

    #[test]
    fn merge_degrades_to_the_roster_when_albion_search_is_down() {
        let roster = vec![roster_member("g1", "Kay")];
        let result = merge_search("kay", "guild", upstream_down(), Ok(roster)).expect("degraded");
        assert_eq!(ids(&result), ["g1"]);
        assert!(result.partial);
    }

    #[test]
    fn merge_survives_a_failing_roster() {
        let result = merge_search(
            "kay",
            "guild",
            upstream_ok(vec![summary("o1", "Kay")]),
            Err(AppError::UpstreamService("roster down".to_owned())),
        )
        .expect("upstream only");
        assert_eq!(ids(&result), ["o1"]);
        assert!(!result.partial);
    }

    #[test]
    fn merge_errors_only_when_nothing_answered() {
        let err = merge_search(
            "kay",
            "guild",
            upstream_down(),
            Err(AppError::UpstreamService("roster down".to_owned())),
        )
        .expect_err("both down");
        assert!(matches!(err, AppError::UpstreamService(_)));
        // A healthy but empty roster plus a dead search is also a failure, not "no players".
        let err = merge_search("kay", "guild", upstream_down(), Ok(vec![])).expect_err("down");
        assert!(matches!(err, AppError::UpstreamService(_)));
    }

    #[test]
    fn merge_caps_guild_hits_so_global_results_survive() {
        let roster: Vec<_> = (0..40)
            .map(|n| roster_member(&format!("g{n:02}"), &format!("Kay{n:02}")))
            .collect();
        let result = merge_search(
            "kay",
            "guild",
            upstream_ok(vec![summary("o1", "Kay")]),
            Ok(roster),
        )
        .expect("merged");
        assert_eq!(result.players.len(), MAX_GUILD_HITS + 1);
        assert_eq!(result.players.last().map(|p| p.id.as_str()), Some("o1"));
    }

    // ------------------------------------------------------------------ against a stub gameinfo

    use axum::{Json, Router, extract::Path, extract::State, http::StatusCode, routing::get};
    use serde_json::{Value, json};
    use std::sync::{Arc, Mutex};

    #[derive(Clone)]
    struct Stub {
        search: Arc<Mutex<(u16, Value)>>,
        members: Arc<Mutex<(u16, Value)>>,
        players: Arc<Mutex<Vec<Value>>>,
        requests: Arc<Mutex<Vec<String>>>,
    }

    impl Stub {
        fn requests(&self) -> Vec<String> {
            self.requests.lock().unwrap().clone()
        }
    }

    async fn serve_stub(
        search: (u16, Value),
        members: (u16, Value),
        players: Vec<Value>,
    ) -> (String, Stub) {
        let stub = Stub {
            search: Arc::new(Mutex::new(search)),
            members: Arc::new(Mutex::new(members)),
            players: Arc::new(Mutex::new(players)),
            requests: Arc::new(Mutex::new(Vec::new())),
        };
        async fn search_h(
            State(s): State<Stub>,
            axum::extract::RawQuery(q): axum::extract::RawQuery,
        ) -> (StatusCode, Json<Value>) {
            s.requests
                .lock()
                .unwrap()
                .push(format!("search?{}", q.unwrap_or_default()));
            let (code, body) = s.search.lock().unwrap().clone();
            (StatusCode::from_u16(code).unwrap(), Json(body))
        }
        async fn members_h(
            State(s): State<Stub>,
            Path(id): Path<String>,
        ) -> (StatusCode, Json<Value>) {
            s.requests.lock().unwrap().push(format!("members/{id}"));
            let (code, body) = s.members.lock().unwrap().clone();
            (StatusCode::from_u16(code).unwrap(), Json(body))
        }
        async fn player_h(
            State(s): State<Stub>,
            Path(id): Path<String>,
        ) -> (StatusCode, Json<Value>) {
            s.requests.lock().unwrap().push(format!("players/{id}"));
            let found = s
                .players
                .lock()
                .unwrap()
                .iter()
                .find(|p| p["Id"] == id)
                .cloned();
            match found {
                Some(p) => (StatusCode::OK, Json(p)),
                None => (StatusCode::NOT_FOUND, Json(json!({}))),
            }
        }
        let app = Router::new()
            .route("/search", get(search_h))
            .route("/guilds/{id}/members", get(members_h))
            .route("/players/{id}", get(player_h))
            .with_state(stub.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let base = format!("http://{}", listener.local_addr().expect("addr"));
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (base, stub)
    }

    fn svc(base: String) -> AlbionService {
        AlbionService::with_client(AlbionApiClient::with_base_url(base), "guild".to_owned())
    }

    fn up_player(id: &str, name: &str, guild: &str) -> Value {
        json!({ "Id": id, "Name": name, "GuildId": guild, "GuildName": guild })
    }

    #[tokio::test]
    async fn search_all_players_queries_albion_with_a_normalized_term_and_merges() {
        let (base, stub) = serve_stub(
            (
                200,
                json!({ "guilds": [], "players": [up_player("o1", "Galvdon", "")] }),
            ),
            (
                200,
                json!([{ "Id": "g1", "Name": "Galvdon", "GuildId": "guild" }]),
            ),
            vec![],
        )
        .await;
        let found = svc(base)
            .search_all_players("  Gálvdon ")
            .await
            .expect("search");
        // Guild member first, then the guildless namesake; both visible.
        assert_eq!(ids(&found), ["g1", "o1"]);
        assert!(found.players[0].in_guild);
        assert!(stub.requests().contains(&"search?q=galvdon".to_owned()));
    }

    #[tokio::test]
    async fn search_all_players_finds_non_guild_players_when_the_roster_is_empty() {
        let (base, _stub) = serve_stub(
            (
                200,
                json!({ "guilds": [], "players": [up_player("o1", "Outsider", "Elsewhere")] }),
            ),
            (200, json!([])),
            vec![],
        )
        .await;
        let found = svc(base)
            .search_all_players("outsider")
            .await
            .expect("search");
        assert_eq!(ids(&found), ["o1"]);
        assert!(!found.players[0].in_guild);
    }

    #[tokio::test]
    async fn search_all_players_degrades_when_albion_returns_an_error() {
        let (base, _stub) = serve_stub(
            (503, json!({})),
            (
                200,
                json!([{ "Id": "g1", "Name": "Kay", "GuildId": "guild" }]),
            ),
            vec![],
        )
        .await;
        let found = svc(base).search_all_players("kay").await.expect("degraded");
        assert_eq!(ids(&found), ["g1"]);
        assert!(found.partial);
    }

    #[tokio::test]
    async fn search_all_players_tolerates_a_malformed_albion_body() {
        let (base, _stub) = serve_stub(
            (200, json!("not an object")),
            (
                200,
                json!([{ "Id": "g1", "Name": "Kay", "GuildId": "guild" }]),
            ),
            vec![],
        )
        .await;
        let found = svc(base).search_all_players("kay").await.expect("degraded");
        assert!(found.partial);
    }

    #[tokio::test]
    async fn search_all_players_blank_query_skips_the_network() {
        let (base, stub) = serve_stub((200, json!({})), (200, json!([])), vec![]).await;
        let found = svc(base).search_all_players("   ").await.expect("blank");
        assert!(found.players.is_empty());
        assert!(stub.requests().is_empty());
    }

    #[tokio::test]
    async fn resolve_link_target_falls_back_to_albion_for_a_non_guild_id() {
        let (base, stub) = serve_stub(
            (200, json!({ "guilds": [], "players": [] })),
            (
                200,
                json!([{ "Id": "g1", "Name": "Kay", "GuildId": "guild" }]),
            ),
            vec![up_player("o1", "Outsider", "Elsewhere")],
        )
        .await;
        let service = svc(base);
        let outsider = service
            .resolve_link_target(Some("o1"), None)
            .await
            .expect("outsider");
        assert_eq!(outsider.name, "Outsider");
        assert!(stub.requests().contains(&"players/o1".to_owned()));
        let member = service
            .resolve_link_target(Some("g1"), None)
            .await
            .expect("member");
        assert_eq!(member.name, "Kay");
        let missing = service.resolve_link_target(Some("nope"), None).await;
        assert!(matches!(missing, Err(AppError::NotFound(_))));
    }

    #[tokio::test]
    async fn resolve_link_target_by_name_searches_all_players() {
        let (base, _stub) = serve_stub(
            (
                200,
                json!({ "guilds": [], "players": [up_player("o1", "Outsider", "Elsewhere")] }),
            ),
            (200, json!([])),
            vec![],
        )
        .await;
        let found = svc(base)
            .resolve_link_target(None, Some("outsider"))
            .await
            .expect("by name");
        assert_eq!(found.id, "o1");
    }

    // ------------------------------------------------------------------ link ownership + audit

    async fn audit_actions(db: &DatabaseConnection) -> Vec<String> {
        use crate::modules::audit::entities as audit;
        use sea_orm::QueryOrder;
        audit::Entity::find()
            .order_by_asc(audit::Column::Id)
            .all(db)
            .await
            .expect("audit rows")
            .into_iter()
            .map(|row| row.action)
            .collect()
    }

    async fn insert_user(db: &DatabaseConnection, username: &str, discord_id: &str) -> i64 {
        crate::modules::users::entities::ActiveModel {
            username: Set(username.to_owned()),
            email: Set(format!("{username}@example.test")),
            role: Set("User".to_owned()),
            discord_id: Set(Some(discord_id.to_owned())),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert user")
        .id
    }

    #[tokio::test]
    async fn link_and_unlink_are_audited_with_the_actor() {
        let db = setup_db().await;
        let actor = insert_user(&db, "actor", "discord_a").await;
        let service = AlbionLinkService::new();
        let audit = LinkAudit {
            actor_user_id: Some(actor),
            via: "self",
        };
        service
            .create_link(&db, "discord_a", "player_1", "PlayerOne", audit)
            .await
            .expect("link");
        service
            .delete_link(&db, "discord_a", audit)
            .await
            .expect("unlink");
        assert_eq!(audit_actions(&db).await, [AUDIT_LINK, AUDIT_UNLINK]);

        use crate::modules::audit::entities as audit_rows;
        let first = audit_rows::Entity::find().one(&db).await.unwrap().unwrap();
        assert_eq!(first.user_id, Some(actor));
        assert_eq!(
            first.details.unwrap()["link"]["albion_player_id"],
            "player_1"
        );
    }

    #[tokio::test]
    async fn a_rejected_claim_leaves_no_link_and_no_audit_row() {
        let db = setup_db().await;
        let service = AlbionLinkService::new();
        service
            .create_link(&db, "discord_a", "player_1", "PlayerOne", SELF_AUDIT)
            .await
            .unwrap();
        let hijack = service
            .create_link(&db, "discord_b", "player_1", "PlayerOne", SELF_AUDIT)
            .await;
        assert!(matches!(hijack, Err(AppError::Conflict(_))));
        assert!(
            service
                .get_link_for_discord_user(&db, "discord_b")
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(audit_actions(&db).await, [AUDIT_LINK]);
        let owner = service
            .get_link_for_discord_user(&db, "discord_a")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(owner.albion_player_id, "player_1");
    }

    #[tokio::test]
    async fn the_database_itself_rejects_a_second_claim_on_a_character() {
        let db = setup_db().await;
        let service = AlbionLinkService::new();
        service
            .create_link(&db, "discord_a", "player_1", "PlayerOne", SELF_AUDIT)
            .await
            .unwrap();
        // Bypasses the service's pre-checks, as a concurrent request would.
        let raced = albion_link::ActiveModel {
            discord_id: Set("discord_b".to_owned()),
            albion_player_id: Set("player_1".to_owned()),
            albion_player_name: Set("PlayerOne".to_owned()),
            linked_at: Set(chrono::Utc::now().into()),
            ..Default::default()
        }
        .insert(&db)
        .await;
        // `AppError::Database` is classified into a status when it becomes a response, which is
        // where a unique violation turns into 409.
        let error: AppError = raced.err().expect("unique constraint").into();
        let status = axum::response::IntoResponse::into_response(error).status();
        assert_eq!(status, axum::http::StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn admin_relink_takes_over_a_claimed_character_and_audits_both_sides() {
        let db = setup_db().await;
        let manager = insert_user(&db, "manager", "discord_m").await;
        let owner = insert_user(&db, "owner", "discord_a").await;
        let rightful = insert_user(&db, "rightful", "discord_b").await;
        let service = AlbionLinkService::new();
        service
            .create_link(&db, "discord_a", "player_1", "PlayerOne", SELF_AUDIT)
            .await
            .unwrap();
        let _ = owner;

        let outcome = service
            .admin_link_user(&db, rightful, "player_1", "PlayerOne", manager)
            .await
            .expect("relink");
        assert_eq!(outcome.link.discord_id, "discord_b");
        assert_eq!(outcome.displaced_discord_id.as_deref(), Some("discord_a"));
        assert!(
            service
                .get_link_for_discord_user(&db, "discord_a")
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(audit_actions(&db).await, [AUDIT_LINK, AUDIT_RELINK]);

        use crate::modules::audit::entities as audit_rows;
        use sea_orm::QueryOrder;
        let last = audit_rows::Entity::find()
            .order_by_desc(audit_rows::Column::Id)
            .one(&db)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(last.user_id, Some(manager));
        let details = last.details.unwrap();
        assert_eq!(details["displaced_other_link"]["discord_id"], "discord_a");
        assert_eq!(details["target_user_id"], rightful);
    }

    #[tokio::test]
    async fn admin_first_link_is_a_plain_link_and_unlink_is_audited() {
        let db = setup_db().await;
        let manager = insert_user(&db, "manager", "discord_m").await;
        let target = insert_user(&db, "target", "discord_t").await;
        let service = AlbionLinkService::new();
        let outcome = service
            .admin_link_user(&db, target, "player_9", "Nine", manager)
            .await
            .unwrap();
        assert!(outcome.displaced_discord_id.is_none());
        let removed = service
            .admin_unlink_user(&db, target, manager)
            .await
            .unwrap();
        assert_eq!(removed.as_deref(), Some("discord_t"));
        // Unlinking an already-unlinked user is a silent no-op, not an audit row.
        assert!(
            service
                .admin_unlink_user(&db, target, manager)
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(audit_actions(&db).await, [AUDIT_LINK, AUDIT_UNLINK]);
    }

    // ── approval flow ────────────────────────────────────────────────────────────────────────

    async fn request(
        db: &DatabaseConnection,
        discord: &str,
        player: &str,
        name: &str,
    ) -> albion_link_request::Model {
        AlbionLinkService::new()
            .request_link(db, discord, player, name, Some("Weaklings"), SELF_AUDIT)
            .await
            .expect("request")
    }

    #[tokio::test]
    async fn a_self_service_request_is_not_a_link() {
        let db = setup_db().await;
        let service = AlbionLinkService::new();
        request(&db, "discord_a", "player_1", "PlayerOne").await;

        // Nothing keyed on `albion_links` (loot, regears, splits, guild role) can see the claim.
        assert!(
            service
                .get_link_for_discord_user(&db, "discord_a")
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            albion_link::Entity::find()
                .all(&db)
                .await
                .unwrap()
                .is_empty()
        );

        let status = service
            .status_for_discord_user(&db, "discord_a")
            .await
            .unwrap();
        assert!(!status.linked);
        assert!(status.pending);
        assert_eq!(
            status.pending_albion_player_name.as_deref(),
            Some("PlayerOne")
        );
        assert_eq!(audit_actions(&db).await, [AUDIT_REQUEST]);
    }

    #[tokio::test]
    async fn asking_again_replaces_the_open_request() {
        let db = setup_db().await;
        let service = AlbionLinkService::new();
        request(&db, "discord_a", "player_1", "PlayerOne").await;
        request(&db, "discord_a", "player_2", "PlayerTwo").await;

        let open = service.list_requests(&db).await.unwrap();
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].albion_player_id, "player_2");
    }

    #[tokio::test]
    async fn a_request_for_a_linked_character_or_by_a_linked_account_conflicts() {
        let db = setup_db().await;
        let service = AlbionLinkService::new();
        service
            .create_link(&db, "discord_a", "player_1", "PlayerOne", SELF_AUDIT)
            .await
            .unwrap();

        let taken = service
            .request_link(&db, "discord_b", "player_1", "PlayerOne", None, SELF_AUDIT)
            .await
            .unwrap_err();
        assert!(matches!(taken, AppError::Conflict(_)));
        let already = service
            .request_link(&db, "discord_a", "player_2", "PlayerTwo", None, SELF_AUDIT)
            .await
            .unwrap_err();
        assert!(matches!(already, AppError::Conflict(_)));
        assert!(service.list_requests(&db).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn approving_creates_the_link_and_drops_competing_claims() {
        let db = setup_db().await;
        let service = AlbionLinkService::new();
        let mine = request(&db, "discord_a", "player_1", "PlayerOne").await;
        request(&db, "discord_b", "player_1", "PlayerOne").await;
        request(&db, "discord_c", "player_9", "Unrelated").await;

        let listed = service.list_requests(&db).await.unwrap();
        let first = listed.iter().find(|r| r.id == mine.id).unwrap();
        assert_eq!(first.competing_requests, 1);
        assert!(!first.character_already_linked);

        let link = service.approve_request(&db, mine.id, 42).await.unwrap();
        assert_eq!(link.discord_id, "discord_a");
        assert_eq!(link.albion_player_name, "PlayerOne");

        let status = service
            .status_for_discord_user(&db, "discord_a")
            .await
            .unwrap();
        assert!(status.linked && !status.pending);
        // The loser is neither linked nor still waiting; the unrelated claim is untouched.
        let left: Vec<_> = service
            .list_requests(&db)
            .await
            .unwrap()
            .into_iter()
            .map(|r| r.discord_id)
            .collect();
        assert_eq!(left, ["discord_c".to_owned()]);
        assert!(
            service
                .get_link_for_discord_user(&db, "discord_b")
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(
            audit_actions(&db).await,
            [
                AUDIT_REQUEST,
                AUDIT_REQUEST,
                AUDIT_REQUEST,
                AUDIT_REJECT,
                AUDIT_LINK
            ]
        );
    }

    #[tokio::test]
    async fn approving_never_displaces_an_existing_link() {
        let db = setup_db().await;
        let service = AlbionLinkService::new();
        let claim = request(&db, "discord_b", "player_1", "PlayerOne").await;
        // Someone else gets the character linked (e.g. by an officer) while the claim waits.
        service
            .create_link(&db, "discord_a", "player_1", "PlayerOne", SELF_AUDIT)
            .await
            .unwrap();

        let listed = service.list_requests(&db).await.unwrap();
        assert!(listed[0].character_already_linked);
        let error = service
            .approve_request(&db, claim.id, 42)
            .await
            .unwrap_err();
        assert!(matches!(error, AppError::Conflict(_)));
        // The claim is kept for the officer to reject, and the rightful link is untouched.
        assert_eq!(service.list_requests(&db).await.unwrap().len(), 1);
        let owner = service
            .get_link_for_discord_user(&db, "discord_a")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(owner.albion_player_id, "player_1");
    }

    #[tokio::test]
    async fn approving_twice_or_a_missing_request_is_not_found() {
        let db = setup_db().await;
        let service = AlbionLinkService::new();
        let claim = request(&db, "discord_a", "player_1", "PlayerOne").await;
        service.approve_request(&db, claim.id, 42).await.unwrap();

        let again = service
            .approve_request(&db, claim.id, 42)
            .await
            .unwrap_err();
        assert!(matches!(again, AppError::NotFound(_)));
        let missing = service.reject_request(&db, 9_999, 42).await.unwrap_err();
        assert!(matches!(missing, AppError::NotFound(_)));
    }

    #[tokio::test]
    async fn rejecting_discards_the_claim_without_linking() {
        let db = setup_db().await;
        let service = AlbionLinkService::new();
        let claim = request(&db, "discord_a", "player_1", "PlayerOne").await;

        let rejected = service.reject_request(&db, claim.id, 42).await.unwrap();
        assert_eq!(rejected.discord_id, "discord_a");
        let status = service
            .status_for_discord_user(&db, "discord_a")
            .await
            .unwrap();
        assert!(!status.linked && !status.pending);
        assert_eq!(audit_actions(&db).await, [AUDIT_REQUEST, AUDIT_REJECT]);
        // The account may ask again.
        request(&db, "discord_a", "player_1", "PlayerOne").await;
    }

    #[tokio::test]
    async fn the_owner_can_withdraw_a_request() {
        let db = setup_db().await;
        let service = AlbionLinkService::new();
        request(&db, "discord_a", "player_1", "PlayerOne").await;

        service
            .cancel_request(&db, "discord_a", SELF_AUDIT)
            .await
            .unwrap();
        assert!(service.list_requests(&db).await.unwrap().is_empty());
        let again = service
            .cancel_request(&db, "discord_a", SELF_AUDIT)
            .await
            .unwrap_err();
        assert!(matches!(again, AppError::NotFound(_)));
        assert_eq!(
            audit_actions(&db).await,
            [AUDIT_REQUEST, AUDIT_REQUEST_CANCEL]
        );
    }

    #[tokio::test]
    async fn a_real_link_clears_the_accounts_open_request() {
        let db = setup_db().await;
        let service = AlbionLinkService::new();
        let target = insert_user(&db, "target", "discord_t").await;
        let manager = insert_user(&db, "manager", "discord_m").await;
        request(&db, "discord_t", "player_1", "PlayerOne").await;

        // An officer links the account directly: the stale claim must not linger.
        service
            .admin_link_user(&db, target, "player_2", "PlayerTwo", manager)
            .await
            .unwrap();
        assert!(service.list_requests(&db).await.unwrap().is_empty());
        let status = service.status_for_user_id(&db, target).await.unwrap();
        assert!(status.linked && !status.pending);
    }

    #[tokio::test]
    async fn the_review_list_names_the_requester() {
        let db = setup_db().await;
        let service = AlbionLinkService::new();
        let user = insert_user(&db, "someone", "discord_s").await;
        request(&db, "discord_s", "player_1", "PlayerOne").await;

        let listed = service.list_requests(&db).await.unwrap();
        assert_eq!(listed[0].user_id, Some(user));
        assert_eq!(listed[0].username.as_deref(), Some("someone"));
        assert_eq!(listed[0].albion_guild_name.as_deref(), Some("Weaklings"));
    }
}
