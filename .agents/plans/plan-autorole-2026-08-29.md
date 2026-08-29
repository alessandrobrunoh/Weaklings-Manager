# Plan: Discord AutoRole

**Status**: Implementing

## Goal

Allow an authorized administrator to select one Discord role in the web admin panel and have the bot assign it automatically to human members when they join the configured guild.

## Acceptance Criteria

- `autorole.manage` is a distinct permission granted to `Admin` by migration.
- Authorized admins can choose or clear one real, assignable Discord role from the admin panel.
- Human members receive the configured role on `GuildMemberAdd`; bots and existing members are unaffected.
- Missing roles, hierarchy problems, missing `Manage Roles`, and Discord API failures are logged without crashing the bot.
- Backend and frontend type/build checks pass.

## Implementation Slices

1. Add the persisted setting, permission, role-list/configuration endpoints, validation, audit event, and OpenAPI models.
2. Add the admin-panel role selector with loading, disabled-role, save, clear, and error states.
3. Add the `GuildMembers` intent and non-fatal member-join assignment flow in the bot.

## Assumptions

- The configured `DISCORD_GUILD_ID` is the only supported guild.
- The backend uses the existing optional `DISCORD_BOT_TOKEN` to retrieve and validate roles.
- Only one AutoRole is supported; clearing it sends an empty string.
