//! Albion vocabulary shared by every feature: the `AlbionBB` server segment and
//! the classifiers that decide which guilds fight on our side.

use std::collections::HashSet;

/// Default server path segment when the caller does not specify one.
const DEFAULT_SERVER: &str = "eu";

/// Normalizes a server string into a valid `AlbionBB` path segment.
/// Accepts `eu`/`europe`, `na`/`americas`/`us`, `asia`/`sgp`; falls back to `eu`.
#[must_use]
pub fn normalize_server(server: Option<&str>) -> String {
    match server.map(str::to_ascii_lowercase).as_deref() {
        Some("eu" | "europe") => "eu".to_string(),
        Some("na" | "americas" | "america" | "us") => "na".to_string(),
        Some("asia" | "sgp") => "asia".to_string(),
        _ => DEFAULT_SERVER.to_string(),
    }
}

/// Which guilds count as ours.
///
/// IDs stay case-sensitive because Albion IDs are opaque; names are lower-cased
/// because they come from operator-typed configuration.
#[derive(Debug, Clone, Default)]
pub struct FriendlySide {
    guild_id: String,
    allied_ids: HashSet<String>,
    allied_names: HashSet<String>,
}

impl FriendlySide {
    /// Builds the classifier from a guild ID plus allied ID and name lists.
    #[must_use]
    pub fn new(guild_id: &str, allied_ids: &[String], allied_names: &[String]) -> Self {
        Self {
            guild_id: guild_id.to_string(),
            allied_ids: allied_ids.iter().cloned().collect(),
            allied_names: allied_names
                .iter()
                .map(|name| name.to_ascii_lowercase())
                .collect(),
        }
    }

    /// Returns `true` when a battle guild fights on our side.
    #[must_use]
    pub fn contains(&self, guild_id: &str, guild_name: &str) -> bool {
        if !guild_id.is_empty() && (guild_id == self.guild_id || self.allied_ids.contains(guild_id))
        {
            return true;
        }
        if guild_name.trim().is_empty() {
            return false;
        }
        self.allied_names.contains(&guild_name.to_ascii_lowercase())
    }

    /// Returns `true` when `guild_id` is this tenant's own guild.
    ///
    /// Allies are friendly but never "own". A blank id is never own, so a
    /// payload that does not expose guild ids cannot match by accident.
    #[must_use]
    pub fn is_own(&self, guild_id: &str) -> bool {
        !guild_id.is_empty() && guild_id == self.guild_id
    }

    /// Builds a [`BattleSide`] for one battle from its guild rows.
    #[must_use]
    pub fn for_battle<'a, 'g>(
        &'a self,
        guilds: impl IntoIterator<Item = (&'g str, &'g str)>,
    ) -> BattleSide<'a> {
        let guild_names = guilds
            .into_iter()
            .filter(|(id, name)| self.contains(id, name))
            .map(|(_, name)| name.trim().to_ascii_lowercase())
            .filter(|name| !name.is_empty())
            .collect();
        BattleSide {
            side: self,
            guild_names,
        }
    }
}

/// [`FriendlySide`] resolved against one battle's guild rows.
///
/// `AlbionBB` does not expose a player's guild id, only the guild name, so the
/// tenant's own guild (known by id) could never be matched on a player row.
/// The battle's own guild rows carry both: any guild the tenant recognises as
/// friendly there makes its name friendly for the players of that battle.
#[derive(Debug, Clone)]
pub struct BattleSide<'a> {
    side: &'a FriendlySide,
    guild_names: HashSet<String>,
}

impl BattleSide<'_> {
    /// Returns `true` when a guild or player row fights on our side.
    #[must_use]
    pub fn contains(&self, guild_id: &str, guild_name: &str) -> bool {
        if self.side.contains(guild_id, guild_name) {
            return true;
        }
        let name = guild_name.trim();
        !name.is_empty() && self.guild_names.contains(&name.to_ascii_lowercase())
    }

    /// Returns `true` when `guild_id` is the tenant's own guild.
    #[must_use]
    pub fn is_own(&self, guild_id: &str) -> bool {
        self.side.is_own(guild_id)
    }
}

/// Battle-side classification rules for event analytics.
///
/// `AlbionBB` exposes every guild in the fight as a peer, but event stats need to separate our side
/// from real opponents. The configured guild plus allied guild IDs/names are treated as friendly,
/// so alliance members do not pollute opponent charts or matchup summaries.
///
/// # Example
/// ```ignore
/// let context = BattleLinkingContext::new(
///     "weaklings-id",
///     &["ally-id".to_string()],
///     &["BetterGetBack".to_string()],
/// );
/// assert!(context.is_friendly_guild("ally-id", "BetterGetBack"));
/// ```
#[derive(Debug, Clone)]
pub struct BattleLinkingContext {
    guild_id: Option<String>,
    allied_guild_ids: HashSet<String>,
    allied_guild_names: HashSet<String>,
    server: Option<String>,
}

impl BattleLinkingContext {
    /// Creates a normalized friendly-guild classifier for a single linking run.
    ///
    /// IDs are kept case-sensitive because Albion IDs are opaque. Names are lower-cased to tolerate
    /// operator input differences in environment variables. The method performs no I/O and is safe
    /// to construct per request or worker tick.
    ///
    /// # Example
    /// ```ignore
    /// let context = BattleLinkingContext::new("main", &[], &["BetterGetBack".to_string()]);
    /// assert!(context.is_friendly_guild("main", "Weaklings"));
    /// ```
    #[must_use]
    pub fn new(guild_id: &str, allied_guild_ids: &[String], allied_guild_names: &[String]) -> Self {
        Self {
            guild_id: Some(guild_id.to_string()),
            allied_guild_ids: allied_guild_ids.iter().cloned().collect(),
            allied_guild_names: allied_guild_names
                .iter()
                .map(|name| name.to_ascii_lowercase())
                .collect(),
            server: None,
        }
    }

    /// Alliance-side classifier: no own guild, every member guild is friendly.
    ///
    /// Alliance tenants have no `albion_guild_id`; their Albion identity is the
    /// alliance, whose friendly side is the set of its active member guild IDs.
    /// `guild_id` stays `None` so no battle row is ever treated as "our own
    /// guild" — an unknown or blank guild ID classifies as not ours.
    #[must_use]
    pub fn for_alliance(member_guild_ids: &[String]) -> Self {
        Self {
            guild_id: None,
            allied_guild_ids: member_guild_ids.iter().cloned().collect(),
            allied_guild_names: HashSet::new(),
            server: None,
        }
    }

    /// Sets the `AlbionBB` server used by automatic battle linking.
    #[must_use]
    pub fn with_server(mut self, server: Option<String>) -> Self {
        self.server = server;
        self
    }

    /// `AlbionBB` server path segment, if configured.
    #[must_use]
    pub fn server(&self) -> Option<&str> {
        self.server.as_deref()
    }

    /// Returns `true` when a battle guild belongs to our side.
    ///
    /// The configured guild ID always wins, then explicit allied IDs, then normalized names as a
    /// fallback for partial upstream payloads.
    ///
    /// # Example
    /// ```ignore
    /// let context = BattleLinkingContext::new("main", &[], &["BetterGetBack".to_string()]);
    /// assert!(context.is_friendly_guild("", "bettergetback"));
    /// ```
    #[must_use]
    pub fn is_friendly_guild(&self, guild_id: &str, guild_name: &str) -> bool {
        if self.is_own_guild(guild_id) || self.allied_guild_ids.contains(guild_id) {
            return true;
        }
        if guild_name.trim().is_empty() {
            return false;
        }
        self.allied_guild_names
            .contains(&guild_name.to_ascii_lowercase())
    }

    /// True when this guild ID is the configured own guild. Alliance-side
    /// contexts own no guild, so this is always `false` for them.
    #[must_use]
    pub fn is_own_guild(&self, guild_id: &str) -> bool {
        self.guild_id.as_deref() == Some(guild_id)
    }

    /// Configured Albion guild ID used to query `AlbionBB` and identify our own
    /// guild row. `None` for alliance-side contexts, which have no guild of
    /// their own.
    #[must_use]
    pub fn guild_id(&self) -> Option<&str> {
        self.guild_id.as_deref()
    }

    /// Allied guild IDs, in the shape [`FriendlySide`] expects.
    #[must_use]
    pub fn allied_guild_ids(&self) -> Vec<String> {
        self.allied_guild_ids.iter().cloned().collect()
    }

    /// Allied guild names, already lower-cased by the constructor.
    #[must_use]
    pub fn allied_guild_names(&self) -> Vec<String> {
        self.allied_guild_names.iter().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn side() -> FriendlySide {
        FriendlySide::new(
            "us",
            &["ally-id".to_string()],
            &["BetterGetBack".to_string()],
        )
    }

    #[test]
    fn own_guild_is_never_an_ally_or_a_blank_id() {
        let side = side();
        assert!(side.is_own("us"));
        assert!(!side.is_own("ally-id"));
        assert!(!side.is_own(""));
        assert!(!FriendlySide::default().is_own(""));
    }

    #[test]
    fn players_without_guild_ids_are_friendly_through_the_battle_guild_rows() {
        let side = side();
        let battle = side.for_battle([("us", "Albion Crew"), ("enemy", "Enemies")]);
        assert!(battle.contains("", "Albion Crew"));
        assert!(battle.contains("", " albion crew "));
        assert!(!battle.contains("", "Enemies"));
        assert!(!battle.contains("", ""));
        // Names only count inside the battle they were seen in.
        assert!(
            !side
                .for_battle([("enemy", "Enemies")])
                .contains("", "Albion Crew")
        );
    }

    #[test]
    fn two_tenants_classify_the_same_battle_differently() {
        let first = FriendlySide::new("guild-a", &[], &[]);
        let second = FriendlySide::new("guild-b", &[], &[]);
        let guilds = [("guild-a", "Alpha"), ("guild-b", "Beta")];
        assert!(first.for_battle(guilds).contains("", "Alpha"));
        assert!(!first.for_battle(guilds).contains("", "Beta"));
        assert!(second.for_battle(guilds).contains("", "Beta"));
        assert!(!second.for_battle(guilds).contains("", "Alpha"));
    }

    #[test]
    fn side_matches_by_id_then_allied_id_then_name() {
        let side = side();
        assert!(side.contains("us", "Weaklings"));
        assert!(side.contains("ally-id", "Whoever"));
        assert!(side.contains("", "bettergetback"));
        assert!(!side.contains("them", "ARCH"));
    }

    /// An empty ID must not match a friendly side whose configured ID is also
    /// empty, otherwise every unidentified guild becomes ours.
    #[test]
    fn empty_id_never_matches_by_id() {
        let side = FriendlySide::new("", &[], &["us".to_string()]);
        assert!(!side.contains("", "ARCH"));
        assert!(side.contains("", "us"));
    }
}
