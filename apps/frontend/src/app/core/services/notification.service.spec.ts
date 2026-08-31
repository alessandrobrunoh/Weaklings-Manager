import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import type { NotificationView, PaginatedData, UnreadCountView } from '../models/api.models';
import { ApiService } from './api.service';
import { NotificationService } from './notification.service';

function sample(overrides: Partial<NotificationView> = {}): NotificationView {
  return {
    id: 1,
    kind: 'broadcast',
    title: 'CTA tonight',
    body: 'Be online.',
    link_path: null,
    source_type: 'broadcast',
    source_id: 9,
    read_at: null,
    created_at: '2026-08-30T12:00:00Z',
    ...overrides,
  };
}

function emptyPage(items: NotificationView[] = []): PaginatedData<NotificationView> {
  return {
    items,
    total_items: items.length,
    total_pages: 1,
    current_page: 1,
    limit: 20,
  };
}

describe('NotificationService', () => {
  it('loads the inbox page into items', async () => {
    const api = {
      get: vi.fn((path: string) => {
        if (path === 'api/notifications/unread-count') {
          return of({ count: 1 } satisfies UnreadCountView);
        }
        return of(emptyPage([sample()]));
      }),
      post: vi.fn(),
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: ApiService, useValue: api }],
    });
    const service = TestBed.inject(NotificationService);

    await service.loadInbox();

    expect(service.items()).toEqual([sample()]);
    expect(service.error()).toBeNull();
  });

  it('stores a load error without throwing', async () => {
    const api = {
      get: vi.fn((path: string) => {
        if (path === 'api/notifications/unread-count') {
          return of({ count: 0 } satisfies UnreadCountView);
        }
        return throwError(() => new Error('nope'));
      }),
      post: vi.fn(),
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: ApiService, useValue: api }],
    });
    const service = TestBed.inject(NotificationService);

    await service.loadInbox();

    expect(service.items()).toEqual([]);
    expect(service.error()).toBe('load');
  });

  it('replaces a row after markRead and refreshes the badge', async () => {
    const read = sample({ read_at: '2026-08-30T12:01:00Z' });
    const api = {
      get: vi.fn((path: string) => {
        if (path === 'api/notifications/unread-count') {
          return of({ count: 0 } satisfies UnreadCountView);
        }
        return of(emptyPage([sample()]));
      }),
      post: vi.fn().mockReturnValue(of(read)),
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: ApiService, useValue: api }],
    });
    const service = TestBed.inject(NotificationService);
    await service.loadInbox();

    const view = await service.markRead(1);

    expect(view?.read_at).toBe('2026-08-30T12:01:00Z');
    expect(service.items()[0].read_at).toBe('2026-08-30T12:01:00Z');
    expect(api.post).toHaveBeenCalledWith('api/notifications/1/read', null);
  });
});
