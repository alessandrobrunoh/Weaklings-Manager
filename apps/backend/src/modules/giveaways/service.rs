//! Create, enter, leave, cancel, and draw guild giveaways.

use std::collections::HashMap;
use std::str::FromStr;

use chrono::Utc;
use rand::seq::SliceRandom;
use sea_orm::prelude::Decimal;
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, PaginatorTrait, QueryFilter,
    QueryOrder, Set, TransactionTrait,
};

use crate::errors::AppError;
use crate::modules::audit::service::AuditService;
use crate::modules::bank::entities::{ActiveModel as BankActiveModel, Entity as BankEntity};
use crate::modules::bank::status::TransactionStatus;
use crate::modules::comps::status::{icon_url_with_quality, parse_item_quality};
use crate::modules::notifications::models::NotifySpec;
use crate::modules::notifications::service::notify_best_effort;
use crate::modules::notifications::status::NotificationKind;
use crate::modules::users::entities::{
    Column as UserColumn, Entity as UserEntity, Model as UserModel,
};
use crate::pagination::{PaginatedData, PaginationParams, SortOrder, resolve_sort_key};

use super::entities::{
    GiveawayActiveModel, GiveawayColumn, GiveawayEntity, GiveawayEntryActiveModel,
    GiveawayEntryColumn, GiveawayEntryEntity, GiveawayModel, GiveawayPrizeActiveModel,
    GiveawayPrizeColumn, GiveawayPrizeEntity, GiveawayPrizeModel,
};
use super::models::{
    CreateGiveawayPrizeRequest, CreateGiveawayRequest, GiveawayDetailView, GiveawayEntryView,
    GiveawayFilters, GiveawayPrizeView, GiveawayView, SetGiveawayDiscordMessageRequest,
};
use super::status::GiveawayStatus;

/// Guild Bank ledger type written when a silver prize is awarded.
pub const TYPE_GIVEAWAY_CREDIT: &str = "giveaway_credit";

/// Stateless giveaway operations.
pub struct GiveawayService;

impl GiveawayService {
    /// Creates a new instance.
    #[must_use]
    pub fn new() -> Self {
        Self
    }

    /// Lists giveaways newest-first unless another sort is requested.
    ///
    /// # Errors
    ///
    /// Unknown sort column or database failure.
    pub async fn list(
        &self,
        db: &DatabaseConnection,
        pagination: &PaginationParams,
        filters: &GiveawayFilters,
    ) -> Result<PaginatedData<GiveawayView>, AppError> {
        let mut query = GiveawayEntity::find();
        if let Some(status) = filters.status {
            query = query.filter(GiveawayColumn::Status.eq(status.as_str()));
        }
        if let Some(search) = filters
            .search
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let pattern = format!("%{}%", search.to_lowercase());
            query = query
                .filter(Expr::expr(Func::lower(Expr::col(GiveawayColumn::Title))).like(pattern));
        }

        let sort = resolve_sort_key(
            filters.sort.as_deref(),
            &[
                ("created_at", GiveawayColumn::CreatedAt),
                ("ends_at", GiveawayColumn::EndsAt),
                ("title", GiveawayColumn::Title),
                ("status", GiveawayColumn::Status),
            ],
            GiveawayColumn::CreatedAt,
        )?;
        query = match SortOrder::from_query(filters.order.as_deref()) {
            SortOrder::Asc => query.order_by_asc(sort).order_by_asc(GiveawayColumn::Id),
            SortOrder::Desc => query.order_by_desc(sort).order_by_desc(GiveawayColumn::Id),
        };

        let limit = pagination.limit();
        let page = pagination.offset_page();
        let paginator = query.paginate(db, limit);
        let total_items = paginator.num_items().await?;
        let total_pages = paginator.num_pages().await?;
        let models = paginator.fetch_page(page).await?;
        let views = to_views(db, &models).await?;
        Ok(PaginatedData::new(
            views,
            total_items,
            total_pages,
            page + 1,
            limit,
        ))
    }

    /// Returns one giveaway with every entry.
    ///
    /// # Errors
    ///
    /// Missing row or database failure.
    pub async fn get(
        &self,
        db: &DatabaseConnection,
        id: i64,
    ) -> Result<GiveawayDetailView, AppError> {
        let model = GiveawayEntity::find_by_id(id)
            .one(db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("giveaway {id} not found")))?;
        let views = to_views(db, std::slice::from_ref(&model)).await?;
        let giveaway = views
            .into_iter()
            .next()
            .ok_or_else(|| AppError::Internal("giveaway view vanished".to_string()))?;
        let entries = load_entries(db, id).await?;
        Ok(GiveawayDetailView { giveaway, entries })
    }

    /// Creates an open giveaway.
    ///
    /// # Errors
    ///
    /// Validation (empty title, past deadline, no prizes) or database failure.
    pub async fn create(
        &self,
        db: &DatabaseConnection,
        creator_id: i64,
        req: CreateGiveawayRequest,
    ) -> Result<GiveawayDetailView, AppError> {
        if creator_id <= 0 {
            return Err(AppError::Unauthorized(
                "giveaways can only be created by a linked user".to_string(),
            ));
        }
        let title = req.title.trim();
        if title.is_empty() {
            return Err(AppError::Validation("title is required".to_string()));
        }
        if title.len() > 120 {
            return Err(AppError::Validation(
                "title must be at most 120 characters".to_string(),
            ));
        }
        let description = req
            .description
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);
        if description.as_ref().is_some_and(|value| value.len() > 2000) {
            return Err(AppError::Validation(
                "description must be at most 2000 characters".to_string(),
            ));
        }
        let ends_at = chrono::DateTime::parse_from_rfc3339(req.ends_at.trim())
            .map_err(|_| AppError::Validation("ends_at must be an RFC 3339 timestamp".to_string()))?
            .with_timezone(&Utc);
        if ends_at <= Utc::now() {
            return Err(AppError::Validation(
                "ends_at must be in the future".to_string(),
            ));
        }
        let silver = normalize_silver(req.silver_amount)?;
        if req.prizes.is_empty() && silver.is_none() {
            return Err(AppError::Validation(
                "add at least one item prize or a silver amount".to_string(),
            ));
        }
        let prizes = req
            .prizes
            .into_iter()
            .map(validate_prize)
            .collect::<Result<Vec<_>, _>>()?;

        let txn = db.begin().await?;
        let inserted = GiveawayActiveModel {
            title: Set(title.to_string()),
            description: Set(description),
            ends_at: Set(ends_at.into()),
            status: Set(GiveawayStatus::Open.as_str().to_string()),
            created_by: Set(creator_id),
            silver_amount: Set(silver),
            ..Default::default()
        }
        .insert(&txn)
        .await?;

        for prize in prizes {
            GiveawayPrizeActiveModel {
                giveaway_id: Set(inserted.id),
                openalbion_item_id: Set(prize.openalbion_item_id),
                openalbion_item_name: Set(prize.openalbion_item_name),
                openalbion_item_icon: Set(prize.openalbion_item_icon),
                openalbion_item_identifier: Set(prize.openalbion_item_identifier),
                openalbion_item_tier: Set(prize.openalbion_item_tier),
                openalbion_item_quality: Set(prize.openalbion_item_quality),
                quantity: Set(prize.quantity),
                ..Default::default()
            }
            .insert(&txn)
            .await?;
        }
        txn.commit().await?;

        let _ = AuditService::log(
            db,
            "GIVEAWAY_CREATED",
            Some("GIVEAWAY"),
            Some(inserted.id),
            Some(creator_id),
            Some(serde_json::json!({ "title": inserted.title })),
        )
        .await;

        self.get(db, inserted.id).await
    }

    /// Adds the caller to an open giveaway. A second enter is a no-op.
    ///
    /// # Errors
    ///
    /// Closed/expired giveaway, unlinked bot-system user, or database failure.
    pub async fn enter(
        &self,
        db: &DatabaseConnection,
        giveaway_id: i64,
        user_id: i64,
    ) -> Result<GiveawayDetailView, AppError> {
        if user_id <= 0 {
            return Err(AppError::Unauthorized(
                "link your Discord account with /link before entering a giveaway".to_string(),
            ));
        }
        let model = require_open_for_entries(db, giveaway_id).await?;
        GiveawayEntryActiveModel {
            giveaway_id: Set(model.id),
            user_id: Set(user_id),
            ..Default::default()
        }
        .insert(db)
        .await
        .map(|_| ())
        .or_else(|error| {
            if matches!(
                error.sql_err(),
                Some(sea_orm::SqlErr::UniqueConstraintViolation(_))
            ) {
                Ok(())
            } else {
                Err(AppError::Database(error))
            }
        })?;
        self.get(db, giveaway_id).await
    }

    /// Removes the caller from an open giveaway. Leaving when not entered is a no-op.
    ///
    /// # Errors
    ///
    /// Closed giveaway or database failure.
    pub async fn leave(
        &self,
        db: &DatabaseConnection,
        giveaway_id: i64,
        user_id: i64,
    ) -> Result<GiveawayDetailView, AppError> {
        if user_id <= 0 {
            return Err(AppError::Unauthorized(
                "link your Discord account with /link before leaving a giveaway".to_string(),
            ));
        }
        let _ = require_open_for_entries(db, giveaway_id).await?;
        GiveawayEntryEntity::delete_many()
            .filter(GiveawayEntryColumn::GiveawayId.eq(giveaway_id))
            .filter(GiveawayEntryColumn::UserId.eq(user_id))
            .exec(db)
            .await?;
        self.get(db, giveaway_id).await
    }

    /// Cancels an open giveaway. Already-terminal rows are rejected.
    ///
    /// # Errors
    ///
    /// Missing row, conflict if not open, or database failure.
    pub async fn cancel(
        &self,
        db: &DatabaseConnection,
        giveaway_id: i64,
        officer_id: i64,
    ) -> Result<GiveawayDetailView, AppError> {
        let now = Utc::now();
        let flip = GiveawayEntity::update_many()
            .filter(GiveawayColumn::Id.eq(giveaway_id))
            .filter(GiveawayColumn::Status.eq(GiveawayStatus::Open.as_str()))
            .set(GiveawayActiveModel {
                status: Set(GiveawayStatus::Cancelled.as_str().to_string()),
                cancelled_at: Set(Some(now.into())),
                cancelled_by: Set(Some(officer_id)),
                ..Default::default()
            })
            .exec(db)
            .await?;
        if flip.rows_affected != 1 {
            let existing = GiveawayEntity::find_by_id(giveaway_id)
                .one(db)
                .await?
                .ok_or_else(|| AppError::NotFound(format!("giveaway {giveaway_id} not found")))?;
            return Err(AppError::Conflict(format!(
                "giveaway {giveaway_id} is not open (status: {})",
                existing.status
            )));
        }
        let _ = AuditService::log(
            db,
            "GIVEAWAY_CANCELLED",
            Some("GIVEAWAY"),
            Some(giveaway_id),
            Some(officer_id),
            None,
        )
        .await;
        self.get(db, giveaway_id).await
    }

    /// Draws a winner for one giveaway.
    ///
    /// `force` is the officer "Draw now" path and ignores `ends_at`. The worker path
    /// (`force = false`) only draws after the deadline. Already-drawn rows return the
    /// existing snapshot so two callers cannot credit silver twice.
    ///
    /// # Errors
    ///
    /// Missing row, conflict if cancelled, or database failure.
    pub async fn draw(
        &self,
        db: &DatabaseConnection,
        giveaway_id: i64,
        force: bool,
    ) -> Result<GiveawayDetailView, AppError> {
        let txn = db.begin().await?;
        let model = GiveawayEntity::find_by_id(giveaway_id)
            .one(&txn)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("giveaway {giveaway_id} not found")))?;
        let status = GiveawayStatus::from_str(&model.status)
            .map_err(|err| AppError::Internal(format!("invalid giveaway status: {err}")))?;
        if status.is_terminal() {
            txn.commit().await?;
            return self.get(db, giveaway_id).await;
        }
        let now = Utc::now();
        if !force && model.ends_at.with_timezone(&Utc) > now {
            txn.commit().await?;
            return Err(AppError::Conflict(
                "giveaway has not reached its deadline".to_string(),
            ));
        }

        let entries = GiveawayEntryEntity::find()
            .filter(GiveawayEntryColumn::GiveawayId.eq(giveaway_id))
            .all(&txn)
            .await?;

        if entries.is_empty() {
            let flip = GiveawayEntity::update_many()
                .filter(GiveawayColumn::Id.eq(giveaway_id))
                .filter(GiveawayColumn::Status.eq(GiveawayStatus::Open.as_str()))
                .set(GiveawayActiveModel {
                    status: Set(GiveawayStatus::ExpiredEmpty.as_str().to_string()),
                    drawn_at: Set(Some(now.into())),
                    ..Default::default()
                })
                .exec(&txn)
                .await?;
            if flip.rows_affected != 1 {
                txn.commit().await?;
                return self.get(db, giveaway_id).await;
            }
            txn.commit().await?;
            let _ = AuditService::log(
                db,
                "GIVEAWAY_EXPIRED_EMPTY",
                Some("GIVEAWAY"),
                Some(giveaway_id),
                None,
                None,
            )
            .await;
            return self.get(db, giveaway_id).await;
        }

        let winner = entries.choose(&mut rand::thread_rng()).ok_or_else(|| {
            AppError::Internal("giveaway had entries but choose returned none".to_string())
        })?;
        let winner_user_id = winner.user_id;

        let mut silver_transaction_id = None;
        if let Some(amount) = model.silver_amount.filter(|value| *value > Decimal::ZERO) {
            let credit = BankActiveModel {
                from_user_id: Set(None),
                to_user_id: Set(winner_user_id),
                to_guild_bank: Set(false),
                amount: Set(amount),
                status: Set(TransactionStatus::Pending.to_string()),
                r#type: Set(TYPE_GIVEAWAY_CREDIT.to_string()),
                split_id: Set(None),
                created_at: Set(now.into()),
                requested_at: Set(None),
                withdrawn_at: Set(None),
                updated_at: Set(now.into()),
                ..Default::default()
            }
            .insert(&txn)
            .await?;
            silver_transaction_id = Some(credit.id);
        }

        let flip = GiveawayEntity::update_many()
            .filter(GiveawayColumn::Id.eq(giveaway_id))
            .filter(GiveawayColumn::Status.eq(GiveawayStatus::Open.as_str()))
            .set(GiveawayActiveModel {
                status: Set(GiveawayStatus::Drawn.as_str().to_string()),
                winner_user_id: Set(Some(winner_user_id)),
                drawn_at: Set(Some(now.into())),
                silver_transaction_id: Set(silver_transaction_id),
                ..Default::default()
            })
            .exec(&txn)
            .await?;
        if flip.rows_affected != 1 {
            if let Some(tx_id) = silver_transaction_id {
                BankEntity::delete_by_id(tx_id).exec(&txn).await?;
            }
            txn.commit().await?;
            return self.get(db, giveaway_id).await;
        }
        txn.commit().await?;

        let _ = AuditService::log(
            db,
            "GIVEAWAY_DRAWN",
            Some("GIVEAWAY"),
            Some(giveaway_id),
            None,
            Some(serde_json::json!({
                "winner_user_id": winner_user_id,
                "silver_transaction_id": silver_transaction_id,
            })),
        )
        .await;
        notify_best_effort(
            db,
            NotifySpec {
                kind: NotificationKind::GiveawayWon,
                user_ids: std::slice::from_ref(&winner_user_id),
                title: "You won a giveaway".into(),
                body: format!("You won: {}", model.title),
                link_path: model
                    .silver_amount
                    .filter(|amount| *amount > Decimal::ZERO)
                    .map(|_| "/bank".to_string()),
                source_type: "giveaway",
                source_id: giveaway_id,
                created_by_user_id: None,
            },
        )
        .await;

        self.get(db, giveaway_id).await
    }

    /// Draws every open giveaway whose deadline has elapsed.
    ///
    /// Failures on one row are logged and do not abort the rest of the batch.
    ///
    /// # Errors
    ///
    /// Database failure listing due giveaways.
    pub async fn draw_due(&self, db: &DatabaseConnection) -> Result<(), AppError> {
        let now = Utc::now();
        let due = GiveawayEntity::find()
            .filter(GiveawayColumn::Status.eq(GiveawayStatus::Open.as_str()))
            .filter(GiveawayColumn::EndsAt.lte(now))
            .all(db)
            .await?;
        for giveaway in due {
            if let Err(error) = self.draw(db, giveaway.id, false).await {
                tracing::warn!(giveaway_id = giveaway.id, error = %error, "giveaway auto-draw failed");
            }
        }
        Ok(())
    }

    /// Stores the Discord announcement coordinates so later edits can find the message.
    ///
    /// # Errors
    ///
    /// Missing row or database failure.
    pub async fn set_discord_message(
        &self,
        db: &DatabaseConnection,
        giveaway_id: i64,
        req: SetGiveawayDiscordMessageRequest,
    ) -> Result<GiveawayDetailView, AppError> {
        let message_id = req.message_id.trim();
        let channel_id = req.channel_id.trim();
        if message_id.is_empty() || channel_id.is_empty() {
            return Err(AppError::Validation(
                "message_id and channel_id are required".to_string(),
            ));
        }
        let flip = GiveawayEntity::update_many()
            .filter(GiveawayColumn::Id.eq(giveaway_id))
            .set(GiveawayActiveModel {
                discord_message_id: Set(Some(message_id.to_string())),
                discord_channel_id: Set(Some(channel_id.to_string())),
                ..Default::default()
            })
            .exec(db)
            .await?;
        if flip.rows_affected != 1 {
            return Err(AppError::NotFound(format!(
                "giveaway {giveaway_id} not found"
            )));
        }
        self.get(db, giveaway_id).await
    }
}

impl Default for GiveawayService {
    fn default() -> Self {
        Self::new()
    }
}

struct ValidatedPrize {
    openalbion_item_id: i64,
    openalbion_item_name: String,
    openalbion_item_icon: Option<String>,
    openalbion_item_identifier: Option<String>,
    openalbion_item_tier: Option<String>,
    openalbion_item_quality: i16,
    quantity: i32,
}

fn validate_prize(req: CreateGiveawayPrizeRequest) -> Result<ValidatedPrize, AppError> {
    let name = req.openalbion_item_name.trim();
    if name.is_empty() {
        return Err(AppError::Validation("prize name is required".to_string()));
    }
    if req.openalbion_item_id <= 0 {
        return Err(AppError::Validation(
            "prize item id must be a positive OpenAlbion id".to_string(),
        ));
    }
    let quality = parse_item_quality(req.openalbion_item_quality).map_err(AppError::Validation)?;
    let quantity = req.quantity.unwrap_or(1);
    if quantity < 1 {
        return Err(AppError::Validation(
            "prize quantity must be at least 1".to_string(),
        ));
    }
    Ok(ValidatedPrize {
        openalbion_item_id: req.openalbion_item_id,
        openalbion_item_name: name.to_string(),
        openalbion_item_icon: icon_url_with_quality(req.openalbion_item_icon.as_deref(), quality),
        openalbion_item_identifier: req
            .openalbion_item_identifier
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned),
        openalbion_item_tier: req
            .openalbion_item_tier
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned),
        openalbion_item_quality: quality,
        quantity,
    })
}

fn normalize_silver(amount: Option<Decimal>) -> Result<Option<Decimal>, AppError> {
    let Some(amount) = amount else {
        return Ok(None);
    };
    if amount.is_sign_negative() || amount.is_zero() {
        return Ok(None);
    }
    if amount.scale() > 2 {
        return Err(AppError::Validation(
            "silver amount must have at most two decimal places".to_string(),
        ));
    }
    Ok(Some(amount))
}

async fn require_open_for_entries(
    db: &DatabaseConnection,
    giveaway_id: i64,
) -> Result<GiveawayModel, AppError> {
    let model = GiveawayEntity::find_by_id(giveaway_id)
        .one(db)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("giveaway {giveaway_id} not found")))?;
    let status = GiveawayStatus::from_str(&model.status)
        .map_err(|err| AppError::Internal(format!("invalid giveaway status: {err}")))?;
    if status != GiveawayStatus::Open {
        return Err(AppError::Conflict(format!(
            "giveaway {giveaway_id} is not open"
        )));
    }
    if model.ends_at.with_timezone(&Utc) <= Utc::now() {
        return Err(AppError::Conflict("this giveaway has ended".to_string()));
    }
    Ok(model)
}

async fn to_views(
    db: &DatabaseConnection,
    models: &[GiveawayModel],
) -> Result<Vec<GiveawayView>, AppError> {
    if models.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<i64> = models.iter().map(|model| model.id).collect();
    let user_ids: Vec<i64> = models
        .iter()
        .flat_map(|model| [Some(model.created_by), model.winner_user_id])
        .flatten()
        .collect();

    let users = UserEntity::find()
        .filter(UserColumn::Id.is_in(user_ids))
        .all(db)
        .await?;
    let users_by_id: HashMap<i64, UserModel> =
        users.into_iter().map(|user| (user.id, user)).collect();

    let prizes = GiveawayPrizeEntity::find()
        .filter(GiveawayPrizeColumn::GiveawayId.is_in(ids.clone()))
        .order_by_asc(GiveawayPrizeColumn::Id)
        .all(db)
        .await?;
    let mut prizes_by_giveaway: HashMap<i64, Vec<GiveawayPrizeModel>> = HashMap::new();
    for prize in prizes {
        prizes_by_giveaway
            .entry(prize.giveaway_id)
            .or_default()
            .push(prize);
    }

    let mut counts: HashMap<i64, u64> = HashMap::new();
    let entry_rows = GiveawayEntryEntity::find()
        .filter(GiveawayEntryColumn::GiveawayId.is_in(ids))
        .all(db)
        .await?;
    for entry in entry_rows {
        *counts.entry(entry.giveaway_id).or_insert(0) += 1;
    }

    models
        .iter()
        .map(|model| {
            let status = GiveawayStatus::from_str(&model.status)
                .map_err(|err| AppError::Internal(format!("invalid giveaway status: {err}")))?;
            let creator = users_by_id.get(&model.created_by);
            let winner = model.winner_user_id.and_then(|id| users_by_id.get(&id));
            Ok(GiveawayView {
                id: model.id,
                title: model.title.clone(),
                description: model.description.clone(),
                ends_at: model.ends_at.to_rfc3339(),
                status,
                created_by: model.created_by,
                created_by_username: creator
                    .map(|user| user.username.clone())
                    .unwrap_or_else(|| model.created_by.to_string()),
                created_at: model.created_at.to_rfc3339(),
                silver_amount: model.silver_amount,
                winner_user_id: model.winner_user_id,
                winner_username: winner.map(|user| user.username.clone()),
                winner_discord_id: winner.and_then(|user| user.discord_id.clone()),
                drawn_at: model.drawn_at.map(|value| value.to_rfc3339()),
                silver_transaction_id: model.silver_transaction_id,
                discord_message_id: model.discord_message_id.clone(),
                discord_channel_id: model.discord_channel_id.clone(),
                entry_count: counts.get(&model.id).copied().unwrap_or(0),
                prizes: prizes_by_giveaway
                    .get(&model.id)
                    .into_iter()
                    .flatten()
                    .map(|prize| GiveawayPrizeView {
                        id: prize.id,
                        openalbion_item_id: prize.openalbion_item_id,
                        openalbion_item_name: prize.openalbion_item_name.clone(),
                        openalbion_item_icon: icon_url_with_quality(
                            prize.openalbion_item_icon.as_deref(),
                            prize.openalbion_item_quality,
                        ),
                        openalbion_item_identifier: prize.openalbion_item_identifier.clone(),
                        openalbion_item_tier: prize.openalbion_item_tier.clone(),
                        openalbion_item_quality: prize.openalbion_item_quality,
                        quantity: prize.quantity,
                    })
                    .collect(),
            })
        })
        .collect()
}

async fn load_entries(
    db: &DatabaseConnection,
    giveaway_id: i64,
) -> Result<Vec<GiveawayEntryView>, AppError> {
    let entries = GiveawayEntryEntity::find()
        .filter(GiveawayEntryColumn::GiveawayId.eq(giveaway_id))
        .order_by_asc(GiveawayEntryColumn::EnteredAt)
        .order_by_asc(GiveawayEntryColumn::Id)
        .all(db)
        .await?;
    if entries.is_empty() {
        return Ok(Vec::new());
    }
    let user_ids: Vec<i64> = entries.iter().map(|entry| entry.user_id).collect();
    let users = UserEntity::find()
        .filter(UserColumn::Id.is_in(user_ids))
        .all(db)
        .await?;
    let users_by_id: HashMap<i64, UserModel> =
        users.into_iter().map(|user| (user.id, user)).collect();
    Ok(entries
        .into_iter()
        .map(|entry| {
            let user = users_by_id.get(&entry.user_id);
            GiveawayEntryView {
                id: entry.id,
                user_id: entry.user_id,
                username: user
                    .map(|row| row.username.clone())
                    .unwrap_or_else(|| entry.user_id.to_string()),
                discord_id: user.and_then(|row| row.discord_id.clone()),
                entered_at: entry.entered_at.to_rfc3339(),
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;
    use sea_orm::{ActiveModelTrait, Database, Set};

    use crate::migration::MigratorTrait;
    use crate::modules::users::entities::ActiveModel as UserActiveModel;

    async fn seed_db() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("sqlite memory");
        crate::migration::Migrator::up(&db, None)
            .await
            .expect("migrations");
        db
    }

    async fn insert_user(db: &DatabaseConnection, username: &str) -> i64 {
        UserActiveModel {
            username: Set(username.to_string()),
            email: Set(format!("{username}@example.com")),
            role: Set("User".to_string()),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("user")
        .id
    }

    fn future_rfc3339() -> String {
        (Utc::now() + Duration::hours(2)).to_rfc3339()
    }

    fn past_rfc3339() -> String {
        (Utc::now() - Duration::hours(1)).to_rfc3339()
    }

    fn sword() -> CreateGiveawayPrizeRequest {
        CreateGiveawayPrizeRequest {
            openalbion_item_id: 1,
            openalbion_item_name: "Broadsword".to_string(),
            openalbion_item_icon: Some(
                "https://render.albiononline.com/v1/item/T8_MAIN_SWORD.png?quality=1&size=64"
                    .to_string(),
            ),
            openalbion_item_identifier: Some("T8_MAIN_SWORD".to_string()),
            openalbion_item_tier: Some("T8".to_string()),
            openalbion_item_quality: Some(4),
            quantity: Some(1),
        }
    }

    fn create_req() -> CreateGiveawayRequest {
        CreateGiveawayRequest {
            title: "T8 swords".to_string(),
            description: Some("Friday loot".to_string()),
            ends_at: future_rfc3339(),
            silver_amount: None,
            prizes: vec![sword()],
        }
    }

    #[tokio::test]
    async fn create_persists_a_prize_and_defaults_quality() {
        let db = seed_db().await;
        let officer = insert_user(&db, "officer").await;
        let mut req = create_req();
        req.prizes[0].openalbion_item_quality = None;
        let detail = GiveawayService::new()
            .create(&db, officer, req)
            .await
            .expect("create");
        assert_eq!(detail.giveaway.status, GiveawayStatus::Open);
        assert_eq!(detail.giveaway.prizes[0].openalbion_item_quality, 4);
        assert!(
            detail.giveaway.prizes[0]
                .openalbion_item_icon
                .as_deref()
                .unwrap()
                .contains("quality=4")
        );
    }

    #[tokio::test]
    async fn create_rejects_a_past_deadline_and_an_empty_prize_list() {
        let db = seed_db().await;
        let officer = insert_user(&db, "officer").await;
        let service = GiveawayService::new();
        let mut past = create_req();
        past.ends_at = past_rfc3339();
        assert!(matches!(
            service.create(&db, officer, past).await,
            Err(AppError::Validation(message)) if message.contains("future")
        ));
        let mut empty = create_req();
        empty.prizes.clear();
        empty.silver_amount = None;
        assert!(matches!(
            service.create(&db, officer, empty).await,
            Err(AppError::Validation(message)) if message.contains("prize")
        ));
    }

    #[tokio::test]
    async fn enter_is_idempotent_and_leave_removes_the_row() {
        let db = seed_db().await;
        let officer = insert_user(&db, "officer").await;
        let member = insert_user(&db, "alice").await;
        let service = GiveawayService::new();
        let created = service.create(&db, officer, create_req()).await.unwrap();
        let first = service
            .enter(&db, created.giveaway.id, member)
            .await
            .unwrap();
        let second = service
            .enter(&db, created.giveaway.id, member)
            .await
            .unwrap();
        assert_eq!(first.giveaway.entry_count, 1);
        assert_eq!(second.giveaway.entry_count, 1);
        let left = service
            .leave(&db, created.giveaway.id, member)
            .await
            .unwrap();
        assert_eq!(left.giveaway.entry_count, 0);
        let left_again = service
            .leave(&db, created.giveaway.id, member)
            .await
            .unwrap();
        assert_eq!(left_again.giveaway.entry_count, 0);
    }

    #[tokio::test]
    async fn enter_after_the_deadline_is_rejected() {
        let db = seed_db().await;
        let officer = insert_user(&db, "officer").await;
        let member = insert_user(&db, "alice").await;
        let service = GiveawayService::new();
        let created = service.create(&db, officer, create_req()).await.unwrap();
        GiveawayEntity::update_many()
            .filter(GiveawayColumn::Id.eq(created.giveaway.id))
            .set(GiveawayActiveModel {
                ends_at: Set((Utc::now() - Duration::minutes(1)).into()),
                ..Default::default()
            })
            .exec(&db)
            .await
            .unwrap();
        assert!(matches!(
            service.enter(&db, created.giveaway.id, member).await,
            Err(AppError::Conflict(_))
        ));
    }

    #[tokio::test]
    async fn draw_with_silver_credits_the_winner_once() {
        let db = seed_db().await;
        let officer = insert_user(&db, "officer").await;
        let alice = insert_user(&db, "alice").await;
        let bob = insert_user(&db, "bob").await;
        let service = GiveawayService::new();
        let mut req = create_req();
        req.silver_amount = Some(Decimal::new(100, 0));
        let created = service.create(&db, officer, req).await.unwrap();
        service
            .enter(&db, created.giveaway.id, alice)
            .await
            .unwrap();
        service.enter(&db, created.giveaway.id, bob).await.unwrap();

        let drawn = service.draw(&db, created.giveaway.id, true).await.unwrap();
        assert_eq!(drawn.giveaway.status, GiveawayStatus::Drawn);
        assert!(
            drawn.giveaway.winner_user_id == Some(alice)
                || drawn.giveaway.winner_user_id == Some(bob)
        );
        let tx_id = drawn.giveaway.silver_transaction_id.expect("silver credit");
        let again = service.draw(&db, created.giveaway.id, true).await.unwrap();
        assert_eq!(again.giveaway.silver_transaction_id, Some(tx_id));
        assert_eq!(again.giveaway.winner_user_id, drawn.giveaway.winner_user_id);

        let credit = BankEntity::find_by_id(tx_id)
            .one(&db)
            .await
            .unwrap()
            .expect("tx");
        assert_eq!(credit.r#type, TYPE_GIVEAWAY_CREDIT);
        assert_eq!(credit.status, TransactionStatus::Pending.to_string());
        assert_eq!(credit.to_user_id, drawn.giveaway.winner_user_id.unwrap());
        assert_eq!(credit.amount, Decimal::new(100, 0));
    }

    #[tokio::test]
    async fn draw_with_no_entries_expires_empty() {
        let db = seed_db().await;
        let officer = insert_user(&db, "officer").await;
        let service = GiveawayService::new();
        let created = service.create(&db, officer, create_req()).await.unwrap();
        let drawn = service.draw(&db, created.giveaway.id, true).await.unwrap();
        assert_eq!(drawn.giveaway.status, GiveawayStatus::ExpiredEmpty);
        assert!(drawn.giveaway.winner_user_id.is_none());
        assert!(drawn.giveaway.silver_transaction_id.is_none());
    }

    #[tokio::test]
    async fn cancel_blocks_a_later_draw() {
        let db = seed_db().await;
        let officer = insert_user(&db, "officer").await;
        let member = insert_user(&db, "alice").await;
        let service = GiveawayService::new();
        let created = service.create(&db, officer, create_req()).await.unwrap();
        service
            .enter(&db, created.giveaway.id, member)
            .await
            .unwrap();
        let cancelled = service
            .cancel(&db, created.giveaway.id, officer)
            .await
            .unwrap();
        assert_eq!(cancelled.giveaway.status, GiveawayStatus::Cancelled);
        let after = service.draw(&db, created.giveaway.id, true).await.unwrap();
        assert_eq!(after.giveaway.status, GiveawayStatus::Cancelled);
        assert!(after.giveaway.winner_user_id.is_none());
    }
}
