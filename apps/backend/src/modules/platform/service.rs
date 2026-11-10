//! Control-plane tenant, feature-flag, and admin assignment operations.

use std::future::Future;

use sea_orm::{ConnectionTrait, DatabaseConnection, DbErr, Statement, TransactionTrait, Value};

use crate::control_migration::{FEATURE_SIDEBAR, SUPERADMIN_ROLE_ID};
use crate::errors::AppError;
use crate::postgres::{tenant_schema_name, tenant_slug};
use crate::tenant::TenantRegistry;

use super::models::{
    AllianceContextView, AllianceMemberView, AssignAdminRequest, AttachableGuildView,
    CreateRankRequest, CreateTenantRequest, FeatureCatalogItem, PatchRankRequest,
    PatchTenantRequest, PlatformAdminView, PutRankFeaturesRequest, PutTenantFeaturesRequest,
    RegisterTenantRequest, TenantFeatureFlag, TenantFeaturesView, TenantRankView, TenantStatusView,
    TenantView,
};

const TENANT_SELECT: &str = "SELECT t.id, t.name, t.slug, t.schema_name, t.status, t.owner_discord_id, \
     t.created_at::text, t.suspended_at::text, t.albion_guild_id, t.albion_api_region, \
     t.discord_icon_hash, t.albion_allied_guild_ids, t.albion_allied_guild_names, \
     t.rank_id::text, r.name, t.kind, t.is_default, t.albion_alliance_id \
     FROM tenants t LEFT JOIN tenant_ranks r ON r.id = t.rank_id";

/// A Discord role configured for this membership that has no per-member grant.
///
/// Departure records these instead of removing the role from everyone who has it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UntrackedAllianceRole {
    /// Discord server the role lives on.
    pub discord_guild_id: String,
    /// Role snowflake.
    pub role_id: String,
}

/// Control-plane operations.
pub struct PlatformService;

impl PlatformService {
    /// Whether `discord_id` is the original owner recorded for this tenant (guild or alliance).
    ///
    /// Owner status is intentionally tenant-scoped and never grants platform access.
    pub async fn is_tenant_owner(
        control: &DatabaseConnection,
        tenant_id: &str,
        discord_id: &str,
    ) -> Result<bool, AppError> {
        let Some(tenant) = Self::get_tenant(control, tenant_id).await? else {
            return Ok(false);
        };
        Ok(tenant_owner_matches(
            tenant.owner_discord_id.as_deref(),
            discord_id,
        ))
    }

    /// List every tenant, including suspended ones.
    ///
    /// # Errors
    ///
    /// Returns a database error if the query fails.
    pub async fn list_tenants(control: &DatabaseConnection) -> Result<Vec<TenantView>, AppError> {
        let rows = control
            .query_all(Statement::from_string(
                control.get_database_backend(),
                format!("{TENANT_SELECT} ORDER BY t.created_at"),
            ))
            .await?;
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            out.push(row_to_view(&row)?);
        }
        Ok(out)
    }

    /// Provision a new tenant schema and register it.
    ///
    /// # Errors
    ///
    /// Returns validation/conflict errors, or a database error if provisioning fails.
    pub async fn create_tenant(
        control: &DatabaseConnection,
        registry: &TenantRegistry,
        body: CreateTenantRequest,
        actor: &str,
    ) -> Result<TenantView, AppError> {
        Self::create_tenant_of_kind(control, registry, body, actor, "guild").await
    }

    async fn create_tenant_of_kind(
        control: &DatabaseConnection,
        registry: &TenantRegistry,
        body: CreateTenantRequest,
        actor: &str,
        kind: &str,
    ) -> Result<TenantView, AppError> {
        let id = body.id.trim();
        if id.is_empty() {
            return Err(AppError::Validation("tenant id is required".to_owned()));
        }
        let name = body.name.trim();
        if name.is_empty() {
            return Err(AppError::Validation("tenant name is required".to_owned()));
        }
        let slug = match body
            .slug
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(slug) => slug.to_owned(),
            None => tenant_slug(id).map_err(|err| AppError::Validation(err.to_string()))?,
        };
        let schema_name =
            tenant_schema_name(id).map_err(|err| AppError::Validation(err.to_string()))?;

        if let Some(existing) = Self::get_tenant(control, id).await? {
            if existing.kind != kind
                || !crate::albion_scope::can_resume_provisioning(&existing.status)
            {
                return Err(AppError::Conflict(format!("tenant {id} already exists")));
            }
            // A previous attempt inserted the row and then failed while creating
            // the schema or running migrations. Resume that row instead of
            // leaving it stuck in `provisioning` with no retry short of SQL.
            registry.provision(id, &existing.schema_name).await?;
        } else {
            control
                .execute(Statement::from_sql_and_values(
                    control.get_database_backend(),
                    "INSERT INTO tenants (id, slug, name, schema_name, status, owner_discord_id, kind) \
                     VALUES ($1, $2, $3, $4, 'provisioning', $5, $6)",
                    [
                        id.into(),
                        slug.clone().into(),
                        name.into(),
                        schema_name.clone().into(),
                        actor.into(),
                        kind.into(),
                    ],
                ))
                .await
                .map_err(map_unique)?;

            registry.provision(id, &schema_name).await?;
        }

        control
            .execute(Statement::from_sql_and_values(
                control.get_database_backend(),
                "UPDATE tenants SET status = 'active' WHERE id = $1",
                [id.into()],
            ))
            .await?;

        if let Some(rank_id) = Self::default_rank_id(control).await? {
            control
                .execute(Statement::from_sql_and_values(
                    control.get_database_backend(),
                    "UPDATE tenants SET rank_id = $2::uuid WHERE id = $1",
                    [id.into(), rank_id.clone().into()],
                ))
                .await?;
            Self::sync_rank_flags(control, id, Some(&rank_id), actor).await?;
            registry.refresh(id).await;
        }

        // Navigation is a tenant-level platform setting rather than a plan
        // capability. New tenants start with it enabled, while platform
        // admins can turn it off later from the feature screen.
        control
            .execute(Statement::from_sql_and_values(
                control.get_database_backend(),
                "INSERT INTO tenant_feature_flags \
                 (tenant_id, feature_key, enabled, enabled_at, enabled_by) \
                 VALUES ($1, $2, true, now(), $3) \
                 ON CONFLICT (tenant_id, feature_key) DO NOTHING",
                [id.into(), FEATURE_SIDEBAR.into(), actor.into()],
            ))
            .await?;

        if let Some(region) = body.albion_api_region.as_deref() {
            Self::update_albion_settings(
                control,
                id,
                body.albion_guild_id.as_deref(),
                Some(region),
                None,
                None,
                None,
            )
            .await?;
        }

        let ctx = registry.get_or_load(id).await?;
        registry
            .ensure_sync_workers(ctx.db.clone(), id, &ctx.kind)
            .await;

        Self::get_tenant(control, id)
            .await?
            .ok_or_else(|| AppError::Internal("tenant vanished after create".to_owned()))
    }

    /// Public lookup used by the Discord bot before running a command.
    ///
    /// # Errors
    ///
    /// Returns a database error if the query fails.
    pub async fn tenant_status(
        control: &DatabaseConnection,
        tenant_id: &str,
        frontend_url: &str,
    ) -> Result<TenantStatusView, AppError> {
        if let Some(row) = Self::get_tenant(control, tenant_id).await? {
            Ok(TenantStatusView {
                id: row.id,
                registered: true,
                status: Some(row.status),
                name: Some(row.name),
                kind: Some(row.kind),
                register_url: None,
            })
        } else {
            let base = frontend_url.trim_end_matches('/');
            Ok(TenantStatusView {
                id: tenant_id.to_owned(),
                registered: false,
                status: None,
                name: None,
                kind: None,
                register_url: Some(format!("{base}/register-tenant?guild={tenant_id}")),
            })
        }
    }

    /// First-time tenant onboarding: provision schema, store Albion settings,
    /// grant `SuperAdmin` to the registrar, and record membership.
    ///
    /// # Errors
    ///
    /// Returns validation/conflict errors, or a database error if provisioning fails.
    pub async fn register_tenant(
        control: &DatabaseConnection,
        registry: &TenantRegistry,
        body: RegisterTenantRequest,
        actor: &str,
        icon_hash: Option<&str>,
    ) -> Result<TenantView, AppError> {
        let kind = parse_tenant_kind(body.kind.as_deref())?;
        if kind == "alliance" {
            return Self::register_alliance_tenant(control, registry, body, actor, icon_hash).await;
        }
        let region = normalize_region(&body.albion_api_region)?;
        let albion_guild_id = body.albion_guild_id.trim();
        if albion_guild_id.is_empty() {
            return Err(AppError::Validation(
                "albion guild id is required".to_owned(),
            ));
        }
        let created = Self::create_tenant_of_kind(
            control,
            registry,
            CreateTenantRequest {
                id: body.id.clone(),
                name: body.name.clone(),
                slug: None,
                albion_guild_id: Some(albion_guild_id.to_owned()),
                albion_api_region: Some(region.clone()),
            },
            actor,
            "guild",
        )
        .await?;
        Self::update_albion_settings(
            control,
            &created.id,
            Some(albion_guild_id),
            Some(&region),
            body.albion_allied_guild_ids.as_deref(),
            body.albion_allied_guild_names.as_deref(),
            icon_hash,
        )
        .await?;
        Self::record_membership(control, actor, &created.id).await?;
        Self::get_tenant(control, &created.id)
            .await?
            .ok_or_else(|| AppError::Internal("tenant vanished after register".to_owned()))
    }

    async fn register_alliance_tenant(
        control: &DatabaseConnection,
        registry: &TenantRegistry,
        body: RegisterTenantRequest,
        actor: &str,
        icon_hash: Option<&str>,
    ) -> Result<TenantView, AppError> {
        let members = Self::resolve_alliance_members(control, &body.member_guild_ids).await?;
        let alliance_id = body
            .albion_alliance_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| AppError::Validation("albion_alliance_required".to_owned()))?;
        let region = if body.albion_api_region.trim().is_empty() {
            "europe"
        } else {
            body.albion_api_region.trim()
        };
        Self::ensure_guilds_in_albion_alliance(&members, alliance_id, region).await?;
        let created = Self::create_tenant_of_kind(
            control,
            registry,
            CreateTenantRequest {
                id: body.id.clone(),
                name: body.name.clone(),
                slug: None,
                albion_guild_id: None,
                albion_api_region: None,
            },
            actor,
            "alliance",
        )
        .await?;
        Self::insert_alliance_memberships(control, &created.id, actor, &members).await?;
        control
            .execute(Statement::from_sql_and_values(
                control.get_database_backend(),
                "UPDATE tenants SET albion_alliance_id = $2, albion_api_region = $3 WHERE id = $1",
                [
                    created.id.clone().into(),
                    alliance_id.to_owned().into(),
                    region.to_owned().into(),
                ],
            ))
            .await?;
        if icon_hash.is_some() {
            Self::update_albion_settings(control, &created.id, None, None, None, None, icon_hash)
                .await?;
        }
        Self::record_membership(control, actor, &created.id).await?;
        Self::get_tenant(control, &created.id)
            .await?
            .ok_or_else(|| AppError::Internal("tenant vanished after register".to_owned()))
    }

    async fn resolve_alliance_members(
        control: &DatabaseConnection,
        member_guild_ids: &[String],
    ) -> Result<Vec<TenantView>, AppError> {
        let mut seen = std::collections::HashSet::new();
        let mut members = Vec::new();
        for raw in member_guild_ids {
            let id = raw.trim();
            if id.is_empty() || !seen.insert(id.to_owned()) {
                continue;
            }
            let Some(tenant) = Self::get_tenant(control, id).await? else {
                return Err(AppError::Validation("alliance_member_invalid".to_owned()));
            };
            if tenant.kind != "guild" || tenant.status != "active" {
                return Err(AppError::Validation("alliance_member_invalid".to_owned()));
            }
            if Self::guild_has_alliance_membership(control, &tenant.id).await? {
                return Err(AppError::Conflict(
                    "alliance_member_already_joined".to_owned(),
                ));
            }
            members.push(tenant);
        }
        if members.is_empty() {
            return Err(AppError::Validation("alliance_requires_guilds".to_owned()));
        }
        Ok(members)
    }

    async fn guild_has_alliance_membership(
        control: &DatabaseConnection,
        guild_tenant_id: &str,
    ) -> Result<bool, AppError> {
        let row = control
            .query_one(Statement::from_sql_and_values(
                control.get_database_backend(),
                "SELECT 1 FROM alliance_memberships WHERE guild_tenant_id = $1 AND status IN ('active', 'pending')",
                [guild_tenant_id.into()],
            ))
            .await?;
        Ok(row.is_some())
    }

    async fn insert_alliance_memberships(
        control: &DatabaseConnection,
        alliance_tenant_id: &str,
        actor: &str,
        members: &[TenantView],
    ) -> Result<(), AppError> {
        let txn = control.begin().await?;
        for member in members {
            let status = if member.owner_discord_id.as_deref() == Some(actor) {
                "active"
            } else {
                "pending"
            };
            let revived = txn
                .execute(Statement::from_sql_and_values(
                    txn.get_database_backend(),
                    "UPDATE alliance_memberships \
                     SET alliance_tenant_id = $1, status = $3, invited_by = $4, \
                         accepted_at = CASE WHEN $3 = 'active' THEN now() ELSE NULL END \
                     WHERE guild_tenant_id = $2 AND status = 'left'",
                    [
                        alliance_tenant_id.into(),
                        member.id.clone().into(),
                        status.into(),
                        actor.into(),
                    ],
                ))
                .await?;
            if revived.rows_affected() > 0 {
                continue;
            }
            txn.execute(Statement::from_sql_and_values(
                txn.get_database_backend(),
                "INSERT INTO alliance_memberships \
                 (alliance_tenant_id, guild_tenant_id, status, invited_by, accepted_at) \
                 VALUES ($1, $2, $3, $4, CASE WHEN $3 = 'active' THEN now() ELSE NULL END)",
                [
                    alliance_tenant_id.into(),
                    member.id.clone().into(),
                    status.into(),
                    actor.into(),
                ],
            ))
            .await
            .map_err(map_membership_unique)?;
        }
        txn.commit().await?;
        Ok(())
    }

    /// Active guild tenants that are not in an alliance right now.
    ///
    /// A `left` membership does not count: that guild is free to join again.
    /// `pending` still counts, so an open invite is not offered twice.
    /// The caller does not have to own the guild; attaching one they do not own
    /// stays a pending invite.
    ///
    /// # Errors
    ///
    /// Returns a database error if the query fails.
    pub async fn list_attachable_guilds(
        control: &DatabaseConnection,
        _actor: &str,
        _managed_ids: &[String],
    ) -> Result<Vec<AttachableGuildView>, AppError> {
        let rows = control
            .query_all(Statement::from_string(
                control.get_database_backend(),
                "SELECT t.id, t.name FROM tenants t \
                 WHERE t.kind = 'guild' AND t.status = 'active' \
                 AND NOT EXISTS (\
                     SELECT 1 FROM alliance_memberships m \
                     WHERE m.guild_tenant_id = t.id \
                       AND m.status IN ('active', 'pending')\
                 ) \
                 ORDER BY t.name",
            ))
            .await?;
        let mut out = Vec::new();
        for row in rows {
            out.push(AttachableGuildView {
                id: row.try_get_by_index(0)?,
                name: row.try_get_by_index(1)?,
            });
        }
        Ok(out)
    }

    /// Memberships of an alliance tenant.
    ///
    /// # Errors
    ///
    /// Returns [`AppError::NotFound`] when the tenant is missing or not an alliance.
    pub async fn list_alliance_members(
        control: &DatabaseConnection,
        alliance_id: &str,
    ) -> Result<Vec<AllianceMemberView>, AppError> {
        let Some(tenant) = Self::get_tenant(control, alliance_id).await? else {
            return Err(AppError::NotFound(format!(
                "tenant {alliance_id} not found"
            )));
        };
        if tenant.kind != "alliance" {
            return Err(AppError::NotFound(format!(
                "tenant {alliance_id} is not an alliance"
            )));
        }
        let rows = control
            .query_all(Statement::from_sql_and_values(
                control.get_database_backend(),
                "SELECT m.guild_tenant_id, t.name, m.status, m.invited_by, m.accepted_at::text, m.discord_role_id \
                 FROM alliance_memberships m \
                 JOIN tenants t ON t.id = m.guild_tenant_id \
                 WHERE m.alliance_tenant_id = $1 \
                 ORDER BY t.name",
                [alliance_id.into()],
            ))
            .await?;
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            out.push(AllianceMemberView {
                guild_tenant_id: row.try_get_by_index(0)?,
                name: row.try_get_by_index(1)?,
                status: row.try_get_by_index(2)?,
                invited_by: row.try_get_by_index(3).ok(),
                accepted_at: row.try_get_by_index(4).ok(),
                discord_role_id: row
                    .try_get_by_index(5)
                    .ok()
                    .filter(|id: &String| !id.is_empty()),
            });
        }
        Ok(out)
    }

    /// Membership status of one guild inside an alliance, if a row exists.
    ///
    /// # Errors
    ///
    /// Returns a database error if the query fails. Does not check that
    /// `alliance_id` is an alliance tenant; callers that list members already do.
    pub async fn alliance_membership_status(
        control: &DatabaseConnection,
        alliance_id: &str,
        guild_tenant_id: &str,
    ) -> Result<Option<String>, AppError> {
        let row = control
            .query_one(Statement::from_sql_and_values(
                control.get_database_backend(),
                "SELECT status FROM alliance_memberships \
                 WHERE alliance_tenant_id = $1 AND guild_tenant_id = $2",
                [alliance_id.into(), guild_tenant_id.into()],
            ))
            .await?;
        match row {
            Some(row) => Ok(Some(row.try_get_by_index(0)?)),
            None => Ok(None),
        }
    }

    /// Alliance settings context for the session's current tenant.
    ///
    /// # Errors
    ///
    /// Returns not-found when `tenant_id` is unknown.
    pub async fn alliance_context_for_tenant(
        control: &DatabaseConnection,
        tenant_id: &str,
    ) -> Result<AllianceContextView, AppError> {
        let Some(tenant) = Self::get_tenant(control, tenant_id).await? else {
            return Err(AppError::NotFound(format!("tenant {tenant_id} not found")));
        };
        if tenant.kind == "alliance" {
            return Ok(AllianceContextView {
                kind: tenant.kind,
                alliance_id: Some(tenant.id.clone()),
                alliance_name: Some(tenant.name),
                membership_status: None,
                members: Self::list_alliance_members(control, &tenant.id).await?,
                albion_alliance_id: tenant.albion_alliance_id.clone(),
            });
        }
        let row = control
            .query_one(Statement::from_sql_and_values(
                control.get_database_backend(),
                "SELECT m.alliance_tenant_id, a.name, m.status \
                 FROM alliance_memberships m \
                 JOIN tenants a ON a.id = m.alliance_tenant_id \
                 WHERE m.guild_tenant_id = $1",
                [tenant_id.into()],
            ))
            .await?;
        let Some(row) = row else {
            return Ok(AllianceContextView {
                kind: tenant.kind,
                alliance_id: None,
                alliance_name: None,
                membership_status: None,
                members: Vec::new(),
                albion_alliance_id: None,
            });
        };
        let alliance_id: String = row.try_get_by_index(0)?;
        let alliance_name: String = row.try_get_by_index(1)?;
        let membership_status: String = row.try_get_by_index(2)?;
        let members = Self::list_alliance_members(control, &alliance_id).await?;
        Ok(AllianceContextView {
            kind: tenant.kind,
            alliance_id: Some(alliance_id),
            alliance_name: Some(alliance_name),
            membership_status: Some(membership_status),
            members,
            albion_alliance_id: None,
        })
    }

    /// Guild tenants whose Albion guild is in `albion_alliance_id` and that are not already active or pending elsewhere.
    pub async fn list_attachable_guilds_in_alliance(
        control: &DatabaseConnection,
        albion_alliance_id: &str,
        region: &str,
    ) -> Result<Vec<AttachableGuildView>, AppError> {
        let rows = control
            .query_all(Statement::from_string(
                control.get_database_backend(),
                "SELECT t.id, t.name, t.albion_guild_id, t.albion_api_region FROM tenants t \
                 WHERE t.kind = 'guild' AND t.status = 'active' \
                   AND t.albion_guild_id IS NOT NULL AND t.albion_guild_id <> '' \
                   AND NOT EXISTS (\
                     SELECT 1 FROM alliance_memberships m \
                     WHERE m.guild_tenant_id = t.id AND m.status IN ('active', 'pending')\
                   ) \
                 ORDER BY t.name",
            ))
            .await?;
        let mut out = Vec::new();
        for row in rows {
            let id: String = row.try_get_by_index(0)?;
            let name: String = row.try_get_by_index(1)?;
            let guild_id: String = row.try_get_by_index(2)?;
            let guild_region: String = row
                .try_get_by_index(3)
                .unwrap_or_else(|_| region.to_owned());
            if guild_region != region {
                continue;
            }
            if guild_belongs_to_alliance(&guild_region, &guild_id, albion_alliance_id).await {
                out.push(AttachableGuildView { id, name });
            }
        }
        Ok(out)
    }

    /// Detaches the Albion alliance and current memberships without deleting the Discord tenant or history.
    pub async fn reset_alliance_setup(
        control: &DatabaseConnection,
        alliance_tenant_id: &str,
        actor: &str,
    ) -> Result<(), AppError> {
        let Some(tenant) = Self::get_tenant(control, alliance_tenant_id).await? else {
            return Err(AppError::NotFound(format!(
                "tenant {alliance_tenant_id} not found"
            )));
        };
        if tenant.kind != "alliance" || tenant.owner_discord_id.as_deref() != Some(actor) {
            return Err(AppError::Forbidden(
                "only the alliance Discord owner can reset setup".to_owned(),
            ));
        }
        let members = Self::list_alliance_members(control, alliance_tenant_id).await?;
        for member in members {
            if member.status == "active" {
                Self::mark_alliance_left(control, alliance_tenant_id, &member.guild_tenant_id, &[])
                    .await?;
            } else if member.status == "pending" {
                control
                    .execute(Statement::from_sql_and_values(
                        control.get_database_backend(),
                        "UPDATE alliance_memberships \
                         SET status = 'left', left_at = COALESCE(left_at, now()) \
                         WHERE alliance_tenant_id = $1 AND guild_tenant_id = $2 AND status = 'pending'",
                        [alliance_tenant_id.into(), member.guild_tenant_id.clone().into()],
                    ))
                    .await?;
                control
                    .execute(Statement::from_sql_and_values(
                        control.get_database_backend(),
                        "UPDATE event_sync_links SET sync_enabled = false \
                         WHERE (source_tenant_id = $1 AND mirror_tenant_id = $2) \
                            OR (source_tenant_id = $2 AND mirror_tenant_id = $1)",
                        [member.guild_tenant_id.into(), alliance_tenant_id.into()],
                    ))
                    .await?;
            }
        }
        control
            .execute(Statement::from_sql_and_values(
                control.get_database_backend(),
                "UPDATE tenants SET albion_alliance_id = NULL WHERE id = $1",
                [alliance_tenant_id.into()],
            ))
            .await?;
        Ok(())
    }

    /// Links an already-created alliance Discord to an Albion alliance and invites matching guilds.
    pub async fn configure_alliance_setup(
        control: &DatabaseConnection,
        alliance_tenant_id: &str,
        actor: &str,
        albion_alliance_id: &str,
        region: &str,
        member_guild_ids: &[String],
    ) -> Result<(), AppError> {
        let Some(tenant) = Self::get_tenant(control, alliance_tenant_id).await? else {
            return Err(AppError::NotFound(format!(
                "tenant {alliance_tenant_id} not found"
            )));
        };
        if tenant.kind != "alliance" || tenant.owner_discord_id.as_deref() != Some(actor) {
            return Err(AppError::Forbidden(
                "only the alliance Discord owner can redo setup".to_owned(),
            ));
        }
        if tenant
            .albion_alliance_id
            .as_deref()
            .is_some_and(|id| !id.is_empty())
        {
            return Err(AppError::Conflict(
                "reset the alliance link before choosing another Albion alliance".to_owned(),
            ));
        }
        let members = Self::resolve_alliance_members(control, member_guild_ids).await?;
        Self::ensure_guilds_in_albion_alliance(&members, albion_alliance_id, region).await?;
        Self::insert_alliance_memberships(control, alliance_tenant_id, actor, &members).await?;
        control
            .execute(Statement::from_sql_and_values(
                control.get_database_backend(),
                "UPDATE tenants SET albion_alliance_id = $2, albion_api_region = $3 WHERE id = $1",
                [
                    alliance_tenant_id.into(),
                    albion_alliance_id.to_owned().into(),
                    region.to_owned().into(),
                ],
            ))
            .await?;
        Ok(())
    }

    async fn ensure_guilds_in_albion_alliance(
        members: &[TenantView],
        albion_alliance_id: &str,
        region: &str,
    ) -> Result<(), AppError> {
        // Automated tests use fake Albion ids and must not call the live API.
        if cfg!(test) {
            return Ok(());
        }
        for member in members {
            let Some(guild_id) = member
                .albion_guild_id
                .as_deref()
                .filter(|id| !id.is_empty())
            else {
                return Err(AppError::Validation(
                    "alliance_member_not_in_albion_alliance".to_owned(),
                ));
            };
            let member_region = member
                .albion_api_region
                .as_deref()
                .filter(|value| !value.is_empty())
                .unwrap_or(region);
            if member_region != region
                || !guild_belongs_to_alliance(member_region, guild_id, albion_alliance_id).await
            {
                return Err(AppError::Validation(
                    "alliance_member_not_in_albion_alliance".to_owned(),
                ));
            }
        }
        Ok(())
    }

    /// The guild owner may decline an invitation before it becomes active.
    ///
    /// Active memberships require a separate departure workflow that handles
    /// shared resources and Discord access; this operation must not remove them.
    ///
    /// # Errors
    ///
    /// Returns forbidden for anyone other than the guild owner, or not-found
    /// when the pending invitation does not exist.
    pub async fn decline_alliance_membership(
        control: &DatabaseConnection,
        alliance_id: &str,
        guild_id: &str,
        actor: &str,
    ) -> Result<(), AppError> {
        let Some(guild) = Self::get_tenant(control, guild_id).await? else {
            return Err(AppError::NotFound(format!("tenant {guild_id} not found")));
        };
        if guild.kind != "guild" || guild.owner_discord_id.as_deref() != Some(actor) {
            return Err(AppError::Forbidden(
                "only the guild owner can decline an alliance invite".to_owned(),
            ));
        }
        let result = control
            .execute(Statement::from_sql_and_values(
                control.get_database_backend(),
                "DELETE FROM alliance_memberships \
                 WHERE alliance_tenant_id = $1 AND guild_tenant_id = $2 AND status = 'pending'",
                [alliance_id.into(), guild_id.into()],
            ))
            .await?;
        if result.rows_affected() == 0 {
            return Err(AppError::NotFound(
                "pending alliance invite not found".to_owned(),
            ));
        }
        Ok(())
    }

    /// Alliance tenant owner invites one guild, reviving a `left` row when one exists.
    ///
    /// This is the same insert used at alliance registration. A departed guild is not
    /// given a second membership. `left_at`, shares, event mirrors, and role-revocation
    /// rows stay. Old event links are not turned back on. `alliance.leave` is not consulted.
    ///
    /// # Errors
    ///
    /// Forbidden unless `actor` owns this alliance tenant. Conflict when the guild already
    /// has a pending or active membership, including one in another alliance.
    pub async fn invite_alliance_membership(
        control: &DatabaseConnection,
        alliance_id: &str,
        guild_id: &str,
        actor: &str,
    ) -> Result<AllianceMemberView, AppError> {
        let Some(alliance) = Self::get_tenant(control, alliance_id).await? else {
            return Err(AppError::NotFound(format!(
                "tenant {alliance_id} not found"
            )));
        };
        if alliance.kind != "alliance" || alliance.owner_discord_id.as_deref() != Some(actor) {
            return Err(AppError::Forbidden(
                "only the alliance owner can invite a guild".to_owned(),
            ));
        }
        let Some(guild) = Self::get_tenant(control, guild_id).await? else {
            return Err(AppError::NotFound(format!("tenant {guild_id} not found")));
        };
        if guild.kind != "guild" || guild.status != "active" {
            return Err(AppError::Validation("alliance_member_invalid".to_owned()));
        }
        Self::insert_alliance_memberships(
            control,
            alliance_id,
            actor,
            std::slice::from_ref(&guild),
        )
        .await?;
        Self::list_alliance_members(control, alliance_id)
            .await?
            .into_iter()
            .find(|row| row.guild_tenant_id == guild_id)
            .ok_or_else(|| AppError::Internal("membership vanished after invite".to_owned()))
    }

    /// Owner of `guild_id` accepts a pending invite into `alliance_id`.
    ///
    /// A `left` membership is not reactivated here. The alliance owner must invite again first.
    ///
    /// # Errors
    ///
    /// Returns not-found, forbidden, or a database error.
    pub async fn accept_alliance_membership(
        control: &DatabaseConnection,
        alliance_id: &str,
        guild_id: &str,
        actor: &str,
    ) -> Result<AllianceMemberView, AppError> {
        let Some(guild) = Self::get_tenant(control, guild_id).await? else {
            return Err(AppError::NotFound(format!("tenant {guild_id} not found")));
        };
        if guild.kind != "guild" || guild.owner_discord_id.as_deref() != Some(actor) {
            return Err(AppError::Forbidden(
                "only the guild owner can accept an alliance invite".to_owned(),
            ));
        }
        let updated = control
            .execute(Statement::from_sql_and_values(
                control.get_database_backend(),
                "UPDATE alliance_memberships \
                 SET status = 'active', accepted_at = COALESCE(accepted_at, now()) \
                 WHERE alliance_tenant_id = $1 AND guild_tenant_id = $2 AND status = 'pending'",
                [alliance_id.into(), guild_id.into()],
            ))
            .await?;
        if updated.rows_affected() == 0 {
            return Err(AppError::NotFound("alliance invite not found".to_owned()));
        }
        Self::list_alliance_members(control, alliance_id)
            .await?
            .into_iter()
            .find(|row| row.guild_tenant_id == guild_id)
            .ok_or_else(|| AppError::Internal("membership vanished after accept".to_owned()))
    }

    /// Sets the alliance-hub Discord role for one member guild.
    ///
    /// # Errors
    ///
    /// Returns not-found when the alliance or membership is missing, or validation
    /// when `discord_role_id` is not a Discord snowflake.
    pub async fn set_alliance_member_discord_role(
        control: &DatabaseConnection,
        alliance_id: &str,
        guild_id: &str,
        discord_role_id: Option<&str>,
    ) -> Result<AllianceMemberView, AppError> {
        let Some(tenant) = Self::get_tenant(control, alliance_id).await? else {
            return Err(AppError::NotFound(format!(
                "tenant {alliance_id} not found"
            )));
        };
        if tenant.kind != "alliance" {
            return Err(AppError::NotFound(format!(
                "tenant {alliance_id} is not an alliance"
            )));
        }
        let role = normalize_optional_discord_snowflake(discord_role_id.unwrap_or(""))?;
        let updated = control
            .execute(Statement::from_sql_and_values(
                control.get_database_backend(),
                "UPDATE alliance_memberships SET discord_role_id = $3 \
                 WHERE alliance_tenant_id = $1 AND guild_tenant_id = $2",
                [alliance_id.into(), guild_id.into(), role.clone().into()],
            ))
            .await?;
        if updated.rows_affected() == 0 {
            return Err(AppError::NotFound(
                "alliance membership not found".to_owned(),
            ));
        }
        Self::list_alliance_members(control, alliance_id)
            .await?
            .into_iter()
            .find(|row| row.guild_tenant_id == guild_id)
            .ok_or_else(|| AppError::Internal("membership vanished after role update".to_owned()))
    }

    /// Records that this membership's link flow granted `role_id` to one Discord user.
    ///
    /// Departure only removes roles listed here. People who merely have the same
    /// role are not guessed at.
    pub async fn record_alliance_role_grant(
        control: &DatabaseConnection,
        alliance_id: &str,
        guild_id: &str,
        discord_guild_id: &str,
        discord_user_id: &str,
        role_id: &str,
    ) -> Result<(), AppError> {
        let discord_guild_id = discord_guild_id.trim();
        let discord_user_id = discord_user_id.trim();
        let role_id = role_id.trim();
        if discord_guild_id.is_empty() || discord_user_id.is_empty() || role_id.is_empty() {
            return Ok(());
        }
        control
            .execute(Statement::from_sql_and_values(
                control.get_database_backend(),
                "INSERT INTO alliance_role_grants \
                 (alliance_tenant_id, guild_tenant_id, discord_guild_id, discord_user_id, role_id) \
                 VALUES ($1, $2, $3, $4, $5) \
                 ON CONFLICT DO NOTHING",
                [
                    alliance_id.into(),
                    guild_id.into(),
                    discord_guild_id.into(),
                    discord_user_id.into(),
                    role_id.into(),
                ],
            ))
            .await?;
        Ok(())
    }

    /// Guild-initiated departure from an active alliance membership.
    ///
    /// The caller must hold `alliance.leave` (`granted_leave`) or be the owner of
    /// this guild tenant. Pending invites are not declined here. History (the
    /// membership row, published shares, and event-sync links) is kept; future
    /// sync is disabled before Discord is contacted.
    ///
    /// # Errors
    ///
    /// Forbidden when the actor is neither granted nor the guild owner, conflict
    /// when the invite is still pending, not-found when the membership is missing.
    pub async fn leave_active_alliance<R, Fut>(
        control: &DatabaseConnection,
        alliance_id: &str,
        guild_id: &str,
        actor: &str,
        granted_leave: bool,
        untracked_roles: &[UntrackedAllianceRole],
        revoker: R,
    ) -> Result<AllianceMemberView, AppError>
    where
        R: Fn(&str, &str, &str) -> Fut + Sync,
        Fut: Future<Output = Result<(), String>> + Send,
    {
        if !granted_leave && !Self::is_tenant_owner(control, guild_id, actor).await? {
            return Err(AppError::Forbidden(
                "missing permission alliance.leave".to_owned(),
            ));
        }
        let Some(guild) = Self::get_tenant(control, guild_id).await? else {
            return Err(AppError::NotFound(format!("tenant {guild_id} not found")));
        };
        if guild.kind != "guild" {
            return Err(AppError::Forbidden(
                "only the member guild can leave an alliance".to_owned(),
            ));
        }
        let status = Self::alliance_membership_status(control, alliance_id, guild_id).await?;
        match status.as_deref() {
            Some("pending") => {
                return Err(AppError::Conflict(
                    "pending alliance invite must be declined, not left".to_owned(),
                ));
            }
            Some("active") => {
                Self::mark_alliance_left(control, alliance_id, guild_id, untracked_roles).await?;
            }
            Some("left") => {}
            Some(_) | None => {
                return Err(AppError::NotFound(
                    "active alliance membership not found".to_owned(),
                ));
            }
        }
        Self::retry_alliance_role_revocations(control, alliance_id, guild_id, &revoker).await?;
        Self::list_alliance_members(control, alliance_id)
            .await?
            .into_iter()
            .find(|row| row.guild_tenant_id == guild_id)
            .ok_or_else(|| AppError::Internal("membership vanished after leave".to_owned()))
    }

    async fn mark_alliance_left(
        control: &DatabaseConnection,
        alliance_id: &str,
        guild_id: &str,
        untracked_roles: &[UntrackedAllianceRole],
    ) -> Result<(), AppError> {
        let txn = control.begin().await?;
        let updated = txn
            .execute(Statement::from_sql_and_values(
                txn.get_database_backend(),
                "UPDATE alliance_memberships \
                 SET status = 'left', left_at = COALESCE(left_at, now()) \
                 WHERE alliance_tenant_id = $1 AND guild_tenant_id = $2 AND status = 'active'",
                [alliance_id.into(), guild_id.into()],
            ))
            .await?;
        if updated.rows_affected() == 0 {
            return Err(AppError::Conflict(
                "alliance membership is no longer active".to_owned(),
            ));
        }
        txn.execute(Statement::from_sql_and_values(
            txn.get_database_backend(),
            "UPDATE event_sync_links SET sync_enabled = false \
             WHERE (source_tenant_id = $1 AND mirror_tenant_id = $2) \
                OR (source_tenant_id = $2 AND mirror_tenant_id = $1)",
            [guild_id.into(), alliance_id.into()],
        ))
        .await?;
        let grants = txn
            .query_all(Statement::from_sql_and_values(
                txn.get_database_backend(),
                "SELECT discord_guild_id, discord_user_id, role_id \
                 FROM alliance_role_grants \
                 WHERE alliance_tenant_id = $1 AND guild_tenant_id = $2",
                [alliance_id.into(), guild_id.into()],
            ))
            .await?;
        for row in &grants {
            let discord_guild_id: String = row.try_get_by_index(0)?;
            let discord_user_id: String = row.try_get_by_index(1)?;
            let role_id: String = row.try_get_by_index(2)?;
            insert_role_revocation(
                &txn,
                alliance_id,
                guild_id,
                &discord_guild_id,
                &discord_user_id,
                &role_id,
                "pending",
                None,
            )
            .await?;
        }
        for role in untracked_roles {
            let discord_guild_id = role.discord_guild_id.trim();
            let role_id = role.role_id.trim();
            if discord_guild_id.is_empty() || role_id.is_empty() {
                continue;
            }
            let known = txn
                .query_one(Statement::from_sql_and_values(
                    txn.get_database_backend(),
                    "SELECT 1 FROM alliance_role_grants \
                     WHERE alliance_tenant_id = $1 AND guild_tenant_id = $2 \
                       AND discord_guild_id = $3 AND role_id = $4",
                    [
                        alliance_id.into(),
                        guild_id.into(),
                        discord_guild_id.into(),
                        role_id.into(),
                    ],
                ))
                .await?;
            if known.is_some() {
                continue;
            }
            insert_role_revocation(
                &txn,
                alliance_id,
                guild_id,
                discord_guild_id,
                "",
                role_id,
                "ambiguous",
                Some(
                    "no membership grant identifies who received this alliance role; role was not removed",
                ),
            )
            .await?;
        }
        txn.commit().await?;
        Ok(())
    }

    async fn retry_alliance_role_revocations<R, Fut>(
        control: &DatabaseConnection,
        alliance_id: &str,
        guild_id: &str,
        revoker: &R,
    ) -> Result<(), AppError>
    where
        R: Fn(&str, &str, &str) -> Fut + Sync,
        Fut: Future<Output = Result<(), String>> + Send,
    {
        let pending = control
            .query_all(Statement::from_sql_and_values(
                control.get_database_backend(),
                "SELECT id::text, discord_guild_id, discord_user_id, role_id \
                 FROM alliance_role_revocations \
                 WHERE alliance_tenant_id = $1 AND guild_tenant_id = $2 \
                   AND status = 'pending' AND discord_user_id <> ''",
                [alliance_id.into(), guild_id.into()],
            ))
            .await?;
        for row in pending {
            let id: String = row.try_get_by_index(0)?;
            let discord_guild_id: String = row.try_get_by_index(1)?;
            let discord_user_id: String = row.try_get_by_index(2)?;
            let role_id: String = row.try_get_by_index(3)?;
            match revoker(&discord_guild_id, &discord_user_id, &role_id).await {
                Ok(()) => {
                    control
                        .execute(Statement::from_sql_and_values(
                            control.get_database_backend(),
                            "UPDATE alliance_role_revocations \
                             SET status = 'verified', verified_at = now(), detail = NULL \
                             WHERE id = $1::uuid AND status = 'pending'",
                            [id.into()],
                        ))
                        .await?;
                }
                Err(error) => {
                    control
                        .execute(Statement::from_sql_and_values(
                            control.get_database_backend(),
                            "UPDATE alliance_role_revocations \
                             SET detail = $2 \
                             WHERE id = $1::uuid AND status = 'pending'",
                            [id.into(), error.into()],
                        ))
                        .await?;
                }
            }
        }
        Ok(())
    }

    /// Record that `discord_id` may enter `tenant_id`.
    ///
    /// # Errors
    ///
    /// Returns a database error if the insert fails.
    pub async fn record_membership(
        control: &DatabaseConnection,
        discord_id: &str,
        tenant_id: &str,
    ) -> Result<(), AppError> {
        control
            .execute(Statement::from_sql_and_values(
                control.get_database_backend(),
                "INSERT INTO user_tenant_memberships (discord_id, tenant_id) \
                 VALUES ($1, $2) ON CONFLICT DO NOTHING",
                [discord_id.into(), tenant_id.into()],
            ))
            .await?;
        Ok(())
    }

    /// Drop the right of `discord_id` to enter `tenant_id`.
    ///
    /// Called when a live Discord check finds the user is no longer in that tenant's server:
    /// web access follows Discord presence, so a stale membership row must not keep a removed
    /// member signing in. A no-op when no row exists.
    ///
    /// # Errors
    ///
    /// Returns a database error if the delete fails.
    pub async fn forget_membership(
        control: &DatabaseConnection,
        discord_id: &str,
        tenant_id: &str,
    ) -> Result<(), AppError> {
        control
            .execute(Statement::from_sql_and_values(
                control.get_database_backend(),
                "DELETE FROM user_tenant_memberships WHERE discord_id = $1 AND tenant_id = $2",
                [discord_id.into(), tenant_id.into()],
            ))
            .await?;
        Ok(())
    }

    /// Tenants this Discord user may switch into.
    ///
    /// Platform admins see every active tenant.
    ///
    /// # Errors
    ///
    /// Returns a database error if the query fails.
    pub async fn list_memberships(
        control: &DatabaseConnection,
        discord_id: &str,
        all: bool,
    ) -> Result<Vec<crate::modules::auth::service::TenantChoice>, AppError> {
        let sql = if all {
            "SELECT id, name, slug, discord_icon_hash FROM tenants \
             WHERE status = 'active' ORDER BY name"
                .to_owned()
        } else {
            "SELECT t.id, t.name, t.slug, t.discord_icon_hash \
             FROM tenants t \
             JOIN user_tenant_memberships m ON m.tenant_id = t.id \
             WHERE m.discord_id = $1 AND t.status = 'active' \
             ORDER BY t.name"
                .to_owned()
        };
        let rows = if all {
            control
                .query_all(Statement::from_string(control.get_database_backend(), sql))
                .await?
        } else {
            control
                .query_all(Statement::from_sql_and_values(
                    control.get_database_backend(),
                    sql,
                    [discord_id.into()],
                ))
                .await?
        };
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            out.push(crate::modules::auth::service::TenantChoice {
                id: row.try_get_by_index(0)?,
                name: row.try_get_by_index(1)?,
                slug: row.try_get_by_index(2)?,
                icon_hash: row.try_get_by_index(3).ok(),
                is_default: false,
            });
        }
        Ok(out)
    }

    /// Stores the current Discord guild icon hash. Empty input is ignored.
    ///
    /// # Errors
    ///
    /// Returns a database error if the update fails.
    pub async fn set_discord_icon_hash(
        control: &DatabaseConnection,
        tenant_id: &str,
        icon_hash: &str,
    ) -> Result<(), AppError> {
        let icon_hash = icon_hash.trim();
        if icon_hash.is_empty() {
            return Ok(());
        }
        control
            .execute(Statement::from_sql_and_values(
                control.get_database_backend(),
                "UPDATE tenants SET discord_icon_hash = $2 WHERE id = $1",
                [tenant_id.into(), icon_hash.into()],
            ))
            .await?;
        Ok(())
    }

    /// True when `discord_id` is recorded as a member of `tenant_id`.
    ///
    /// # Errors
    ///
    /// Returns a database error if the query fails.
    pub async fn is_member(
        control: &DatabaseConnection,
        discord_id: &str,
        tenant_id: &str,
    ) -> Result<bool, AppError> {
        let row = control
            .query_one(Statement::from_sql_and_values(
                control.get_database_backend(),
                "SELECT 1 FROM user_tenant_memberships \
                 WHERE discord_id = $1 AND tenant_id = $2",
                [discord_id.into(), tenant_id.into()],
            ))
            .await?;
        Ok(row.is_some())
    }

    /// Suspend or resume a tenant, optionally renaming it.
    ///
    /// # Errors
    ///
    /// Returns not-found or validation errors.
    pub async fn patch_tenant(
        control: &DatabaseConnection,
        registry: &TenantRegistry,
        tenant_id: &str,
        body: PatchTenantRequest,
        actor: &str,
    ) -> Result<TenantView, AppError> {
        if Self::get_tenant(control, tenant_id).await?.is_none() {
            return Err(AppError::NotFound(format!("tenant {tenant_id} not found")));
        }

        if let Some(name) = body
            .name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            control
                .execute(Statement::from_sql_and_values(
                    control.get_database_backend(),
                    "UPDATE tenants SET name = $2 WHERE id = $1",
                    [tenant_id.into(), name.into()],
                ))
                .await?;
        }

        if let Some(owner) = body.owner_discord_id.as_deref() {
            let owner = owner.trim();
            if owner.is_empty() {
                return Err(AppError::Validation(
                    "owner_discord_id must not be empty".to_owned(),
                ));
            }
            control
                .execute(Statement::from_sql_and_values(
                    control.get_database_backend(),
                    "UPDATE tenants SET owner_discord_id = $2 WHERE id = $1",
                    [tenant_id.into(), owner.into()],
                ))
                .await?;
        }

        let albion_touched = body.albion_guild_id.is_some()
            || body.albion_api_region.is_some()
            || body.albion_allied_guild_ids.is_some()
            || body.albion_allied_guild_names.is_some();
        if albion_touched {
            let region = match body.albion_api_region.as_deref() {
                Some(raw) => Some(normalize_region(raw)?),
                None => None,
            };
            Self::update_albion_settings(
                control,
                tenant_id,
                body.albion_guild_id.as_deref().map(str::trim),
                region.as_deref(),
                body.albion_allied_guild_ids.as_deref(),
                body.albion_allied_guild_names.as_deref(),
                None,
            )
            .await?;
        }

        if let Some(rank_id) = body.rank_id.as_deref() {
            let rank_id = rank_id.trim();
            if rank_id.is_empty() {
                control
                    .execute(Statement::from_sql_and_values(
                        control.get_database_backend(),
                        "UPDATE tenants SET rank_id = NULL WHERE id = $1",
                        [tenant_id.into()],
                    ))
                    .await?;
                Self::sync_rank_flags(control, tenant_id, None, actor).await?;
            } else {
                if Self::get_rank(control, rank_id).await?.is_none() {
                    return Err(AppError::Validation(format!(
                        "rank {rank_id} does not exist"
                    )));
                }
                control
                    .execute(Statement::from_sql_and_values(
                        control.get_database_backend(),
                        "UPDATE tenants SET rank_id = $2::uuid WHERE id = $1",
                        [tenant_id.into(), rank_id.into()],
                    ))
                    .await?;
                Self::sync_rank_flags(control, tenant_id, Some(rank_id), actor).await?;
            }
            registry.refresh(tenant_id).await;
        }

        if let Some(is_default) = body.is_default {
            if is_default {
                // The partial unique index also protects this invariant for
                // concurrent requests; clearing first keeps the update
                // deterministic for normal requests.
                control
                    .execute(Statement::from_sql_and_values(
                        control.get_database_backend(),
                        "UPDATE tenants SET is_default = false WHERE is_default",
                        [],
                    ))
                    .await?;
            }
            control
                .execute(Statement::from_sql_and_values(
                    control.get_database_backend(),
                    "UPDATE tenants SET is_default = $2 WHERE id = $1",
                    [tenant_id.into(), is_default.into()],
                ))
                .await?;
        }

        if let Some(status) = body.status.as_deref() {
            match status {
                "suspended" => {
                    control
                        .execute(Statement::from_sql_and_values(
                            control.get_database_backend(),
                            "UPDATE tenants SET status = 'suspended', suspended_at = now() \
                             WHERE id = $1",
                            [tenant_id.into()],
                        ))
                        .await?;
                    registry.stop_sync_workers(tenant_id);
                    registry.evict(tenant_id);
                }
                "active" => {
                    control
                        .execute(Statement::from_sql_and_values(
                            control.get_database_backend(),
                            "UPDATE tenants SET status = 'active', suspended_at = NULL \
                             WHERE id = $1",
                            [tenant_id.into()],
                        ))
                        .await?;
                    registry.evict(tenant_id);
                    let ctx = registry.get_or_load(tenant_id).await?;
                    registry
                        .ensure_sync_workers(ctx.db.clone(), tenant_id, &ctx.kind)
                        .await;
                }
                other => {
                    return Err(AppError::Validation(format!(
                        "status must be active or suspended, not {other}"
                    )));
                }
            }
        }

        Self::get_tenant(control, tenant_id)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("tenant {tenant_id} not found")))
    }

    /// Catalog plus current flags for one tenant.
    ///
    /// # Errors
    ///
    /// Returns not-found if the tenant is missing.
    pub async fn get_features(
        control: &DatabaseConnection,
        tenant_id: &str,
    ) -> Result<TenantFeaturesView, AppError> {
        let tenant = Self::get_tenant(control, tenant_id)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("tenant {tenant_id} not found")))?;
        let catalog = Self::feature_catalog(control).await?;
        let flag_rows = control
            .query_all(Statement::from_sql_and_values(
                control.get_database_backend(),
                "SELECT feature_key, enabled FROM tenant_feature_flags WHERE tenant_id = $1",
                [tenant_id.into()],
            ))
            .await?;
        let mut flags = Vec::new();
        for row in flag_rows {
            flags.push(TenantFeatureFlag {
                key: row.try_get_by_index(0)?,
                enabled: row.try_get_by_index(1)?,
            });
        }
        let allowed_keys = match tenant.rank_id.as_deref() {
            Some(rank_id) => Self::rank_feature_keys(control, rank_id).await?,
            None => Vec::new(),
        };
        Ok(TenantFeaturesView {
            catalog,
            flags,
            rank_id: tenant.rank_id,
            rank_name: tenant.rank_name,
            allowed_keys,
        })
    }

    /// Upsert flag rows and evict the tenant cache so the next request reloads them.
    ///
    /// # Errors
    ///
    /// Returns not-found or a database error.
    pub async fn put_features(
        control: &DatabaseConnection,
        registry: &TenantRegistry,
        tenant_id: &str,
        body: PutTenantFeaturesRequest,
        actor: &str,
        enforce_allowlist: bool,
    ) -> Result<TenantFeaturesView, AppError> {
        if Self::get_tenant(control, tenant_id).await?.is_none() {
            return Err(AppError::NotFound(format!("tenant {tenant_id} not found")));
        }
        if enforce_allowlist {
            let allowed = Self::get_features(control, tenant_id).await?.allowed_keys;
            for flag in &body.flags {
                if flag.enabled && !allowed.iter().any(|key| key == &flag.key) {
                    return Err(AppError::Conflict(format!(
                        "feature {} is not included in this tenant rank",
                        flag.key
                    )));
                }
            }
        }
        for flag in &body.flags {
            control
                .execute(Statement::from_sql_and_values(
                    control.get_database_backend(),
                    "INSERT INTO tenant_feature_flags \
                     (tenant_id, feature_key, enabled, enabled_at, enabled_by) \
                     VALUES ($1, $2, $3, CASE WHEN $3 THEN now() ELSE NULL END, $4) \
                     ON CONFLICT (tenant_id, feature_key) DO UPDATE SET \
                     enabled = EXCLUDED.enabled, \
                     enabled_at = CASE WHEN EXCLUDED.enabled THEN now() ELSE NULL END, \
                     enabled_by = EXCLUDED.enabled_by",
                    [
                        tenant_id.into(),
                        flag.key.clone().into(),
                        flag.enabled.into(),
                        actor.into(),
                    ],
                ))
                .await?;
        }
        registry.refresh(tenant_id).await;
        Self::get_features(control, tenant_id).await
    }

    /// List platform-role assignments.
    ///
    /// # Errors
    ///
    /// Returns a database error if the query fails.
    pub async fn list_admins(
        control: &DatabaseConnection,
    ) -> Result<Vec<PlatformAdminView>, AppError> {
        let rows = control
            .query_all(Statement::from_string(
                control.get_database_backend(),
                "SELECT a.discord_id, a.platform_role_id::text, r.name \
                 FROM platform_role_assignments a \
                 JOIN platform_roles r ON r.id = a.platform_role_id \
                 ORDER BY a.discord_id"
                    .to_owned(),
            ))
            .await?;
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            out.push(PlatformAdminView {
                discord_id: row.try_get_by_index(0)?,
                role_id: row.try_get_by_index(1)?,
                role_name: row.try_get_by_index(2)?,
            });
        }
        Ok(out)
    }

    /// Grant the `SuperAdmin` platform role.
    ///
    /// # Errors
    ///
    /// Returns validation or database errors.
    pub async fn assign_admin(
        control: &DatabaseConnection,
        body: AssignAdminRequest,
        actor: &str,
    ) -> Result<PlatformAdminView, AppError> {
        let discord_id = body.discord_id.trim();
        if discord_id.is_empty() {
            return Err(AppError::Validation("discord_id is required".to_owned()));
        }
        control
            .execute(Statement::from_sql_and_values(
                control.get_database_backend(),
                "INSERT INTO platform_role_assignments (discord_id, platform_role_id, assigned_by) \
                 VALUES ($1, $2::uuid, $3) \
                 ON CONFLICT (discord_id, platform_role_id) DO NOTHING",
                [
                    discord_id.into(),
                    Value::from(SUPERADMIN_ROLE_ID),
                    actor.into(),
                ],
            ))
            .await?;
        Self::list_admins(control)
            .await?
            .into_iter()
            .find(|row| row.discord_id == discord_id)
            .ok_or_else(|| AppError::Internal("assignment missing after insert".to_owned()))
    }

    /// Revoke every platform role from `discord_id`.
    ///
    /// # Errors
    ///
    /// Returns not-found if nothing was deleted.
    pub async fn revoke_admin(
        control: &DatabaseConnection,
        discord_id: &str,
    ) -> Result<(), AppError> {
        let result = control
            .execute(Statement::from_sql_and_values(
                control.get_database_backend(),
                "DELETE FROM platform_role_assignments WHERE discord_id = $1",
                [discord_id.into()],
            ))
            .await?;
        if result.rows_affected() == 0 {
            return Err(AppError::NotFound(format!(
                "no platform role for {discord_id}"
            )));
        }
        Ok(())
    }

    /// Every catalog feature (optional modules).
    ///
    /// # Errors
    ///
    /// Returns a database error if the query fails.
    pub async fn list_catalog(
        control: &DatabaseConnection,
    ) -> Result<Vec<FeatureCatalogItem>, AppError> {
        Self::feature_catalog(control).await
    }

    async fn feature_catalog(
        control: &DatabaseConnection,
    ) -> Result<Vec<FeatureCatalogItem>, AppError> {
        let rows = control
            .query_all(Statement::from_string(
                control.get_database_backend(),
                "SELECT key, display_name, description FROM feature_catalog ORDER BY key"
                    .to_owned(),
            ))
            .await?;
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            out.push(FeatureCatalogItem {
                key: row.try_get_by_index(0)?,
                display_name: row.try_get_by_index(1)?,
                description: row.try_get_by_index(2).ok(),
            });
        }
        Ok(out)
    }

    /// Load one tenant by Discord guild id.
    ///
    /// # Errors
    ///
    /// Returns a database error if the query fails.
    pub async fn get_tenant(
        control: &DatabaseConnection,
        tenant_id: &str,
    ) -> Result<Option<TenantView>, DbErr> {
        let row = control
            .query_one(Statement::from_sql_and_values(
                control.get_database_backend(),
                format!("{TENANT_SELECT} WHERE t.id = $1"),
                [tenant_id.into()],
            ))
            .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        Ok(Some(row_to_view(&row)?))
    }

    /// List every tenant rank, with attached feature keys.
    ///
    /// # Errors
    ///
    /// Returns a database error if the query fails.
    pub async fn list_ranks(control: &DatabaseConnection) -> Result<Vec<TenantRankView>, AppError> {
        let rows = control
            .query_all(Statement::from_string(
                control.get_database_backend(),
                "SELECT id::text, name, description, is_default, created_at::text \
                 FROM tenant_ranks ORDER BY name"
                    .to_owned(),
            ))
            .await?;
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let id: String = row.try_get_by_index(0)?;
            let feature_keys = Self::rank_feature_keys(control, &id).await?;
            out.push(TenantRankView {
                id,
                name: row.try_get_by_index(1)?,
                description: row.try_get_by_index(2).ok(),
                is_default: row.try_get_by_index(3)?,
                created_at: row.try_get_by_index(4).ok(),
                feature_keys,
            });
        }
        Ok(out)
    }

    /// Create a rank with no features attached.
    ///
    /// # Errors
    ///
    /// Returns validation or unique-name conflicts.
    pub async fn create_rank(
        control: &DatabaseConnection,
        body: CreateRankRequest,
    ) -> Result<TenantRankView, AppError> {
        let name = body.name.trim();
        if name.is_empty() {
            return Err(AppError::Validation("rank name is required".to_owned()));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let description = body
            .description
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        control
            .execute(Statement::from_sql_and_values(
                control.get_database_backend(),
                "INSERT INTO tenant_ranks (id, name, description) VALUES ($1::uuid, $2, $3)",
                [
                    id.clone().into(),
                    name.into(),
                    description.map(ToOwned::to_owned).into(),
                ],
            ))
            .await
            .map_err(map_unique)?;
        Self::get_rank(control, &id)
            .await?
            .ok_or_else(|| AppError::Internal("rank vanished after create".to_owned()))
    }

    /// Rename a rank.
    ///
    /// # Errors
    ///
    /// Returns not-found or validation errors.
    pub async fn patch_rank(
        control: &DatabaseConnection,
        rank_id: &str,
        body: PatchRankRequest,
    ) -> Result<TenantRankView, AppError> {
        if Self::get_rank(control, rank_id).await?.is_none() {
            return Err(AppError::NotFound(format!("rank {rank_id} not found")));
        }
        if let Some(name) = body
            .name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            control
                .execute(Statement::from_sql_and_values(
                    control.get_database_backend(),
                    "UPDATE tenant_ranks SET name = $2 WHERE id = $1::uuid",
                    [rank_id.into(), name.into()],
                ))
                .await
                .map_err(map_unique)?;
        }
        if let Some(description) = body.description.as_deref() {
            let description = description.trim();
            let value = if description.is_empty() {
                None
            } else {
                Some(description.to_owned())
            };
            control
                .execute(Statement::from_sql_and_values(
                    control.get_database_backend(),
                    "UPDATE tenant_ranks SET description = $2 WHERE id = $1::uuid",
                    [rank_id.into(), value.into()],
                ))
                .await?;
        }
        if let Some(is_default) = body.is_default {
            // Clear first, then set: the partial unique index on `is_default`
            // rejects a second default row whatever order the update scans in.
            let txn = control.begin().await?;
            txn.execute(Statement::from_sql_and_values(
                txn.get_database_backend(),
                "UPDATE tenant_ranks SET is_default = false \
                 WHERE is_default AND ($2 OR id = $1::uuid)",
                [rank_id.into(), is_default.into()],
            ))
            .await?;
            if is_default {
                txn.execute(Statement::from_sql_and_values(
                    txn.get_database_backend(),
                    "UPDATE tenant_ranks SET is_default = true WHERE id = $1::uuid",
                    [rank_id.into()],
                ))
                .await?;
            }
            txn.commit().await?;
        }
        Self::get_rank(control, rank_id)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("rank {rank_id} not found")))
    }

    /// Delete a rank that no tenant uses.
    ///
    /// # Errors
    ///
    /// Returns 409 when tenants still reference the rank.
    pub async fn delete_rank(control: &DatabaseConnection, rank_id: &str) -> Result<(), AppError> {
        if Self::get_rank(control, rank_id).await?.is_none() {
            return Err(AppError::NotFound(format!("rank {rank_id} not found")));
        }
        let in_use: i64 = control
            .query_one(Statement::from_sql_and_values(
                control.get_database_backend(),
                "SELECT count(*) FROM tenants WHERE rank_id = $1::uuid",
                [rank_id.into()],
            ))
            .await?
            .and_then(|row| row.try_get_by_index(0).ok())
            .unwrap_or(0);
        if in_use > 0 {
            return Err(AppError::Conflict(format!(
                "rank {rank_id} is assigned to {in_use} tenant(s)"
            )));
        }
        control
            .execute(Statement::from_sql_and_values(
                control.get_database_backend(),
                "DELETE FROM tenant_ranks WHERE id = $1::uuid",
                [rank_id.into()],
            ))
            .await?;
        Ok(())
    }

    /// Replace the feature allowlist for a rank and sync assigned tenants.
    ///
    /// # Errors
    ///
    /// Returns not-found or a database error.
    pub async fn put_rank_features(
        control: &DatabaseConnection,
        registry: &TenantRegistry,
        rank_id: &str,
        body: PutRankFeaturesRequest,
        actor: &str,
    ) -> Result<TenantRankView, AppError> {
        if Self::get_rank(control, rank_id).await?.is_none() {
            return Err(AppError::NotFound(format!("rank {rank_id} not found")));
        }
        control
            .execute(Statement::from_sql_and_values(
                control.get_database_backend(),
                "DELETE FROM tenant_rank_features WHERE rank_id = $1::uuid",
                [rank_id.into()],
            ))
            .await?;
        for key in &body.keys {
            let key = key.trim();
            if key.is_empty() {
                continue;
            }
            control
                .execute(Statement::from_sql_and_values(
                    control.get_database_backend(),
                    "INSERT INTO tenant_rank_features (rank_id, feature_key) \
                     VALUES ($1::uuid, $2)",
                    [rank_id.into(), key.into()],
                ))
                .await?;
        }
        let tenant_rows = control
            .query_all(Statement::from_sql_and_values(
                control.get_database_backend(),
                "SELECT id FROM tenants WHERE rank_id = $1::uuid",
                [rank_id.into()],
            ))
            .await?;
        for row in tenant_rows {
            let tenant_id: String = row.try_get_by_index(0)?;
            Self::sync_rank_flags(control, &tenant_id, Some(rank_id), actor).await?;
            registry.refresh(&tenant_id).await;
        }
        Self::get_rank(control, rank_id)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("rank {rank_id} not found")))
    }

    async fn get_rank(
        control: &DatabaseConnection,
        rank_id: &str,
    ) -> Result<Option<TenantRankView>, AppError> {
        let row = control
            .query_one(Statement::from_sql_and_values(
                control.get_database_backend(),
                "SELECT id::text, name, description, is_default, created_at::text \
                 FROM tenant_ranks WHERE id = $1::uuid",
                [rank_id.into()],
            ))
            .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        Ok(Some(TenantRankView {
            id: row.try_get_by_index(0)?,
            name: row.try_get_by_index(1)?,
            description: row.try_get_by_index(2).ok(),
            is_default: row.try_get_by_index(3)?,
            created_at: row.try_get_by_index(4).ok(),
            feature_keys: Self::rank_feature_keys(control, rank_id).await?,
        }))
    }

    /// Rank handed to tenants created without an explicit one, if any.
    async fn default_rank_id(control: &DatabaseConnection) -> Result<Option<String>, AppError> {
        let row = control
            .query_one(Statement::from_string(
                control.get_database_backend(),
                "SELECT id::text FROM tenant_ranks WHERE is_default LIMIT 1".to_owned(),
            ))
            .await?;
        match row {
            Some(row) => Ok(Some(row.try_get_by_index(0)?)),
            None => Ok(None),
        }
    }

    async fn rank_feature_keys(
        control: &DatabaseConnection,
        rank_id: &str,
    ) -> Result<Vec<String>, AppError> {
        let rows = control
            .query_all(Statement::from_sql_and_values(
                control.get_database_backend(),
                "SELECT feature_key FROM tenant_rank_features \
                 WHERE rank_id = $1::uuid ORDER BY feature_key",
                [rank_id.into()],
            ))
            .await?;
        let mut keys = Vec::with_capacity(rows.len());
        for row in rows {
            keys.push(row.try_get_by_index(0)?);
        }
        Ok(keys)
    }

    async fn sync_rank_flags(
        control: &DatabaseConnection,
        tenant_id: &str,
        rank_id: Option<&str>,
        actor: &str,
    ) -> Result<(), AppError> {
        if let Some(rank_id) = rank_id {
            control
                .execute(Statement::from_sql_and_values(
                    control.get_database_backend(),
                    "INSERT INTO tenant_feature_flags \
                     (tenant_id, feature_key, enabled, enabled_at, enabled_by) \
                     SELECT $1, feature_key, true, now(), $2 \
                     FROM tenant_rank_features WHERE rank_id = $3::uuid \
                     ON CONFLICT (tenant_id, feature_key) DO NOTHING",
                    [tenant_id.into(), actor.into(), rank_id.into()],
                ))
                .await?;
            control
                .execute(Statement::from_sql_and_values(
                    control.get_database_backend(),
                    "UPDATE tenant_feature_flags SET enabled = false, enabled_at = NULL \
                     WHERE tenant_id = $1 AND enabled AND feature_key <> $3 \
                     AND feature_key NOT IN \
                     (SELECT feature_key FROM tenant_rank_features WHERE rank_id = $2::uuid)",
                    [tenant_id.into(), rank_id.into(), FEATURE_SIDEBAR.into()],
                ))
                .await?;
        } else {
            control
                .execute(Statement::from_sql_and_values(
                    control.get_database_backend(),
                    "UPDATE tenant_feature_flags SET enabled = false, enabled_at = NULL \
                     WHERE tenant_id = $1 AND enabled AND feature_key <> $2",
                    [tenant_id.into(), FEATURE_SIDEBAR.into()],
                ))
                .await?;
        }
        Ok(())
    }

    async fn update_albion_settings(
        control: &DatabaseConnection,
        tenant_id: &str,
        albion_guild_id: Option<&str>,
        albion_api_region: Option<&str>,
        allied_ids: Option<&str>,
        allied_names: Option<&str>,
        icon_hash: Option<&str>,
    ) -> Result<(), AppError> {
        control
            .execute(Statement::from_sql_and_values(
                control.get_database_backend(),
                "UPDATE tenants SET \
                 albion_guild_id = COALESCE($2, albion_guild_id), \
                 albion_api_region = COALESCE($3, albion_api_region), \
                 albion_allied_guild_ids = COALESCE($4, albion_allied_guild_ids), \
                 albion_allied_guild_names = COALESCE($5, albion_allied_guild_names), \
                 discord_icon_hash = COALESCE($6, discord_icon_hash) \
                 WHERE id = $1",
                [
                    tenant_id.into(),
                    albion_guild_id.map(ToOwned::to_owned).into(),
                    albion_api_region.map(ToOwned::to_owned).into(),
                    allied_ids.map(str::trim).map(ToOwned::to_owned).into(),
                    allied_names.map(str::trim).map(ToOwned::to_owned).into(),
                    icon_hash.map(ToOwned::to_owned).into(),
                ],
            ))
            .await?;
        Ok(())
    }
}

#[allow(clippy::too_many_arguments)]
async fn insert_role_revocation(
    conn: &impl ConnectionTrait,
    alliance_id: &str,
    guild_id: &str,
    discord_guild_id: &str,
    discord_user_id: &str,
    role_id: &str,
    status: &str,
    detail: Option<&str>,
) -> Result<(), AppError> {
    conn.execute(Statement::from_sql_and_values(
        conn.get_database_backend(),
        "INSERT INTO alliance_role_revocations \
         (id, alliance_tenant_id, guild_tenant_id, discord_guild_id, discord_user_id, role_id, status, detail) \
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8) \
         ON CONFLICT (alliance_tenant_id, guild_tenant_id, discord_guild_id, discord_user_id, role_id) \
         DO NOTHING",
        [
            uuid::Uuid::new_v4().to_string().into(),
            alliance_id.into(),
            guild_id.into(),
            discord_guild_id.into(),
            discord_user_id.into(),
            role_id.into(),
            status.into(),
            detail.map(ToOwned::to_owned).into(),
        ],
    ))
    .await?;
    Ok(())
}

async fn guild_belongs_to_alliance(region: &str, guild_id: &str, alliance_id: &str) -> bool {
    let region = crate::modules::albion::client::AlbionRegion::from_env_str(region);
    let client = crate::modules::albion::client::AlbionApiClient::new(region);
    match client.get_guild(guild_id).await {
        Ok(guild) => guild
            .alliance_id
            .as_deref()
            .is_some_and(|id| id == alliance_id),
        Err(error) => {
            tracing::warn!(guild_id, error = %error, "could not check Albion alliance membership");
            false
        }
    }
}

/// Ownership is the recorded `owner_discord_id`, whatever the tenant kind: an alliance owner
/// has the same tenant-wide bypass as a guild owner. Leaving an alliance is guarded separately
/// (`alliance.leave`, and `leave_active_alliance` requires a guild tenant).
fn tenant_owner_matches(owner_discord_id: Option<&str>, actor: &str) -> bool {
    owner_discord_id == Some(actor)
}

fn row_to_view(row: &sea_orm::QueryResult) -> Result<TenantView, DbErr> {
    Ok(TenantView {
        id: row.try_get_by_index(0)?,
        name: row.try_get_by_index(1)?,
        slug: row.try_get_by_index(2)?,
        schema_name: row.try_get_by_index(3)?,
        status: row.try_get_by_index(4)?,
        owner_discord_id: row.try_get_by_index(5).ok(),
        created_at: row.try_get_by_index(6).ok(),
        suspended_at: row.try_get_by_index(7).ok(),
        albion_guild_id: row.try_get_by_index(8).ok(),
        albion_api_region: row.try_get_by_index(9).ok(),
        icon_hash: row.try_get_by_index(10).ok(),
        albion_allied_guild_ids: row.try_get_by_index(11).ok(),
        albion_allied_guild_names: row.try_get_by_index(12).ok(),
        rank_id: row.try_get_by_index(13).ok(),
        rank_name: row.try_get_by_index(14).ok(),
        kind: row
            .try_get_by_index(15)
            .ok()
            .filter(|kind: &String| !kind.is_empty())
            .unwrap_or_else(|| "guild".to_owned()),
        is_default: row.try_get_by_index(16).unwrap_or(false),
        albion_alliance_id: row.try_get_by_index(17).ok(),
    })
}

/// `guild` when omitted/blank; `alliance` must be spelled that way (any case).
fn parse_tenant_kind(raw: Option<&str>) -> Result<&'static str, AppError> {
    let value = raw
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("guild")
        .to_ascii_lowercase();
    match value.as_str() {
        "guild" => Ok("guild"),
        "alliance" => Ok("alliance"),
        other => Err(AppError::Validation(format!(
            "tenant kind must be guild or alliance, not {other}"
        ))),
    }
}

fn normalize_region(raw: &str) -> Result<String, AppError> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "europe" | "eu" => Ok("europe".to_owned()),
        "americas" | "america" | "us" | "na" => Ok("americas".to_owned()),
        "asia" | "sgp" | "east" => Ok("asia".to_owned()),
        other => Err(AppError::Validation(format!(
            "albion region must be europe, americas, or asia, not {other}"
        ))),
    }
}

fn normalize_optional_discord_snowflake(value: &str) -> Result<Option<String>, AppError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if !trimmed.chars().all(|character| character.is_ascii_digit())
        || !(17..=20).contains(&trimmed.len())
    {
        return Err(AppError::Validation(
            "discord_role_id must be a Discord snowflake (17-20 digits)".to_owned(),
        ));
    }
    Ok(Some(trimmed.to_owned()))
}

fn map_unique(err: DbErr) -> AppError {
    match err.sql_err() {
        Some(sea_orm::SqlErr::UniqueConstraintViolation(_)) => {
            AppError::Conflict("tenant id or slug already exists".to_owned())
        }
        _ => AppError::Database(err),
    }
}

fn map_membership_unique(err: DbErr) -> AppError {
    match err.sql_err() {
        Some(sea_orm::SqlErr::UniqueConstraintViolation(_)) => {
            AppError::Conflict("alliance_member_already_joined".to_owned())
        }
        _ => AppError::Database(err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control_migration::Migrator;
    use crate::postgres::{
        connect_with_search_path, drop_schema, ensure_schema,
        test_support::{try_admin_db, unique_schema},
    };
    use sea_orm_migration::MigratorTrait;

    #[test]
    fn owner_identity_is_limited_to_the_selected_tenant() {
        assert!(tenant_owner_matches(Some("owner-1"), "owner-1"));
        assert!(!tenant_owner_matches(Some("owner-1"), "owner-2"));
        // Switching to a different tenant evaluates that tenant's owner row;
        // ownership in the previous tenant does not carry across the session.
        assert!(!tenant_owner_matches(Some("owner-2"), "owner-1"));
        assert!(!tenant_owner_matches(None, "owner-1"));
    }

    #[test]
    fn an_alliance_owner_is_a_tenant_owner() {
        // auth-6: the old `kind == "guild"` clause left alliance owners without the bypass.
        assert!(tenant_owner_matches(Some("owner-1"), "owner-1"));
        assert!(!tenant_owner_matches(Some("owner-1"), ""));
    }

    #[tokio::test]
    async fn forgetting_a_membership_removes_only_that_tenant_for_that_user() {
        let control = sea_orm::Database::connect("sqlite::memory:")
            .await
            .expect("connect");
        control
            .execute_unprepared(
                "CREATE TABLE user_tenant_memberships (\
                 discord_id TEXT NOT NULL, tenant_id TEXT NOT NULL, \
                 PRIMARY KEY (discord_id, tenant_id))",
            )
            .await
            .expect("create table");
        for (user, tenant) in [("u1", "t1"), ("u1", "t2"), ("u2", "t1")] {
            PlatformService::record_membership(&control, user, tenant)
                .await
                .expect("record");
        }

        PlatformService::forget_membership(&control, "u1", "t1")
            .await
            .expect("forget");
        // Idempotent: a second call and an unknown pair are no-ops.
        PlatformService::forget_membership(&control, "u1", "t1")
            .await
            .expect("forget again");
        PlatformService::forget_membership(&control, "nobody", "t9")
            .await
            .expect("forget unknown");

        assert!(
            !PlatformService::is_member(&control, "u1", "t1")
                .await
                .unwrap()
        );
        assert!(
            PlatformService::is_member(&control, "u1", "t2")
                .await
                .unwrap()
        );
        assert!(
            PlatformService::is_member(&control, "u2", "t1")
                .await
                .unwrap()
        );
    }

    #[test]
    fn region_aliases() {
        assert_eq!(normalize_region("EU").unwrap(), "europe");
        assert_eq!(normalize_region("americas").unwrap(), "americas");
        assert_eq!(normalize_region("NA").unwrap(), "americas");
        assert_eq!(normalize_region("asia").unwrap(), "asia");
        assert!(normalize_region("mars").is_err());
    }

    #[tokio::test]
    async fn get_tenant_missing_is_none_and_patch_updates_owner_and_albion() {
        let Some((url, admin)) = try_admin_db().await else {
            return;
        };
        let schema = unique_schema("it_pt");
        ensure_schema(&admin, &schema).await.expect("schema");
        let control = connect_with_search_path(&url, &schema)
            .await
            .expect("connect");
        Migrator::up(&control, None).await.expect("migrate");

        control
            .execute_unprepared(
                "INSERT INTO tenants (id, slug, name, schema_name, status, owner_discord_id) \
                 VALUES ('111', 'weaklings', 'Weaklings', 'tenant_111', 'active', 'owner-1')",
            )
            .await
            .expect("insert");

        assert!(
            PlatformService::get_tenant(&control, "999")
                .await
                .expect("query")
                .is_none()
        );

        let found = PlatformService::get_tenant(&control, "111")
            .await
            .expect("query")
            .expect("row");
        assert_eq!(found.owner_discord_id.as_deref(), Some("owner-1"));
        assert_eq!(found.name, "Weaklings");

        let registry = TenantRegistry::new(url, control.clone());
        let updated = PlatformService::patch_tenant(
            &control,
            &registry,
            "111",
            PatchTenantRequest {
                name: Some("Renamed".into()),
                owner_discord_id: Some("owner-2".into()),
                albion_guild_id: Some("alb-9".into()),
                albion_api_region: Some("NA".into()),
                albion_allied_guild_ids: Some("a,b".into()),
                albion_allied_guild_names: Some("Ally".into()),
                status: None,
                rank_id: None,
                is_default: None,
            },
            "tester",
        )
        .await
        .expect("patch");
        assert_eq!(updated.name, "Renamed");
        assert_eq!(updated.owner_discord_id.as_deref(), Some("owner-2"));
        assert_eq!(updated.albion_guild_id.as_deref(), Some("alb-9"));
        assert_eq!(updated.albion_api_region.as_deref(), Some("americas"));
        assert_eq!(updated.albion_allied_guild_ids.as_deref(), Some("a,b"));
        assert_eq!(updated.albion_allied_guild_names.as_deref(), Some("Ally"));

        let empty_owner = PlatformService::patch_tenant(
            &control,
            &registry,
            "111",
            PatchTenantRequest {
                owner_discord_id: Some("  ".into()),
                ..PatchTenantRequest::default()
            },
            "tester",
        )
        .await;
        assert!(empty_owner.is_err());

        drop_schema(&admin, &schema).await.expect("drop");
    }

    #[tokio::test]
    async fn rank_crud_assigns_features_and_refuses_delete_in_use() {
        let Some((url, admin)) = try_admin_db().await else {
            return;
        };
        let schema = unique_schema("it_rk");
        ensure_schema(&admin, &schema).await.expect("schema");
        let control = connect_with_search_path(&url, &schema)
            .await
            .expect("connect");
        Migrator::up(&control, None).await.expect("migrate");

        assert!(
            PlatformService::list_ranks(&control)
                .await
                .expect("list")
                .is_empty()
        );

        let gold = PlatformService::create_rank(
            &control,
            CreateRankRequest {
                name: "Gold".into(),
                description: Some("splits events regears".into()),
            },
        )
        .await
        .expect("create");
        assert!(gold.feature_keys.is_empty());

        let registry = TenantRegistry::new(url, control.clone());
        let gold = PlatformService::put_rank_features(
            &control,
            &registry,
            &gold.id,
            PutRankFeaturesRequest {
                keys: vec!["splits".into(), "events".into(), "regears".into()],
            },
            "admin",
        )
        .await
        .expect("features");
        assert_eq!(gold.feature_keys, vec!["events", "regears", "splits"]);

        control
            .execute_unprepared(
                "INSERT INTO tenants (id, slug, name, schema_name, status, owner_discord_id) \
                 VALUES ('111', 'weaklings', 'Weaklings', 'tenant_111', 'active', 'owner-1')",
            )
            .await
            .expect("insert tenant");

        let assigned = PlatformService::patch_tenant(
            &control,
            &registry,
            "111",
            PatchTenantRequest {
                rank_id: Some(gold.id.clone()),
                ..PatchTenantRequest::default()
            },
            "admin",
        )
        .await
        .expect("assign");
        assert_eq!(assigned.rank_name.as_deref(), Some("Gold"));

        let flags = PlatformService::get_features(&control, "111")
            .await
            .expect("flags");
        let enabled: Vec<_> = flags
            .flags
            .iter()
            .filter(|flag| flag.enabled)
            .map(|flag| flag.key.as_str())
            .collect();
        assert!(enabled.contains(&"splits"));
        assert!(enabled.contains(&"events"));
        assert!(enabled.contains(&"regears"));

        let err = PlatformService::delete_rank(&control, &gold.id)
            .await
            .expect_err("in use");
        assert!(matches!(err, AppError::Conflict(_)));

        let silver = PlatformService::create_rank(
            &control,
            CreateRankRequest {
                name: "Silver".into(),
                description: None,
            },
        )
        .await
        .expect("silver");
        PlatformService::put_rank_features(
            &control,
            &registry,
            &silver.id,
            PutRankFeaturesRequest {
                keys: vec!["splits".into()],
            },
            "admin",
        )
        .await
        .expect("silver features");

        PlatformService::patch_tenant(
            &control,
            &registry,
            "111",
            PatchTenantRequest {
                rank_id: Some(silver.id.clone()),
                ..PatchTenantRequest::default()
            },
            "admin",
        )
        .await
        .expect("downgrade");

        let flags = PlatformService::get_features(&control, "111")
            .await
            .expect("flags after downgrade");
        let enabled: Vec<_> = flags
            .flags
            .iter()
            .filter(|flag| flag.enabled)
            .map(|flag| flag.key.as_str())
            .collect();
        assert_eq!(enabled, vec!["splits"]);

        drop_schema(&admin, &schema).await.expect("drop");
    }

    #[tokio::test]
    async fn default_rank_lands_on_newly_registered_tenants() {
        let Some((url, admin)) = try_admin_db().await else {
            return;
        };
        let schema = unique_schema("it_dfr");
        ensure_schema(&admin, &schema).await.expect("schema");
        let control = connect_with_search_path(&url, &schema)
            .await
            .expect("connect");
        Migrator::up(&control, None).await.expect("migrate");
        let registry = TenantRegistry::new(url, control.clone());

        let free = PlatformService::create_rank(
            &control,
            CreateRankRequest {
                name: "Free".into(),
                description: None,
            },
        )
        .await
        .expect("free");
        assert!(!free.is_default);
        PlatformService::put_rank_features(
            &control,
            &registry,
            &free.id,
            PutRankFeaturesRequest {
                keys: vec!["events".into()],
            },
            "admin",
        )
        .await
        .expect("free features");
        let free = PlatformService::patch_rank(
            &control,
            &free.id,
            PatchRankRequest {
                is_default: Some(true),
                ..PatchRankRequest::default()
            },
        )
        .await
        .expect("mark default");
        assert!(free.is_default);

        let id = unique_schema("gid");
        let created = PlatformService::register_tenant(
            &control,
            &registry,
            RegisterTenantRequest {
                id: id.clone(),
                name: "New Guild".into(),
                kind: None,
                albion_guild_id: "alb-1".into(),
                albion_api_region: "europe".into(),
                albion_allied_guild_ids: None,
                albion_allied_guild_names: None,
                member_guild_ids: vec![],
                albion_alliance_id: None,
            },
            "registrar-9",
            None,
        )
        .await
        .expect("register");
        assert_eq!(created.rank_name.as_deref(), Some("Free"));
        assert_eq!(created.kind, "guild");

        let flags = PlatformService::get_features(&control, &id)
            .await
            .expect("flags");
        let enabled: Vec<_> = flags
            .flags
            .iter()
            .filter(|flag| flag.enabled)
            .map(|flag| flag.key.as_str())
            .collect();
        // Navigation is enabled for new tenants independently of rank features.
        assert_eq!(enabled, vec!["events", "sidebar"]);

        drop_schema(&admin, &created.schema_name)
            .await
            .expect("drop tenant schema");
        drop_schema(&admin, &schema).await.expect("drop");
    }

    /// The bot polls three lists for every tenant it serves: events, battles
    /// and giveaways. An alliance created with the default rank holds only the
    /// features that rank grants, so the module endpoints it was never granted
    /// answer 403 - and the bot has to cope with that, because events work.
    #[tokio::test]
    async fn bot_reads_an_alliance_events_but_is_refused_modules_its_rank_lacks() {
        use axum::body::Body;
        use axum::routing::get;
        use tower::ServiceExt;

        let Some((url, admin)) = try_admin_db().await else {
            return;
        };
        let schema = unique_schema("it_bal");
        ensure_schema(&admin, &schema).await.expect("schema");
        let control = connect_with_search_path(&url, &schema)
            .await
            .expect("connect");
        Migrator::up(&control, None).await.expect("migrate");
        let registry = TenantRegistry::new(url, control.clone());

        let free = PlatformService::create_rank(
            &control,
            CreateRankRequest {
                name: "Free".into(),
                description: None,
            },
        )
        .await
        .expect("free");
        PlatformService::put_rank_features(
            &control,
            &registry,
            &free.id,
            PutRankFeaturesRequest {
                keys: vec!["events".into()],
            },
            "admin",
        )
        .await
        .expect("free features");
        PlatformService::patch_rank(
            &control,
            &free.id,
            PatchRankRequest {
                is_default: Some(true),
                ..PatchRankRequest::default()
            },
        )
        .await
        .expect("mark default");

        let id = unique_schema("alid");
        let alliance = PlatformService::create_tenant_of_kind(
            &control,
            &registry,
            CreateTenantRequest {
                id: id.clone(),
                name: "The Alliance".into(),
                slug: None,
                albion_guild_id: None,
                albion_api_region: None,
            },
            "registrar-9",
            "alliance",
        )
        .await
        .expect("create alliance");
        assert_eq!(alliance.kind, "alliance");

        let mut cfg = crate::config::Config::for_tests();
        cfg.bot_api_secret = Some("s3cret".to_owned());
        let status_of = |path: &'static str| {
            let app = axum::Router::new()
                .route(path, get(|| async { "ok" }))
                .layer(axum::middleware::from_fn_with_state(
                    registry.clone(),
                    crate::tenant::resolve_tenant,
                ))
                .layer(axum::Extension(crate::tenant::ControlDb(control.clone())))
                .layer(axum::Extension(cfg.clone()));
            let request = axum::http::Request::builder()
                .uri(path)
                .header(crate::tenant::BOT_SECRET_HEADER, "s3cret")
                .header("X-Guild-Id", id.as_str())
                .body(Body::empty())
                .expect("request");
            async move {
                app.oneshot(request)
                    .await
                    .expect("router responds")
                    .status()
            }
        };

        assert_eq!(status_of("/api/events").await, axum::http::StatusCode::OK);
        assert_eq!(
            status_of("/api/admin/settings").await,
            axum::http::StatusCode::OK
        );
        // Not granted by the rank: the bot must treat these as "module absent".
        assert_eq!(
            status_of("/api/battles").await,
            axum::http::StatusCode::FORBIDDEN
        );
        assert_eq!(
            status_of("/api/giveaways").await,
            axum::http::StatusCode::FORBIDDEN
        );

        drop_schema(&admin, &alliance.schema_name)
            .await
            .expect("drop tenant schema");
        drop_schema(&admin, &schema).await.expect("drop");
    }

    #[tokio::test]
    async fn marking_a_rank_default_clears_the_previous_holder() {
        let Some((url, admin)) = try_admin_db().await else {
            return;
        };
        let schema = unique_schema("it_dfm");
        ensure_schema(&admin, &schema).await.expect("schema");
        let control = connect_with_search_path(&url, &schema)
            .await
            .expect("connect");
        Migrator::up(&control, None).await.expect("migrate");

        let mut ids = Vec::new();
        for name in ["Free", "Gold"] {
            let rank = PlatformService::create_rank(
                &control,
                CreateRankRequest {
                    name: (*name).into(),
                    description: None,
                },
            )
            .await
            .expect("create");
            ids.push(rank.id);
        }

        // Backwards too: the second rank first, then the one stored before it.
        for id in ids.iter().rev() {
            PlatformService::patch_rank(
                &control,
                id,
                PatchRankRequest {
                    is_default: Some(true),
                    ..PatchRankRequest::default()
                },
            )
            .await
            .expect("mark default");
        }

        let defaults: Vec<_> = PlatformService::list_ranks(&control)
            .await
            .expect("list")
            .into_iter()
            .filter(|rank| rank.is_default)
            .map(|rank| rank.name)
            .collect();
        assert_eq!(defaults, vec!["Free"]);

        // Clearing the flag leaves new tenants rankless.
        PlatformService::patch_rank(
            &control,
            &ids[0],
            PatchRankRequest {
                is_default: Some(false),
                ..PatchRankRequest::default()
            },
        )
        .await
        .expect("clear default");
        assert!(
            PlatformService::default_rank_id(&control)
                .await
                .expect("default")
                .is_none()
        );

        drop_schema(&admin, &schema).await.expect("drop");
    }

    #[tokio::test]
    async fn register_tenant_does_not_grant_platform_superadmin() {
        let Some((url, admin)) = try_admin_db().await else {
            return;
        };
        let schema = unique_schema("it_reg");
        ensure_schema(&admin, &schema).await.expect("schema");
        let control = connect_with_search_path(&url, &schema)
            .await
            .expect("connect");
        Migrator::up(&control, None).await.expect("migrate");

        let registry = TenantRegistry::new(url, control.clone());
        let id = unique_schema("gid");
        let created = PlatformService::register_tenant(
            &control,
            &registry,
            RegisterTenantRequest {
                id: id.clone(),
                name: "New Guild".into(),
                kind: Some("guild".into()),
                albion_guild_id: "alb-1".into(),
                albion_api_region: "europe".into(),
                albion_allied_guild_ids: None,
                albion_allied_guild_names: None,
                member_guild_ids: vec![],
                albion_alliance_id: None,
            },
            "registrar-9",
            None,
        )
        .await
        .expect("register");

        assert_eq!(created.kind, "guild");
        assert_eq!(created.owner_discord_id.as_deref(), Some("registrar-9"));
        let admins = PlatformService::list_admins(&control)
            .await
            .expect("admins");
        assert!(
            admins.is_empty(),
            "first registrar is tenant SuperAdmin, not a platform SuperAdmin: {admins:?}"
        );
        assert!(
            PlatformService::is_member(&control, "registrar-9", &id)
                .await
                .expect("member")
        );

        drop_schema(&admin, &created.schema_name)
            .await
            .expect("drop tenant schema");
        drop_schema(&admin, &schema).await.expect("drop");
    }

    #[test]
    fn tenant_kind_defaults_to_guild() {
        assert_eq!(parse_tenant_kind(None).expect("none"), "guild");
        assert_eq!(parse_tenant_kind(Some("")).expect("empty"), "guild");
        assert_eq!(parse_tenant_kind(Some(" Guild ")).expect("padded"), "guild");
    }

    #[test]
    fn tenant_kind_accepts_alliance() {
        assert_eq!(
            parse_tenant_kind(Some("ALLIANCE")).expect("alliance"),
            "alliance"
        );
    }

    #[test]
    fn tenant_kind_rejects_unknown_values() {
        let err = parse_tenant_kind(Some("clan")).expect_err("unknown");
        match err {
            AppError::Validation(msg) => {
                assert!(msg.contains("guild or alliance"), "{msg}");
                assert!(msg.contains("clan"), "{msg}");
            }
            other => panic!("expected validation, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn register_alliance_without_member_guilds_creates_nothing() {
        let Some((url, admin)) = try_admin_db().await else {
            return;
        };
        let schema = unique_schema("it_alk");
        ensure_schema(&admin, &schema).await.expect("schema");
        let control = connect_with_search_path(&url, &schema)
            .await
            .expect("connect");
        Migrator::up(&control, None).await.expect("migrate");

        let registry = TenantRegistry::new(url, control.clone());
        let id = unique_schema("gid");
        let err = PlatformService::register_tenant(
            &control,
            &registry,
            RegisterTenantRequest {
                id: id.clone(),
                name: "Alliance Hub".into(),
                kind: Some("alliance".into()),
                albion_guild_id: String::new(),
                albion_api_region: "europe".into(),
                albion_allied_guild_ids: None,
                albion_allied_guild_names: None,
                member_guild_ids: vec![],
                albion_alliance_id: None,
            },
            "registrar-9",
            None,
        )
        .await
        .expect_err("alliance needs guilds");
        match err {
            AppError::Validation(msg) => assert_eq!(msg, "alliance_requires_guilds"),
            other => panic!("expected validation, got {other:?}"),
        }
        assert!(
            PlatformService::get_tenant(&control, &id)
                .await
                .expect("lookup")
                .is_none(),
            "failed alliance register must not leave a tenant row"
        );

        drop_schema(&admin, &schema).await.expect("drop");
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
            albion_alliance_id: None,
        }
    }

    fn alliance_register(id: &str, members: Vec<String>) -> RegisterTenantRequest {
        RegisterTenantRequest {
            id: id.to_owned(),
            name: "Alliance Hub".into(),
            kind: Some("alliance".into()),
            albion_guild_id: String::new(),
            albion_api_region: "europe".into(),
            albion_allied_guild_ids: None,
            albion_allied_guild_names: None,
            member_guild_ids: members,
            albion_alliance_id: Some("alb-alliance".into()),
        }
    }

    #[tokio::test]
    async fn register_alliance_with_unknown_guild_creates_nothing() {
        let Some((url, admin)) = try_admin_db().await else {
            return;
        };
        let schema = unique_schema("it_alunk");
        ensure_schema(&admin, &schema).await.expect("schema");
        let control = connect_with_search_path(&url, &schema)
            .await
            .expect("connect");
        Migrator::up(&control, None).await.expect("migrate");

        let registry = TenantRegistry::new(url, control.clone());
        let id = unique_schema("aid");
        let err = PlatformService::register_tenant(
            &control,
            &registry,
            alliance_register(&id, vec!["missing-guild".into()]),
            "officer-1",
            None,
        )
        .await
        .expect_err("unknown member");
        match err {
            AppError::Validation(msg) => assert_eq!(msg, "alliance_member_invalid"),
            other => panic!("expected validation, got {other:?}"),
        }
        assert!(
            PlatformService::get_tenant(&control, &id)
                .await
                .expect("lookup")
                .is_none(),
            "failed alliance register must not leave a tenant row"
        );

        drop_schema(&admin, &schema).await.expect("drop");
    }

    #[tokio::test]
    async fn register_alliance_with_guild_already_in_another_alliance_conflicts() {
        let Some((url, admin)) = try_admin_db().await else {
            return;
        };
        let schema = unique_schema("it_al409");
        ensure_schema(&admin, &schema).await.expect("schema");
        let control = connect_with_search_path(&url, &schema)
            .await
            .expect("connect");
        Migrator::up(&control, None).await.expect("migrate");

        let registry = TenantRegistry::new(url.clone(), control.clone());
        let guild_id = unique_schema("gid");
        let first_alliance = unique_schema("a1");
        let second_alliance = unique_schema("a2");
        let guild = PlatformService::register_tenant(
            &control,
            &registry,
            guild_register(&guild_id, "Member Guild"),
            "officer-1",
            None,
        )
        .await
        .expect("guild");
        let first = PlatformService::register_tenant(
            &control,
            &registry,
            alliance_register(&first_alliance, vec![guild_id.clone()]),
            "officer-1",
            None,
        )
        .await
        .expect("first alliance");

        let err = PlatformService::register_tenant(
            &control,
            &registry,
            alliance_register(&second_alliance, vec![guild_id.clone()]),
            "officer-1",
            None,
        )
        .await
        .expect_err("already joined");
        match err {
            AppError::Conflict(msg) => assert_eq!(msg, "alliance_member_already_joined"),
            other => panic!("expected conflict, got {other:?}"),
        }
        assert!(
            PlatformService::get_tenant(&control, &second_alliance)
                .await
                .expect("lookup")
                .is_none(),
            "failed alliance register must not leave a tenant row"
        );

        drop_schema(&admin, &guild.schema_name)
            .await
            .expect("drop guild");
        drop_schema(&admin, &first.schema_name)
            .await
            .expect("drop first");
        drop_schema(&admin, &schema).await.expect("drop");
    }

    #[tokio::test]
    async fn register_alliance_activates_membership_when_actor_owns_the_guild() {
        let Some((url, admin)) = try_admin_db().await else {
            return;
        };
        let schema = unique_schema("it_alown");
        ensure_schema(&admin, &schema).await.expect("schema");
        let control = connect_with_search_path(&url, &schema)
            .await
            .expect("connect");
        Migrator::up(&control, None).await.expect("migrate");

        let registry = TenantRegistry::new(url, control.clone());
        let guild_id = unique_schema("gid");
        let alliance_id = unique_schema("aid");
        let guild = PlatformService::register_tenant(
            &control,
            &registry,
            guild_register(&guild_id, "Owned Guild"),
            "officer-1",
            None,
        )
        .await
        .expect("guild");
        let alliance = PlatformService::register_tenant(
            &control,
            &registry,
            alliance_register(&alliance_id, vec![guild_id.clone()]),
            "officer-1",
            None,
        )
        .await
        .expect("alliance");

        assert_eq!(alliance.kind, "alliance");
        assert!(
            alliance.albion_guild_id.is_none() || alliance.albion_guild_id.as_deref() == Some("")
        );
        let members = PlatformService::list_alliance_members(&control, &alliance_id)
            .await
            .expect("members");
        assert_eq!(members.len(), 1);
        assert_eq!(members[0].guild_tenant_id, guild_id);
        assert_eq!(members[0].status, "active");
        assert_eq!(members[0].invited_by.as_deref(), Some("officer-1"));
        assert!(members[0].accepted_at.is_some());

        drop_schema(&admin, &guild.schema_name)
            .await
            .expect("drop guild");
        drop_schema(&admin, &alliance.schema_name)
            .await
            .expect("drop alliance");
        drop_schema(&admin, &schema).await.expect("drop");
    }

    #[tokio::test]
    async fn register_alliance_leaves_membership_pending_when_actor_does_not_own_the_guild() {
        let Some((url, admin)) = try_admin_db().await else {
            return;
        };
        let schema = unique_schema("it_alpend");
        ensure_schema(&admin, &schema).await.expect("schema");
        let control = connect_with_search_path(&url, &schema)
            .await
            .expect("connect");
        Migrator::up(&control, None).await.expect("migrate");

        let registry = TenantRegistry::new(url, control.clone());
        let guild_id = unique_schema("gid");
        let alliance_id = unique_schema("aid");
        let guild = PlatformService::register_tenant(
            &control,
            &registry,
            guild_register(&guild_id, "Other Guild"),
            "guild-owner",
            None,
        )
        .await
        .expect("guild");
        let alliance = PlatformService::register_tenant(
            &control,
            &registry,
            alliance_register(&alliance_id, vec![guild_id.clone()]),
            "alliance-officer",
            None,
        )
        .await
        .expect("alliance");

        let members = PlatformService::list_alliance_members(&control, &alliance_id)
            .await
            .expect("members");
        assert_eq!(members[0].status, "pending");
        assert!(members[0].accepted_at.is_none());

        let refused = PlatformService::decline_alliance_membership(
            &control,
            &alliance_id,
            &guild_id,
            "other-user",
        )
        .await;
        assert!(matches!(refused, Err(AppError::Forbidden(_))));

        PlatformService::decline_alliance_membership(
            &control,
            &alliance_id,
            &guild_id,
            "guild-owner",
        )
        .await
        .expect("decline pending invitation");
        assert!(
            PlatformService::alliance_membership_status(&control, &alliance_id, &guild_id)
                .await
                .expect("membership status")
                .is_none()
        );
        PlatformService::insert_alliance_memberships(
            &control,
            &alliance_id,
            "alliance-officer",
            std::slice::from_ref(&guild),
        )
        .await
        .expect("reinvite");

        let accepted = PlatformService::accept_alliance_membership(
            &control,
            &alliance_id,
            &guild_id,
            "guild-owner",
        )
        .await
        .expect("accept");
        assert_eq!(accepted.status, "active");
        assert!(accepted.accepted_at.is_some());

        let active_decline = PlatformService::decline_alliance_membership(
            &control,
            &alliance_id,
            &guild_id,
            "guild-owner",
        )
        .await;
        assert!(matches!(active_decline, Err(AppError::NotFound(_))));

        drop_schema(&admin, &guild.schema_name)
            .await
            .expect("drop guild");
        drop_schema(&admin, &alliance.schema_name)
            .await
            .expect("drop alliance");
        drop_schema(&admin, &schema).await.expect("drop");
    }

    #[test]
    fn alliance_member_discord_role_snowflake_is_optional_and_strict() {
        assert_eq!(normalize_optional_discord_snowflake("  ").unwrap(), None);
        assert_eq!(
            normalize_optional_discord_snowflake("123456789012345678")
                .unwrap()
                .as_deref(),
            Some("123456789012345678")
        );
        assert!(normalize_optional_discord_snowflake("not-a-role").is_err());
        assert!(normalize_optional_discord_snowflake("123").is_err());
    }

    #[tokio::test]
    async fn set_alliance_member_discord_role_round_trips_and_clears() {
        let Some((url, admin)) = try_admin_db().await else {
            return;
        };
        let schema = unique_schema("it_alrole");
        ensure_schema(&admin, &schema).await.expect("schema");
        let control = connect_with_search_path(&url, &schema)
            .await
            .expect("connect");
        Migrator::up(&control, None).await.expect("migrate");

        let registry = TenantRegistry::new(url, control.clone());
        let guild_id = unique_schema("gid");
        let alliance_id = unique_schema("aid");
        let guild = PlatformService::register_tenant(
            &control,
            &registry,
            guild_register(&guild_id, "Role Guild"),
            "officer-1",
            None,
        )
        .await
        .expect("guild");
        let alliance = PlatformService::register_tenant(
            &control,
            &registry,
            alliance_register(&alliance_id, vec![guild_id.clone()]),
            "officer-1",
            None,
        )
        .await
        .expect("alliance");

        let assigned = PlatformService::set_alliance_member_discord_role(
            &control,
            &alliance_id,
            &guild_id,
            Some(" 123456789012345678 "),
        )
        .await
        .expect("assign");
        assert_eq!(
            assigned.discord_role_id.as_deref(),
            Some("123456789012345678")
        );

        let cleared = PlatformService::set_alliance_member_discord_role(
            &control,
            &alliance_id,
            &guild_id,
            Some(""),
        )
        .await
        .expect("clear");
        assert_eq!(cleared.discord_role_id, None);

        drop_schema(&admin, &guild.schema_name)
            .await
            .expect("drop guild");
        drop_schema(&admin, &alliance.schema_name)
            .await
            .expect("drop alliance");
        drop_schema(&admin, &schema).await.expect("drop");
    }

    #[tokio::test]
    async fn tenant_status_exposes_kind_for_registered_guilds() {
        let Some((url, admin)) = try_admin_db().await else {
            return;
        };
        let schema = unique_schema("it_stk");
        ensure_schema(&admin, &schema).await.expect("schema");
        let control = connect_with_search_path(&url, &schema)
            .await
            .expect("connect");
        Migrator::up(&control, None).await.expect("migrate");

        let registry = TenantRegistry::new(url, control.clone());
        let id = unique_schema("gid");
        let created = PlatformService::register_tenant(
            &control,
            &registry,
            RegisterTenantRequest {
                id: id.clone(),
                name: "Kinded Guild".into(),
                kind: None,
                albion_guild_id: "alb-1".into(),
                albion_api_region: "europe".into(),
                albion_allied_guild_ids: None,
                albion_allied_guild_names: None,
                member_guild_ids: vec![],
                albion_alliance_id: None,
            },
            "registrar-9",
            None,
        )
        .await
        .expect("register");

        let status = PlatformService::tenant_status(&control, &id, "https://app.example")
            .await
            .expect("status");
        assert_eq!(status.kind.as_deref(), Some("guild"));
        assert!(status.registered);

        drop_schema(&admin, &created.schema_name)
            .await
            .expect("drop tenant schema");
        drop_schema(&admin, &schema).await.expect("drop");
    }

    #[tokio::test]
    #[allow(clippy::too_many_lines)]
    async fn leave_keeps_history_stops_sync_and_retries_discord() {
        let Some((url, admin)) = try_admin_db().await else {
            return;
        };
        let schema = unique_schema("it_leave");
        ensure_schema(&admin, &schema).await.expect("schema");
        let control = connect_with_search_path(&url, &schema)
            .await
            .expect("connect");
        Migrator::up(&control, None).await.expect("migrate");
        let registry = TenantRegistry::new(url, control.clone());

        let guild_id = unique_schema("gid");
        let alliance_id = unique_schema("aid");
        let guild = PlatformService::register_tenant(
            &control,
            &registry,
            guild_register(&guild_id, "Leaving Guild"),
            "guild-owner",
            None,
        )
        .await
        .expect("guild");
        let alliance = PlatformService::register_tenant(
            &control,
            &registry,
            alliance_register(&alliance_id, vec![guild_id.clone()]),
            "alliance-officer",
            None,
        )
        .await
        .expect("alliance");
        PlatformService::accept_alliance_membership(
            &control,
            &alliance_id,
            &guild_id,
            "guild-owner",
        )
        .await
        .expect("accept");

        let pending_guild_id = unique_schema("pgid");
        let pending_alliance_id = unique_schema("paid");
        let pending_guild = PlatformService::register_tenant(
            &control,
            &registry,
            guild_register(&pending_guild_id, "Invited Guild"),
            "guild-owner",
            None,
        )
        .await
        .expect("pending guild");
        let pending_alliance = PlatformService::register_tenant(
            &control,
            &registry,
            alliance_register(&pending_alliance_id, vec![pending_guild_id.clone()]),
            "alliance-officer",
            None,
        )
        .await
        .expect("pending alliance");

        control
            .execute_unprepared(&format!(
                "INSERT INTO alliance_shares \
                 (id, alliance_tenant_id, source_tenant_id, artifact_type, source_id, published_id, shared_by) \
                 VALUES ('{}', '{alliance_id}', '{guild_id}', 'build', 7, 8, 'guild-owner')",
                uuid::Uuid::new_v4()
            ))
            .await
            .expect("share");
        control
            .execute_unprepared(&format!(
                "INSERT INTO event_sync_links \
                 (id, source_tenant_id, source_event_id, mirror_tenant_id, mirror_event_id) \
                 VALUES ('{}', '{guild_id}', 3, '{alliance_id}', 4)",
                uuid::Uuid::new_v4()
            ))
            .await
            .expect("link");
        PlatformService::record_alliance_role_grant(
            &control,
            &alliance_id,
            &guild_id,
            &alliance_id,
            "discord-user",
            "12345678901234567",
        )
        .await
        .expect("grant");

        let denied = PlatformService::leave_active_alliance(
            &control,
            &alliance_id,
            &guild_id,
            "stranger",
            false,
            &[],
            |_: &str, _: &str, _: &str| std::future::ready(Ok(())),
        )
        .await;
        assert!(matches!(denied, Err(AppError::Forbidden(_))));
        assert_eq!(
            PlatformService::alliance_membership_status(&control, &alliance_id, &guild_id)
                .await
                .expect("status")
                .as_deref(),
            Some("active")
        );

        let pending_leave = PlatformService::leave_active_alliance(
            &control,
            &pending_alliance_id,
            &pending_guild_id,
            "guild-owner",
            false,
            &[],
            |_: &str, _: &str, _: &str| std::future::ready(Ok(())),
        )
        .await;
        assert!(matches!(pending_leave, Err(AppError::Conflict(_))));
        assert_eq!(
            PlatformService::alliance_membership_status(
                &control,
                &pending_alliance_id,
                &pending_guild_id
            )
            .await
            .expect("pending status")
            .as_deref(),
            Some("pending")
        );
        PlatformService::decline_alliance_membership(
            &control,
            &pending_alliance_id,
            &pending_guild_id,
            "guild-owner",
        )
        .await
        .expect("decline still removes only the pending invite");
        assert!(
            PlatformService::alliance_membership_status(
                &control,
                &pending_alliance_id,
                &pending_guild_id
            )
            .await
            .expect("declined")
            .is_none()
        );

        let left = PlatformService::leave_active_alliance(
            &control,
            &alliance_id,
            &guild_id,
            "guild-owner",
            false,
            &[UntrackedAllianceRole {
                discord_guild_id: guild_id.clone(),
                role_id: "22345678901234567".into(),
            }],
            |_: &str, _: &str, _: &str| std::future::ready(Err("discord unavailable".to_owned())),
        )
        .await
        .expect("owner leave");
        assert_eq!(left.status, "left");

        let share_count: i64 = control
            .query_one(Statement::from_sql_and_values(
                control.get_database_backend(),
                "SELECT COUNT(*) FROM alliance_shares WHERE source_tenant_id = $1",
                [guild_id.clone().into()],
            ))
            .await
            .expect("shares")
            .expect("row")
            .try_get_by_index(0)
            .expect("count");
        assert_eq!(share_count, 1);
        let sync_enabled: bool = control
            .query_one(Statement::from_sql_and_values(
                control.get_database_backend(),
                "SELECT sync_enabled FROM event_sync_links WHERE source_tenant_id = $1",
                [guild_id.clone().into()],
            ))
            .await
            .expect("link")
            .expect("row")
            .try_get_by_index(0)
            .expect("flag");
        assert!(!sync_enabled);
        let link_count: i64 = control
            .query_one(Statement::from_sql_and_values(
                control.get_database_backend(),
                "SELECT COUNT(*) FROM event_sync_links WHERE source_tenant_id = $1",
                [guild_id.clone().into()],
            ))
            .await
            .expect("links")
            .expect("row")
            .try_get_by_index(0)
            .expect("count");
        assert_eq!(link_count, 1);

        crate::modules::events::sync::sync_participation(
            &control,
            &registry,
            &guild_id,
            3,
            &crate::modules::alliance_share::ShareActor {
                discord_id: "discord-user".into(),
                username: "user".into(),
                email: None,
            },
            None,
        )
        .await
        .expect("disabled sync link does not fan out");

        let revocations = control
            .query_all(Statement::from_sql_and_values(
                control.get_database_backend(),
                "SELECT status, discord_user_id, detail FROM alliance_role_revocations \
                 WHERE guild_tenant_id = $1 ORDER BY status",
                [guild_id.clone().into()],
            ))
            .await
            .expect("revocations");
        assert_eq!(revocations.len(), 2);
        let mut saw_pending = false;
        let mut saw_ambiguous = false;
        for row in &revocations {
            let status: String = row.try_get_by_index(0).expect("status");
            let user: String = row.try_get_by_index(1).expect("user");
            if status == "pending" {
                saw_pending = true;
                assert_eq!(user, "discord-user");
                let detail: String = row.try_get_by_index(2).expect("detail");
                assert!(detail.contains("discord unavailable"));
            } else if status == "ambiguous" {
                saw_ambiguous = true;
                assert!(user.is_empty());
            }
        }
        assert!(saw_pending);
        assert!(saw_ambiguous);

        PlatformService::leave_active_alliance(
            &control,
            &alliance_id,
            &guild_id,
            "guild-owner",
            false,
            &[],
            |_: &str, _: &str, _: &str| std::future::ready(Ok(())),
        )
        .await
        .expect("retry");
        let pending_left: i64 = control
            .query_one(Statement::from_sql_and_values(
                control.get_database_backend(),
                "SELECT COUNT(*) FROM alliance_role_revocations \
                 WHERE guild_tenant_id = $1 AND status = 'pending'",
                [guild_id.into()],
            ))
            .await
            .expect("pending")
            .expect("row")
            .try_get_by_index(0)
            .expect("count");
        assert_eq!(pending_left, 0);

        drop_schema(&admin, &guild.schema_name)
            .await
            .expect("drop guild");
        drop_schema(&admin, &alliance.schema_name)
            .await
            .expect("drop alliance");
        drop_schema(&admin, &pending_guild.schema_name)
            .await
            .expect("drop pending guild");
        drop_schema(&admin, &pending_alliance.schema_name)
            .await
            .expect("drop pending alliance");
        drop_schema(&admin, &schema).await.expect("drop");
    }

    #[tokio::test]
    #[allow(clippy::too_many_lines)]
    async fn rejoin_from_left_reuses_the_row_and_leaves_history_unsynced() {
        let Some((url, admin)) = try_admin_db().await else {
            return;
        };
        let schema = unique_schema("it_rejoin");
        ensure_schema(&admin, &schema).await.expect("schema");
        let control = connect_with_search_path(&url, &schema)
            .await
            .expect("connect");
        Migrator::up(&control, None).await.expect("migrate");
        let registry = TenantRegistry::new(url, control.clone());

        let guild_id = unique_schema("gid");
        let alliance_id = unique_schema("aid");
        let guild = PlatformService::register_tenant(
            &control,
            &registry,
            guild_register(&guild_id, "Returning Guild"),
            "guild-owner",
            None,
        )
        .await
        .expect("guild");
        let alliance = PlatformService::register_tenant(
            &control,
            &registry,
            alliance_register(&alliance_id, vec![guild_id.clone()]),
            "alliance-owner",
            None,
        )
        .await
        .expect("alliance");
        PlatformService::accept_alliance_membership(
            &control,
            &alliance_id,
            &guild_id,
            "guild-owner",
        )
        .await
        .expect("accept");

        control
            .execute_unprepared(&format!(
                "INSERT INTO alliance_shares \
                 (id, alliance_tenant_id, source_tenant_id, artifact_type, source_id, published_id, shared_by) \
                 VALUES ('{}', '{alliance_id}', '{guild_id}', 'build', 7, 8, 'guild-owner')",
                uuid::Uuid::new_v4()
            ))
            .await
            .expect("share");
        control
            .execute_unprepared(&format!(
                "INSERT INTO event_sync_links \
                 (id, source_tenant_id, source_event_id, mirror_tenant_id, mirror_event_id) \
                 VALUES ('{}', '{guild_id}', 3, '{alliance_id}', 4)",
                uuid::Uuid::new_v4()
            ))
            .await
            .expect("link");

        PlatformService::leave_active_alliance(
            &control,
            &alliance_id,
            &guild_id,
            "guild-owner",
            false,
            &[UntrackedAllianceRole {
                discord_guild_id: guild_id.clone(),
                role_id: "32345678901234567".into(),
            }],
            |_: &str, _: &str, _: &str| std::future::ready(Ok(())),
        )
        .await
        .expect("leave");

        let left_at: String = control
            .query_one(Statement::from_sql_and_values(
                control.get_database_backend(),
                "SELECT left_at::text FROM alliance_memberships WHERE guild_tenant_id = $1",
                [guild_id.clone().into()],
            ))
            .await
            .expect("left_at")
            .expect("row")
            .try_get_by_index(0)
            .expect("left_at");

        let skipped = PlatformService::accept_alliance_membership(
            &control,
            &alliance_id,
            &guild_id,
            "guild-owner",
        )
        .await;
        assert!(matches!(skipped, Err(AppError::NotFound(_))));

        let stranger = PlatformService::invite_alliance_membership(
            &control,
            &alliance_id,
            &guild_id,
            "guild-owner",
        )
        .await;
        assert!(matches!(stranger, Err(AppError::Forbidden(_))));

        let invited = PlatformService::invite_alliance_membership(
            &control,
            &alliance_id,
            &guild_id,
            "alliance-owner",
        )
        .await
        .expect("reinvite");
        assert_eq!(invited.status, "pending");
        assert_eq!(invited.guild_tenant_id, guild_id);

        let memberships: i64 = control
            .query_one(Statement::from_sql_and_values(
                control.get_database_backend(),
                "SELECT COUNT(*) FROM alliance_memberships WHERE guild_tenant_id = $1",
                [guild_id.clone().into()],
            ))
            .await
            .expect("count")
            .expect("row")
            .try_get_by_index(0)
            .expect("count");
        assert_eq!(memberships, 1);
        let left_at_after: String = control
            .query_one(Statement::from_sql_and_values(
                control.get_database_backend(),
                "SELECT left_at::text FROM alliance_memberships WHERE guild_tenant_id = $1",
                [guild_id.clone().into()],
            ))
            .await
            .expect("left_at")
            .expect("row")
            .try_get_by_index(0)
            .expect("left_at");
        assert_eq!(left_at_after, left_at);

        let rejoined = PlatformService::accept_alliance_membership(
            &control,
            &alliance_id,
            &guild_id,
            "guild-owner",
        )
        .await
        .expect("accept rejoin");
        assert_eq!(rejoined.status, "active");

        let share_count: i64 = control
            .query_one(Statement::from_sql_and_values(
                control.get_database_backend(),
                "SELECT COUNT(*) FROM alliance_shares WHERE source_tenant_id = $1",
                [guild_id.clone().into()],
            ))
            .await
            .expect("shares")
            .expect("row")
            .try_get_by_index(0)
            .expect("count");
        assert_eq!(share_count, 1);
        let sync_enabled: bool = control
            .query_one(Statement::from_sql_and_values(
                control.get_database_backend(),
                "SELECT sync_enabled FROM event_sync_links WHERE source_tenant_id = $1",
                [guild_id.clone().into()],
            ))
            .await
            .expect("link")
            .expect("row")
            .try_get_by_index(0)
            .expect("flag");
        assert!(!sync_enabled);

        crate::modules::events::sync::sync_participation(
            &control,
            &registry,
            &guild_id,
            3,
            &crate::modules::alliance_share::ShareActor {
                discord_id: "discord-user".into(),
                username: "user".into(),
                email: None,
            },
            None,
        )
        .await
        .expect("old link stays unsynced after rejoin");

        let ambiguous: i64 = control
            .query_one(Statement::from_sql_and_values(
                control.get_database_backend(),
                "SELECT COUNT(*) FROM alliance_role_revocations \
                 WHERE guild_tenant_id = $1 AND status = 'ambiguous' AND discord_user_id = ''",
                [guild_id.clone().into()],
            ))
            .await
            .expect("ambiguous")
            .expect("row")
            .try_get_by_index(0)
            .expect("count");
        assert_eq!(ambiguous, 1);
        let stripped: i64 = control
            .query_one(Statement::from_sql_and_values(
                control.get_database_backend(),
                "SELECT COUNT(*) FROM alliance_role_revocations \
                 WHERE guild_tenant_id = $1 AND status = 'verified'",
                [guild_id.into()],
            ))
            .await
            .expect("verified")
            .expect("row")
            .try_get_by_index(0)
            .expect("count");
        assert_eq!(stripped, 0);

        drop_schema(&admin, &guild.schema_name)
            .await
            .expect("drop guild");
        drop_schema(&admin, &alliance.schema_name)
            .await
            .expect("drop alliance");
        drop_schema(&admin, &schema).await.expect("drop");
    }
}
