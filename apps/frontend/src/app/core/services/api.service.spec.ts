import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { API_BASE_URL } from '../tokens/api-base.token';
import { ApiService } from './api.service';

describe('ApiService query parameters', () => {
  it('preserves an empty split_id marker for flattened optional bank filters', () => {
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
    expect(request.request.params.has('split_id')).toBe(true);
    expect(request.request.params.get('split_id')).toBe('');
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
