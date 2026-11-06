//! Typed client for the Discord REST API used by the backend.
//!
//! [`DiscordRest`] is the one place where backend code talks to Discord REST (member reads,
//! role grants and revocations, nicknames, role and channel listings). The bot token is a
//! process-wide secret; every call names the guild it targets, and requests on one guild share
//! a token bucket of 4 requests per second (see the `limiter` module). A `429` answer is returned
//! as [`DiscordError::RateLimited`] with the `Retry-After` delay, never retried inside the call.
//!
//! Errors are classified once: `404` with code `10007` is an absent member, `404` with code
//! `10004` means the bot cannot see the server, and other `404`s are
//! [`DiscordError::NotFound`]. Only `10007` may be read as "the member left".

mod client;
mod error;
mod limiter;
mod types;

pub use client::{DEFAULT_API_BASE, DiscordRest, LiveDiscordRest};
pub use error::{DiscordError, upstream};
pub use types::{
    DiscordChannelPayload, DiscordGuildMemberPayload, DiscordRolePayload, DiscordUserPayload,
};
