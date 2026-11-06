//! Payloads returned by Discord REST, as far as the backend reads them.

use serde::Deserialize;

/// One guild role (`GET /guilds/{id}/roles`).
#[derive(Debug, Clone, Deserialize)]
pub struct DiscordRolePayload {
    /// Role snowflake. Equal to the guild id for `@everyone`.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Position in the role list; higher ranks above lower.
    pub position: i32,
    /// Managed by an integration or the server itself; the bot cannot assign it.
    pub managed: bool,
}

/// A forum tag attached to a forum channel.
#[derive(Debug, Clone, Deserialize)]
pub struct DiscordForumTagPayload {
    /// Tag snowflake.
    pub id: String,
    /// Tag name.
    pub name: String,
}

/// One guild channel (`GET /guilds/{id}/channels`).
#[derive(Debug, Deserialize)]
pub struct DiscordChannelPayload {
    /// Channel snowflake.
    pub id: String,
    /// Channel name.
    pub name: String,
    /// Discord channel type code.
    #[serde(rename = "type")]
    pub type_id: i32,
    /// Parent category id, if any.
    pub parent_id: Option<String>,
    /// Position among sibling channels.
    #[serde(default)]
    pub position: i32,
    /// Tags of a forum channel.
    #[serde(default)]
    pub available_tags: Vec<DiscordForumTagPayload>,
}

/// A Discord user object embedded in a guild member payload.
#[derive(Debug, Clone, Deserialize)]
pub struct DiscordUserPayload {
    /// User snowflake.
    pub id: String,
    /// Unique username.
    pub username: String,
    /// Display name, if set.
    #[serde(default)]
    pub global_name: Option<String>,
    /// Avatar hash, if set.
    #[serde(default)]
    pub avatar: Option<String>,
    /// Whether the account is a bot.
    #[serde(default)]
    pub bot: bool,
}

/// A guild member (`GET /guilds/{id}/members/{user}`, member listings, and the user-token
/// `GET /users/@me/guilds/{id}/member`).
#[derive(Debug, Clone, Deserialize)]
pub struct DiscordGuildMemberPayload {
    /// The user object, absent on some partial payloads.
    #[serde(default)]
    pub user: Option<DiscordUserPayload>,
    /// Server nickname, if set.
    #[serde(default)]
    pub nick: Option<String>,
    /// Role snowflakes held by the member.
    #[serde(default)]
    pub roles: Vec<String>,
}
