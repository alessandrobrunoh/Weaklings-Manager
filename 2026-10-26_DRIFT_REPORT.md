## README.md

- The frontend stack is described as Angular SSR with Express and as running on port 4200, with `FRONTEND_URL` defaulting to `http://localhost:3001`. The current frontend is Vite/Analog SSR, Vite's default development port is 5173, and the backend's configured `FRONTEND_URL` default is `http://localhost:5173` ([frontend Vite config](apps/frontend/vite.config.ts#L57-L75), [backend config](apps/backend/src/config.rs#L61-L63)).
- The setup block categorizes `MISTRAL_API_KEY` as an optional feature, but backend startup deserializes it as a required `String` and calls `Config::from_env`; without the variable, configuration loading fails ([backend config field](apps/backend/src/config.rs#L75-L76), [config loader](apps/backend/src/config.rs#L165-L174)).
- The Audit & Observability feature still presents `DISCORD_AUDIT_LOG_CHANNEL_ID` as the audit-notification setting. Runtime audit notification routing reads `discord_audit_log_channel_id` from `guild_settings`; the environment variable is only read by the migration that imports legacy values ([audit service](apps/backend/src/modules/audit/service.rs#L192-L195), [legacy migration](apps/backend/src/migration/m20260825_000001_create_guild_settings.rs#L64-L67)).
- The split lifecycle list omits `awaiting_event`, which is an active `SplitStatus` accepted and serialized by the backend ([split status](apps/backend/src/modules/splits/status.rs#L16-L38)).
- The architecture paragraph's enumerated `/api` module list is incomplete: the current router also mounts routes including `applications`, `tickets`, `attention`, `enemies`, `fingerprints`, `economy`, `combat`, `fights`, `giveaways`, `regear`, `alliance`, `progression`, `vods`, `warns`, and `notifications` ([module router](apps/backend/src/modules/mod.rs#L46-L80)).
- The bot is described as a 1:1 mirror of web-app functionality. Its registered command map exposes a selected set of 26 commands, not the web application's full feature surface ([bot command registry](apps/discord-bot/src/commands/index.ts#L43-L74)).

## apps/backend/README.md

No drift detected.

## apps/discord-bot/README.md

- The opening description claims the bot mirrors web-app functionality “1:1”, but its command registry exposes a selected set of 26 commands and does not cover the full frontend feature surface ([command registry](apps/discord-bot/src/commands/index.ts#L43-L74)).

## apps/frontend/README.md

No drift detected.

## apps/README.md

No drift detected.

## apps/backend/src/README.md

No drift detected.

## apps/backend/src/control_migration/README.md

No drift detected.

## apps/backend/src/event_sessions/README.md

No drift detected.

## apps/backend/src/migration/README.md

No drift detected.

## apps/backend/src/modules/README.md

No drift detected.

## apps/backend/src/modules/admin/README.md

No drift detected.

## apps/backend/src/modules/albion/README.md

No drift detected.

## apps/backend/src/modules/albionbb/README.md

No drift detected.

## apps/backend/src/modules/albiondata/README.md

No drift detected.

## apps/backend/src/modules/alliance_share/README.md

No drift detected.

## apps/backend/src/modules/applications/README.md

No drift detected.

## apps/backend/src/modules/attention/README.md

No drift detected.

## apps/backend/src/modules/audit/README.md

No drift detected.

## apps/backend/src/modules/auth/README.md

No drift detected.

## apps/backend/src/modules/bank/README.md

No drift detected.

## apps/backend/src/modules/battles/README.md

No drift detected.

## apps/backend/src/modules/combat/README.md

No drift detected.

## apps/backend/src/modules/comps/README.md

- The README advertises build/comp versioning, but the backend test run currently fails the contract for listing all build versions and for renaming all versions in a group. The version lookup filters by `(category_id, created_by, identity_key(name))`, which excludes a sibling created under a different creator and leaves the version-list/rename behavior short of the documented versioning surface ([version-group lookup](apps/backend/src/modules/comps/service.rs#L281-L303), [version listing test](apps/backend/src/modules/comps/service.rs#L3344-L3362), [group rename test](apps/backend/src/modules/comps/service.rs#L3396-L3425)).

## apps/backend/src/modules/economy/README.md

No drift detected.

## apps/backend/src/modules/enemies/README.md

No drift detected.

## apps/backend/src/modules/events/README.md

No drift detected.

## apps/backend/src/modules/fight_analytics/README.md

No drift detected.

## apps/backend/src/modules/fingerprints/README.md

No drift detected.

## apps/backend/src/modules/giveaways/README.md

No drift detected.

## apps/backend/src/modules/health/README.md

No drift detected.

## apps/backend/src/modules/intel/README.md

No drift detected.

## apps/backend/src/modules/notifications/README.md

No drift detected.

## apps/backend/src/modules/openalbion/README.md

No drift detected.

## apps/backend/src/modules/platform/README.md

No drift detected.

## apps/backend/src/modules/progression/README.md

No drift detected.

## apps/backend/src/modules/regear/README.md

No drift detected.

## apps/backend/src/modules/siphoned/README.md

No drift detected.

## apps/backend/src/modules/splits/README.md

No drift detected.

## apps/backend/src/modules/tickets/README.md

No drift detected.

## apps/backend/src/modules/trials/README.md

No drift detected.

## apps/backend/src/modules/users/README.md

No drift detected.

## apps/backend/src/modules/utils/README.md

No drift detected.

## apps/backend/src/modules/vods/README.md

No drift detected.

## apps/backend/src/modules/warns/README.md

No drift detected.

## apps/discord-bot/src/README.md

No drift detected.

## apps/discord-bot/src/api/README.md

No drift detected.

## apps/discord-bot/src/commands/README.md

No drift detected.

## apps/discord-bot/src/embeds/README.md

No drift detected.

## apps/discord-bot/src/handlers/README.md

No drift detected.

## apps/discord-bot/src/services/README.md

No drift detected.

## apps/frontend/src/README.md

No drift detected.

## apps/frontend/src/app/README.md

No drift detected.

## apps/frontend/src/app/core/README.md

No drift detected.

## apps/frontend/src/app/core/guards/README.md

No drift detected.

## apps/frontend/src/app/core/models/README.md

No drift detected.

## apps/frontend/src/app/core/services/README.md

No drift detected.

## apps/frontend/src/app/core/tokens/README.md

No drift detected.

## apps/frontend/src/app/features/README.md

No drift detected.

## apps/frontend/src/app/features/admin/README.md

No drift detected.

## apps/frontend/src/app/features/albion-settings/README.md

No drift detected.

## apps/frontend/src/app/features/audit/README.md

No drift detected.

## apps/frontend/src/app/features/auth/README.md

No drift detected.

## apps/frontend/src/app/features/bank/README.md

No drift detected.

## apps/frontend/src/app/features/battles/README.md

No drift detected.

## apps/frontend/src/app/features/comps/README.md

No drift detected.

## apps/frontend/src/app/features/dashboard/README.md

No drift detected.

## apps/frontend/src/app/features/events/README.md

No drift detected.

## apps/frontend/src/app/features/fights/README.md

No drift detected.

## apps/frontend/src/app/features/guild/README.md

No drift detected.

## apps/frontend/src/app/features/intel/README.md

No drift detected.

## apps/frontend/src/app/features/leaderboards/README.md

No drift detected.

## apps/frontend/src/app/features/onboarding/README.md

No drift detected.

## apps/frontend/src/app/features/platform/README.md

No drift detected.

## apps/frontend/src/app/features/regears/README.md

No drift detected.

## apps/frontend/src/app/features/settings/README.md

No drift detected.

## apps/frontend/src/app/features/siphoned/README.md

No drift detected.

## apps/frontend/src/app/features/splits/README.md

No drift detected.

## apps/frontend/src/app/features/tests/README.md

No drift detected.

## apps/frontend/src/app/features/tests/timeline/README.md

No drift detected.

## apps/frontend/src/app/features/users/README.md

No drift detected.

## apps/frontend/src/app/features/warns/README.md

No drift detected.

## apps/frontend/src/app/i18n/README.md

No drift detected.

## apps/frontend/src/app/layout/README.md

No drift detected.

## apps/frontend/src/app/layout/shell/README.md

No drift detected.

## apps/frontend/src/app/layout/sidebar/README.md

No drift detected.

## apps/frontend/src/app/layout/tenant-rail/README.md

No drift detected.

## apps/frontend/src/app/layout/topbar/README.md

No drift detected.

## apps/frontend/src/app/shared/README.md

No drift detected.

## apps/frontend/src/app/shared/charts/README.md

No drift detected.

## apps/frontend/src/app/shared/components/README.md

No drift detected.

## apps/frontend/src/app/shared/components/ability-bar/README.md

No drift detected.

## apps/frontend/src/app/shared/components/albion-link-gate/README.md

No drift detected.

## apps/frontend/src/app/shared/components/avatar/README.md

No drift detected.

## apps/frontend/src/app/shared/components/chart/README.md

No drift detected.

## apps/frontend/src/app/shared/components/data-table/README.md

No drift detected.

## apps/frontend/src/app/shared/components/destiny-board/README.md

No drift detected.

## apps/frontend/src/app/shared/components/dialog/README.md

No drift detected.

## apps/frontend/src/app/shared/components/empty-state/README.md

No drift detected.

## apps/frontend/src/app/shared/components/equipment-grid/README.md

No drift detected.

## apps/frontend/src/app/shared/components/error-state/README.md

No drift detected.

## apps/frontend/src/app/shared/components/icon/README.md

No drift detected.

## apps/frontend/src/app/shared/components/loading/README.md

No drift detected.

## apps/frontend/src/app/shared/components/meter/README.md

No drift detected.

## apps/frontend/src/app/shared/components/ownership-scope-toggle/README.md

No drift detected.

## apps/frontend/src/app/shared/components/page-header/README.md

No drift detected.

## apps/frontend/src/app/shared/components/page-stack/README.md

No drift detected.

## apps/frontend/src/app/shared/components/search-dialog/README.md

No drift detected.

## apps/frontend/src/app/shared/components/searchable-select/README.md

No drift detected.

## apps/frontend/src/app/shared/components/stat-card/README.md

No drift detected.

## apps/frontend/src/app/shared/components/status-chip/README.md

No drift detected.

## apps/frontend/src/app/shared/components/version-diff-list/README.md

No drift detected.

## apps/frontend/src/app/shared/components/version-switcher/README.md

No drift detected.

## apps/frontend/src/app/shared/components/view-toggle/README.md

No drift detected.

## apps/frontend/src/app/shared/components/weaklings-logo/README.md

No drift detected.

## apps/frontend/src/app/shared/data/README.md

No drift detected.

## apps/frontend/src/app/shared/directives/README.md

No drift detected.

## apps/frontend/src/app/shared/discord/README.md

No drift detected.

## apps/frontend/src/app/shared/services/README.md

No drift detected.

## apps/frontend/src/app/shared/validation/README.md

No drift detected.

## apps/frontend/src/server/README.md

No drift detected.

## apps/frontend/src/server/plugins/README.md

No drift detected.

## apps/frontend/src/server/routes/README.md

No drift detected.

## apps/frontend/src/server/routes/api/README.md

No drift detected.

## apps/frontend/src/server/routes/api/events/README.md

No drift detected.

## apps/frontend/src/server/routes/api/events/[id]/README.md

No drift detected.

## apps/frontend/src/server/routes/api/events/[id]/roster/README.md

No drift detected.

## scripts/README.md

No drift detected.
