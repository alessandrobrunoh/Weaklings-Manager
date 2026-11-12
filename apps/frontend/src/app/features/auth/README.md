# Authentication pages

## Overview

This directory contains the public login page, post-OAuth server selection, the no-server guild list, the blocked-access screen and the first-time tenant registration wizard.

All five pages share one layout (`auth-layout.styles.ts`): a centred card at one width, with the brand mark and product name, one page title, one line of helper text, the content, and a footer row of actions that holds at most one primary button. The layout works at 390px without horizontal page scroll.

## Interface

- `Login` provides Discord login plus theme/language controls and a `no_tenant` alert. Its primary action is "Continue with Discord"; a `session_unreachable` error adds an outline retry.
- `ChooseServer` lists the pending tenants as one row each. Choosing a row calls `selectTenant` and opens `/dashboard`. With no pending tenants it shows an empty state and the Discord sign-in.
- `NeedsTenant` lists the Discord servers the user can register, one row each. With no servers the bot invite becomes the primary action. A failed load shows an error with retry, never the empty copy.
- `Blocked` (public route `/blocked`) tells a member an officer blocked their access, with "Check again" (primary) and "Sign out". The officer's reason is never shown. It is reached from the OAuth callback redirect, from `authGuard` / `tenantGuard` (when `AuthService.accessBlocked()` is set) and from `accessBlockedInterceptor` (a `403` with problem code `account_blocked` on a live session).
- `RegisterTenant` presents a three-step wizard (name and kind, Albion guild or alliance, review) with a "Step n of 3" progress line. Alliance registration picks an Albion alliance and then the member guilds.

## Invariants

- Login accepts `next` only when it begins with `/`; otherwise routing depends on whether the profile has a tenant.
- Tenant kind is `guild` or `alliance`; region is `europe`, `americas`, or `asia`. The region label is shown on the review step, not the raw id.
- Server selection calls `selectTenant` and navigates to `/dashboard` on success.
- Registration failures show `register.submitFailed`; the API error text is never shown.
- Picked search results are exposed with `aria-pressed`; the chosen region drops any picked guild or alliance.

## Side Effects

The pages call authentication and API services, navigate between login/onboarding routes, and show toasts. The login action starts OAuth; logout uses a full-page navigation to `/login`.

## Verification

Run `npm test --prefix apps/frontend` from the repository root. The specs cover the no-server page's error and retry path, the chooser rows and selection, and the blocked page's still-blocked and unblocked paths. The registration submit-failure path is not covered by a spec.
