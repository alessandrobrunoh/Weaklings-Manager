//! Per-tenant Albion guild identity.
//!
//! A tenant row is the only source for guild, region, and allies. Env
//! `ALBION_*` is not mixed in: an empty allied list means no allies, and a
//! missing or unreadable column fails closed instead of using another tenant's
//! deployment-wide guild.

use sea_orm::{ConnectionTrait, DatabaseConnection, DbErr, Statement};

use crate::modules::albionbb::client::normalize_server;
use crate::modules::events::service::BattleLinkingContext;

/// Guild, region, and allies used to scope Albion reads and writes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlbionScope {
    pub guild_id: String,
    pub region: String,
    pub allied_guild_ids: Vec<String>,
    pub allied_guild_names: Vec<String>,
}

/// Why a tenant scope could not be built.
#[derive(Debug)]
pub enum AlbionScopeError {
    /// Control-plane query or column decode failed.
    Database(DbErr),
    /// No row, blank guild id, or blank region. Callers must not substitute env config.
    NotConfigured,
}

impl From<DbErr> for AlbionScopeError {
    fn from(err: DbErr) -> Self {
        Self::Database(err)
    }
}

impl AlbionScope {
    /// Builds a scope from control-plane columns only.
    ///
    /// Blank or missing guild id and region are [`AlbionScopeError::NotConfigured`].
    /// Allied columns are parsed as CSV; blank means no allies, never the process env.
    ///
    /// # Errors
    ///
    /// Returns [`AlbionScopeError::NotConfigured`] when guild id or region is missing.
    pub fn from_tenant_columns(
        guild_id: Option<&str>,
        region: Option<&str>,
        allied_ids: Option<&str>,
        allied_names: Option<&str>,
    ) -> Result<Self, AlbionScopeError> {
        let Some(guild_id) = guild_id.map(str::trim).filter(|id| !id.is_empty()) else {
            return Err(AlbionScopeError::NotConfigured);
        };
        let Some(region) = region.map(str::trim).filter(|region| !region.is_empty()) else {
            return Err(AlbionScopeError::NotConfigured);
        };
        Ok(Self {
            guild_id: guild_id.to_owned(),
            region: region.to_owned(),
            allied_guild_ids: crate::config::split_csv(allied_ids.unwrap_or("")),
            allied_guild_names: crate::config::split_csv(allied_names.unwrap_or("")),
        })
    }

    #[must_use]
    pub fn server(&self) -> String {
        normalize_server(Some(&self.region))
    }

    #[must_use]
    pub fn linking_context(&self) -> BattleLinkingContext {
        BattleLinkingContext::new(
            &self.guild_id,
            &self.allied_guild_ids,
            &self.allied_guild_names,
        )
        .with_server(Some(self.server()).filter(|server| !server.is_empty()))
    }
}

/// Loads the tenant row and resolves [`AlbionScope`].
///
/// # Errors
///
/// Returns [`AlbionScopeError::Database`] when the query or a column decode fails,
/// and [`AlbionScopeError::NotConfigured`] when the tenant has no usable guild settings.
pub async fn load_albion_scope(
    control: &DatabaseConnection,
    tenant_id: &str,
) -> Result<AlbionScope, AlbionScopeError> {
    if tenant_id.is_empty() {
        return Err(AlbionScopeError::NotConfigured);
    }
    let row = control
        .query_one(Statement::from_sql_and_values(
            control.get_database_backend(),
            "SELECT albion_guild_id, albion_api_region, albion_allied_guild_ids, \
             albion_allied_guild_names \
             FROM tenants WHERE id = $1",
            [tenant_id.into()],
        ))
        .await?;
    let Some(row) = row else {
        return Err(AlbionScopeError::NotConfigured);
    };
    let guild_id: Option<String> = row.try_get_by_index(0)?;
    let region: Option<String> = row.try_get_by_index(1)?;
    let allied_ids: Option<String> = row.try_get_by_index(2)?;
    let allied_names: Option<String> = row.try_get_by_index(3)?;
    AlbionScope::from_tenant_columns(
        guild_id.as_deref(),
        region.as_deref(),
        allied_ids.as_deref(),
        allied_names.as_deref(),
    )
}

/// Whether a background sync cycle should hit Albion for this tenant.
#[must_use]
pub fn sync_cycle_should_run(status: &str, kind: &str) -> bool {
    status == "active" && !kind.is_empty() && crate::tenant::starts_sync_workers(kind)
}

/// Both observations must say `active`. A suspend that lands between them wins.
#[must_use]
pub fn worker_start_allowed(status_before: &str, status_after: &str) -> bool {
    status_before == "active" && status_after == "active"
}

/// `create` may resume a row left in `provisioning` after a failed attempt.
#[must_use]
pub fn can_resume_provisioning(existing_status: &str) -> bool {
    existing_status == "provisioning"
}

impl From<AlbionScopeError> for crate::errors::AppError {
    fn from(err: AlbionScopeError) -> Self {
        match err {
            AlbionScopeError::Database(err) => Self::Database(err),
            AlbionScopeError::NotConfigured => {
                Self::Validation("tenant has no Albion guild configuration".to_owned())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configured_tenant_does_not_inherit_env_allies() {
        let scope = AlbionScope::from_tenant_columns(Some("guild-1"), Some("asia"), Some(""), None)
            .expect("configured");
        assert_eq!(scope.guild_id, "guild-1");
        assert_eq!(scope.region, "asia");
        assert!(scope.allied_guild_ids.is_empty());
        assert!(scope.allied_guild_names.is_empty());
    }

    #[test]
    fn distinct_tenants_keep_their_own_allies() {
        let europe = AlbionScope::from_tenant_columns(
            Some("guild-eu"),
            Some("europe"),
            Some("ally-eu"),
            Some("Ally EU"),
        )
        .unwrap();
        let americas = AlbionScope::from_tenant_columns(
            Some("guild-na"),
            Some("americas"),
            Some(""),
            Some(""),
        )
        .unwrap();
        assert_ne!(europe.guild_id, americas.guild_id);
        assert_eq!(europe.allied_guild_ids, vec!["ally-eu".to_string()]);
        assert!(americas.allied_guild_ids.is_empty());
    }

    #[test]
    fn missing_guild_or_region_is_not_configured() {
        assert!(matches!(
            AlbionScope::from_tenant_columns(None, Some("europe"), None, None),
            Err(AlbionScopeError::NotConfigured)
        ));
        assert!(matches!(
            AlbionScope::from_tenant_columns(Some("g"), Some("  "), None, None),
            Err(AlbionScopeError::NotConfigured)
        ));
    }

    #[test]
    fn sync_runs_only_for_active_guild_tenants() {
        assert!(sync_cycle_should_run("active", "guild"));
        assert!(!sync_cycle_should_run("suspended", "guild"));
        assert!(!sync_cycle_should_run("provisioning", "guild"));
        assert!(!sync_cycle_should_run("active", "alliance"));
        assert!(!sync_cycle_should_run("active", ""));
    }

    #[test]
    fn suspend_between_checks_blocks_worker_start() {
        assert!(worker_start_allowed("active", "active"));
        assert!(!worker_start_allowed("active", "suspended"));
        assert!(!worker_start_allowed("suspended", "active"));
        assert!(!worker_start_allowed("provisioning", "active"));
    }

    #[test]
    fn only_provisioning_rows_can_be_resumed() {
        assert!(can_resume_provisioning("provisioning"));
        assert!(!can_resume_provisioning("active"));
        assert!(!can_resume_provisioning("suspended"));
    }
}
