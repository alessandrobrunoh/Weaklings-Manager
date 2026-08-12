//! Fine-grained permissions used by route handlers to authorize requests.
//!
//! A `Permission` is an atomic capability (e.g. "accept a bank withdrawal")
//! attached to a route via the [`Require`](super::extractors::Require) extractor.
//! Roles are mapped to one or more permissions through the `role_permissions`
//! database table, so changing "who can do what" is a data edit — not a redeploy.

use serde::{Deserialize, Serialize};
use strum::{AsRefStr, EnumString, VariantArray};

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
    /// Create a user via the admin endpoint. Admin-only today.
    #[strum(serialize = "users.create")]
    UsersCreate,
    /// Reload the in-memory permission cache after a DB change. Admin-only.
    #[strum(serialize = "permissions.reload")]
    PermissionsReload,
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
}

impl Permission {
    /// Stable string key persisted in `role_permissions.permission`.
    ///
    /// Backed by `strum::AsRefStr`. Never rename existing values — they are
    /// part of the data contract with the DB rows.
    #[must_use]
    pub fn as_str(&self) -> &str {
        self.as_ref()
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
        assert_eq!(Permission::all().len(), 13);
    }
}
