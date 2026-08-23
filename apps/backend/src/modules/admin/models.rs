//! Request and response types for the admin module.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// One role and the permissions currently granted to it.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct RolePermissionsView {
    /// Discord role id, the primary key of `roles`.
    pub role_id: String,
    /// Human-readable role name.
    pub role_name: String,
    /// Ordering weight; higher wins when a member holds several roles.
    pub priority: i32,
    /// Permission keys granted to this role.
    pub permissions: Vec<String>,
}

/// The whole authorization matrix, plus the full set of assignable keys.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PermissionMatrix {
    /// Every role known to the system, highest priority first.
    pub roles: Vec<RolePermissionsView>,
    /// Every permission the backend can gate on, so the UI can render the
    /// full grid rather than only what happens to be granted today.
    pub available_permissions: Vec<String>,
}

/// Request body to replace one role's permission set.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct UpdateRolePermissionsRequest {
    /// The complete set of permissions the role should end up with.
    ///
    /// This is a replacement, not a patch: sending the full set makes the
    /// outcome independent of what was there before, so two officers editing
    /// the same role cannot interleave into a state neither intended.
    pub permissions: Vec<String>,
}
