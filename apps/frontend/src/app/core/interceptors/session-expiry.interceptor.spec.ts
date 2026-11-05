import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { API_BASE_URL } from '../tokens/api-base.token';
import { AuthService } from '../services/auth.service';
import { ToastService } from '../services/toast.service';
import { TranslateService } from '../services/translate.service';
import { sessionExpiryInterceptor } from './session-expiry.interceptor';

describe('sessionExpiryInterceptor', () => {
  let profile: { tenant_id: string } | null;
  let auth: { profile: () => unknown; setProfile: ReturnType<typeof vi.fn> };
  let router: { url: string; navigate: ReturnType<typeof vi.fn> };
  let toasts: { error: ReturnType<typeof vi.fn> };
  let http: HttpClient;
  let controller: HttpTestingController;

  beforeEach(() => {
    profile = { tenant_id: '111' };
    auth = {
      profile: () => profile,
      setProfile: vi.fn((next: typeof profile) => {
        profile = next;
      }),
    };
    router = { url: '/events/5?tab=roster', navigate: vi.fn().mockResolvedValue(true) };
    toasts = { error: vi.fn() };

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([sessionExpiryInterceptor])),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: 'https://api.example.test' },
        { provide: AuthService, useValue: auth },
        { provide: Router, useValue: router },
        { provide: ToastService, useValue: toasts },
        { provide: TranslateService, useValue: { t: (key: string) => key } },
      ],
    });
    http = TestBed.inject(HttpClient);
    controller = TestBed.inject(HttpTestingController);
  });

  function fail(url: string, status: number, detail = 'No active session'): { error: unknown } {
    const seen: { error: unknown } = { error: null };
    http.get(url).subscribe({ error: (err) => (seen.error = err) });
    controller.expectOne(url).flush({ detail }, { status, statusText: 'err' });
    return seen;
  }

  it('signs the user out and redirects to /login with next on a 401 from the API', () => {
    const seen = fail('https://api.example.test/api/events', 401);

    expect(auth.setProfile).toHaveBeenCalledWith(null);
    expect(toasts.error).toHaveBeenCalledWith('auth.session_expired');
    expect(router.navigate).toHaveBeenCalledWith(['/login'], {
      queryParams: { next: '/events/5?tab=roster' },
    });
    // The error still reaches the caller.
    expect(seen.error).not.toBeNull();
  });

  it('also treats a same-origin relative API path as a backend call', () => {
    fail('/api/events', 401);
    expect(auth.setProfile).toHaveBeenCalledWith(null);
  });

  it('does not loop: a second 401 after sign-out is ignored', () => {
    fail('https://api.example.test/api/events', 401);
    fail('https://api.example.test/api/notifications/unread-count', 401);

    expect(auth.setProfile).toHaveBeenCalledTimes(1);
    expect(router.navigate).toHaveBeenCalledTimes(1);
  });

  it('leaves the auth endpoints to AuthService', () => {
    fail('https://api.example.test/api/auth/me', 401);
    expect(auth.setProfile).not.toHaveBeenCalled();
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('does not sign out on 403 or 5xx', () => {
    fail('https://api.example.test/api/events', 403);
    fail('https://api.example.test/api/events', 500);
    expect(auth.setProfile).not.toHaveBeenCalled();
  });

  it('keeps the session on a 401 that is not about a missing session', () => {
    fail(
      'https://api.example.test/api/giveaways',
      401,
      'giveaways can only be created by a linked user',
    );
    expect(auth.setProfile).not.toHaveBeenCalled();
    expect(router.navigate).not.toHaveBeenCalled();
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it('signs out on an invalid session cookie too', () => {
    fail('https://api.example.test/api/events', 401, 'Invalid session cookie format');
    expect(auth.setProfile).toHaveBeenCalledWith(null);
  });

  it('ignores third-party hosts', () => {
    fail('https://other.example.test/api/events', 401);
    expect(auth.setProfile).not.toHaveBeenCalled();
  });

  it('does nothing when nobody is signed in', () => {
    profile = null;
    fail('https://api.example.test/api/events', 401);
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('does not add next when already on the login page', () => {
    router.url = '/login?next=%2Fevents';
    fail('https://api.example.test/api/events', 401);
    expect(router.navigate).toHaveBeenCalledWith(['/login'], { queryParams: {} });
  });
});
