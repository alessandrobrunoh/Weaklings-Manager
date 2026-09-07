//! Control-plane tenant, feature-flag, and admin assignment operations.

use sea_orm::{ConnectionTrait, DatabaseConnection, DbErr, Statement, TransactionTrait, Value};

use crate::control_migration::SUPERADMIN_ROLE_ID;
use crate::errors::AppError;
use crate::postgres::{tenant_schema_name, tenant_slug};
use crate::tenant::TenantRegistry;

use super::models::{
    AssignAdminRequest, CreateRankRequest, CreateTenantRequest, FeatureCatalogItem,
    PatchRankRequest, PatchTenantRequest, PlatformAdminView, PutRankFeaturesRequest,
    PutTenantFeaturesRequest, RegisterTenantRequest, TenantFeatureFlag, TenantFeaturesView,
    TenantRankView, TenantStatusView, TenantView,
};

const TENANT_SELECT: &str = "SELECT t.id, t.name, t.slug, t.schema_name, t.status, t.owner_discord_id, \
     t.created_at::text, t.suspended_at::text, t.albion_guild_id, t.albion_api_region, \
     t.discord_icon_hash, t.albion_allied_guild_ids, t.albion_allied_guild_names, \
     t.rank_id::text, r.name \
     FROM tenants t LEFT JOIN tenant_ranks r ON r.id = t.rank_id";

/// Control-plane operations.
pub struct PlatformService;

impl PlatformService {
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

        if Self::get_tenant(control, id).await?.is_some() {
            return Err(AppError::Conflict(format!("tenant {id} already exists")));
        }

        control
            .execute(Statement::from_sql_and_values(
                control.get_database_backend(),
                "INSERT INTO tenants (id, slug, name, schema_name, status, owner_discord_id) \
                 VALUES ($1, $2, $3, $4, 'provisioning', $5)",
                [
                    id.into(),
                    slug.clone().into(),
                    name.into(),
                    schema_name.clone().into(),
                    actor.into(),
                ],
            ))
            .await
            .map_err(map_unique)?;

        registry.provision(id, &schema_name).await?;

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
            registry.evict(id);
        }

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
        match Self::get_tenant(control, tenant_id).await? {
            Some(row) => Ok(TenantStatusView {
                id: row.id,
                registered: true,
                status: Some(row.status),
                name: Some(row.name),
                register_url: None,
            }),
            None => {
                let base = frontend_url.trim_end_matches('/');
                Ok(TenantStatusView {
                    id: tenant_id.to_owned(),
                    registered: false,
                    status: None,
                    name: None,
                    register_url: Some(format!("{base}/register-tenant?guild={tenant_id}")),
                })
            }
        }
    }

    /// First-time tenant onboarding: provision schema, store Albion settings,
    /// grant SuperAdmin to the registrar, and record membership.
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
        let region = normalize_region(&body.albion_api_region)?;
        let albion_guild_id = body.albion_guild_id.trim();
        if albion_guild_id.is_empty() {
            return Err(AppError::Validation(
                "albion guild id is required".to_owned(),
            ));
        }
        let created = Self::create_tenant(
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
            });
        }
        Ok(out)
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
            registry.evict(tenant_id);
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
                    let _ = registry.get_or_load(tenant_id).await?;
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
        registry.evict(tenant_id);
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

    /// Grant the SuperAdmin platform role.
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
            registry.evict(&tenant_id);
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
                     WHERE tenant_id = $1 AND enabled AND feature_key NOT IN \
                     (SELECT feature_key FROM tenant_rank_features WHERE rank_id = $2::uuid)",
                    [tenant_id.into(), rank_id.into()],
                ))
                .await?;
        } else {
            control
                .execute(Statement::from_sql_and_values(
                    control.get_database_backend(),
                    "UPDATE tenant_feature_flags SET enabled = false, enabled_at = NULL \
                     WHERE tenant_id = $1 AND enabled",
                    [tenant_id.into()],
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
    })
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
                albion_guild_id: "alb-1".into(),
                albion_api_region: "europe".into(),
                albion_allied_guild_ids: None,
                albion_allied_guild_names: None,
            },
            "registrar-9",
            None,
        )
        .await
        .expect("register");
        assert_eq!(created.rank_name.as_deref(), Some("Free"));

        let flags = PlatformService::get_features(&control, &id)
            .await
            .expect("flags");
        let enabled: Vec<_> = flags
            .flags
            .iter()
            .filter(|flag| flag.enabled)
            .map(|flag| flag.key.as_str())
            .collect();
        assert_eq!(enabled, vec!["events"]);

        drop_schema(&admin, &created.schema_name)
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
                albion_guild_id: "alb-1".into(),
                albion_api_region: "europe".into(),
                albion_allied_guild_ids: None,
                albion_allied_guild_names: None,
            },
            "registrar-9",
            None,
        )
        .await
        .expect("register");

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
}

fn map_unique(err: DbErr) -> AppError {
    match err.sql_err() {
        Some(sea_orm::SqlErr::UniqueConstraintViolation(_)) => {
            AppError::Conflict("tenant id or slug already exists".to_owned())
        }
        _ => AppError::Database(err),
    }
}
