import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { API_BASE_URL } from '../tokens/api-base.token';
import { AuthService } from '../services/auth.service';
import { accessBlockedInterceptor } from './access-blocked.interceptor';

describe('accessBlockedInterceptor', () => {
  let auth: { markBlocked: ReturnType<typeof vi.fn> };
  let router: { url: string; navigate: ReturnType<typeof vi.fn> };
  let http: HttpClient;
  let controller: HttpTestingController;

  beforeEach(() => {
    auth = { markBlocked: vi.fn() };
    router = { url: '/events/5', navigate: vi.fn().mockResolvedValue(true) };

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([accessBlockedInterceptor])),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: 'https://api.example.test' },
        { provide: AuthService, useValue: auth },
        { provide: Router, useValue: router },
      ],
    });
    http = TestBed.inject(HttpClient);
    controller = TestBed.inject(HttpTestingController);
  });

  function fail(url: string, status: number, body: unknown): { error: unknown } {
    const seen: { error: unknown } = { error: null };
    http.get(url).subscribe({ error: (err) => (seen.error = err) });
    controller.expectOne(url).flush(body, { status, statusText: 'err' });
    return seen;
  }

  it('sends a blocked member to /blocked on a 403 account_blocked and keeps the error', () => {
    const seen = fail('https://api.example.test/api/events', 403, { code: 'account_blocked' });

    expect(auth.markBlocked).toHaveBeenCalledTimes(1);
    expect(router.navigate).toHaveBeenCalledWith(['/blocked']);
    expect(seen.error).not.toBeNull();
  });

  it('ignores an ordinary 403', () => {
    fail('https://api.example.test/api/events', 403, { detail: 'Forbidden: nope' });

    expect(auth.markBlocked).not.toHaveBeenCalled();
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('leaves the session probe to the guards', () => {
    fail('https://api.example.test/api/auth/me', 403, { code: 'account_blocked' });

    expect(auth.markBlocked).not.toHaveBeenCalled();
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('does not navigate again when already on the blocked screen', () => {
    router.url = '/blocked';
    fail('https://api.example.test/api/events', 403, { code: 'account_blocked' });

    expect(auth.markBlocked).toHaveBeenCalledTimes(1);
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('ignores third-party hosts', () => {
    fail('https://other.example.test/thing', 403, { code: 'account_blocked' });

    expect(auth.markBlocked).not.toHaveBeenCalled();
  });
});
