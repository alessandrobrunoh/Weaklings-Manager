import { PLATFORM_ID, TransferState } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, ApiService } from './api.service';
import { AuthService, SESSION_STATE_KEY } from './auth.service';

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

  it('flags a blocked member instead of reading the 403 as a plain missing session', async () => {
    const blocked = new ApiError(403, 'blocked', { code: 'account_blocked' });
    const get = vi
      .fn()
      .mockReturnValueOnce(of(profile))
      .mockReturnValueOnce(throwError(() => blocked));
    TestBed.configureTestingModule({
      providers: [{ provide: ApiService, useValue: { get, post: vi.fn() } }],
    });
    const auth = TestBed.inject(AuthService);

    await auth.load();
    expect(auth.accessBlocked()).toBe(false);
    const again = await auth.load();

    expect(again).toBeNull();
    expect(auth.isAuthenticated()).toBe(false);
    expect(auth.accessBlocked()).toBe(true);
    expect(auth.sessionUnreachable()).toBe(false);
  });

  it('a plain 403 stays a missing session, not a block', async () => {
    const get = vi.fn().mockReturnValue(throwError(() => new ApiError(403, 'nope')));
    TestBed.configureTestingModule({
      providers: [{ provide: ApiService, useValue: { get, post: vi.fn() } }],
    });
    const auth = TestBed.inject(AuthService);

    expect(await auth.load()).toBeNull();
    expect(auth.accessBlocked()).toBe(false);
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

describe('AuthService across the server render and hydration', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('reuses the session the server probed instead of probing again in the browser', async () => {
    const get = vi.fn().mockReturnValue(of(profile));
    TestBed.configureTestingModule({
      providers: [{ provide: ApiService, useValue: { get, post: vi.fn() } }],
    });
    TestBed.inject(TransferState).set(SESSION_STATE_KEY, {
      profile,
      sessionUnreachable: false,
    });
    const auth = TestBed.inject(AuthService);

    const loaded = await auth.load();

    expect(loaded).toBe(profile);
    expect(auth.isAuthenticated()).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });

  it('probes again on a later load once the transferred session has been used', async () => {
    const get = vi.fn().mockReturnValue(throwError(() => new ApiError(401, 'nope')));
    TestBed.configureTestingModule({
      providers: [{ provide: ApiService, useValue: { get, post: vi.fn() } }],
    });
    TestBed.inject(TransferState).set(SESSION_STATE_KEY, {
      profile,
      sessionUnreachable: false,
    });
    const auth = TestBed.inject(AuthService);

    await auth.load();
    const again = await auth.load();

    expect(again).toBeNull();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('probes once per server render and stores the result for the browser', async () => {
    const get = vi.fn().mockReturnValue(of(profile));
    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: 'server' },
        { provide: ApiService, useValue: { get, post: vi.fn() } },
      ],
    });
    const auth = TestBed.inject(AuthService);

    await Promise.all([auth.load(), auth.load()]);
    await auth.load();

    expect(get).toHaveBeenCalledTimes(1);
    expect(auth.isAuthenticated()).toBe(true);
    expect(TestBed.inject(TransferState).get(SESSION_STATE_KEY, null)).toEqual({
      profile,
      sessionUnreachable: false,
    });
  });

  it('carries an unreachable backend to the browser as unreachable, not as a logout', async () => {
    const get = vi.fn().mockReturnValue(throwError(() => new ApiError(0, 'down')));
    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: 'server' },
        { provide: ApiService, useValue: { get, post: vi.fn() } },
      ],
    });
    const auth = TestBed.inject(AuthService);

    await auth.load();

    expect(auth.sessionUnreachable()).toBe(true);
    expect(TestBed.inject(TransferState).get(SESSION_STATE_KEY, null)).toEqual({
      profile: null,
      sessionUnreachable: true,
    });
  });
});
