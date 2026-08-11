//! `AlbionBB` service logic module.
//!
//! `AlbionBbService` wraps the generic AlbionBB API client and adds a short-TTL
//! in-memory cache for single-battle and single-guild lookups (which are
//! immutable historical facts). Battle list and kills endpoints are not cached.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

use super::client::{
    AlbionBbApiClient, AlbionBbBattleDetail, AlbionBbBattleSummary, AlbionBbBattlesFilters,
    AlbionBbGuildInfo, AlbionBbKillEvent, AlbionBbPageMeta,
};
use crate::errors::AppError;

/// How long cached single-resource lookups are considered fresh.
const RESOURCE_CACHE_TTL: Duration = Duration::from_secs(60 * 60 * 24);

type BattleCache = Arc<RwLock<HashMap<i64, (Instant, AlbionBbBattleDetail)>>>;
type GuildCache = Arc<RwLock<HashMap<String, (Instant, AlbionBbGuildInfo)>>>;

/// Service exposing AlbionBB operations, with cached single-resource lookups.
#[derive(Clone)]
pub struct AlbionBbService {
    client: AlbionBbApiClient,
    battle_cache: BattleCache,
    guild_cache: GuildCache,
}

impl AlbionBbService {
    #[must_use]
    pub fn new(client: AlbionBbApiClient) -> Self {
        Self {
            client,
            battle_cache: Arc::new(RwLock::new(HashMap::new())),
            guild_cache: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Fetches battles matching the given filters (uncached — list views must
    /// reflect new battles as they happen).
    pub async fn get_battles(
        &self,
        server: Option<&str>,
        filters: &AlbionBbBattlesFilters,
    ) -> Result<(Vec<AlbionBbBattleSummary>, AlbionBbPageMeta), AppError> {
        self.client.get_battles(server, filters).await
    }

    /// Fetches a single battle by id, serving from cache when fresh.
    pub async fn get_battle(
        &self,
        server: Option<&str>,
        battle_id: i64,
    ) -> Result<AlbionBbBattleDetail, AppError> {
        if let Some((fetched_at, detail)) = self.battle_cache.read().await.get(&battle_id)
            && fetched_at.elapsed() < RESOURCE_CACHE_TTL
        {
            return Ok(detail.clone());
        }

        let detail = self.client.get_battle(server, battle_id).await?;
        self.battle_cache
            .write()
            .await
            .insert(battle_id, (Instant::now(), detail.clone()));
        Ok(detail)
    }

    /// Fetches kill events for a battle (uncached — kill feeds are real-time).
    pub async fn get_battle_kills(
        &self,
        server: Option<&str>,
        battle_id: i64,
    ) -> Result<Vec<AlbionBbKillEvent>, AppError> {
        self.client.get_battle_kills(server, battle_id).await
    }

    /// Fetches player career stats (uncached passthrough).
    pub async fn get_player_stats(
        &self,
        server: Option<&str>,
        player_id: &str,
        min_players: Option<i64>,
    ) -> Result<serde_json::Value, AppError> {
        self.client
            .get_player_stats(server, player_id, min_players)
            .await
    }

    /// Fetches guild info, serving from cache when fresh.
    pub async fn get_guild(
        &self,
        server: Option<&str>,
        guild_id: &str,
    ) -> Result<AlbionBbGuildInfo, AppError> {
        let key = format!("{}:{guild_id}", server.unwrap_or("eu"));
        if let Some((fetched_at, info)) = self.guild_cache.read().await.get(&key)
            && fetched_at.elapsed() < RESOURCE_CACHE_TTL
        {
            return Ok(info.clone());
        }

        let info = self.client.get_guild(server, guild_id).await?;
        self.guild_cache
            .write()
            .await
            .insert(key, (Instant::now(), info.clone()));
        Ok(info)
    }
}

impl Default for AlbionBbService {
    fn default() -> Self {
        Self::new(AlbionBbApiClient::default())
    }
}
