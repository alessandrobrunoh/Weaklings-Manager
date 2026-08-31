//! Fine-grained permissions used by route handlers to authorize requests.
//!
//! A `Permission` is an atomic capability (e.g. "accept a bank withdrawal")
//! attached to a route via the [`Require`](super::extractors::Require) extractor.
//! Roles are mapped to one or more permissions through the `role_permissions`
//! database table, so changing "who can do what" is a data edit — not a redeploy.

use serde::{Deserialize, Serialize};
use strum::{AsRefStr, EnumString, IntoStaticStr, VariantArray};

/// Every capability the backend can gate behind authorization.
///
/// The `#[strum(serialize = "...")]` attribute on each variant is the **stable
/// string key** persisted in the `role_permissions.permission` column — never
/// rename an existing value, it is part of the data contract.
///
/// Adding a new restricted action:
/// 1. add a variant here with its `serialize` key;
/// 2. call `user.require(&perms, Permission::YourNewVariant).await?` in the handler;
/// 3. grant it to whichever roles need it via the `role_permissions` table,
///    then `POST /api/admin/permissions/reload`.
///
/// `as_str` / `from_str` / `all` are derived by `strum` — no manual `match`
/// to keep in sync.
#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    Hash,
    Serialize,
    Deserialize,
    AsRefStr,
    EnumString,
    IntoStaticStr,
    VariantArray,
)]
pub enum Permission {
    /// Accept (pay out) a requested bank withdrawal. Officer-or-above today.
    #[strum(serialize = "bank.withdraw.accept")]
    BankWithdrawAccept,
    /// View another user's bank balance / transactions. Admin-only today.
    #[strum(serialize = "bank.view_others")]
    BankViewOthers,
    /// Create / edit participants / close out a loot split. Officer-or-above today.
    #[strum(serialize = "splits.manage")]
    SplitsManage,
    /// Create, rename, and delete the island/tab catalog used when locating a split. Admin-only.
    #[strum(serialize = "splits.islands.manage")]
    SplitsIslandsManage,
    /// Create a user via the admin endpoint. Admin-only today.
    #[strum(serialize = "users.create")]
    UsersCreate,
    /// Reload the in-memory permission cache after a DB change. Admin-only.
    #[strum(serialize = "permissions.reload")]
    PermissionsReload,
    /// Create, update, link, and delete gestionale roles. Distinct from editing the matrix.
    #[strum(serialize = "roles.manage")]
    RolesManage,
    /// Manage build categories (create, edit, delete).
    #[strum(serialize = "comps.build_categories.manage")]
    CompsBuildCategoriesManage,
    /// Manage comp categories (create, edit, delete).
    #[strum(serialize = "comps.comp_categories.manage")]
    CompsCompCategoriesManage,
    /// Manage builds (create, edit, delete).
    #[strum(serialize = "comps.builds.manage")]
    CompsBuildsManage,
    /// Manage comps (create, edit, delete).
    #[strum(serialize = "comps.comps.manage")]
    CompsCompsManage,
    /// Manage events (create, edit, delete).
    #[strum(serialize = "events.manage")]
    EventsManage,
    /// Import siphoned energy ledger rows from the Albion export. Moderator-or-above today.
    #[strum(serialize = "siphoned.ingest")]
    SiphonedIngest,
    /// View the siphoned energy ledger / per-player balances. User-or-above today.
    #[strum(serialize = "siphoned.view")]
    SiphonedView,
    /// View audit logs
    #[strum(serialize = "audit.view")]
    AuditView,
    /// View the regear queue (own deaths by default; officer queue with adjudicate). Member+.
    #[strum(serialize = "regear.view")]
    RegearView,
    /// Request a regear for one of the caller's deaths. Member+.
    #[strum(serialize = "regear.request")]
    RegearRequest,
    /// Accept or reject a pending regear request. Officer+.
    #[strum(serialize = "regear.adjudicate")]
    RegearAdjudicate,
    /// Update guild-wide regear settings (caps, slot mask, pricing). Admin+.
    #[strum(serialize = "regear.settings.manage")]
    RegearSettingsManage,
    /// View scouted enemy comps, similarity scores and matchup tallies. Member+.
    #[strum(serialize = "intel.view")]
    IntelView,
    /// Create / edit / merge / archive scouted comps and trigger manual scouting. Officer+.
    #[strum(serialize = "intel.manage")]
    IntelManage,
    /// View the full guild report aggregate (silver flows, attendance, leaderboards). Officer+.
    #[strum(serialize = "intel.report.view")]
    IntelReportView,
    /// View and edit the guild's Discord integration settings (channel/role IDs), moved off
    /// deployment env vars so an admin can change them without a redeploy. Admin-only.
    #[strum(serialize = "admin.settings.manage")]
    AdminSettingsManage,
    /// Configure the role assigned automatically to human members joining Discord. Admin-only by default.
    #[strum(serialize = "autorole.manage")]
    AutoroleManage,
    /// View own season XP / level / rank and the guild XP leaderboard. Member+.
    #[strum(serialize = "progression.view")]
    ProgressionView,
    /// Edit the XP curve, rates, warn threshold, and seasons. Admin+.
    #[strum(serialize = "progression.settings.manage")]
    ProgressionSettingsManage,
    /// Add/set another member's XP, level, or multiplier. Officer+.
    #[strum(serialize = "progression.adjust")]
    ProgressionAdjust,
    /// View the guild warn register. Officer+.
    #[strum(serialize = "warns.view")]
    WarnsView,
    /// Issue or revoke a warn. Officer+.
    #[strum(serialize = "warns.issue")]
    WarnsIssue,
    /// Claim a VOD review for XP. Member+.
    #[strum(serialize = "vod.submit")]
    VodSubmit,
    /// Compose a guild-wide in-app announcement. Officer+ today.
    #[strum(serialize = "notifications.broadcast")]
    NotificationsBroadcast,
}

impl Permission {
    /// Stable string key persisted in `role_permissions.permission`.
    ///
    /// Backed by `strum::AsRefStr`. Never rename existing values — they are
    /// part of the data contract with the DB rows.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        self.into()
    }

    /// Parse a permission string coming from the database.
    ///
    /// Returns `None` for unknown strings (e.g. a permission removed from code
    /// but still present in a stale DB row) — callers should skip such entries
    /// rather than failing the whole cache load.
    ///
    /// Backed by `strum::EnumString` (which gives `FromStr`); we wrap the
    /// `Result` into the `Option` signature the cache loader expects.
    #[must_use]
    pub fn from_str(s: &str) -> Option<Self> {
        s.parse().ok()
    }

    /// Every known permission. Used to seed the Admin role with full access.
    ///
    /// Backed by `strum::VariantArray` — automatically tracks new variants,
    /// so adding one can never leave Admin without it.
    pub fn all() -> &'static [Permission] {
        Self::VARIANTS
    }

    /// Metadata for UI grouping. Derived from the stable key (`resource.action…`).
    #[must_use]
    pub fn info(self) -> PermissionInfo {
        let key = self.as_str();
        let (resource, action) = key.split_once('.').unwrap_or((key, ""));
        PermissionInfo {
            key,
            resource,
            action,
        }
    }

    /// Catalog of every known permission. New enum variants appear here automatically.
    #[must_use]
    pub fn catalog() -> Vec<PermissionInfo> {
        Self::all().iter().copied().map(Self::info).collect()
    }
}

/// Grouping metadata for a [`Permission`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PermissionInfo {
    /// Stable key stored in `role_permissions.permission`.
    pub key: &'static str,
    /// First segment of the key (`bank`, `regear`, `roles`, …).
    pub resource: &'static str,
    /// Remainder of the key (`withdraw.accept`, `manage`, …).
    pub action: &'static str,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn as_str_and_from_str_roundtrip() {
        for perm in Permission::all() {
            let s = perm.as_str();
            assert_eq!(
                Permission::from_str(s),
                Some(*perm),
                "roundtrip failed for {s}"
            );
        }
    }

    #[test]
    fn from_str_rejects_unknown() {
        assert_eq!(Permission::from_str("nope.does.not.exist"), None);
    }

    #[test]
    fn all_contains_every_variant() {
        assert_eq!(Permission::all().len(), 31);
    }

    #[test]
    fn catalog_covers_every_variant_and_splits_resource() {
        let catalog = Permission::catalog();
        assert_eq!(catalog.len(), Permission::all().len());
        for (perm, info) in Permission::all().iter().zip(catalog.iter()) {
            assert_eq!(info.key, perm.as_str());
            assert!(!info.resource.is_empty());
            assert_eq!(format!("{}.{}", info.resource, info.action), info.key);
            assert_eq!(Permission::from_str(info.key), Some(*perm));
        }
    }
}
