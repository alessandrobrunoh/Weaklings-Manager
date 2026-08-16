use super::entities::{self, ActiveModel};
use crate::config::Config;
use reqwest::Client;
use sea_orm::{ActiveModelTrait, DatabaseConnection, EntityTrait, Set};

pub struct AuditService;

impl AuditService {
    pub async fn log(
        db: &DatabaseConnection,
        action: &str,
        entity_type: Option<&str>,
        entity_id: Option<i64>,
        user_id: Option<i64>,
        details: Option<serde_json::Value>,
    ) -> Result<entities::Model, crate::errors::AppError> {
        let model = ActiveModel {
            action: Set(action.to_string()),
            entity_type: Set(entity_type.map(String::from)),
            entity_id: Set(entity_id),
            user_id: Set(user_id),
            details: Set(details.clone()),
            ..Default::default()
        };

        // Discord notifications are best-effort: a missing/misconfigured environment (e.g. unit
        // tests) must never abort the audit row write or the surrounding request.
        let cfg = match Config::try_from_env() {
            Ok(cfg) => cfg,
            Err(e) => {
                tracing::warn!("Skipping Discord notifications, config unavailable: {e}");
                return model
                    .insert(db)
                    .await
                    .map_err(crate::errors::AppError::Database);
            }
        };

        let inserted = model.insert(db).await?;

        let mut user_display = String::from("System");
        if let Some(uid) = user_id {
            if let Ok(Some(u)) = crate::modules::users::entities::Entity::find_by_id(uid)
                .one(db)
                .await
            {
                let discord_tag = u.discord_id.as_deref().unwrap_or("No Discord");
                user_display = format!("{} (<@{}>)", u.username, discord_tag);
            } else {
                user_display = format!("User ID {}", uid);
            }
        }

        let mut target_display = String::new();
        if let Some(details_val) = &details {
            if let Some(target_uid_val) = details_val.get("target_user_id") {
                if let Some(t_uid) = target_uid_val.as_i64() {
                    if let Ok(Some(u)) = crate::modules::users::entities::Entity::find_by_id(t_uid)
                        .one(db)
                        .await
                    {
                        let discord_tag = u.discord_id.as_deref().unwrap_or("No Discord");
                        target_display =
                            format!("\n**Target User:** {} (<@{}>)", u.username, discord_tag);
                    }
                }
            }
        }

        // Send to Discord audit log channel if configured
        if let Some(channel_id) = &cfg.discord_audit_log_channel_id {
            if let Some(token) = &cfg.discord_bot_token {
                let mut message = format!(
                    "**Audit Log:** `{}`\n**Entity:** `{:?}` (ID: {:?})\n**User:** {}{}\n**Details:**\n```json\n{}\n```",
                    action,
                    entity_type,
                    entity_id,
                    user_display,
                    target_display,
                    details.as_ref().map(|v| v.to_string()).unwrap_or_default()
                );
                Self::truncate_discord_msg(&mut message);
                let payload = serde_json::json!({ "content": message });
                Self::send_discord_payload(channel_id, token, payload).await;
            }
        }

        // Send transaction spam to Discord if configured
        if let Some(channel_id) = &cfg.discord_transaction_spam_channel_id {
            if let Some(token) = &cfg.discord_bot_token {
                if entity_type == Some("TRANSACTION") {
                    let mut message = format!(
                        "**Transaction Activity:** `{}`\n**Entity ID:** {:?}\n**User:** {}{}\n**Details:**\n```json\n{}\n```",
                        action,
                        entity_id,
                        user_display,
                        target_display,
                        serde_json::to_string_pretty(&inserted.details).unwrap_or_default()
                    );
                    Self::truncate_discord_msg(&mut message);

                    let mut payload = serde_json::json!({ "content": message });

                    if action == "WITHDRAW_REQUESTED" {
                        payload["components"] = serde_json::json!([{
                            "type": 1,
                            "components": [
                                {
                                    "type": 2,
                                    "style": 3,
                                    "custom_id": format!("bank:accept:{}", entity_id.unwrap_or(0)),
                                    "label": "Accept"
                                },
                                {
                                    "type": 2,
                                    "style": 4,
                                    "custom_id": format!("bank:reject:{}", entity_id.unwrap_or(0)),
                                    "label": "Reject"
                                }
                            ]
                        }]);
                    }

                    Self::send_discord_payload(channel_id, token, payload).await;
                }
            }
        }

        Ok(inserted)
    }

    fn truncate_discord_msg(content: &mut String) {
        if content.len() > 1900 {
            content.truncate(1900);
            content.push_str("\n... (truncated)");
            if content.contains("```json") {
                content.push_str("\n```");
            }
        }
    }

    /// Sends a payload to a Discord channel via the bot REST API, retrying on rate limits.
    ///
    /// Best-effort: failures are logged, never propagated, so audit trails and event
    /// announcements never fail because Discord is unreachable.
    pub(crate) async fn send_discord_payload(
        channel_id: &str,
        token: &str,
        payload: serde_json::Value,
    ) -> Option<serde_json::Value> {
        let client = Client::new();
        let url = format!(
            "https://discord.com/api/v10/channels/{}/messages",
            channel_id
        );

        let current_payload = payload.clone();
        for _attempt in 1..=3 {
            let resp = client
                .post(&url)
                .header("Authorization", format!("Bot {}", token))
                .json(&current_payload)
                .send()
                .await;

            match resp {
                Ok(res) if res.status() == reqwest::StatusCode::TOO_MANY_REQUESTS => {
                    if let Ok(json) = res.json::<serde_json::Value>().await {
                        if let Some(retry_after) = json.get("retry_after").and_then(|v| v.as_f64())
                        {
                            tracing::warn!(
                                "Discord rate limited. Retrying after {} seconds...",
                                retry_after
                            );
                            tokio::time::sleep(std::time::Duration::from_secs_f64(retry_after))
                                .await;
                            continue;
                        }
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                }
                Ok(res) if !res.status().is_success() => {
                    let status = res.status();
                    let text = res.text().await.unwrap_or_default();
                    tracing::warn!(
                        "Failed to send Discord message. Status: {}, Body: {}",
                        status,
                        text
                    );
                    return None;
                }
                Err(e) => {
                    tracing::warn!("Error sending Discord message: {}", e);
                    return None;
                }
                Ok(res) => match res.json::<serde_json::Value>().await {
                    Ok(json) => return Some(json),
                    Err(e) => {
                        tracing::warn!("Discord message sent but response parsing failed: {}", e);
                        return None;
                    }
                },
            }
        }

        None
    }
}
