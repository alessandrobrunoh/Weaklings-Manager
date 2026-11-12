# Auth module

## Overview

Auth implements Discord OAuth2 login, session verification, permission checks, and a startup-loaded permission cache. It also supports bot-header request contexts and tenant selection.

## Interface

The application mounts this router under `/api/auth`. Local operations include Discord login/callback; pending/list/select/switch tenant; registerable guilds and bot invite; current profile; logout; and logout-all.

`UserContext` exposes `is_superadmin`, `has_permission`, and `require`. Its request extractor tries session-cookie authentication before bot-header authentication. `Permission` provides stable string parsing/catalog metadata; `PermissionCache` supplies role-based checks.

## Invariants

- OAuth callback requires matching query `state` and private `oauth_state` cookie. A unique/default tenant match may be selected automatically; otherwise the callback redirects to tenant selection, no-tenant, or safe registration flow.
- Linked roles match member Discord role IDs, sort by descending priority then name, and fall back to the default role or `"User"`.
- Bot role IDs are comma-separated, limited to 8,192 header bytes and 250 IDs, and must contain 1–20 ASCII digits; duplicates are removed.
- Permission checks grant all permissions to superadmins. The `EventsManage` role permission also grants granular event view/create/edit/delete permissions.
- The `session_user` cookie is not a credential on its own: it carries a `sid` that must match a live (not revoked, not expired, same Discord id) row in the control database's `auth_sessions` table (`session_store`). A cookie without a `sid` is rejected; there is no legacy fallback. Validation is one primary-key lookup, cached per instance for 30 s; revoking evicts the local entry, while other instances honour a revoked session for at most that 30 s. `/auth/me` slides the 7-day expiry at most once a day.
- Logout revokes the caller's session; `logout-all` revokes every session of the caller's Discord id and no one else's. Logging in over an existing cookie revokes the old session; each login purges rows expired or revoked more than a day ago.
- A member blocked by an officer (`users.blocked_at`, tenant-scoped) is refused with `403 account_blocked` everywhere: the session-cookie extractor and the bot-header extractor read the row on every request (so the 30 s session cache cannot outlive a block), `GET /auth/me` refuses it, and `finalize_session` (login, tenant select/switch) issues no session; the OAuth callback redirects the browser to `/blocked`. Platform admins and the tenant owner are exempt. Sessions are not revoked: they are shared across tenants and the block is not.
- A supplied bot secret is compared in constant time. A valid bot context without a Discord ID resolves to the `bot_system` context; with an ID, the user and linked roles are resolved.

## Side Effects

OAuth code exchange/profile lookup call Discord over HTTP. Callback handlers set/clear private cookies and redirect. `Permissions::reload` loads from the database then swaps the shared cache only on success. The current-profile handler refreshes tenant/profile/role data and may persist the highest role in session state.

## Verification

From the repository root, run `cargo test -p backend-identity`.
