import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  BroadcastRequest,
  BroadcastResult,
  NotificationView,
  PaginatedData,
  ReadAllResult,
  UnreadCountView,
} from '../models/api.models';
import { ApiError, ApiService } from './api.service';

const POLL_MS = 30_000;
const INBOX_LIMIT = 20;

/**
 * Client for the per-member inbox.
 *
 * Polls the unread badge while the tab is visible. The panel loads the
 * latest page on open rather than keeping a live list.
 */
@Injectable({ providedIn: 'root' })
export class NotificationService {
  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly _items = signal<NotificationView[]>([]);
  private readonly _unreadCount = signal(0);
  private readonly _loading = signal(false);
  private readonly _error = signal<string | null>(null);
  /** Bumped by `reset()` so responses that were in flight for the old tenant are dropped. */
  private epoch = 0;

  /** Latest inbox page. */
  readonly items = this._items.asReadonly();
  /** Unread badge count. */
  readonly unreadCount = this._unreadCount.asReadonly();
  /** True while the inbox page is in flight. */
  readonly loading = this._loading.asReadonly();
  /** Last load error, if any. */
  readonly error = this._error.asReadonly();

  constructor() {
    if (typeof window === 'undefined') {
      return;
    }
    void this.refreshUnread();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void this.refreshUnread();
      }
    }, POLL_MS);
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        void this.refreshUnread();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    this.destroyRef.onDestroy(() => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
    });
  }

  /**
   * Refresh the unread badge.
   *
   * A 401 clears the badge (the session is gone). Any other failure keeps the
   * last count so a blip is not shown as "nothing unread".
   */
  async refreshUnread(): Promise<void> {
    const epoch = this.epoch;
    try {
      const view = await firstValueFrom(
        this.api.get<UnreadCountView>('api/notifications/unread-count'),
      );
      if (epoch === this.epoch) {
        this._unreadCount.set(view.count);
      }
    } catch (err) {
      if (epoch === this.epoch && err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        this._unreadCount.set(0);
      }
    }
  }

  /**
   * Drop the inbox and badge of the previous session scope and refetch the badge.
   *
   * Called when the active tenant changes: the service is a root singleton, so
   * without this the old tenant's unread count and rows stay visible until the
   * next poll.
   */
  reset(): void {
    this.epoch++;
    this._items.set([]);
    this._unreadCount.set(0);
    this._error.set(null);
    this._loading.set(false);
    void this.refreshUnread();
  }

  /** Load the latest inbox page into `items`. */
  async loadInbox(): Promise<void> {
    const epoch = this.epoch;
    this._loading.set(true);
    this._error.set(null);
    try {
      const page = await firstValueFrom(
        this.api.get<PaginatedData<NotificationView>>('api/notifications', {
          page: 1,
          limit: INBOX_LIMIT,
        }),
      );
      if (epoch === this.epoch) {
        this._items.set(page.items);
      }
    } catch {
      if (epoch === this.epoch) {
        this._error.set('load');
      }
    } finally {
      if (epoch === this.epoch) {
        this._loading.set(false);
      }
    }
  }

  /** Mark one row read and refresh the badge. */
  async markRead(id: number): Promise<NotificationView | null> {
    try {
      const view = await firstValueFrom(
        this.api.post<NotificationView>(`api/notifications/${id}/read`, null),
      );
      this._items.update((list) => list.map((row) => (row.id === id ? view : row)));
      await this.refreshUnread();
      return view;
    } catch {
      return null;
    }
  }

  /** Mark every unread row read. */
  async markAllRead(): Promise<void> {
    try {
      await firstValueFrom(this.api.post<ReadAllResult>('api/notifications/read-all', null));
      this._items.update((list) =>
        list.map((row) => (row.read_at ? row : { ...row, read_at: new Date().toISOString() })),
      );
      this._unreadCount.set(0);
    } catch {
      // Keep current state; the next poll will correct the badge.
    }
  }

  /** Fan a guild announcement out to every member. */
  async broadcast(body: BroadcastRequest): Promise<BroadcastResult> {
    const result = await firstValueFrom(
      this.api.post<BroadcastResult>('api/notifications/broadcast', body),
    );
    await this.loadInbox();
    await this.refreshUnread();
    return result;
  }
}
