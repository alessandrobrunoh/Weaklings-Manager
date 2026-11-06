//! The capabilities document and the pure function that builds it.
//!
//! Nothing here touches the database or the request: the router gathers the
//! facts (tenant row, features, the actor's granted permissions) and hands them
//! to [`build`], which is therefore testable in isolation.

use std::collections::{BTreeSet, HashSet};
use std::hash::{Hash, Hasher};

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::catalogue::{self, MODULES};
use crate::modules::auth::Permission;

/// Who the tenant is, as the clients need it.
#[derive(Debug, Clone)]
pub struct TenantFacts {
    /// Discord guild id / `tenants.id`.
    pub id: String,
    /// Display name.
    pub name: String,
    /// `guild` or `alliance`.
    pub kind: String,
    /// `provisioning`, `active` or `suspended`.
    pub status: String,
    /// IANA timezone for wall-clock inputs. Only known inside an authenticated tenant request.
    pub timezone: Option<String>,
    /// The alliance this tenant belongs to (or is the hub of).
    pub alliance: Option<AllianceBlock>,
    /// Enabled feature flags.
    pub features: HashSet<String>,
}

/// The actor a document is built for. Absent for the bot's tenant-wide document.
#[derive(Debug, Clone)]
pub struct ActorFacts {
    /// Local `users.id`, `0` for background bot calls.
    pub user_id: i64,
    /// Whether the actor owns the tenant.
    pub is_owner: bool,
    /// Whether the actor is a platform admin.
    pub is_platform_admin: bool,
    /// Every permission the actor holds in this tenant (owner and admin bypass included).
    pub granted: HashSet<Permission>,
}

/// Alliance link of a tenant.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
pub struct AllianceBlock {
    /// Alliance tenant id.
    pub id: String,
    /// Alliance display name.
    pub name: String,
    /// `member` for a guild in the alliance, `hub` for the alliance tenant itself.
    pub role: String,
}

/// The tenant block of the document.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
pub struct TenantBlock {
    /// Discord guild id / `tenants.id`.
    pub id: String,
    /// Display name.
    pub name: String,
    /// `guild` or `alliance`.
    pub kind: String,
    /// Tenant lifecycle status.
    pub status: String,
    /// IANA timezone, present on authenticated documents.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
    /// Alliance link, when there is one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alliance: Option<AllianceBlock>,
}

/// The user block, present on `GET /api/me/capabilities` only.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
pub struct UserBlock {
    /// Local `users.id`.
    pub user_id: i64,
    /// Owner of the tenant.
    pub is_owner: bool,
    /// Platform admin.
    pub is_platform_admin: bool,
    /// Stable permission keys the user holds in this tenant, sorted.
    pub permissions: Vec<String>,
}

/// One module as seen by the actor (or by the bot, without `accessible`).
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
pub struct ModuleEntry {
    /// Module key from the catalogue.
    pub key: String,
    /// Tenant kind and feature flags allow the module.
    pub enabled: bool,
    /// Enabled and the actor holds the view permission. Absent for the bot document.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accessible: Option<bool>,
    /// `own`, or `aggregate` for alliances seeing member-guild data.
    pub scope: String,
    /// Read-only for this tenant kind.
    pub read_only: bool,
    /// UI grants the actor holds (`view`, `create`, `edit`, ...). Empty for the bot document.
    pub grants: Vec<String>,
    /// Why the module is not enabled or not accessible.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
}

/// One Discord command and whether this tenant gets it.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
pub struct CommandEntry {
    /// Command name as registered with Discord.
    pub name: String,
    /// Module that provides it.
    pub module: String,
    /// The tenant gets the command.
    pub enabled: bool,
    /// Enabled and the actor may use it. Absent for the bot document.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accessible: Option<bool>,
    /// The module's view permission, if it has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required_permission: Option<String>,
    /// Why the command is not enabled or not accessible.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
}

/// One navigation entry. Presentation (icon, label, path) stays in the client.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
pub struct NavEntry {
    /// Navigation key the client maps to a route.
    pub key: String,
    /// Module that owns the entry.
    pub module: String,
    /// Navigation group.
    pub group: String,
    /// Shown to the actor.
    pub visible: bool,
}

/// The capabilities document.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
pub struct Capabilities {
    /// Validator for the whole document: the `ETag` of `GET /api/me/capabilities`.
    pub version: String,
    /// Validator for the tenant part only: the value of `X-Capabilities-Version`.
    pub tenant_version: String,
    /// The tenant.
    pub tenant: TenantBlock,
    /// The actor. Absent on the bot document.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<UserBlock>,
    /// Modules offered to this tenant kind. Modules the kind does not support are not listed.
    pub modules: Vec<ModuleEntry>,
    /// Every catalogue command, enabled or not.
    pub commands: Vec<CommandEntry>,
    /// Navigation. Present on the user document only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nav: Option<Vec<NavEntry>>,
    /// Digest of the enabled command names. Present on the bot document only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commands_hash: Option<String>,
}

/// `OpenAPI` wrapper for the success envelope of [`Capabilities`].
#[derive(Debug, Serialize, ToSchema)]
pub struct ApiResponseCapabilities {
    /// Always `success`.
    #[schema(example = "success")]
    pub status: String,
    /// The document.
    pub data: Capabilities,
}

/// Digest of a sequence of parts, stable within a build and short enough for a header.
fn digest(parts: &[String]) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for part in parts {
        part.hash(&mut hasher);
        // Separator so ["ab", "c"] and ["a", "bc"] differ.
        0xff_u8.hash(&mut hasher);
    }
    format!("{:016x}", hasher.finish())
}

/// Validator for the tenant part: catalogue, kind, status and feature flags, the
/// inputs the tenant middleware has per request. It is the `X-Capabilities-Version`
/// header. Name, timezone and alliance link are in [`Capabilities::version`] only.
#[must_use]
pub fn tenant_version(kind: &str, status: &str, features: &HashSet<String>) -> String {
    let mut sorted: Vec<&String> = features.iter().collect();
    sorted.sort();
    let mut parts = vec![
        catalogue::fingerprint().to_owned(),
        kind.to_owned(),
        status.to_owned(),
    ];
    parts.extend(sorted.into_iter().cloned());
    digest(&parts)
}

/// The `ETag` of the whole document: the tenant validator, the tenant block
/// (name, timezone, alliance link) and, when there is one, the actor's facts.
fn document_version(
    tenant_version: &str,
    tenant: &TenantFacts,
    actor: Option<&ActorFacts>,
) -> String {
    // `Debug` of the tuple keeps `None` apart from any string, so the parts stay unambiguous.
    let mut parts = vec![
        tenant_version.to_owned(),
        format!("{:?}", (&tenant.name, &tenant.timezone, &tenant.alliance)),
    ];
    if let Some(actor) = actor {
        let mut permissions: Vec<&str> = actor.granted.iter().map(|p| p.as_str()).collect();
        permissions.sort_unstable();
        parts.push(actor.user_id.to_string());
        parts.push(actor.is_owner.to_string());
        parts.push(actor.is_platform_admin.to_string());
        parts.extend(permissions.into_iter().map(str::to_owned));
    }
    digest(&parts)
}

/// Builds the document for `tenant`, for `actor` when there is one.
#[must_use]
#[allow(
    clippy::too_many_lines,
    reason = "one pass over the catalogue that fills the four lists together"
)]
pub fn build(tenant: &TenantFacts, actor: Option<&ActorFacts>) -> Capabilities {
    let kind = tenant.kind.as_str();
    let active = tenant.status == "active";
    let tenant_version = tenant_version(kind, &tenant.status, &tenant.features);
    let version = document_version(&tenant_version, tenant, actor);
    let granted = |permission: Option<Permission>| {
        actor.is_some_and(|a| permission.is_none_or(|p| a.granted.contains(&p)))
    };

    let mut modules = Vec::new();
    let mut nav = Vec::new();
    let mut commands = Vec::new();
    let mut enabled_commands = BTreeSet::new();

    for module in MODULES {
        let supported = module.supports_kind(kind);
        let feature_ok = module.feature.satisfied(kind, &tenant.features);
        let enabled = supported && active && feature_ok;
        let reason = if !active {
            Some("tenant_suspended")
        } else if !feature_ok {
            Some("feature_disabled")
        } else {
            None
        };

        if supported {
            let accessible = enabled && granted(module.view);
            let (scope, read_only) = module.scope_for(kind);
            let grants = actor.map_or_else(Vec::new, |a| {
                module
                    .grants
                    .iter()
                    .filter(|(_, permission)| a.granted.contains(permission))
                    .map(|(name, _)| (*name).to_owned())
                    .collect()
            });
            let reason_code = reason.map(str::to_owned).or_else(|| {
                (actor.is_some() && enabled && !accessible).then(|| "permission_missing".to_owned())
            });
            modules.push(ModuleEntry {
                key: module.key.to_owned(),
                enabled,
                accessible: actor.map(|_| accessible),
                scope: scope.to_owned(),
                read_only,
                grants,
                reason_code,
            });
            if actor.is_some() {
                nav.push(NavEntry {
                    key: module.key.to_owned(),
                    module: module.key.to_owned(),
                    group: module.nav_group.to_owned(),
                    visible: accessible,
                });
            }
        }

        for name in module.commands {
            let command_enabled = enabled;
            let command_accessible = command_enabled && granted(module.view);
            let reason_code = if supported {
                reason
            } else {
                Some("kind_unsupported")
            }
            .map(str::to_owned)
            .or_else(|| {
                (actor.is_some() && command_enabled && !command_accessible)
                    .then(|| "permission_missing".to_owned())
            });
            if command_enabled {
                enabled_commands.insert((*name).to_owned());
            }
            commands.push(CommandEntry {
                name: (*name).to_owned(),
                module: module.key.to_owned(),
                enabled: command_enabled,
                accessible: actor.map(|_| command_accessible),
                required_permission: module.view.map(|p| p.as_str().to_owned()),
                reason_code,
            });
        }
    }

    let commands_hash = actor
        .is_none()
        .then(|| digest(&enabled_commands.iter().cloned().collect::<Vec<_>>()));

    Capabilities {
        version,
        tenant_version,
        tenant: TenantBlock {
            id: tenant.id.clone(),
            name: tenant.name.clone(),
            kind: tenant.kind.clone(),
            status: tenant.status.clone(),
            timezone: tenant.timezone.clone(),
            alliance: tenant.alliance.clone(),
        },
        user: actor.map(|a| {
            let mut permissions: Vec<String> =
                a.granted.iter().map(|p| p.as_str().to_owned()).collect();
            permissions.sort();
            UserBlock {
                user_id: a.user_id,
                is_owner: a.is_owner,
                is_platform_admin: a.is_platform_admin,
                permissions,
            }
        }),
        modules,
        commands,
        nav: actor.map(|_| nav),
        commands_hash,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tenant(kind: &str, features: &[&str]) -> TenantFacts {
        TenantFacts {
            id: "123".to_owned(),
            name: "Weaklings".to_owned(),
            kind: kind.to_owned(),
            status: "active".to_owned(),
            timezone: Some("Europe/Rome".to_owned()),
            alliance: None,
            features: features.iter().map(|f| (*f).to_owned()).collect(),
        }
    }

    fn member(granted: &[Permission]) -> ActorFacts {
        ActorFacts {
            user_id: 7,
            is_owner: false,
            is_platform_admin: false,
            granted: granted.iter().copied().collect(),
        }
    }

    fn module<'a>(caps: &'a Capabilities, key: &str) -> Option<&'a ModuleEntry> {
        caps.modules.iter().find(|m| m.key == key)
    }

    #[test]
    fn alliance_document_has_no_progression_module_and_bank_without_feature() {
        let facts = tenant("alliance", &[]);
        let caps = build(&facts, Some(&member(&[])));
        assert!(module(&caps, "progression").is_none());
        let bank = module(&caps, "bank").expect("bank is offered to alliances");
        assert!(bank.enabled);
        assert_eq!(bank.scope, "aggregate");
        assert!(bank.read_only);
    }

    #[test]
    fn guild_without_regears_feature_reports_feature_disabled() {
        let caps = build(&tenant("guild", &[]), Some(&member(&[])));
        let regears = module(&caps, "regears").expect("regears listed for guilds");
        assert!(!regears.enabled);
        assert_eq!(regears.reason_code.as_deref(), Some("feature_disabled"));
    }

    #[test]
    fn missing_view_permission_is_permission_missing_not_disabled() {
        let caps = build(&tenant("guild", &["warns"]), Some(&member(&[])));
        let warns = module(&caps, "warns").expect("warns listed");
        assert!(warns.enabled);
        assert_eq!(warns.accessible, Some(false));
        assert_eq!(warns.reason_code.as_deref(), Some("permission_missing"));

        let caps = build(
            &tenant("guild", &["warns"]),
            Some(&member(&[Permission::WarnsView])),
        );
        let warns = module(&caps, "warns").expect("warns listed");
        assert_eq!(warns.accessible, Some(true));
        assert_eq!(warns.reason_code, None);
    }

    #[test]
    fn alliance_warn_command_reports_kind_unsupported() {
        let caps = build(&tenant("alliance", &[]), None);
        let warn = caps
            .commands
            .iter()
            .find(|c| c.name == "warn")
            .expect("warn is in the catalogue");
        assert!(!warn.enabled);
        assert_eq!(warn.reason_code.as_deref(), Some("kind_unsupported"));
    }

    #[test]
    fn bot_document_has_no_user_no_nav_no_accessible_and_a_commands_hash() {
        let caps = build(&tenant("guild", &["events"]), None);
        assert!(caps.user.is_none());
        assert!(caps.nav.is_none());
        assert!(caps.commands_hash.is_some());
        assert!(caps.modules.iter().all(|m| m.accessible.is_none()));
    }

    #[test]
    fn alliance_link_and_name_changes_move_the_etag() {
        let guild = tenant("guild", &["events"]);
        let before = build(&guild, Some(&member(&[])));

        let mut linked = guild.clone();
        linked.alliance = Some(AllianceBlock {
            id: "999".to_owned(),
            name: "Hub".to_owned(),
            role: "member".to_owned(),
        });
        let after_link = build(&linked, Some(&member(&[])));
        assert_ne!(before.version, after_link.version);
        // The tenant validator stays the middleware's: kind, status and features only.
        assert_eq!(before.tenant_version, after_link.tenant_version);

        let mut renamed = guild.clone();
        renamed.name = "Renamed".to_owned();
        assert_ne!(before.version, build(&renamed, Some(&member(&[]))).version);

        // The bot document has no user, but its ETag still covers the tenant block.
        let bot_before = build(&guild, None);
        let bot_after = build(&linked, None);
        assert_ne!(bot_before.version, bot_after.version);
    }

    #[test]
    fn user_document_sorts_permissions_and_carries_nav() {
        let caps = build(
            &tenant("guild", &["events"]),
            Some(&member(&[Permission::EventsView, Permission::AuditView])),
        );
        let user = caps.user.as_ref().expect("user block");
        let mut sorted = user.permissions.clone();
        sorted.sort();
        assert_eq!(user.permissions, sorted);
        assert!(caps.nav.as_ref().is_some_and(|nav| !nav.is_empty()));
        assert!(caps.commands_hash.is_none());
    }

    #[test]
    fn version_changes_with_features_kind_and_permissions_but_not_with_order() {
        let base = build(&tenant("guild", &["events"]), Some(&member(&[])));
        let more_features = build(&tenant("guild", &["events", "warns"]), Some(&member(&[])));
        let other_kind = build(&tenant("alliance", &["events"]), Some(&member(&[])));
        let more_perms = build(
            &tenant("guild", &["events"]),
            Some(&member(&[Permission::EventsView])),
        );
        assert_ne!(base.tenant_version, more_features.tenant_version);
        assert_ne!(base.tenant_version, other_kind.tenant_version);
        assert_ne!(base.version, more_perms.version);
        assert_eq!(base.tenant_version, more_perms.tenant_version);

        let reordered = build(&tenant("guild", &["events"]), Some(&member(&[])));
        assert_eq!(base, reordered);
    }

    #[test]
    fn suspended_tenant_disables_every_module() {
        let mut facts = tenant("guild", &["events"]);
        facts.status = "suspended".to_owned();
        let caps = build(&facts, None);
        assert!(caps.modules.iter().all(|m| !m.enabled));
        assert!(
            caps.modules
                .iter()
                .all(|m| m.reason_code.as_deref() == Some("tenant_suspended"))
        );
    }

    #[test]
    fn grants_list_only_the_permissions_the_actor_holds() {
        let caps = build(
            &tenant("guild", &["events"]),
            Some(&member(&[Permission::EventsCreate])),
        );
        let events = module(&caps, "events").expect("events listed");
        assert_eq!(events.grants, vec!["create".to_owned()]);
    }

    #[test]
    fn catalogue_modules_are_all_known_to_the_document() {
        let caps = build(&tenant("guild", &[]), None);
        assert_eq!(caps.modules.len(), MODULES.len());
    }
}
