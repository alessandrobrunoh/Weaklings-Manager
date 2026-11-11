//! The module catalogue: the one table that says which product modules exist,
//! which tenant kinds they are offered to, which feature flag and permission
//! unlock them, which API prefixes they own and which bot commands they
//! provide.
//!
//! It replaces the prefix table that used to live in `tenant.rs`
//! (`FEATURE_GATES`). That table is kept for now and [`feature_for_path`] must
//! agree with it (see the equivalence test below); the clients read the
//! capabilities built from this catalogue instead of their own copies.

use std::collections::HashSet;
use std::sync::OnceLock;

use crate::auth::Permission;

/// Whether a module is offered to alliance tenants.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AllianceRule {
    /// Not offered to alliance tenants.
    Unsupported,
    /// Offered to alliance tenants, which work on their own data.
    Own,
    /// Offered to alliance tenants as read-only aggregates of member-guild data.
    Aggregate,
}

/// The feature flag a module or an API prefix needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeatureRule {
    /// No feature flag.
    None,
    /// The tenant must have this feature enabled.
    Required(&'static str),
    /// The tenant must have this feature enabled, unless it is an alliance.
    RequiredUnlessAlliance(&'static str),
}

impl FeatureRule {
    /// The feature key this rule names, if any.
    #[must_use]
    #[cfg_attr(
        not(test),
        allow(
            dead_code,
            reason = "read by the catalogue equivalence check; the legacy table still gates until SA-3"
        )
    )]
    pub const fn key(self) -> Option<&'static str> {
        match self {
            Self::None => None,
            Self::Required(key) | Self::RequiredUnlessAlliance(key) => Some(key),
        }
    }

    /// Whether a tenant of `kind` with `features` meets this rule.
    #[must_use]
    pub fn satisfied(self, kind: &str, features: &HashSet<String>) -> bool {
        match self {
            Self::None => true,
            Self::Required(key) => features.contains(key),
            Self::RequiredUnlessAlliance(key) => kind == "alliance" || features.contains(key),
        }
    }
}

/// One API prefix owned by a module.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ApiPrefix {
    /// Path prefix, matched on whole segments (`/api/splits` owns `/api/splits/1`).
    pub path: &'static str,
    /// Feature rule enforced on requests under this prefix.
    pub feature: FeatureRule,
}

const fn api(path: &'static str, feature: FeatureRule) -> ApiPrefix {
    ApiPrefix { path, feature }
}

/// One product module of the catalogue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModuleDef {
    /// Stable key used by clients (`events`, `splits`, `warns`, ...).
    pub key: &'static str,
    /// Offered to guild tenants.
    pub guild: bool,
    /// Offered to alliance tenants, and how.
    pub alliance: AllianceRule,
    /// Feature flag that switches the module on for a tenant.
    pub feature: FeatureRule,
    /// Permission that makes the module accessible to a user. `None` means any member.
    pub view: Option<Permission>,
    /// API prefixes owned by this module. Paths outside every prefix are never gated.
    pub api: &'static [ApiPrefix],
    /// Discord bot command names this module provides.
    pub commands: &'static [&'static str],
    /// Per-action permissions, exposed to clients as UI grants (`create`, `edit`, ...).
    pub grants: &'static [(&'static str, Permission)],
    /// Navigation group the client places the module in.
    pub nav_group: &'static str,
}

impl ModuleDef {
    /// Whether tenants of `kind` are offered this module at all.
    #[must_use]
    pub fn supports_kind(&self, kind: &str) -> bool {
        match kind {
            "guild" => self.guild,
            "alliance" => self.alliance != AllianceRule::Unsupported,
            _ => false,
        }
    }

    /// The scope and read-only flag an alliance sees for this module.
    ///
    /// Guild tenants always see their own data, writable.
    #[must_use]
    pub fn scope_for(&self, kind: &str) -> (&'static str, bool) {
        match (kind, self.alliance) {
            ("alliance", AllianceRule::Aggregate) => ("aggregate", true),
            _ => ("own", false),
        }
    }
}

/// The catalogue. One entry per module; edit a cell here, not in the clients.
pub const MODULES: &[ModuleDef] = &[
    ModuleDef {
        key: "dashboard",
        guild: true,
        alliance: AllianceRule::Own,
        feature: FeatureRule::None,
        view: None,
        api: &[],
        commands: &[],
        grants: &[],
        nav_group: "overview",
    },
    ModuleDef {
        key: "users",
        guild: true,
        alliance: AllianceRule::Own,
        feature: FeatureRule::None,
        view: None,
        api: &[api("/api/users", FeatureRule::None)],
        commands: &["users"],
        grants: &[],
        nav_group: "overview",
    },
    ModuleDef {
        key: "albion_link",
        guild: true,
        alliance: AllianceRule::Own,
        feature: FeatureRule::None,
        view: None,
        api: &[api("/api/albion", FeatureRule::None)],
        commands: &["link", "register", "player", "me"],
        grants: &[],
        nav_group: "overview",
    },
    ModuleDef {
        key: "notifications",
        guild: true,
        alliance: AllianceRule::Own,
        feature: FeatureRule::None,
        view: None,
        api: &[api("/api/notifications", FeatureRule::None)],
        commands: &[],
        grants: &[],
        nav_group: "administration",
    },
    ModuleDef {
        key: "audit",
        guild: true,
        alliance: AllianceRule::Own,
        feature: FeatureRule::None,
        view: Some(Permission::AuditView),
        api: &[api("/api/audit", FeatureRule::None)],
        commands: &[],
        grants: &[],
        nav_group: "administration",
    },
    ModuleDef {
        key: "admin",
        guild: true,
        alliance: AllianceRule::Own,
        feature: FeatureRule::None,
        view: Some(Permission::AdminSettingsManage),
        api: &[api("/api/admin", FeatureRule::None)],
        commands: &[],
        grants: &[],
        nav_group: "administration",
    },
    ModuleDef {
        key: "events",
        guild: true,
        alliance: AllianceRule::Own,
        feature: FeatureRule::Required("events"),
        view: Some(Permission::EventsView),
        api: &[
            api("/api/events", FeatureRule::Required("events")),
            api("/api/vods", FeatureRule::None),
        ],
        commands: &[
            "events",
            "event-create",
            "event-join",
            "event-leave",
            "event-start",
            "event-stop",
            "event-calendar-refresh",
            "event-roster",
            "roster",
            "flash",
            "vod",
        ],
        grants: &[
            ("view", Permission::EventsView),
            ("create", Permission::EventsCreate),
            ("edit", Permission::EventsEdit),
            ("delete", Permission::EventsDelete),
        ],
        nav_group: "operations",
    },
    ModuleDef {
        key: "comps",
        guild: true,
        alliance: AllianceRule::Own,
        feature: FeatureRule::Required("comps"),
        view: Some(Permission::CompsCompsView),
        api: &[api("/api/comps", FeatureRule::Required("comps"))],
        commands: &["build"],
        grants: &[
            ("view", Permission::CompsCompsView),
            ("create", Permission::CompsCompsCreate),
            ("edit", Permission::CompsCompsEdit),
            ("delete", Permission::CompsCompsDelete),
        ],
        nav_group: "operations",
    },
    ModuleDef {
        key: "splits",
        guild: true,
        alliance: AllianceRule::Own,
        feature: FeatureRule::Required("splits"),
        view: Some(Permission::SplitsView),
        api: &[
            api("/api/splits/islands", FeatureRule::Required("splits.paid")),
            api("/api/splits", FeatureRule::Required("splits")),
        ],
        commands: &[],
        grants: &[
            ("view", Permission::SplitsView),
            ("create", Permission::SplitsCreate),
            ("edit", Permission::SplitsEdit),
            ("delete", Permission::SplitsDelete),
        ],
        nav_group: "finance",
    },
    ModuleDef {
        key: "bank",
        guild: true,
        alliance: AllianceRule::Aggregate,
        feature: FeatureRule::RequiredUnlessAlliance("bank"),
        view: None,
        api: &[api(
            "/api/bank",
            FeatureRule::RequiredUnlessAlliance("bank"),
        )],
        commands: &["balance", "balance-request"],
        grants: &[],
        nav_group: "finance",
    },
    ModuleDef {
        key: "regears",
        guild: true,
        alliance: AllianceRule::Aggregate,
        feature: FeatureRule::Required("regears"),
        view: Some(Permission::RegearView),
        api: &[api("/api/regear", FeatureRule::Required("regears"))],
        commands: &[],
        grants: &[
            ("view", Permission::RegearView),
            ("request", Permission::RegearRequest),
            ("adjudicate", Permission::RegearAdjudicate),
        ],
        nav_group: "operations",
    },
    ModuleDef {
        key: "warns",
        guild: true,
        alliance: AllianceRule::Unsupported,
        feature: FeatureRule::Required("warns"),
        view: Some(Permission::WarnsView),
        api: &[api("/api/warns", FeatureRule::Required("warns"))],
        commands: &["warn", "warns", "unwarn"],
        grants: &[
            ("view", Permission::WarnsView),
            ("issue", Permission::WarnsIssue),
        ],
        nav_group: "community",
    },
    ModuleDef {
        key: "progression",
        guild: true,
        alliance: AllianceRule::Unsupported,
        feature: FeatureRule::None,
        view: Some(Permission::ProgressionView),
        api: &[
            api(
                "/api/progression/settings",
                FeatureRule::Required("progression"),
            ),
            api("/api/progression", FeatureRule::None),
        ],
        commands: &["rank", "leaderboard", "xp"],
        grants: &[],
        nav_group: "overview",
    },
    ModuleDef {
        key: "battles",
        guild: true,
        alliance: AllianceRule::Aggregate,
        feature: FeatureRule::Required("battles"),
        view: Some(Permission::FightsView),
        api: &[
            api("/api/battles", FeatureRule::Required("battles")),
            api("/api/fights", FeatureRule::Required("battles")),
            api("/api/economy", FeatureRule::Required("battles")),
            api("/api/fight-analytics", FeatureRule::Required("battles")),
        ],
        commands: &["battles"],
        grants: &[],
        nav_group: "operations",
    },
    ModuleDef {
        key: "intel",
        guild: true,
        alliance: AllianceRule::Unsupported,
        feature: FeatureRule::Required("intel"),
        view: Some(Permission::IntelView),
        api: &[
            api("/api/intel", FeatureRule::Required("intel")),
            api("/api/enemies", FeatureRule::Required("intel")),
            api("/api/fingerprints", FeatureRule::Required("intel")),
            api("/api/attention", FeatureRule::Required("intel")),
        ],
        commands: &[],
        grants: &[],
        nav_group: "community",
    },
    ModuleDef {
        key: "tests",
        guild: true,
        alliance: AllianceRule::Unsupported,
        feature: FeatureRule::Required("tests"),
        view: Some(Permission::CombatTestsView),
        api: &[
            api("/api/combat/tests", FeatureRule::Required("tests")),
            api("/api/combat/runs", FeatureRule::Required("tests")),
        ],
        commands: &[],
        grants: &[],
        nav_group: "community",
    },
    ModuleDef {
        key: "siphoned",
        guild: true,
        alliance: AllianceRule::Unsupported,
        feature: FeatureRule::Required("siphoned"),
        view: Some(Permission::SiphonedView),
        api: &[api("/api/siphoned", FeatureRule::Required("siphoned"))],
        commands: &[],
        grants: &[],
        nav_group: "community",
    },
    ModuleDef {
        key: "giveaways",
        guild: true,
        alliance: AllianceRule::Unsupported,
        feature: FeatureRule::Required("giveaways"),
        view: Some(Permission::GiveawaysView),
        api: &[api("/api/giveaways", FeatureRule::Required("giveaways"))],
        commands: &[],
        grants: &[],
        nav_group: "community",
    },
    ModuleDef {
        key: "applications",
        guild: true,
        alliance: AllianceRule::Unsupported,
        feature: FeatureRule::Required("applications"),
        view: None,
        api: &[
            api("/api/applications", FeatureRule::Required("applications")),
            api("/api/tickets", FeatureRule::None),
            api("/api/trials", FeatureRule::None),
        ],
        commands: &["applications-panel"],
        grants: &[("manage", Permission::ApplicationsManage)],
        nav_group: "community",
    },
    ModuleDef {
        key: "alliance",
        guild: true,
        alliance: AllianceRule::Own,
        feature: FeatureRule::None,
        view: None,
        api: &[
            api("/api/alliances", FeatureRule::None),
            api("/api/alliance", FeatureRule::None),
        ],
        commands: &[],
        grants: &[],
        nav_group: "administration",
    },
    ModuleDef {
        key: "sync",
        guild: true,
        alliance: AllianceRule::Own,
        feature: FeatureRule::None,
        view: None,
        api: &[api("/api/sync", FeatureRule::None)],
        commands: &[],
        grants: &[],
        nav_group: "administration",
    },
    ModuleDef {
        key: "members",
        guild: true,
        alliance: AllianceRule::Own,
        feature: FeatureRule::None,
        view: None,
        api: &[api("/api/members", FeatureRule::None)],
        commands: &[],
        grants: &[],
        nav_group: "administration",
    },
    ModuleDef {
        key: "discord",
        guild: true,
        alliance: AllianceRule::Own,
        feature: FeatureRule::None,
        view: Some(Permission::AdminSettingsManage),
        api: &[api("/api/discord", FeatureRule::None)],
        commands: &[],
        grants: &[],
        nav_group: "administration",
    },
];

/// The module whose prefix matches `path` most specifically, with that prefix.
///
/// Matching is on whole path segments, so `/api/compsomething` belongs to no
/// module. Paths outside every prefix (`/api/bot/*`, `/api/openapi.json`, ...)
/// return `None`, which means "never gated".
#[must_use]
pub fn match_path(path: &str) -> Option<(&'static ModuleDef, &'static ApiPrefix)> {
    let path = path.trim_end_matches('/');
    MODULES
        .iter()
        .flat_map(|module| module.api.iter().map(move |prefix| (module, prefix)))
        .filter(|(_, prefix)| segment_prefix(prefix.path, path))
        .max_by_key(|(_, prefix)| prefix.path.len())
}

/// The module that owns `path`, if any.
#[must_use]
pub fn module_for_path(path: &str) -> Option<&'static ModuleDef> {
    match_path(path).map(|(module, _)| module)
}

/// The feature key `path` requires, following the most specific prefix.
///
/// Must return the same keys as the legacy `tenant::FEATURE_GATES` table.
#[must_use]
#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "read by the catalogue equivalence check; the legacy table still gates until SA-3"
    )
)]
pub fn feature_for_path(path: &str) -> Option<&'static str> {
    match_path(path).and_then(|(_, prefix)| prefix.feature.key())
}

/// Looks a module up by key.
#[must_use]
#[cfg_attr(
    not(test),
    allow(dead_code, reason = "read by the catalogue tests and the SA-3 clients")
)]
pub fn module(key: &str) -> Option<&'static ModuleDef> {
    MODULES.iter().find(|module| module.key == key)
}

/// A stable text fingerprint of the whole catalogue. It changes whenever any
/// cell changes, so it feeds the capabilities version.
#[must_use]
pub fn fingerprint() -> &'static str {
    static FINGERPRINT: OnceLock<String> = OnceLock::new();
    FINGERPRINT.get_or_init(|| format!("{MODULES:?}"))
}

fn segment_prefix(prefix: &str, path: &str) -> bool {
    path == prefix
        || path
            .strip_prefix(prefix)
            .is_some_and(|rest| rest.starts_with('/'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tenant::FEATURE_GATES;
    use std::collections::HashSet;

    fn features(keys: &[&str]) -> HashSet<String> {
        keys.iter().map(|key| (*key).to_owned()).collect()
    }

    /// The catalogue answers every old `(prefix, feature)` pair the same way,
    /// so the legacy table can be deleted later without changing any gate.
    #[test]
    fn feature_for_path_matches_the_legacy_gate_table() {
        for (prefix, feature) in FEATURE_GATES {
            assert_eq!(
                feature_for_path(prefix),
                Some(*feature),
                "catalogue disagrees with FEATURE_GATES for {prefix}"
            );
        }
    }

    /// And the catalogue gates nothing the legacy table does not: no new
    /// feature requirement appears by accident.
    #[test]
    fn catalogue_adds_no_feature_gate_the_legacy_table_lacks() {
        for module in MODULES {
            for prefix in module.api {
                if let Some(feature) = prefix.feature.key() {
                    assert!(
                        FEATURE_GATES
                            .iter()
                            .any(|(path, key)| *path == prefix.path && *key == feature),
                        "{} gates {} with {feature}, which FEATURE_GATES does not",
                        module.key,
                        prefix.path
                    );
                }
            }
        }
    }

    #[test]
    fn prefixes_match_whole_segments_and_the_narrowest_wins() {
        assert_eq!(feature_for_path("/api/compsomething"), None);
        assert_eq!(feature_for_path("/api/bankruptcy"), None);
        assert_eq!(feature_for_path("/api/splits/42/complete"), Some("splits"));
        assert_eq!(
            feature_for_path("/api/splits/islands/7/tabs"),
            Some("splits.paid")
        );
        assert_eq!(
            feature_for_path("/api/progression/leaderboard"),
            None,
            "the leaderboard stays ungated, only progression settings are"
        );
    }

    #[test]
    fn unknown_prefixes_and_bot_routes_are_never_gated() {
        for path in [
            "/api/bot/outbox/claim",
            "/api/openapi.json",
            "/api/some/future/route",
        ] {
            assert!(module_for_path(path).is_none(), "{path} must stay open");
            assert_eq!(feature_for_path(path), None);
        }
    }

    #[test]
    fn alliance_matrix_has_no_progression_and_bank_needs_no_feature() {
        let progression = module("progression").expect("progression module");
        assert!(!progression.supports_kind("alliance"));
        assert!(progression.supports_kind("guild"));

        let bank = module("bank").expect("bank module");
        assert!(bank.supports_kind("alliance"));
        assert!(bank.feature.satisfied("alliance", &features(&[])));
        assert!(!bank.feature.satisfied("guild", &features(&[])));
        assert!(bank.feature.satisfied("guild", &features(&["bank"])));
    }

    #[test]
    fn guild_only_modules_are_refused_for_alliances() {
        for key in ["warns", "intel", "giveaways", "applications"] {
            let module = module(key).expect("module exists");
            assert!(!module.supports_kind("alliance"), "{key} is guild-only");
        }
    }

    #[test]
    fn the_sync_members_discord_and_alliance_modules_exist_for_both_kinds() {
        for key in ["sync", "members", "discord"] {
            let module = module(key).expect("module exists");
            assert!(module.supports_kind("guild"));
            assert!(module.supports_kind("alliance"));
        }
        let alliance = module("alliance").expect("alliance module");
        assert!(alliance.supports_kind("alliance"));
        assert!(alliance.supports_kind("guild"));
    }

    #[test]
    fn module_and_command_names_are_unique() {
        let mut keys = HashSet::new();
        let mut commands = HashSet::new();
        for module in MODULES {
            assert!(keys.insert(module.key), "duplicate module {}", module.key);
            for command in module.commands {
                assert!(commands.insert(*command), "duplicate command {command}");
            }
        }
    }

    #[test]
    fn nav_keys_are_unique_and_every_module_has_a_group() {
        let mut keys = HashSet::new();
        for module in MODULES {
            assert!(keys.insert(module.key));
            assert!(!module.nav_group.is_empty());
        }
    }

    #[test]
    fn fingerprint_is_stable_within_a_build() {
        assert_eq!(fingerprint(), fingerprint());
    }
}
