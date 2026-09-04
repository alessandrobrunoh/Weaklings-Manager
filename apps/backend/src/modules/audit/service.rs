use super::entities::{self, ActiveModel};
use crate::config::Config;
use crate::errors::AppError;
use crate::modules::admin::service::AdminService;
use crate::pagination::{PaginatedData, PaginationParams, SortOrder, resolve_sort_key};
use reqwest::Client;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, PaginatorTrait, QueryFilter,
    QueryOrder, Set,
};

pub struct AuditService;

/// Filters for `GET /api/audit`.
#[derive(Debug, Clone, Default)]
pub struct AuditListFilters {
    pub action: Option<String>,
    pub entity_type: Option<String>,
    pub entity_id: Option<i64>,
    pub user_id: Option<i64>,
    pub search: Option<String>,
    pub sort: Option<String>,
    pub order: Option<String>,
}

impl AuditService {
    /// Lists audit rows with pagination, exact filters, optional action search, and sort.
    ///
    /// # Errors
    ///
    /// Returns `AppError::Validation` for an unknown `sort` column or `AppError::Database` if the
    /// query fails.
    pub async fn list(
        db: &DatabaseConnection,
        pagination: &PaginationParams,
        filters: &AuditListFilters,
    ) -> Result<PaginatedData<entities::Model>, AppError> {
        let mut query = entities::Entity::find();

        if let Some(action) = filters
            .action
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            query = query.filter(entities::Column::Action.eq(action));
        }
        if let Some(entity_type) = filters
            .entity_type
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            query = query.filter(entities::Column::EntityType.eq(entity_type));
        }
        if let Some(entity_id) = filters.entity_id {
            query = query.filter(entities::Column::EntityId.eq(entity_id));
        }
        if let Some(user_id) = filters.user_id {
            query = query.filter(entities::Column::UserId.eq(user_id));
        }
        if let Some(search) = filters
            .search
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let pattern = format!("%{}%", search.to_lowercase());
            query = query.filter(
                sea_orm::sea_query::Expr::expr(sea_orm::sea_query::Func::lower(
                    sea_orm::sea_query::Expr::col(entities::Column::Action),
                ))
                .like(pattern),
            );
        }

        let sort_column = resolve_sort_key(
            filters.sort.as_deref(),
            &[
                ("created_at", entities::Column::CreatedAt),
                ("action", entities::Column::Action),
                ("entity_type", entities::Column::EntityType),
                ("user_id", entities::Column::UserId),
            ],
            entities::Column::CreatedAt,
        )?;
        let order = SortOrder::from_query(filters.order.as_deref());
        query = match order {
            SortOrder::Asc => query
                .order_by_asc(sort_column)
                .order_by_asc(entities::Column::Id),
            SortOrder::Desc => query
                .order_by_desc(sort_column)
                .order_by_desc(entities::Column::Id),
        };

        let limit = pagination.limit();
        let page = pagination.offset_page();
        let paginator = query.paginate(db, limit);
        let total_items = paginator.num_items().await?;
        let total_pages = paginator.num_pages().await?;
        let items = paginator.fetch_page(page).await?;
        Ok(PaginatedData::new(
            items,
            total_items,
            total_pages,
            page + 1,
            limit,
        ))
    }

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
            split_id: Set(details
                .as_ref()
                .and_then(|value| value.get("split_id"))
                .and_then(serde_json::Value::as_i64)
                .or_else(|| {
                    (entity_type == Some("SPLIT"))
                        .then_some(entity_id)
                        .flatten()
                })),
            user_id: Set(user_id),
            details: Set(details.clone()),
            ..Default::default()
        };

        // Discord notifications are best-effort: a missing/misconfigured environment (e.g. unit
        // tests) must never abort the audit row write or the surrounding request. The bot token
        // itself is still a deployment secret (an env var, not something an admin edits), but the
        // channel IDs now live in `guild_settings` — moved off env vars so they are editable from
        // the admin UI without a redeploy.
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
        let guild_settings = AdminService::get_guild_settings(db).await.ok();

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

        let entity_type_display = entity_type.unwrap_or("—");
        let entity_id_display = entity_id
            .map(|id| id.to_string())
            .unwrap_or_else(|| "—".to_string());

        // Send to Discord audit log channel if configured
        let audit_channel_id = guild_settings
            .as_ref()
            .and_then(|s| s.discord_audit_log_channel_id.as_ref());
        if let Some(channel_id) = audit_channel_id {
            if let Some(token) = &cfg.discord_bot_token {
                let color = if action.contains("REVOKE")
                    || action.contains("DELETE")
                    || action.contains("CANCEL")
                    || action.contains("FAIL")
                {
                    15548997 // Crimson Red
                } else if action.contains("WARN") || action.contains("REJECT") {
                    16705372 // Amber Yellow
                } else {
                    12951641 // Albion Gold / Brand
                };

                let mut fields = vec![
                    serde_json::json!({
                        "name": "👤 Operator",
                        "value": user_display,
                        "inline": true
                    }),
                    serde_json::json!({
                        "name": "🎯 Entity",
                        "value": format!("`{}` (ID: {})", entity_type_display, entity_id_display),
                        "inline": true
                    }),
                ];

                if !target_display.trim().is_empty() {
                    fields.push(serde_json::json!({
                        "name": "🎯 Target User",
                        "value": target_display.replace("\n**Target User:** ", ""),
                        "inline": true
                    }));
                }

                if let Some(det) = &details {
                    let mut det_str = serde_json::to_string_pretty(det).unwrap_or_default();
                    if det_str.len() > 1000 {
                        det_str.truncate(1000);
                        det_str.push_str("\n... (truncated)");
                    }
                    fields.push(serde_json::json!({
                        "name": "📝 Details",
                        "value": format!("```json\n{}\n```", det_str),
                        "inline": false
                    }));
                }

                let embed = serde_json::json!({
                    "author": { "name": "⚔️ WEAKLINGS — AUDIT LOG" },
                    "title": format!("🛡️ Action: `{}`", action),
                    "description": format!("*Audit trail entry for `{}` (ID: {})*", entity_type_display, entity_id_display),
                    "color": color,
                    "fields": fields,
                    "footer": { "text": format!("Audit Log #{} • Weaklings Security", inserted.id) },
                    "timestamp": chrono::Utc::now().to_rfc3339()
                });

                let payload = serde_json::json!({ "embeds": [embed] });
                Self::send_discord_payload(channel_id, token, payload).await;
            }
        }

        // Send transaction spam to Discord if configured
        let spam_channel_id = guild_settings
            .as_ref()
            .and_then(|s| s.discord_transaction_spam_channel_id.as_ref());
        if let Some(channel_id) = spam_channel_id {
            if let Some(token) = &cfg.discord_bot_token {
                if entity_type == Some("TRANSACTION") {
                    let is_withdraw = action == "WITHDRAW_REQUESTED";
                    let title = if is_withdraw {
                        format!("💸 Withdrawal Request #{}", entity_id_display)
                    } else {
                        format!("💰 Vault Transaction: `{}`", action)
                    };

                    let color = if is_withdraw {
                        16705372 // Amber
                    } else if action.contains("ACCEPT") || action.contains("COMPLETE") {
                        3066993 // Green
                    } else if action.contains("REJECT") {
                        15548997 // Red
                    } else {
                        12951641 // Gold
                    };

                    let mut fields = vec![serde_json::json!({
                        "name": "👤 Member",
                        "value": user_display,
                        "inline": true
                    })];

                    if let Some(amount_val) = details
                        .as_ref()
                        .and_then(|d| d.get("amount"))
                        .and_then(serde_json::Value::as_i64)
                    {
                        fields.push(serde_json::json!({
                            "name": "💵 Amount",
                            "value": format!("**{}** Silver", amount_val),
                            "inline": true
                        }));
                    }

                    if !target_display.trim().is_empty() {
                        fields.push(serde_json::json!({
                            "name": "🎯 Target",
                            "value": target_display.replace("\n**Target User:** ", ""),
                            "inline": true
                        }));
                    }

                    if let Some(det) = &inserted.details {
                        let mut det_str = serde_json::to_string_pretty(det).unwrap_or_default();
                        if det_str.len() > 1000 {
                            det_str.truncate(1000);
                            det_str.push_str("\n... (truncated)");
                        }
                        fields.push(serde_json::json!({
                            "name": "📋 Transaction Details",
                            "value": format!("```json\n{}\n```", det_str),
                            "inline": false
                        }));
                    }

                    let embed = serde_json::json!({
                        "author": { "name": "⚔️ WEAKLINGS — GUILD VAULT" },
                        "title": title,
                        "description": format!("*Transaction Activity: `{}` · Entity #{}*", action, entity_id_display),
                        "color": color,
                        "fields": fields,
                        "footer": { "text": format!("Transaction #{} • Automated Banking Alert", entity_id_display) },
                        "timestamp": chrono::Utc::now().to_rfc3339()
                    });

                    let mut payload = serde_json::json!({ "embeds": [embed] });

                    if is_withdraw {
                        payload["components"] = serde_json::json!([{
                            "type": 1,
                            "components": [
                                {
                                    "type": 2,
                                    "style": 3,
                                    "custom_id": format!("bank:accept:{}", entity_id.unwrap_or(0)),
                                    "label": "Accept",
                                    "emoji": { "name": "✅" }
                                },
                                {
                                    "type": 2,
                                    "style": 4,
                                    "custom_id": format!("bank:reject:{}", entity_id.unwrap_or(0)),
                                    "label": "Reject",
                                    "emoji": { "name": "❌" }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migration::MigratorTrait;
    use sea_orm::Database;

    async fn seed_db() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:").await.expect("connect");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("migrate");
        db
    }

    async fn insert_log(db: &DatabaseConnection, action: &str, entity_type: Option<&str>) {
        ActiveModel {
            action: Set(action.to_string()),
            entity_type: Set(entity_type.map(str::to_string)),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert audit log");
    }

    #[tokio::test]
    async fn list_sorts_by_created_at_and_filters_action() {
        let db = seed_db().await;
        insert_log(&db, "WARN_ISSUE", Some("USER_WARN")).await;
        insert_log(&db, "WARN_REVOKE", Some("USER_WARN")).await;
        insert_log(&db, "EVENT_CREATED", Some("EVENT")).await;

        let filtered = AuditService::list(
            &db,
            &PaginationParams {
                page: Some(1),
                limit: Some(20),
            },
            &AuditListFilters {
                action: Some("WARN_ISSUE".into()),
                ..AuditListFilters::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(filtered.total_items, 1);
        assert_eq!(filtered.items[0].action, "WARN_ISSUE");

        let newest_first = AuditService::list(
            &db,
            &PaginationParams {
                page: Some(1),
                limit: Some(20),
            },
            &AuditListFilters {
                sort: Some("created_at".into()),
                order: Some("desc".into()),
                ..AuditListFilters::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(newest_first.items[0].action, "EVENT_CREATED");

        let oldest_first = AuditService::list(
            &db,
            &PaginationParams {
                page: Some(1),
                limit: Some(20),
            },
            &AuditListFilters {
                sort: Some("created_at".into()),
                order: Some("asc".into()),
                ..AuditListFilters::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(oldest_first.items[0].action, "WARN_ISSUE");
    }

    #[tokio::test]
    async fn list_rejects_unknown_sort_column() {
        let db = seed_db().await;
        let error = AuditService::list(
            &db,
            &PaginationParams {
                page: Some(1),
                limit: Some(20),
            },
            &AuditListFilters {
                sort: Some("fame".into()),
                ..AuditListFilters::default()
            },
        )
        .await
        .unwrap_err();
        match error {
            AppError::Validation(message) => assert!(message.contains("fame")),
            other => panic!("expected validation, got {other:?}"),
        }
    }
}
