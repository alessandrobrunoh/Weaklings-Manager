//! Per-tenant worker that sends the daily Albion bank log import reminder.
//!
//! The rules live in [`backend_bank::bank_log::reminder`]; this loop only wakes up every 30
//! minutes. At most one message per UTC day is sent, tracked on the guild settings, so a
//! restart or a second instance does not ping twice in the same day except in the narrow
//! window of two instances checking at the same moment.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use sea_orm::DatabaseConnection;
use tokio::time::interval;

use backend_bank::bank_log::reminder::{self, ReminderOutcome};
use backend_core::config::Config;

const TICK_INTERVAL: Duration = Duration::from_secs(30 * 60);

/// Spawns the reminder loop for one tenant. Returns immediately.
pub fn spawn(db: DatabaseConnection, tenant_id: String, stop: Arc<AtomicBool>) {
    tokio::spawn(async move {
        let mut ticker = interval(TICK_INTERVAL);
        loop {
            ticker.tick().await;
            if stop.load(Ordering::Relaxed) {
                tracing::info!(tenant_id, "bank log reminder worker stopped");
                break;
            }
            let token = Config::try_from_env()
                .ok()
                .and_then(|cfg| cfg.discord_bot_token)
                .filter(|token| !token.trim().is_empty());
            match reminder::run_once(&db, chrono::Utc::now(), token.as_deref()).await {
                Ok(ReminderOutcome::Sent { days }) => {
                    tracing::info!(tenant_id, days, "bank log reminder sent");
                }
                Ok(ReminderOutcome::Skipped { reason }) => {
                    tracing::debug!(tenant_id, reason, "bank log reminder skipped");
                }
                Ok(ReminderOutcome::NotDue) => {}
                Err(error) => {
                    tracing::warn!(tenant_id, error = %error, "bank log reminder check failed");
                }
            }
        }
    });
}
