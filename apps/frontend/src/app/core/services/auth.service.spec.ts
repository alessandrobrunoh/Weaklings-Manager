import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, ApiService } from './api.service';
import { AuthService } from './auth.service';

const profile = {
  id: 'u1',
  username: 'ada',
  tenant_id: 'g1',
} as never;

describe('AuthService session probe', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('keeps the last profile when /auth/me fails for a non-auth reason', async () => {
    const get = vi
      .fn()
      .mockReturnValueOnce(of(profile))
      .mockReturnValueOnce(throwError(() => new ApiError(503, 'down')));
    TestBed.configureTestingModule({
      providers: [{ provide: ApiService, useValue: { get, post: vi.fn() } }],
    });
    const auth = TestBed.inject(AuthService);

    await auth.load();
    const again = await auth.load();

    expect(again).toBe(profile);
    expect(auth.isAuthenticated()).toBe(true);
    expect(auth.sessionUnreachable()).toBe(true);
  });

  it('clears the profile on 401', async () => {
    const get = vi
      .fn()
      .mockReturnValueOnce(of(profile))
      .mockReturnValueOnce(throwError(() => new ApiError(401, 'nope')));
    TestBed.configureTestingModule({
      providers: [{ provide: ApiService, useValue: { get, post: vi.fn() } }],
    });
    const auth = TestBed.inject(AuthService);

    await auth.load();
    const again = await auth.load();

    expect(again).toBeNull();
    expect(auth.isAuthenticated()).toBe(false);
    expect(auth.sessionUnreachable()).toBe(false);
  });

  it('does not drop local state when logout fails', async () => {
    const post = vi.fn().mockReturnValue(throwError(() => new ApiError(500, 'nope')));
    TestBed.configureTestingModule({
      providers: [
        {
          provide: ApiService,
          useValue: { get: vi.fn().mockReturnValue(of(profile)), post },
        },
      ],
    });
    const auth = TestBed.inject(AuthService);
    await auth.load();

    await expect(auth.logout()).rejects.toBeInstanceOf(ApiError);
    expect(auth.profile()).toBe(profile);
    expect(auth.isAuthenticated()).toBe(true);
  });

  it('clears local state after a successful logout', async () => {
    const post = vi.fn().mockReturnValue(of(undefined));
    TestBed.configureTestingModule({
      providers: [
        {
          provide: ApiService,
          useValue: { get: vi.fn().mockReturnValue(of(profile)), post },
        },
      ],
    });
    const auth = TestBed.inject(AuthService);
    await auth.load();

    await auth.logout();

    expect(auth.profile()).toBeNull();
    expect(post).toHaveBeenCalledWith('api/auth/logout', null);
  });
});
