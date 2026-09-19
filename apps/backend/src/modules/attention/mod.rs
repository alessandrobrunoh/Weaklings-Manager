//! Attention signals: deterministic, versioned rules (plan §7) that answer
//! "what's wrong" instead of leaving an officer to infer it from totals.
//!
//! `attention::rules` is pure: each rule function takes already-aggregated
//! inputs and returns `Option<rules::Finding>`, with no database access and
//! no generated text — only numbers and identifiers. `attention::writer`
//! owns every query, evaluates every rule, and replaces `attention_findings`
//! wholesale per rule on each recompute (see
//! `m20260908_000010_create_attention_findings` for why this is not an
//! immutable-identity table). `attention::service`/`router` expose the
//! current findings read-only.
//!
//! # Recomputed on read, not on a schedule
//!
//! Unlike `fight_analytics` (recomputed eagerly after a specific fight
//! changes) this module's findings are guild-wide, not tied to any single
//! fight, so there is no natural per-write hook to recompute from. This
//! codebase has no async worker or job queue (see `fight_analytics::mod`'s
//! own doc comment for why one isn't introduced lightly), so
//! `GET /api/attention/findings` recomputes synchronously, then reads, on
//! every call — consistent with the "eager, best-effort, no queue" style
//! already used everywhere else, and cheap enough at this guild's scale
//! (bounded by fights in a ~60-day window, not a full-table scan). A
//! scheduled recompute would be the natural next step if traffic ever
//! warranted it; nothing here blocks adding one later.

pub mod entities;
pub mod router;
pub mod rules;
pub mod service;
pub mod writer;

pub use router::router;
