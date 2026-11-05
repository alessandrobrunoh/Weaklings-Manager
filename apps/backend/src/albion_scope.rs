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

/// Read-path Albion scope for event routes.
///
/// Guild tenants classify battles through their own guild plus explicit
/// allies, exactly like [`AlbionScope`]. Alliance tenants have no
/// `albion_guild_id`: their Albion identity is the alliance, so the friendly
/// side is the set of active member guild IDs and no guild is ever "ours".
/// Whichever kind is missing its configuration fails closed with
/// [`AlbionScopeError::NotConfigured`].
#[derive(Debug, Clone)]
pub struct EventReadScope {
    server: String,
    context: BattleLinkingContext,
}

impl EventReadScope {
    /// `AlbionBB` server derived from the tenant's region.
    #[must_use]
    pub fn server(&self) -> String {
        self.server.clone()
    }

    /// Friendly-guild classifier for event detail reads.
    #[must_use]
    pub fn linking_context(&self) -> BattleLinkingContext {
        self.context.clone()
    }

    /// Builds a scope from control-plane columns plus the alliance's active
    /// member guild IDs (already filtered to non-blank values).
    ///
    /// A non-blank `albion_guild_id` always wins and keeps the strict guild
    /// scope — guild tenants that joined an alliance are unchanged. Only when
    /// the guild is absent does a non-blank `albion_alliance_id` produce an
    /// alliance scope.
    ///
    /// # Errors
    ///
    /// Returns [`AlbionScopeError::NotConfigured`] when neither a guild nor an
    /// alliance identity is configured, or when the alliance tenant has no
    /// region.
    pub fn from_tenant_row(
        kind: &str,
        guild_id: Option<&str>,
        region: Option<&str>,
        alliance_id: Option<&str>,
        allied_ids: Option<&str>,
        allied_names: Option<&str>,
        member_guild_ids: &[String],
    ) -> Result<Self, AlbionScopeError> {
        let guild_id = guild_id.map(str::trim).filter(|id| !id.is_empty());
        if kind == "guild" {
            let scope =
                AlbionScope::from_tenant_columns(guild_id, region, allied_ids, allied_names)?;
            return Ok(Self {
                server: scope.server(),
                context: scope.linking_context(),
            });
        }
        let has_alliance = alliance_id.map(str::trim).is_some_and(|id| !id.is_empty());
        if kind != "alliance" || !has_alliance {
            return Err(AlbionScopeError::NotConfigured);
        }
        let Some(region) = region.map(str::trim).filter(|region| !region.is_empty()) else {
            return Err(AlbionScopeError::NotConfigured);
        };
        Ok(Self {
            server: normalize_server(Some(region)),
            context: BattleLinkingContext::for_alliance(member_guild_ids),
        })
    }
}

/// Loads the tenant row and resolves an [`EventReadScope`] for event reads.
///
/// Guild tenants resolve exactly as [`load_albion_scope`]. Alliance tenants
/// resolve through their alliance: the friendly side is the set of
/// `albion_guild_id`s of the alliance's active member tenants.
///
/// # Errors
///
/// Returns [`AlbionScopeError::Database`] when a query or column decode fails,
/// and [`AlbionScopeError::NotConfigured`] when the tenant has neither a guild
/// nor an alliance configuration, or lacks a region.
pub async fn load_event_read_scope(
    control: &DatabaseConnection,
    tenant_id: &str,
) -> Result<EventReadScope, AlbionScopeError> {
    if tenant_id.is_empty() {
        return Err(AlbionScopeError::NotConfigured);
    }
    let row = control
        .query_one(Statement::from_sql_and_values(
            control.get_database_backend(),
            "SELECT kind, albion_guild_id, albion_api_region, albion_alliance_id, \
             albion_allied_guild_ids, albion_allied_guild_names \
             FROM tenants WHERE id = $1",
            [tenant_id.into()],
        ))
        .await?;
    let Some(row) = row else {
        return Err(AlbionScopeError::NotConfigured);
    };
    let kind: String = row.try_get_by_index(0)?;
    let guild_id: Option<String> = row.try_get_by_index(1)?;
    let region: Option<String> = row.try_get_by_index(2)?;
    let alliance_id: Option<String> = row.try_get_by_index(3)?;
    let allied_ids: Option<String> = row.try_get_by_index(4)?;
    let allied_names: Option<String> = row.try_get_by_index(5)?;
    // Member guild IDs are only meaningful for an alliance tenant; a guild
    // tenant resolves through its own guild without the extra query.
    let member_guild_ids = if kind == "alliance" {
        // Membership rows are keyed by the Discord tenant id, not the Albion
        // alliance id stored on that tenant.
        load_active_member_guild_ids(control, tenant_id).await?
    } else {
        Vec::new()
    };
    EventReadScope::from_tenant_row(
        &kind,
        guild_id.as_deref(),
        region.as_deref(),
        alliance_id.as_deref(),
        allied_ids.as_deref(),
        allied_names.as_deref(),
        &member_guild_ids,
    )
}

/// Active member guild IDs of an alliance, blanks excluded.
async fn load_active_member_guild_ids(
    control: &DatabaseConnection,
    alliance_tenant_id: &str,
) -> Result<Vec<String>, AlbionScopeError> {
    let rows = control
        .query_all(Statement::from_sql_and_values(
            control.get_database_backend(),
            "SELECT t.albion_guild_id FROM tenants t \
             JOIN alliance_memberships m ON m.guild_tenant_id = t.id \
             WHERE m.alliance_tenant_id = $1 AND m.status = 'active'",
            [alliance_tenant_id.into()],
        ))
        .await?;
    let mut member_ids = Vec::new();
    for row in rows {
        let id: Option<String> = row.try_get_by_index(0)?;
        if let Some(id) = id
            .map(|id| id.trim().to_owned())
            .filter(|id| !id.is_empty())
        {
            member_ids.push(id);
        }
    }
    Ok(member_ids)
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
    fn alliance_scope_classifies_member_guilds_as_friendly() {
        let members = vec!["guild-1".to_string(), "guild-2".to_string()];
        let scope = EventReadScope::from_tenant_row(
            "alliance",
            None,
            Some("europe"),
            Some("alb-alliance"),
            None,
            None,
            &members,
        )
        .expect("alliance tenant should resolve");
        assert_eq!(scope.server(), "eu");
        let context = scope.linking_context();
        assert!(context.is_friendly_guild("guild-1", ""));
        assert!(context.is_friendly_guild("guild-2", "Some Name"));
        assert!(!context.is_friendly_guild("guild-3", "Outsider"));
        // No own guild: unknown and blank guild ids are never "ours".
        assert_eq!(context.guild_id(), None);
        assert!(!context.is_own_guild(""));
        assert!(!context.is_own_guild("guild-1"));
    }

    #[test]
    fn guild_scope_wins_when_both_identities_are_configured() {
        let scope = EventReadScope::from_tenant_row(
            "guild",
            Some("guild-1"),
            Some("asia"),
            Some("alb-alliance"),
            Some("ally-id"),
            Some("Ally Name"),
            &["member-guild".to_string()],
        )
        .expect("guild tenant should resolve");
        let context = scope.linking_context();
        assert_eq!(context.guild_id(), Some("guild-1"));
        assert!(context.is_own_guild("guild-1"));
        assert!(context.is_friendly_guild("ally-id", ""));
        // Member guilds of the alliance are not implicitly friendly here:
        // a guild tenant's allies come from its own allied columns.
        assert!(!context.is_friendly_guild("member-guild", ""));
    }

    #[test]
    fn alliance_scope_without_region_or_identity_is_not_configured() {
        assert!(matches!(
            EventReadScope::from_tenant_row(
                "alliance",
                None,
                None,
                Some("alb-alliance"),
                None,
                None,
                &[]
            ),
            Err(AlbionScopeError::NotConfigured)
        ));
        assert!(matches!(
            EventReadScope::from_tenant_row(
                "alliance",
                None,
                Some("   "),
                Some("alb-alliance"),
                None,
                None,
                &[]
            ),
            Err(AlbionScopeError::NotConfigured)
        ));
        // Neither a guild nor an alliance identity.
        assert!(matches!(
            EventReadScope::from_tenant_row("unknown", None, Some("europe"), None, None, None, &[]),
            Err(AlbionScopeError::NotConfigured)
        ));
        assert!(matches!(
            EventReadScope::from_tenant_row(
                "alliance",
                None,
                Some("europe"),
                Some("  "),
                None,
                None,
                &[]
            ),
            Err(AlbionScopeError::NotConfigured)
        ));
    }

    #[test]
    fn blank_alliance_with_no_guild_stays_not_configured_for_reads() {
        // Guards the loader's member-guild query trigger: a row with neither
        // identity must fail closed, not resolve an empty alliance scope.
        assert!(matches!(
            EventReadScope::from_tenant_row(
                "guild",
                Some("  "),
                Some("europe"),
                None,
                None,
                None,
                &[]
            ),
            Err(AlbionScopeError::NotConfigured)
        ));
    }

    #[tokio::test]
    #[allow(clippy::too_many_lines)]
    async fn event_read_scope_resolves_guild_and_alliance_tenants() {
        use sea_orm_migration::MigratorTrait;

        let Some((url, admin)) = crate::postgres::test_support::try_admin_db().await else {
            return;
        };
        let schema = crate::postgres::test_support::unique_schema("it_evrsc");
        crate::postgres::ensure_schema(&admin, &schema)
            .await
            .expect("control schema");
        let control = crate::postgres::connect_with_search_path(&url, &schema)
            .await
            .expect("control connect");
        crate::control_migration::Migrator::up(&control, None)
            .await
            .expect("control migrations");

        let alliance_id = crate::postgres::test_support::unique_schema("aid");
        let guild_id = crate::postgres::test_support::unique_schema("gid");
        let insert_tenant =
            |id: &str, kind: &str, albion_guild_id: Option<&str>, alliance: Option<&str>| {
                Statement::from_sql_and_values(
                    control.get_database_backend(),
                    "INSERT INTO tenants (id, slug, name, schema_name, status, kind, \
                     albion_guild_id, albion_api_region, albion_alliance_id) \
                     VALUES ($1, $2, $3, $4, 'active', $5, $6, 'europe', $7)",
                    [
                        id.into(),
                        format!("slug-{id}").into(),
                        format!("name-{id}").into(),
                        format!("schema_{id}").into(),
                        kind.into(),
                        albion_guild_id.into(),
                        alliance.into(),
                    ],
                )
            };
        control
            .execute(insert_tenant(&guild_id, "guild", Some("alb-guild"), None))
            .await
            .expect("guild tenant");
        control
            .execute(insert_tenant(
                &alliance_id,
                "alliance",
                None,
                Some("alb-alliance"),
            ))
            .await
            .expect("alliance tenant");
        control
            .execute(Statement::from_sql_and_values(
                control.get_database_backend(),
                "INSERT INTO alliance_memberships (alliance_tenant_id, guild_tenant_id, status) \
                 VALUES ($1, $2, 'active')",
                [alliance_id.clone().into(), guild_id.clone().into()],
            ))
            .await
            .expect("membership");

        // Guild tenant: unchanged strict guild scope.
        let guild_scope = load_event_read_scope(&control, &guild_id)
            .await
            .expect("guild tenant should resolve");
        assert_eq!(guild_scope.linking_context().guild_id(), Some("alb-guild"));

        // Alliance tenant: resolves through its member guilds, no own guild.
        let alliance_scope = load_event_read_scope(&control, &alliance_id)
            .await
            .expect("alliance tenant should resolve");
        assert_eq!(alliance_scope.server(), "eu");
        let context = alliance_scope.linking_context();
        assert_eq!(context.guild_id(), None);
        assert_eq!(context.allied_guild_ids(), vec!["alb-guild".to_owned()]);
        assert!(context.is_friendly_guild("alb-guild", ""));
        assert!(!context.is_friendly_guild("some-other-guild", "Outsider"));

        // A tenant with neither identity still fails closed.
        let lone_id = crate::postgres::test_support::unique_schema("lone");
        control
            .execute(insert_tenant(&lone_id, "guild", None, None))
            .await
            .expect("lone tenant");
        assert!(matches!(
            load_event_read_scope(&control, &lone_id).await,
            Err(AlbionScopeError::NotConfigured)
        ));

        crate::postgres::drop_schema(&admin, &schema)
            .await
            .expect("drop schema");
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
