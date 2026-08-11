import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

import { AuthService } from '../services/auth.service';
import type { Role } from '../models/api.models';

/**
 * Route guard ensuring the user is authenticated.
 *
 * Probes the session via `AuthService.load()` (idempotent — caches the result
 * in the service) and redirects to `/login` if no session exists.
 */
export const authGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  if (auth.isAuthenticated()) {
    return true;
  }

  const profile = await auth.load();
  if (profile) {
    return true;
  }

  return router.createUrlTree(['/login']);
};

const ELEVATED_ROLES: ReadonlyArray<Role> = ['Officer', 'Admin', 'SuperAdmin'];

/**
 * Role-restricted guard. Use with `authGuard` (apply both — this only checks
 * the role, not whether the user is signed in).
 *
 * @example
 * `{ path: 'admin', canActivate: [authGuard, roleGuard('Admin', 'SuperAdmin')] }`
 */
export const roleGuard =
  (...roles: Array<Exclude<Role, 'User'>>): CanActivateFn =>
  () => {
    const auth = inject(AuthService);
    const router = inject(Router);
    const allowedRoles = roles.filter((role): role is Exclude<Role, 'User'> =>
      ELEVATED_ROLES.includes(role),
    );

    if (auth.hasRole(...allowedRoles)) {
      return true;
    }

    return router.createUrlTree(['/dashboard']);
  };
