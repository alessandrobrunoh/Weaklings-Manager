//! Live aggregate of member-guild bank ledgers for an alliance tenant.
//!
//! The alliance schema has no `transactions` of its own. Reads fan out to
//! active member guilds and match people by Discord id. Mutations proxy into
//! one member guild schema through [`super::service::BankService`].

use std::sync::Arc;

use sea_orm::prelude::Decimal;
use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, PaginatorTrait, QueryFilter};

use crate::errors::AppError;
use crate::modules::auth::Permission;
use crate::modules::platform::service::PlatformService;
use crate::modules::users::entities::{
    Column as UserColumn, Entity as UserEntity, Model as UserModel,
};
use crate::pagination::{MAX_PAGE_LIMIT, PaginatedData, PaginationParams, SortOrder, paginate_vec};
use crate::tenant::{TenantContext, TenantRegistry};

use super::entities::{Column as TransactionColumn, Entity as TransactionEntity};
use super::models::{
    AcceptWithdrawalRequest, BalanceSummary, BankAnalyticsSummary, BankBreakdown,
    CreateTransactionRequest, GuildBalanceBreakdown, GuildBankSummary, RejectWithdrawalRequest,
    TransactionFilters, TransactionView, UpdateTransactionRequest, WithdrawRequest,
};
use super::service::BankService;
use super::status::TransactionStatus;

/// Identity of the caller on the alliance tenant, used to match member-guild users.
pub(super) struct AllianceCaller {
    pub discord_id: String,
    pub alliance_user_id: i64,
    pub is_superadmin: bool,
}

impl AllianceCaller {
    pub(super) fn from_user(user: &crate::modules::auth::UserContext) -> Self {
        Self {
            discord_id: user.id.clone(),
            alliance_user_id: user.user_id,
            is_superadmin: user.is_superadmin(),
        }
    }
}

struct MemberGuild {
    tenant_id: String,
    name: String,
    ctx: Arc<TenantContext>,
}

/// Whether the current tenant is an alliance hub.
pub(super) async fn tenant_is_alliance(
    registry: &TenantRegistry,
    tenant_id: &str,
) -> Result<bool, AppError> {
    Ok(registry.get_or_load(tenant_id).await?.kind == "alliance")
}

async fn active_member_guilds(
    control: &DatabaseConnection,
    registry: &TenantRegistry,
    alliance_tenant_id: &str,
) -> Result<Vec<MemberGuild>, AppError> {
    let members = PlatformService::list_alliance_members(control, alliance_tenant_id).await?;
    let mut out = Vec::new();
    for member in members {
        if member.status != "active" {
            continue;
        }
        match registry.get_or_load(&member.guild_tenant_id).await {
            Ok(ctx) => out.push(MemberGuild {
                tenant_id: member.guild_tenant_id,
                name: member.name,
                ctx,
            }),
            Err(err) => {
                tracing::warn!(
                    guild_tenant_id = %member.guild_tenant_id,
                    error = %err,
                    "skipping alliance member guild that could not be opened"
                );
            }
        }
    }
    Ok(out)
}

async fn user_by_discord(
    db: &DatabaseConnection,
    discord_id: &str,
) -> Result<Option<UserModel>, AppError> {
    Ok(UserEntity::find()
        .filter(UserColumn::DiscordId.eq(discord_id))
        .one(db)
        .await?)
}

async fn can_view_others(caller: &AllianceCaller, guild: &MemberGuild) -> Result<bool, AppError> {
    if caller.is_superadmin {
        return Ok(true);
    }
    let Some(member) = user_by_discord(&guild.ctx.db, &caller.discord_id).await? else {
        return Ok(false);
    };
    Ok(guild
        .ctx
        .permissions
        .check(
            false,
            std::slice::from_ref(&member.role),
            Permission::BankViewOthers,
        )
        .await)
}

async fn require_guild_permission(
    caller: &AllianceCaller,
    guild: &MemberGuild,
    perm: Permission,
) -> Result<i64, AppError> {
    let Some(member) = user_by_discord(&guild.ctx.db, &caller.discord_id).await? else {
        return Err(AppError::Forbidden(format!(
            "not a member of guild {}",
            guild.tenant_id
        )));
    };
    guild
        .ctx
        .permissions
        .require(
            caller.is_superadmin,
            std::slice::from_ref(&member.role),
            perm,
        )
        .await?;
    Ok(member.id)
}

fn resolve_explicit_or_only_member<'a>(
    members: &'a [MemberGuild],
    requested: Option<&str>,
) -> Result<&'a MemberGuild, AppError> {
    if let Some(id) = requested.map(str::trim).filter(|id| !id.is_empty()) {
        return member_by_id(members, id);
    }
    match members {
        [] => Err(AppError::Validation(
            "this alliance has no active member guilds".to_owned(),
        )),
        [only] => Ok(only),
        _ => Err(AppError::Validation(
            "guild_tenant_id is required when the alliance has more than one member guild"
                .to_owned(),
        )),
    }
}

fn member_by_id<'a>(
    members: &'a [MemberGuild],
    guild_tenant_id: &str,
) -> Result<&'a MemberGuild, AppError> {
    members
        .iter()
        .find(|guild| guild.tenant_id == guild_tenant_id)
        .ok_or_else(|| {
            AppError::NotFound(format!(
                "guild {guild_tenant_id} is not an active member of this alliance"
            ))
        })
}

async fn guild_has_rows_for(guild: &MemberGuild, discord_id: &str) -> Result<bool, AppError> {
    let Some(user) = user_by_discord(&guild.ctx.db, discord_id).await? else {
        return Ok(false);
    };
    let count = TransactionEntity::find()
        .filter(TransactionColumn::ToUserId.eq(user.id))
        .count(&guild.ctx.db)
        .await?;
    Ok(count > 0)
}

async fn resolve_target_guild<'a>(
    members: &'a [MemberGuild],
    requested: Option<&str>,
    discord_id: &str,
) -> Result<&'a MemberGuild, AppError> {
    if let Some(id) = requested.map(str::trim).filter(|id| !id.is_empty()) {
        return member_by_id(members, id);
    }
    let mut hits = Vec::new();
    for guild in members {
        if guild_has_rows_for(guild, discord_id).await? {
            hits.push(guild);
        }
    }
    match hits.len() {
        0 => Err(AppError::Validation(
            "no member guild has bank rows for this Discord user".to_owned(),
        )),
        1 => Ok(hits[0]),
        _ => Err(AppError::Validation(
            "guild_tenant_id is required when this Discord user has bank rows in more than one member guild"
                .to_owned(),
        )),
    }
}

async fn target_discord_id(
    alliance_db: &DatabaseConnection,
    caller: &AllianceCaller,
    requested_user_id: Option<i64>,
) -> Result<String, AppError> {
    let Some(user_id) = requested_user_id.filter(|id| *id != caller.alliance_user_id) else {
        return Ok(caller.discord_id.clone());
    };
    let user = UserEntity::find_by_id(user_id)
        .one(alliance_db)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("User {user_id} not found")))?;
    user.discord_id.ok_or_else(|| {
        AppError::Validation(format!(
            "user {user_id} has no Discord id to match across guilds"
        ))
    })
}

fn stamp(view: TransactionView, guild: &MemberGuild) -> TransactionView {
    view.with_guild(guild.tenant_id.clone(), guild.name.clone())
}

fn sort_views(views: &mut [TransactionView], filters: &TransactionFilters) {
    let sort_key = filters.sort.as_deref().unwrap_or("created_at");
    let desc = SortOrder::from_query(filters.order.as_deref()) == SortOrder::Desc;
    views.sort_by(|a, b| {
        let primary = match sort_key {
            "amount" => a.amount.cmp(&b.amount),
            "status" => a.status.as_str().cmp(b.status.as_str()),
            "to_username" => a.to_username.cmp(&b.to_username),
            _ => a.created_at.cmp(&b.created_at),
        };
        let primary = if desc { primary.reverse() } else { primary };
        primary
            .then_with(|| a.guild_tenant_id.cmp(&b.guild_tenant_id))
            .then_with(|| a.id.cmp(&b.id))
    });
}

async fn list_guild_pages(
    guild: &MemberGuild,
    user_id: Option<i64>,
    filters: &TransactionFilters,
) -> Result<Vec<TransactionView>, AppError> {
    let service = BankService::new();
    let mut page = 1_u64;
    let mut out = Vec::new();
    loop {
        let chunk = service
            .list_transactions(
                &guild.ctx.db,
                user_id,
                &PaginationParams {
                    page: Some(page),
                    limit: Some(MAX_PAGE_LIMIT),
                },
                filters,
            )
            .await?;
        let empty = chunk.items.is_empty();
        let total_pages = chunk.total_pages;
        out.extend(chunk.items.into_iter().map(|view| stamp(view, guild)));
        if empty || page >= total_pages {
            break;
        }
        page += 1;
    }
    Ok(out)
}

/// Derived balance for one Discord user across active member guilds.
#[allow(clippy::too_many_arguments)]
pub(super) async fn get_balance(
    control: &DatabaseConnection,
    registry: &TenantRegistry,
    alliance_tenant_id: &str,
    alliance_db: &DatabaseConnection,
    caller: &AllianceCaller,
    requested_user_id: Option<i64>,
) -> Result<BalanceSummary, AppError> {
    let members = active_member_guilds(control, registry, alliance_tenant_id).await?;
    let discord_id = target_discord_id(alliance_db, caller, requested_user_id).await?;
    let viewing_others = discord_id != caller.discord_id;
    let service = BankService::new();
    let mut pending_total = Decimal::ZERO;
    let mut pending_count = 0_u64;
    let mut requested_total = Decimal::ZERO;
    let mut requested_count = 0_u64;
    let mut guilds = Vec::new();

    for guild in &members {
        if viewing_others && !can_view_others(caller, guild).await? {
            continue;
        }
        let Some(user) = user_by_discord(&guild.ctx.db, &discord_id).await? else {
            continue;
        };
        let summary = service.get_balance(&guild.ctx.db, user.id).await?;
        pending_total += summary.pending_total;
        pending_count += summary.pending_count;
        requested_total += summary.requested_total;
        requested_count += summary.requested_count;
        guilds.push(GuildBalanceBreakdown {
            guild_tenant_id: guild.tenant_id.clone(),
            guild_name: guild.name.clone(),
            pending_total: summary.pending_total,
            pending_count: summary.pending_count,
            requested_total: summary.requested_total,
            requested_count: summary.requested_count,
        });
    }

    Ok(BalanceSummary {
        user_id: requested_user_id.unwrap_or(caller.alliance_user_id),
        pending_total,
        pending_count,
        requested_total,
        requested_count,
        guilds,
    })
}

/// Paginated transaction list aggregated from active member guilds.
#[allow(clippy::too_many_arguments)]
pub(super) async fn list_transactions(
    control: &DatabaseConnection,
    registry: &TenantRegistry,
    alliance_tenant_id: &str,
    alliance_db: &DatabaseConnection,
    caller: &AllianceCaller,
    requested_user_id: Option<i64>,
    global: bool,
    pagination: &PaginationParams,
    filters: &TransactionFilters,
) -> Result<PaginatedData<TransactionView>, AppError> {
    let members = active_member_guilds(control, registry, alliance_tenant_id).await?;
    let mut views = Vec::new();
    if global && requested_user_id.is_none() {
        for guild in &members {
            let user_id = if can_view_others(caller, guild).await? {
                None
            } else {
                match user_by_discord(&guild.ctx.db, &caller.discord_id).await? {
                    Some(user) => Some(user.id),
                    None => continue,
                }
            };
            views.extend(list_guild_pages(guild, user_id, filters).await?);
        }
    } else {
        let discord_id = target_discord_id(alliance_db, caller, requested_user_id).await?;
        let viewing_others = discord_id != caller.discord_id;
        for guild in &members {
            if viewing_others && !can_view_others(caller, guild).await? {
                continue;
            }
            let Some(user) = user_by_discord(&guild.ctx.db, &discord_id).await? else {
                continue;
            };
            views.extend(list_guild_pages(guild, Some(user.id), filters).await?);
        }
    }
    sort_views(&mut views, filters);
    Ok(paginate_vec(views, pagination))
}

/// Sum of settled payouts across active member guilds.
pub(super) async fn get_guild_summary(
    control: &DatabaseConnection,
    registry: &TenantRegistry,
    alliance_tenant_id: &str,
) -> Result<GuildBankSummary, AppError> {
    let members = active_member_guilds(control, registry, alliance_tenant_id).await?;
    let service = BankService::new();
    let mut paid_total = Decimal::ZERO;
    let mut paid_count = 0_u64;
    for guild in &members {
        let summary = service.get_guild_summary(&guild.ctx.db).await?;
        paid_total += summary.paid_total;
        paid_count += summary.paid_count;
    }
    Ok(GuildBankSummary {
        paid_total,
        paid_count,
    })
}

fn empty_analytics() -> BankAnalyticsSummary {
    BankAnalyticsSummary {
        transaction_count: 0,
        ledger_volume: Decimal::ZERO,
        outstanding_total: Decimal::ZERO,
        outstanding_count: 0,
        requested_total: Decimal::ZERO,
        requested_count: 0,
        paid_out_total: Decimal::ZERO,
        paid_out_count: 0,
        donated_total: Decimal::ZERO,
        donated_count: 0,
        sources: Vec::new(),
        destinations: Vec::new(),
        transaction_types: Vec::new(),
    }
}

fn prefix_breakdowns(rows: Vec<BankBreakdown>, guild_name: &str) -> Vec<BankBreakdown> {
    rows.into_iter()
        .map(|row| BankBreakdown {
            label: format!("{}: {}", guild_name, row.label),
            transaction_count: row.transaction_count,
            total_amount: row.total_amount,
        })
        .collect()
}

/// Officer analytics aggregated from member guilds the caller may inspect.
pub(super) async fn get_admin_summary(
    control: &DatabaseConnection,
    registry: &TenantRegistry,
    alliance_tenant_id: &str,
    caller: &AllianceCaller,
) -> Result<BankAnalyticsSummary, AppError> {
    let members = active_member_guilds(control, registry, alliance_tenant_id).await?;
    let service = BankService::new();
    let mut summary = empty_analytics();
    for guild in &members {
        if !can_view_others(caller, guild).await? {
            continue;
        }
        let part = service.get_analytics_summary(&guild.ctx.db).await?;
        summary.transaction_count += part.transaction_count;
        summary.ledger_volume += part.ledger_volume;
        summary.outstanding_total += part.outstanding_total;
        summary.outstanding_count += part.outstanding_count;
        summary.requested_total += part.requested_total;
        summary.requested_count += part.requested_count;
        summary.paid_out_total += part.paid_out_total;
        summary.paid_out_count += part.paid_out_count;
        summary.donated_total += part.donated_total;
        summary.donated_count += part.donated_count;
        summary
            .sources
            .extend(prefix_breakdowns(part.sources, &guild.name));
        summary
            .destinations
            .extend(prefix_breakdowns(part.destinations, &guild.name));
        summary
            .transaction_types
            .extend(prefix_breakdowns(part.transaction_types, &guild.name));
    }
    Ok(summary)
}

fn strip_guild(req: &WithdrawRequest) -> WithdrawRequest {
    WithdrawRequest {
        transaction_ids: req.transaction_ids.clone(),
        all: req.all,
        guild_tenant_id: None,
    }
}

/// Request withdrawal against one member-guild ledger.
pub(super) async fn request_withdrawal(
    control: &DatabaseConnection,
    registry: &TenantRegistry,
    alliance_tenant_id: &str,
    caller: &AllianceCaller,
    req: &WithdrawRequest,
) -> Result<Vec<TransactionView>, AppError> {
    let members = active_member_guilds(control, registry, alliance_tenant_id).await?;
    let guild = resolve_target_guild(
        members.as_slice(),
        req.guild_tenant_id.as_deref(),
        &caller.discord_id,
    )
    .await?;
    let Some(user) = user_by_discord(&guild.ctx.db, &caller.discord_id).await? else {
        return Err(AppError::Forbidden(format!(
            "not a member of guild {}",
            guild.tenant_id
        )));
    };
    let views = BankService::new()
        .request_withdrawal(&guild.ctx.db, user.id, &strip_guild(req))
        .await?;
    Ok(views.into_iter().map(|view| stamp(view, guild)).collect())
}

fn strip_accept(req: &AcceptWithdrawalRequest) -> AcceptWithdrawalRequest {
    AcceptWithdrawalRequest {
        transaction_ids: req.transaction_ids.clone(),
        all: req.all,
        user_id: req.user_id,
        guild_tenant_id: None,
    }
}

fn strip_reject(req: &RejectWithdrawalRequest) -> RejectWithdrawalRequest {
    RejectWithdrawalRequest {
        transaction_ids: req.transaction_ids.clone(),
        all: req.all,
        user_id: req.user_id,
        guild_tenant_id: None,
    }
}

/// Accept requested withdrawals on one member-guild ledger.
pub(super) async fn accept_withdrawal(
    control: &DatabaseConnection,
    registry: &TenantRegistry,
    alliance_tenant_id: &str,
    caller: &AllianceCaller,
    req: &AcceptWithdrawalRequest,
) -> Result<Vec<TransactionView>, AppError> {
    let members = active_member_guilds(control, registry, alliance_tenant_id).await?;
    let guild = resolve_target_guild(
        members.as_slice(),
        req.guild_tenant_id.as_deref(),
        &caller.discord_id,
    )
    .await?;
    let officer_id =
        require_guild_permission(caller, guild, Permission::BankWithdrawAccept).await?;
    let views = BankService::new()
        .accept_withdrawal(&guild.ctx.db, officer_id, &strip_accept(req))
        .await?;
    Ok(views.into_iter().map(|view| stamp(view, guild)).collect())
}

/// Reject requested withdrawals on one member-guild ledger.
pub(super) async fn reject_withdrawal(
    control: &DatabaseConnection,
    registry: &TenantRegistry,
    alliance_tenant_id: &str,
    caller: &AllianceCaller,
    req: &RejectWithdrawalRequest,
) -> Result<Vec<TransactionView>, AppError> {
    let members = active_member_guilds(control, registry, alliance_tenant_id).await?;
    let guild = resolve_target_guild(
        members.as_slice(),
        req.guild_tenant_id.as_deref(),
        &caller.discord_id,
    )
    .await?;
    let officer_id =
        require_guild_permission(caller, guild, Permission::BankWithdrawAccept).await?;
    let views = BankService::new()
        .reject_withdrawal(&guild.ctx.db, officer_id, &strip_reject(req))
        .await?;
    Ok(views.into_iter().map(|view| stamp(view, guild)).collect())
}

/// Manually credit a member-guild ledger.
pub(super) async fn create_transaction(
    control: &DatabaseConnection,
    registry: &TenantRegistry,
    alliance_tenant_id: &str,
    caller: &AllianceCaller,
    req: &CreateTransactionRequest,
) -> Result<TransactionView, AppError> {
    let members = active_member_guilds(control, registry, alliance_tenant_id).await?;
    let guild = resolve_explicit_or_only_member(&members, req.guild_tenant_id.as_deref())?;
    let actor_id =
        require_guild_permission(caller, guild, Permission::BankTransactionsCreate).await?;
    let view = BankService::new()
        .create_transaction(&guild.ctx.db, req, actor_id)
        .await?;
    Ok(stamp(view, guild))
}

/// Edit a row on one member-guild ledger.
pub(super) async fn update_transaction(
    control: &DatabaseConnection,
    registry: &TenantRegistry,
    alliance_tenant_id: &str,
    caller: &AllianceCaller,
    id: i64,
    req: &UpdateTransactionRequest,
) -> Result<TransactionView, AppError> {
    let members = active_member_guilds(control, registry, alliance_tenant_id).await?;
    let guild = resolve_explicit_or_only_member(&members, req.guild_tenant_id.as_deref())?;
    let actor_id =
        require_guild_permission(caller, guild, Permission::BankTransactionsEdit).await?;
    let view = BankService::new()
        .update_transaction(&guild.ctx.db, id, req, actor_id)
        .await?;
    Ok(stamp(view, guild))
}

/// Delete a row on one member-guild ledger.
pub(super) async fn delete_transaction(
    control: &DatabaseConnection,
    registry: &TenantRegistry,
    alliance_tenant_id: &str,
    caller: &AllianceCaller,
    id: i64,
    guild_tenant_id: Option<&str>,
) -> Result<(), AppError> {
    let members = active_member_guilds(control, registry, alliance_tenant_id).await?;
    let guild = resolve_explicit_or_only_member(&members, guild_tenant_id)?;
    let actor_id =
        require_guild_permission(caller, guild, Permission::BankTransactionsDelete).await?;
    BankService::new()
        .delete_transaction(&guild.ctx.db, id, actor_id)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control_migration::Migrator;
    use crate::modules::platform::models::RegisterTenantRequest;
    use crate::postgres::{
        connect_with_search_path, drop_schema, ensure_schema,
        test_support::{try_admin_db, unique_schema},
    };
    use sea_orm::{ActiveModelTrait, ActiveValue::Set};
    use sea_orm_migration::MigratorTrait;

    struct World {
        url: String,
        admin: DatabaseConnection,
        control: DatabaseConnection,
        control_schema: String,
        registry: TenantRegistry,
        guild_a: crate::modules::platform::models::TenantView,
        guild_b: crate::modules::platform::models::TenantView,
        outsider: crate::modules::platform::models::TenantView,
        alliance: crate::modules::platform::models::TenantView,
    }

    fn guild_register(id: &str, name: &str) -> RegisterTenantRequest {
        RegisterTenantRequest {
            id: id.to_owned(),
            name: name.to_owned(),
            kind: Some("guild".into()),
            albion_guild_id: "alb-1".into(),
            albion_api_region: "europe".into(),
            albion_allied_guild_ids: None,
            albion_allied_guild_names: None,
            member_guild_ids: vec![],
        }
    }

    fn alliance_register(id: &str, members: Vec<String>) -> RegisterTenantRequest {
        RegisterTenantRequest {
            id: id.to_owned(),
            name: "Alliance Hub".into(),
            kind: Some("alliance".into()),
            albion_guild_id: String::new(),
            albion_api_region: String::new(),
            albion_allied_guild_ids: None,
            albion_allied_guild_names: None,
            member_guild_ids: members,
        }
    }

    async fn setup() -> Option<World> {
        let (url, admin) = try_admin_db().await?;
        let control_schema = unique_schema("it_abnk");
        ensure_schema(&admin, &control_schema)
            .await
            .expect("control schema");
        let control = connect_with_search_path(&url, &control_schema)
            .await
            .expect("connect control");
        Migrator::up(&control, None).await.expect("control migrate");
        let registry = TenantRegistry::new(url.clone(), control.clone());

        let guild_a_id = unique_schema("ga");
        let guild_b_id = unique_schema("gb");
        let outsider_id = unique_schema("go");
        let alliance_id = unique_schema("al");

        let guild_a = PlatformService::register_tenant(
            &control,
            &registry,
            guild_register(&guild_a_id, "Guild A"),
            "owner-a",
            None,
        )
        .await
        .expect("guild a");
        let guild_b = PlatformService::register_tenant(
            &control,
            &registry,
            guild_register(&guild_b_id, "Guild B"),
            "owner-a",
            None,
        )
        .await
        .expect("guild b");
        let outsider = PlatformService::register_tenant(
            &control,
            &registry,
            guild_register(&outsider_id, "Outsider"),
            "owner-out",
            None,
        )
        .await
        .expect("outsider");
        let alliance = PlatformService::register_tenant(
            &control,
            &registry,
            alliance_register(&alliance_id, vec![guild_a_id, guild_b_id]),
            "owner-a",
            None,
        )
        .await
        .expect("alliance");

        Some(World {
            url,
            admin,
            control,
            control_schema,
            registry,
            guild_a,
            guild_b,
            outsider,
            alliance,
        })
    }

    async fn cleanup(world: World) {
        for schema in [
            world.guild_a.schema_name,
            world.guild_b.schema_name,
            world.outsider.schema_name,
            world.alliance.schema_name,
            world.control_schema,
        ] {
            drop_schema(&world.admin, &schema).await.expect("drop");
        }
        let _ = world.url;
        let _ = world.control;
        let _ = world.registry;
    }

    async fn insert_user(
        db: &DatabaseConnection,
        username: &str,
        email: &str,
        discord_id: &str,
        role: &str,
    ) -> i64 {
        use crate::modules::users::entities::ActiveModel as UserActiveModel;
        UserActiveModel {
            username: Set(username.to_string()),
            email: Set(email.to_string()),
            role: Set(role.to_string()),
            discord_id: Set(Some(discord_id.to_string())),
            ..Default::default()
        }
        .insert(db)
        .await
        .expect("insert user")
        .id
    }

    async fn credit(db: &DatabaseConnection, to_user_id: i64, amount: &str, actor: i64) -> i64 {
        let view = BankService::new()
            .create_transaction(
                db,
                &CreateTransactionRequest {
                    to_user_id,
                    amount: amount.parse().unwrap(),
                    status: Some(TransactionStatus::Pending),
                    r#type: Some(super::super::service::TYPE_SPLIT_CREDIT.to_string()),
                    split_id: None,
                    to_guild_bank: Some(false),
                    from_user_id: None,
                    guild_tenant_id: None,
                },
                actor,
            )
            .await
            .expect("credit");
        view.id
    }

    fn caller(discord_id: &str, alliance_user_id: i64) -> AllianceCaller {
        AllianceCaller {
            discord_id: discord_id.to_owned(),
            alliance_user_id,
            is_superadmin: false,
        }
    }

    #[tokio::test]
    async fn split_credit_in_member_guild_shows_on_alliance_balance() {
        let Some(world) = setup().await else {
            return;
        };
        let guild_a = world
            .registry
            .get_or_load(&world.guild_a.id)
            .await
            .expect("open a");
        let alliance = world
            .registry
            .get_or_load(&world.alliance.id)
            .await
            .expect("open al");

        let alice_a = insert_user(
            &guild_a.db,
            "alice",
            "alice-a@ex.com",
            "discord-alice",
            "User",
        )
        .await;
        let alice_al = insert_user(
            &alliance.db,
            "alice",
            "alice-al@ex.com",
            "discord-alice",
            "User",
        )
        .await;
        credit(&guild_a.db, alice_a, "25.00", alice_a).await;

        let balance = get_balance(
            &world.control,
            &world.registry,
            &world.alliance.id,
            &alliance.db,
            &caller("discord-alice", alice_al),
            None,
        )
        .await
        .expect("balance");
        assert_eq!(balance.pending_count, 1);
        assert_eq!(balance.pending_total, "25.00".parse().unwrap());
        assert_eq!(balance.guilds.len(), 1);
        assert_eq!(balance.guilds[0].guild_tenant_id, world.guild_a.id);
        assert_eq!(balance.guilds[0].guild_name, "Guild A");

        let listed = list_transactions(
            &world.control,
            &world.registry,
            &world.alliance.id,
            &alliance.db,
            &caller("discord-alice", alice_al),
            None,
            false,
            &PaginationParams {
                page: Some(1),
                limit: Some(10),
            },
            &TransactionFilters::default(),
        )
        .await
        .expect("list");
        assert_eq!(listed.total_items, 1);
        assert_eq!(
            listed.items[0].guild_tenant_id.as_deref(),
            Some(world.guild_a.id.as_str())
        );
        assert_eq!(listed.items[0].amount, "25.00".parse().unwrap());

        cleanup(world).await;
    }

    #[tokio::test]
    async fn withdraw_proxy_reduces_guild_ledger_and_writes_nothing_in_alliance() {
        let Some(world) = setup().await else {
            return;
        };
        let guild_a = world
            .registry
            .get_or_load(&world.guild_a.id)
            .await
            .expect("open a");
        let alliance = world
            .registry
            .get_or_load(&world.alliance.id)
            .await
            .expect("open al");

        let alice_a = insert_user(
            &guild_a.db,
            "alice",
            "alice-a@ex.com",
            "discord-alice",
            "User",
        )
        .await;
        let alice_al = insert_user(
            &alliance.db,
            "alice",
            "alice-al@ex.com",
            "discord-alice",
            "User",
        )
        .await;
        credit(&guild_a.db, alice_a, "12.00", alice_a).await;

        let requested = request_withdrawal(
            &world.control,
            &world.registry,
            &world.alliance.id,
            &caller("discord-alice", alice_al),
            &WithdrawRequest {
                transaction_ids: None,
                all: Some(true),
                guild_tenant_id: Some(world.guild_a.id.clone()),
            },
        )
        .await
        .expect("withdraw");
        assert_eq!(requested.len(), 1);
        assert_eq!(requested[0].status, TransactionStatus::Requested);

        let guild_balance = BankService::new()
            .get_balance(&guild_a.db, alice_a)
            .await
            .expect("guild balance");
        assert_eq!(guild_balance.pending_count, 0);
        assert_eq!(guild_balance.requested_count, 1);
        assert_eq!(guild_balance.requested_total, "12.00".parse().unwrap());

        let alliance_rows = TransactionEntity::find()
            .all(&alliance.db)
            .await
            .expect("alliance txs");
        assert!(
            alliance_rows.is_empty(),
            "alliance schema must not gain ledger rows"
        );

        cleanup(world).await;
    }

    #[tokio::test]
    async fn non_member_guild_credit_is_not_included() {
        let Some(world) = setup().await else {
            return;
        };
        let outsider = world
            .registry
            .get_or_load(&world.outsider.id)
            .await
            .expect("open out");
        let alliance = world
            .registry
            .get_or_load(&world.alliance.id)
            .await
            .expect("open al");

        let alice_out = insert_user(
            &outsider.db,
            "alice",
            "alice-out@ex.com",
            "discord-alice",
            "User",
        )
        .await;
        let alice_al = insert_user(
            &alliance.db,
            "alice",
            "alice-al@ex.com",
            "discord-alice",
            "User",
        )
        .await;
        credit(&outsider.db, alice_out, "99.00", alice_out).await;

        let balance = get_balance(
            &world.control,
            &world.registry,
            &world.alliance.id,
            &alliance.db,
            &caller("discord-alice", alice_al),
            None,
        )
        .await
        .expect("balance");
        assert_eq!(balance.pending_count, 0);
        assert!(balance.guilds.is_empty());

        cleanup(world).await;
    }

    #[tokio::test]
    async fn permission_filter_hides_others_without_view_others() {
        let Some(world) = setup().await else {
            return;
        };
        let guild_a = world
            .registry
            .get_or_load(&world.guild_a.id)
            .await
            .expect("open a");
        let guild_b = world
            .registry
            .get_or_load(&world.guild_b.id)
            .await
            .expect("open b");
        let alliance = world
            .registry
            .get_or_load(&world.alliance.id)
            .await
            .expect("open al");

        let alice_a = insert_user(
            &guild_a.db,
            "alice",
            "alice-a@ex.com",
            "discord-alice",
            "User",
        )
        .await;
        let bob_a = insert_user(&guild_a.db, "bob", "bob-a@ex.com", "discord-bob", "User").await;
        let alice_b = insert_user(
            &guild_b.db,
            "alice",
            "alice-b@ex.com",
            "discord-alice",
            "Admin",
        )
        .await;
        let bob_b = insert_user(&guild_b.db, "bob", "bob-b@ex.com", "discord-bob", "User").await;
        let alice_al = insert_user(
            &alliance.db,
            "alice",
            "alice-al@ex.com",
            "discord-alice",
            "Admin",
        )
        .await;

        credit(&guild_a.db, alice_a, "1.00", alice_a).await;
        credit(&guild_a.db, bob_a, "40.00", bob_a).await;
        credit(&guild_b.db, alice_b, "2.00", alice_b).await;
        credit(&guild_b.db, bob_b, "50.00", bob_b).await;

        let listed = list_transactions(
            &world.control,
            &world.registry,
            &world.alliance.id,
            &alliance.db,
            &caller("discord-alice", alice_al),
            None,
            true,
            &PaginationParams {
                page: Some(1),
                limit: Some(50),
            },
            &TransactionFilters::default(),
        )
        .await
        .expect("list");

        let a_amounts: Vec<_> = listed
            .items
            .iter()
            .filter(|row| row.guild_tenant_id.as_deref() == Some(world.guild_a.id.as_str()))
            .map(|row| (row.to_username.clone(), row.amount))
            .collect();
        assert_eq!(
            a_amounts.len(),
            1,
            "guild A without view_others must only include the caller: {a_amounts:?}"
        );
        assert_eq!(a_amounts[0].0, "alice");

        let b_names: Vec<_> = listed
            .items
            .iter()
            .filter(|row| row.guild_tenant_id.as_deref() == Some(world.guild_b.id.as_str()))
            .map(|row| row.to_username.clone())
            .collect();
        assert!(b_names.contains(&"alice".to_string()));
        assert!(
            b_names.contains(&"bob".to_string()),
            "guild B Admin must see bob: {b_names:?}"
        );

        cleanup(world).await;
    }

    #[tokio::test]
    async fn empty_alliance_returns_empty_list_not_error() {
        let Some((url, admin)) = try_admin_db().await else {
            return;
        };
        let control_schema = unique_schema("it_abnke");
        ensure_schema(&admin, &control_schema)
            .await
            .expect("schema");
        let control = connect_with_search_path(&url, &control_schema)
            .await
            .expect("connect");
        Migrator::up(&control, None).await.expect("migrate");
        let registry = TenantRegistry::new(url, control.clone());

        let guild_id = unique_schema("gpend");
        let alliance_id = unique_schema("alpend");
        let guild = PlatformService::register_tenant(
            &control,
            &registry,
            guild_register(&guild_id, "Pending Guild"),
            "guild-owner",
            None,
        )
        .await
        .expect("guild");
        let alliance = PlatformService::register_tenant(
            &control,
            &registry,
            alliance_register(&alliance_id, vec![guild_id]),
            "alliance-officer",
            None,
        )
        .await
        .expect("alliance pending");
        let alliance_ctx = registry.get_or_load(&alliance.id).await.expect("open al");
        let alice_al = insert_user(
            &alliance_ctx.db,
            "alice",
            "alice-al@ex.com",
            "discord-alice",
            "User",
        )
        .await;

        let listed = list_transactions(
            &control,
            &registry,
            &alliance.id,
            &alliance_ctx.db,
            &caller("discord-alice", alice_al),
            None,
            true,
            &PaginationParams {
                page: Some(1),
                limit: Some(10),
            },
            &TransactionFilters::default(),
        )
        .await
        .expect("empty list");
        assert_eq!(listed.total_items, 0);
        assert!(listed.items.is_empty());

        let balance = get_balance(
            &control,
            &registry,
            &alliance.id,
            &alliance_ctx.db,
            &caller("discord-alice", alice_al),
            None,
        )
        .await
        .expect("empty balance");
        assert_eq!(balance.pending_count, 0);
        assert!(balance.guilds.is_empty());

        drop_schema(&admin, &guild.schema_name)
            .await
            .expect("drop guild");
        drop_schema(&admin, &alliance.schema_name)
            .await
            .expect("drop alliance");
        drop_schema(&admin, &control_schema)
            .await
            .expect("drop control");
    }
}
