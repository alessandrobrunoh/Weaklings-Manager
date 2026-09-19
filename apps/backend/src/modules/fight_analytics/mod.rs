//! Fight-level analytics: the payoff of normalizing evidence at the battle
//! level (`battles::evidence_entities`) is that a canonical Fight — one real
//! engagement, one or more `AlbionBB` battle segments — can finally be
//! aggregated once, correctly, instead of re-parsed from JSON on every read.
//!
//! Two things are computed and persisted here, both derived and rebuildable:
//! - `fights.outcome`/`outcome_method` — the Fight's decided outcome, closing
//!   the gap left in `battles::outcome`'s own docs: the shared outcome rule
//!   was extracted and unified, but never persisted, because persisting it
//!   without a recompute path would have recreated the exact two-truths bug
//!   that rule was built to kill. This module is that recompute path.
//! - `fight_stats` — one row per fight: unique friendly/enemy players
//!   (deduplicated by `player_key` across every segment, so a multi-segment
//!   fight can no longer double-count a player who appears in two of its
//!   segments), summed kills/deaths/fame, and summed loss estimates from
//!   `economy::entities::battle_loss_estimate`.
//!
//! # Staleness, not a job queue
//!
//! A fight's analytics are recomputed eagerly, synchronously, in the same
//! best-effort chain every other writer already uses (battle hydration,
//! Fight merge/split/move) — there is no separate async worker or job queue
//! in this codebase, and introducing one for this alone would be a
//! disproportionate new subsystem. `fights.analytics_stale` and
//! `analytics_computed_at` are the observability this still provides: an
//! eager recompute that fails (or one that predates this feature) leaves a
//! fight visibly stale rather than silently wrong, and a diagnostic query
//! over that column is the whole "queue depth" view for now.
//!
//! See `m20260908_000009_create_fight_stats` for the full schema rationale.

pub mod compute;
pub mod entities;
pub mod router;
pub mod service;
pub mod writer;

pub use router::router;
