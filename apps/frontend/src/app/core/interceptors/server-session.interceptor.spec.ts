import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { API_BASE_URL } from '../tokens/api-base.token';
import { SERVER_REQUEST_CONTEXT } from '../tokens/server-request.token';
import { serverSessionInterceptor } from './server-session.interceptor';

describe('serverSessionInterceptor', () => {
  let http: HttpClient;
  let backend: HttpTestingController;

  function setup(context: { cookie: string | null } | null): void {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([serverSessionInterceptor])),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: 'http://backend.test' },
        { provide: SERVER_REQUEST_CONTEXT, useValue: context },
      ],
    });
    http = TestBed.inject(HttpClient);
    backend = TestBed.inject(HttpTestingController);
  }

  afterEach(() => {
    backend.verify();
  });

  it('forwards the browser cookie to requests for the backend', () => {
    setup({ cookie: 'session=abc' });

    http.get('http://backend.test/api/auth/me').subscribe();

    const req = backend.expectOne('http://backend.test/api/auth/me');
    expect(req.request.headers.get('Cookie')).toBe('session=abc');
    req.flush({});
  });

  it('does not send the cookie to third-party URLs', () => {
    setup({ cookie: 'session=abc' });

    http.get('https://openalbion.example/categories').subscribe();

    const req = backend.expectOne('https://openalbion.example/categories');
    expect(req.request.headers.has('Cookie')).toBe(false);
    req.flush({});
  });

  it('leaves requests alone when no server request is present (browser)', () => {
    setup(null);

    http.get('http://backend.test/api/auth/me').subscribe();

    const req = backend.expectOne('http://backend.test/api/auth/me');
    expect(req.request.headers.has('Cookie')).toBe(false);
    req.flush({});
  });

  beforeEach(() => {
    TestBed.resetTestingModule();
  });
});
