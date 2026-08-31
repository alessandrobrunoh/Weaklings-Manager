import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, UrlTree } from '@angular/router';
import { describe, expect, it } from 'vitest';

import { AuthService } from '../services/auth.service';
import { permissionGuard, permissionGuardTo } from './auth.guard';

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
