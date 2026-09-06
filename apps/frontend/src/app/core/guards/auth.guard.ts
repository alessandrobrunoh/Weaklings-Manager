import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

import { AuthService } from '../services/auth.service';


/**
 * Route guard ensuring the user is authenticated.
 *
 * Probes the session via `AuthService.load()` (idempotent — caches the result
 * in the service) and redirects to `/login` if no session exists.
 */
export const authGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  if (auth.isAuthenticated()) {
    return true;
  }

  const profile = await auth.load();
  if (profile) {
    return true;
  }

  return router.createUrlTree(['/login'], { queryParams: { next: state.url } });
};

/**
 * Route guard for the public `/login` page.
 *
 * Probes the session (same as `authGuard`) and redirects straight to
 * `/dashboard` when a valid session already exists, so an already-logged-in
 * user never sees the login screen — e.g. when hitting `/login` directly in
 * a new tab, where the synchronous `isAuthenticated` signal hasn't been
 * populated yet.
 */
export const redirectIfAuthenticatedGuard: CanActivateFn = async (route) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const next = route.queryParamMap.get('next');
  const destination = next && next.startsWith('/') ? next : null;

  const sendHome = (profile: { tenant_id?: string | null; is_platform_admin?: boolean } | null) => {
    if (destination) {
      return router.parseUrl(destination);
    }
    if (profile?.tenant_id) {
      return router.parseUrl('/dashboard');
    }
    return router.parseUrl('/needs-tenant');
  };

  if (auth.isAuthenticated()) {
    return sendHome(auth.profile());
  }

  const profile = await auth.load();
  if (profile) {
    return sendHome(profile);
  }

  return true;
};

/**
 * Blocks the guild app until the session is pinned to a registered tenant.
 */
export const tenantGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const profile = auth.profile() ?? (await auth.load());
  if (profile?.tenant_id) {
    return true;
  }
  return router.createUrlTree(['/needs-tenant']);
};

/**
 * Permission-restricted guard. Use with `authGuard`. Any listed key is enough (OR).
 * Missing permission sends the user to `redirectPath`.
 *
 * @example
 * `{ path: 'admin', canActivate: [authGuard, permissionGuard('roles.manage', 'permissions.reload')] }`
 */
export const permissionGuardTo =
  (redirectPath: string, ...keys: string[]): CanActivateFn =>
  () => {
    const auth = inject(AuthService);
    const router = inject(Router);

    if (keys.some((key) => auth.hasPermission(key))) {
      return true;
    }

    return router.createUrlTree([redirectPath]);
  };

/** Same as `permissionGuardTo('/dashboard', ...)`. */
export const permissionGuard = (...keys: string[]): CanActivateFn =>
  permissionGuardTo('/dashboard', ...keys);

/**
 * Control-plane guard. Use with `authGuard`. Missing platform role
 * sends the user to `/dashboard`.
 */
export const platformGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  if (auth.profile()?.is_platform_admin) {
    return true;
  }

  if (auth.profile()?.tenant_id) {
    return router.createUrlTree(['/dashboard']);
  }
  return router.createUrlTree(['/needs-tenant']);
};
