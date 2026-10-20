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

/// Maximum entries retained in each cache before oldest/expired are pruned.
const MAX_CACHE_ENTRIES: usize = 500;

type BattleCacheKey = (String, i64);
type BattleCache = Arc<RwLock<HashMap<BattleCacheKey, (Instant, AlbionBbBattleDetail)>>>;
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
        let key = (super::client::normalize_server(server), battle_id);
        if let Some((fetched_at, detail)) = self.battle_cache.read().await.get(&key)
            && fetched_at.elapsed() < RESOURCE_CACHE_TTL
        {
            return Ok(detail.clone());
        }

        let detail = self.client.get_battle(server, battle_id).await?;
        let mut cache = self.battle_cache.write().await;
        cache.retain(|_, (fetched_at, _)| fetched_at.elapsed() < RESOURCE_CACHE_TTL);
        if cache.len() >= MAX_CACHE_ENTRIES {
            if let Some(oldest_key) = cache
                .iter()
                .min_by_key(|(_, (fetched_at, _))| *fetched_at)
                .map(|(k, _)| k.clone())
            {
                cache.remove(&oldest_key);
            }
        }
        cache.insert(key, (Instant::now(), detail.clone()));
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
        let key = format!("{}:{guild_id}", super::client::normalize_server(server));
        if let Some((fetched_at, info)) = self.guild_cache.read().await.get(&key)
            && fetched_at.elapsed() < RESOURCE_CACHE_TTL
        {
            return Ok(info.clone());
        }

        let info = self.client.get_guild(server, guild_id).await?;
        let mut cache = self.guild_cache.write().await;
        cache.retain(|_, (fetched_at, _)| fetched_at.elapsed() < RESOURCE_CACHE_TTL);
        if cache.len() >= MAX_CACHE_ENTRIES {
            if let Some(oldest_key) = cache
                .iter()
                .min_by_key(|(_, (fetched_at, _))| *fetched_at)
                .map(|(k, _)| k.clone())
            {
                cache.remove(&oldest_key);
            }
        }
        cache.insert(key, (Instant::now(), info.clone()));
        Ok(info)
    }
}

impl Default for AlbionBbService {
    fn default() -> Self {
        Self::new(AlbionBbApiClient::default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cache_keys_by_server_and_battle_id() {
        let service = AlbionBbService::default();
        let key_eu = (String::from("europe"), 12345);
        let key_us = (String::from("americas"), 12345);

        let dummy_detail = AlbionBbBattleDetail {
            summary: AlbionBbBattleSummary {
                id: 12345,
                start_time: "2026-08-01T00:00:00Z".to_string(),
                end_time: "2026-08-01T01:00:00Z".to_string(),
                total_players: 10,
                total_kills: 5,
                total_fame: 1000,
                guilds: Vec::new(),
            },
            players: Vec::new(),
        };

        service
            .battle_cache
            .write()
            .await
            .insert(key_eu.clone(), (Instant::now(), dummy_detail.clone()));

        assert!(service.battle_cache.read().await.contains_key(&key_eu));
        assert!(!service.battle_cache.read().await.contains_key(&key_us));
    }

    #[tokio::test]
    async fn cache_prunes_expired_and_bounds_size() {
        let service = AlbionBbService::default();
        let dummy_detail = AlbionBbBattleDetail {
            summary: AlbionBbBattleSummary {
                id: 1,
                start_time: "2026-08-01T00:00:00Z".to_string(),
                end_time: "2026-08-01T01:00:00Z".to_string(),
                total_players: 10,
                total_kills: 5,
                total_fame: 1000,
                guilds: Vec::new(),
            },
            players: Vec::new(),
        };

        let mut cache = service.battle_cache.write().await;
        cache.insert(
            ("default".to_string(), 999),
            (
                Instant::now() - Duration::from_secs(60 * 60 * 25),
                dummy_detail.clone(),
            ),
        );

        cache.retain(|_, (fetched_at, _)| fetched_at.elapsed() < RESOURCE_CACHE_TTL);
        assert!(!cache.contains_key(&("default".to_string(), 999)));
    }
}
