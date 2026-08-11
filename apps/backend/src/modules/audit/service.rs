use super::entities::{self, ActiveModel};
use crate::config::Config;
use reqwest::Client;
use sea_orm::{ActiveModelTrait, DatabaseConnection, Set};
use serde_json::json;

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
        let cfg = Config::from_env();
        let model = ActiveModel {
            action: Set(action.to_string()),
            entity_type: Set(entity_type.map(String::from)),
            entity_id: Set(entity_id),
            user_id: Set(user_id),
            details: Set(details.clone()),
            ..Default::default()
        };

        let inserted = model.insert(db).await?;

        // Send to Discord audit log channel if configured
        if let Some(channel_id) = &cfg.discord_audit_log_channel_id {
            if let Some(token) = &cfg.discord_bot_token {
                let message = format!(
                    "**Audit Log:** `{}`\n**Entity:** `{:?}` (ID: {:?})\n**User ID:** {:?}\n**Details:**\n```json\n{}\n```",
                    action,
                    entity_type,
                    entity_id,
                    user_id,
                    details.map(|v| v.to_string()).unwrap_or_default()
                );
                Self::send_discord_message(channel_id, token, &message).await;
            }
        }

        // Send transaction spam to Discord if configured
        if let Some(channel_id) = &cfg.discord_transaction_spam_channel_id {
            if let Some(token) = &cfg.discord_bot_token {
                if entity_type == Some("TRANSACTION") {
                    let message = format!(
                        "**Transaction Activity:** `{}`\n**Entity ID:** {:?}\n**User ID:** {:?}\n**Details:**\n```json\n{}\n```",
                        action,
                        entity_id,
                        user_id,
                        serde_json::to_string_pretty(&inserted.details).unwrap_or_default()
                    );
                    Self::send_discord_message(channel_id, token, &message).await;
                }
            }
        }

        Ok(inserted)
    }

    async fn send_discord_message(channel_id: &str, token: &str, content: &str) {
        let client = Client::new();
        let url = format!(
            "https://discord.com/api/v10/channels/{}/messages",
            channel_id
        );

        let mut truncated_content = content.to_string();
        if truncated_content.len() > 1900 {
            truncated_content.truncate(1900);
            truncated_content.push_str("\n... (truncated)");
            if content.ends_with("```") {
                truncated_content.push_str("\n```");
            }
        }

        let _ = client
            .post(&url)
            .header("Authorization", format!("Bot {}", token))
            .json(&json!({ "content": truncated_content }))
            .send()
            .await;
    }
}
