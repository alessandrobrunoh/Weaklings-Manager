# Core services

## Overview

This directory holds ten root-provided Angular services that centralize API access, authentication, domain queries, notifications, realtime rosters, branding, theme, toasts, and translations.

## Interface

- `ApiService` provides typed HTTP verbs, raw requests, and normalized `ApiError` values.
- `AuthService` exposes profile/authentication state, tenant and guild operations, login/logout, profile loading, and permission checks.
- `EnemiesService` and `IntelService` provide enemy dossiers and intelligence/report operations.
- `NotificationService` manages inbox state and notification actions; `RealtimeRosterService` manages a roster WebSocket and message stream.
- `BrandingService`, `ThemeService`, `ToastService`, and `TranslateService` provide shared presentation state and translation behavior.

## Invariants

- Each service is registered with `providedIn: 'root'`.
- Typed `ApiService` verbs unwrap the standard `{ status, data }` response; `requestRaw` does not.
- Authentication profile updates keep profile and authenticated signals synchronized. Theme preferences and locale selection use their supported finite values and fallback rules.
- Realtime roster connections validate event IDs and incoming message shapes before emitting.

## Side Effects

These services issue HTTP requests and manage browser state. Theme and language preferences use `localStorage`; branding and theme update document styles/classes; notifications poll while the page is visible; realtime roster connections open WebSockets and may retry; toast and reconnect flows schedule timers.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. The service contracts described here were read from direct implementations; backend enforcement is outside this directory.
