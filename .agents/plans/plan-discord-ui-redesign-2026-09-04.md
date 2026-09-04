# Discord UI Redesign Plan

## Objective
Standardize 100% of Discord messages, embeds, and interactive flows to match the aesthetic and information density of Battleboards and Event announcements.

## Scope
1. **Design System & Primitives (`embeds/theme.ts`)**:
   - Reusable horizontal ASCII bar charts (`buildAsciiBar`, `buildAsciiChart`).
   - Standardized layout helpers and consistent guild branding headers/footers.
2. **Member & Player Commands (`commands/`)**:
   - `/player`: Player lookup with PvP/PvE fame distribution chart and combat metrics.
   - `/me`: Member profile with level progress bar, bank balances, attendance.
   - `/leaderboard`: Season XP leaderboard with podium and ASCII comparison chart.
   - `/rank`: Progression card with milestone progress and active multipliers.
   - `/balance`: Vault dossier with breakdown and payout action.
   - `/roster`: Guild roster overview with column chunks and total counts.
   - `/warns`, `/warn`, `/unwarn`: Disciplinary records with escalation gauge.
   - `/vod`: VOD review card with status, reviewer claim button.
   - `/xp`: Season progression adjustment logs.
3. **Loot Splits Forum Posts (`services/split-summary.ts`, `services/split-forum.ts`)**:
   - Convert plain text split summaries into rich embeds with fee/net bar charts and payout statuses.
4. **Bank Transactions & Withdrawal Requests (`apps/backend/src/modules/audit/service.rs`)**:
   - Formatted embed for `WITHDRAW_REQUESTED` with ledger details and Approve/Reject buttons.
5. **System Audit Logs (`apps/backend/src/modules/audit/service.rs`)**:
   - Structured audit cards with severity colors, actor/target fields, and human-readable diffs.
6. **Event Signup Thread & Live Alerts (`embeds/event.embed.ts`, `handlers/button.ts`, `handlers/select.ts`)**:
   - Thread roster with role group fill bars.
   - Role and build selection prompts styled as tactical deployment cards.
7. **Applications & Recruitment (`embeds/application.embed.ts`)**:
   - Clean recruitment panel and ticket welcome cards.
