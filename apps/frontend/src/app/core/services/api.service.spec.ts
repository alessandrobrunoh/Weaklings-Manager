import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { API_BASE_URL } from '../tokens/api-base.token';
import { ApiError, ApiService } from './api.service';

describe('ApiService query parameters', () => {
  it('omits empty optional query parameters', () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    });

    const api = TestBed.inject(ApiService);
    const http = TestBed.inject(HttpTestingController);

    api.get('bank/transactions', { page: 1, split_id: '' }).subscribe();

    const request = http.expectOne((req) => req.url === '/api/bank/transactions');
    expect(request.request.params.get('page')).toBe('1');
    expect(request.request.params.has('split_id')).toBe(false);
    request.flush({ status: 'success', data: {} });
    http.verify();
  });

  it('continues omitting unspecified optional parameters', () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    });

    const api = TestBed.inject(ApiService);
    const http = TestBed.inject(HttpTestingController);

    api.get('bank/transactions', { page: 1, split_id: undefined }).subscribe();

    const request = http.expectOne('/api/bank/transactions?page=1');
    expect(request.request.params.has('split_id')).toBe(false);
    request.flush({ status: 'success', data: {} });
    http.verify();
  });
});

describe('ApiService envelope and error normalization', () => {
  function setup() {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: '' },
      ],
    });
    return { api: TestBed.inject(ApiService), http: TestBed.inject(HttpTestingController) };
  }

  it('unwraps the envelope so a list endpoint yields the bare array', () => {
    const { api, http } = setup();
    let result: unknown;
    api.get<{ tenant_id: string }[]>('api/events/5/participation-guilds').subscribe((v) => (result = v));
    http
      .expectOne('/api/events/5/participation-guilds')
      .flush({ status: 'success', data: [{ tenant_id: 'g1', name: 'Alpha' }] });
    expect(result).toEqual([{ tenant_id: 'g1', name: 'Alpha' }]);
  });

  it('uses the Problem Details detail as the error message', () => {
    const { api, http } = setup();
    let error: unknown;
    api.get('api/x').subscribe({ error: (e) => (error = e) });
    http.expectOne('/api/x').flush({ detail: 'Comp is used by 3 events' }, { status: 409, statusText: 'Conflict' });
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).message).toBe('Comp is used by 3 events');
  });

  it('replaces an HTML gateway page with a short server-error message', () => {
    const { api, http } = setup();
    let error: ApiError | undefined;
    api.get('api/x').subscribe({ error: (e) => (error = e) });
    http
      .expectOne('/api/x')
      .flush('<html><body>502 Bad Gateway</body></html>', { status: 502, statusText: 'Bad Gateway' });
    expect(error?.message).toContain('502');
    expect(error?.message).not.toContain('<html');
    expect(error?.message).not.toContain('Http failure');
  });

  it('reports an empty 4xx body without Angular failure text', () => {
    const { api, http } = setup();
    let error: ApiError | undefined;
    api.get('api/x').subscribe({ error: (e) => (error = e) });
    http.expectOne('/api/x').flush(null, { status: 403, statusText: 'Forbidden' });
    expect(error?.status).toBe(403);
    expect(error?.message).toBe('The request failed (error 403).');
  });
});
