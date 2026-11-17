//! Daily Discord reminder to import the Albion bank log.
//!
//! The game keeps 28 days of log. From day 5 after the last import, the backend pings the
//! guild's staff role once per UTC day in the configured channel until someone imports. Days
//! are counted in UTC, the timezone of the export itself.
//!
//! A guild that never imported gets no reminder. When the channel, the staff role or the bot
//! token is missing, or Discord refuses the message, nothing is sent and the reason is stored on
//! the guild settings so the admin pages can show it.

use chrono::{DateTime, NaiveDate, Utc};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder, Set,
};

use backend_core::errors::AppError;
use backend_entities::admin::{ActiveModel as GuildSettingsActiveModel, Entity as GuildSettingsEntity};
use backend_entities::auth::role::{Column as RoleColumn, Entity as RoleEntity};
use backend_entities::bank_log::entry::{Column as EntryColumn, Entity as EntryEntity};
use backend_identity::audit::service::AuditService;

/// The game log window.
pub const GAME_LOG_DAYS: i64 = 28;
/// Reminders start this many days after the last import.
pub const REMINDER_AFTER_DAYS: i64 = 5;

/// Stored reasons a reminder was not sent (the frontend translates them).
pub const ERROR_MISSING_CHANNEL: &str = "missing_channel";
pub const ERROR_MISSING_STAFF_ROLE: &str = "missing_staff_role";
pub const ERROR_MISSING_BOT_TOKEN: &str = "missing_bot_token";
pub const ERROR_DISCORD_REFUSED: &str = "discord_refused";

/// Whole days since the last import when a reminder is due today, `None` otherwise.
#[must_use]
pub fn reminder_due(
    last_import: Option<DateTime<Utc>>,
    reminded_on: Option<&str>,
    now: DateTime<Utc>,
) -> Option<i64> {
    let last_import = last_import?;
    let today = now.date_naive();
    let days = (today - last_import.date_naive()).num_days();
    if days < REMINDER_AFTER_DAYS {
        return None;
    }
    let already = reminded_on
        .and_then(|day| NaiveDate::parse_from_str(day, "%Y-%m-%d").ok())
        .is_some_and(|day| day >= today);
    (!already).then_some(days)
}

/// The reminder text. `role_id` is pinged.
#[must_use]
pub fn reminder_message(role_id: &str, days: i64) -> String {
    let left = GAME_LOG_DAYS - days;
    if left > 0 {
        format!(
            "<@&{role_id}> The Albion guild bank log was last imported {days} days ago. \
             Rows older than {GAME_LOG_DAYS} days leave the game log: {left} days left before \
             the first ones are lost. Export the silver log in game and import it on the Bank \
             log page."
        )
    } else {
        format!(
            "<@&{role_id}> The Albion guild bank log was last imported {days} days ago. Rows \
             older than {GAME_LOG_DAYS} days have already left the game log and cannot be \
             recovered. Import it now on the Bank log page to stop losing more."
        )
    }
}

/// What one reminder check did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReminderOutcome {
    NotDue,
    Sent { days: i64 },
    Skipped { reason: &'static str },
}

/// Checks one tenant and sends today's reminder when it is due.
pub async fn run_once(
    db: &DatabaseConnection,
    now: DateTime<Utc>,
    bot_token: Option<&str>,
) -> Result<ReminderOutcome, AppError> {
    let Some(settings) = GuildSettingsEntity::find_by_id(1).one(db).await? else {
        return Ok(ReminderOutcome::NotDue);
    };
    let last_import = EntryEntity::find()
        .order_by_desc(EntryColumn::ImportedAt)
        .one(db)
        .await?
        .map(|entry| entry.imported_at.with_timezone(&Utc));
    let Some(days) = reminder_due(last_import, settings.bank_log_reminded_on.as_deref(), now)
    else {
        if settings.bank_log_reminder_error.is_some() && last_import.is_some_and(|at| {
            (now.date_naive() - at.date_naive()).num_days() < REMINDER_AFTER_DAYS
        }) {
            // An import happened: an old failure no longer matters.
            let mut active: GuildSettingsActiveModel = settings.into();
            active.bank_log_reminder_error = Set(None);
            active.update(db).await?;
        }
        return Ok(ReminderOutcome::NotDue);
    };

    let channel = settings
        .discord_bank_log_channel_id
        .clone()
        .filter(|id| !id.trim().is_empty());
    let role = RoleEntity::find()
        .filter(RoleColumn::IsStaff.eq(true))
        .one(db)
        .await?
        .and_then(|role| role.discord_role_id)
        .filter(|id| !id.trim().is_empty());
    let skip = match (&channel, &role, bot_token) {
        (None, _, _) => Some(ERROR_MISSING_CHANNEL),
        (_, None, _) => Some(ERROR_MISSING_STAFF_ROLE),
        (_, _, None) => Some(ERROR_MISSING_BOT_TOKEN),
        _ => None,
    };
    if let Some(reason) = skip {
        if settings.bank_log_reminder_error.as_deref() != Some(reason) {
            let mut active: GuildSettingsActiveModel = settings.into();
            active.bank_log_reminder_error = Set(Some(reason.to_string()));
            active.update(db).await?;
        }
        return Ok(ReminderOutcome::Skipped { reason });
    }
    let (channel, role, token) = (
        channel.expect("checked"),
        role.expect("checked"),
        bot_token.expect("checked"),
    );
    let payload = serde_json::json!({
        "content": reminder_message(&role, days),
        "allowed_mentions": { "parse": [], "roles": [role] },
    });
    let sent = AuditService::send_discord_payload(&channel, token, payload).await;
    let mut active: GuildSettingsActiveModel = settings.into();
    if sent.is_some() {
        active.bank_log_reminded_on = Set(Some(now.date_naive().to_string()));
        active.bank_log_reminder_error = Set(None);
        active.update(db).await?;
        tracing::info!(days, "bank log import reminder sent");
        Ok(ReminderOutcome::Sent { days })
    } else {
        active.bank_log_reminder_error = Set(Some(ERROR_DISCORD_REFUSED.to_string()));
        active.update(db).await?;
        Ok(ReminderOutcome::Skipped {
            reason: ERROR_DISCORD_REFUSED,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> DateTime<Utc> {
        s.parse().unwrap()
    }

    #[test]
    fn no_import_means_no_reminder() {
        assert_eq!(reminder_due(None, None, at("2026-11-17T12:00:00Z")), None);
    }

    #[test]
    fn the_reminder_starts_on_day_five_and_repeats_daily() {
        let last = Some(at("2026-11-10T20:00:00Z"));
        assert_eq!(reminder_due(last, None, at("2026-11-14T23:00:00Z")), None);
        assert_eq!(reminder_due(last, None, at("2026-11-15T00:30:00Z")), Some(5));
        assert_eq!(
            reminder_due(last, Some("2026-11-15"), at("2026-11-15T18:00:00Z")),
            None
        );
        assert_eq!(
            reminder_due(last, Some("2026-11-15"), at("2026-11-16T08:00:00Z")),
            Some(6)
        );
    }

    #[test]
    fn the_message_counts_the_days_left() {
        assert!(reminder_message("1", 5).contains("23 days left"));
        assert!(reminder_message("1", 30).contains("cannot be recovered"));
        assert!(reminder_message("42", 5).starts_with("<@&42>"));
    }
}
