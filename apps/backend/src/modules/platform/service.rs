//! Control-plane tenant, feature-flag, and admin assignment operations.

use sea_orm::{ConnectionTrait, DatabaseConnection, DbErr, Statement, Value};

use crate::backfill::{tenant_schema_name, tenant_slug};
use crate::control_migration::SUPERADMIN_ROLE_ID;
use crate::errors::AppError;
use crate::postgres::quote_ident;
use crate::tenant::TenantRegistry;

use super::models::{
    AssignAdminRequest, CreateTenantRequest, FeatureCatalogItem, PatchTenantRequest,
    PlatformAdminView, PutTenantFeaturesRequest, RegisterTenantRequest, TenantFeatureFlag,
    TenantFeaturesView, TenantStatusView, TenantView,
};

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
                "SELECT id, name, slug, schema_name, status, owner_discord_id, \
                 created_at::text, suspended_at::text, albion_guild_id, albion_api_region, \
                 discord_icon_hash \
                 FROM tenants ORDER BY created_at"
                    .to_owned(),
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
        Self::assign_admin(
            control,
            AssignAdminRequest {
                discord_id: actor.to_owned(),
            },
            actor,
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
        if Self::get_tenant(control, tenant_id).await?.is_none() {
            return Err(AppError::NotFound(format!("tenant {tenant_id} not found")));
        }
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
        Ok(TenantFeaturesView { catalog, flags })
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
    ) -> Result<TenantFeaturesView, AppError> {
        if Self::get_tenant(control, tenant_id).await?.is_none() {
            return Err(AppError::NotFound(format!("tenant {tenant_id} not found")));
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

    async fn get_tenant(
        control: &DatabaseConnection,
        tenant_id: &str,
    ) -> Result<Option<TenantView>, DbErr> {
        let row = control
            .query_one(Statement::from_sql_and_values(
                control.get_database_backend(),
                format!(
                    "SELECT id, name, slug, schema_name, status, owner_discord_id, \
                     created_at::text, suspended_at::text, albion_guild_id, albion_api_region, \
                     discord_icon_hash FROM {} WHERE id = $1",
                    quote_ident("tenants")
                ),
                [tenant_id.into()],
            ))
            .await?;
        let Some(row) = row else {
            return Ok(None);
        };
        Ok(Some(row_to_view(&row)?))
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
    use super::normalize_region;

    #[test]
    fn region_aliases() {
        assert_eq!(normalize_region("EU").unwrap(), "europe");
        assert_eq!(normalize_region("americas").unwrap(), "americas");
        assert_eq!(normalize_region("NA").unwrap(), "americas");
        assert_eq!(normalize_region("asia").unwrap(), "asia");
        assert!(normalize_region("mars").is_err());
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
