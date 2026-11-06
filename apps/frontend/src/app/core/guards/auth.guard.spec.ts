import { TestBed } from '@angular/core/testing';
import { convertToParamMap, provideRouter, Router, UrlTree } from '@angular/router';
import { describe, expect, it } from 'vitest';

import { AuthService } from '../services/auth.service';
import {
  permissionGuard,
  permissionGuardTo,
  platformGuard,
  redirectIfAuthenticatedGuard,
  tenantGuard,
} from './auth.guard';

class AuthStub {
  permissions: string[] = [];

  hasPermission(permission: string): boolean {
    return this.permissions.includes(permission);
  }
}

describe('permissionGuardTo', () => {
  it('allows a session that holds any listed permission', async () => {
    const auth = new AuthStub();
    auth.permissions = ['autorole.manage'];
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: AuthService, useValue: auth }],
    });

    const guard = permissionGuardTo('/admin', 'roles.manage', 'autorole.manage');
    const result = TestBed.runInInjectionContext(() =>
      guard({} as never, {} as never),
    );
    expect(result).toBe(true);
  });

  it('redirects to the given path when no listed permission is present', async () => {
    const auth = new AuthStub();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: AuthService, useValue: auth }],
    });
    const router = TestBed.inject(Router);

    const guard = permissionGuardTo('/admin', 'roles.manage');
    const result = TestBed.runInInjectionContext(() =>
      guard({} as never, {} as never),
    );
    expect(result).toBeInstanceOf(UrlTree);
    expect(router.serializeUrl(result as UrlTree)).toBe('/admin');
  });

  it('permissionGuard still falls back to the dashboard', async () => {
    const auth = new AuthStub();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: AuthService, useValue: auth }],
    });
    const router = TestBed.inject(Router);

    const guard = permissionGuard('roles.manage');
    const result = TestBed.runInInjectionContext(() =>
      guard({} as never, {} as never),
    );
    expect(router.serializeUrl(result as UrlTree)).toBe('/dashboard');
  });
});

describe('platformGuard', () => {
  it('allows a platform admin', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: AuthService, useValue: { profile: () => ({ is_platform_admin: true }) } },
      ],
    });
    const result = TestBed.runInInjectionContext(() =>
      platformGuard({} as never, {} as never),
    );
    expect(result).toBe(true);
  });

  it('redirects everyone else away from the platform console', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        {
          provide: AuthService,
          useValue: { profile: () => ({ is_platform_admin: false, tenant_id: null }) },
        },
      ],
    });
    const router = TestBed.inject(Router);
    const result = TestBed.runInInjectionContext(() =>
      platformGuard({} as never, {} as never),
    );
    expect(router.serializeUrl(result as UrlTree)).toBe('/needs-tenant');
  });
});

describe('tenantGuard', () => {
  it('allows a session pinned to a registered tenant', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        {
          provide: AuthService,
          useValue: {
            profile: () => ({ tenant_id: '111' }),
            load: async () => ({ tenant_id: '111' }),
            sessionUnreachable: () => false,
          },
        },
      ],
    });
    const result = await TestBed.runInInjectionContext(() =>
      tenantGuard({} as never, {} as never),
    );
    expect(result).toBe(true);
  });

  it('blocks the guild app when no tenant is registered', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        {
          provide: AuthService,
          useValue: {
            profile: () => ({ tenant_id: null }),
            load: async () => ({ tenant_id: null }),
            sessionUnreachable: () => false,
          },
        },
      ],
    });
    const router = TestBed.inject(Router);
    const result = await TestBed.runInInjectionContext(() =>
      tenantGuard({} as never, {} as never),
    );
    expect(router.serializeUrl(result as UrlTree)).toBe('/needs-tenant');
  });
});

describe('redirectIfAuthenticatedGuard', () => {
  async function run(next: string | null) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        {
          provide: AuthService,
          useValue: {
            isAuthenticated: () => true,
            profile: () => ({ tenant_id: '111' }),
            load: async () => ({ tenant_id: '111' }),
          },
        },
      ],
    });
    const router = TestBed.inject(Router);
    const route = {
      queryParamMap: convertToParamMap(next === null ? {} : { next }),
    };
    const result = await TestBed.runInInjectionContext(() =>
      redirectIfAuthenticatedGuard(route as never, {} as never),
    );
    return router.serializeUrl(result as UrlTree);
  }

  it('honours a same-origin next', async () => {
    expect(await run('/events/12')).toBe('/events/12');
  });

  it.each(['//evil.example', '/\\evil.example'])(
    'does not follow an off-origin next (%s) and falls back to the dashboard',
    async (next) => {
      expect(await run(next)).toBe('/dashboard');
    },
  );
});
