import { DestroyRef, Injectable, PLATFORM_ID, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { Observable, Subject } from 'rxjs';

import type { RosterRealtimeMessage } from '../models/api.models';
import { API_BASE_URL } from '../tokens/api-base.token';

export type RosterConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error';

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

/**
 * Maintains the single live-roster WebSocket requested by the current page.
 * Consumers should refetch the roster after receiving any message because the
 * socket intentionally only carries invalidation/version notifications.
 */
@Injectable({ providedIn: 'root' })
export class RealtimeRosterService {
  private readonly apiBaseUrl = inject(API_BASE_URL);
  private readonly destroyRef = inject(DestroyRef);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly messageSubject = new Subject<RosterRealtimeMessage>();
  private readonly _connectionState = signal<RosterConnectionState>('disconnected');

  private socket: WebSocket | null = null;
  private requestedEventId: number | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionId = 0;
  private visibilityListener: (() => void) | null = null;
  private destroyed = false;

  /** Current state of the requested live-roster connection. */
  readonly connectionState = this._connectionState.asReadonly();
  /** Validated live-roster invalidation notifications for the requested event. */
  readonly messages: Observable<RosterRealtimeMessage> = this.messageSubject.asObservable();

  constructor() {
    if (!this.isBrowser) {
      this._connectionState.set('error');
    } else {
      this.bindVisibility();
    }
    this.destroyRef.onDestroy(() => this.destroy());
  }

  /**
   * Opens the live-roster connection for one event. Calling this again for the
   * same active event is a no-op; a different event replaces the prior socket.
   */
  connect(eventId: number): void {
    if (!Number.isSafeInteger(eventId) || eventId < 1 || this.destroyed) {
      return;
    }
    if (!this.isBrowser) {
      this._connectionState.set('error');
      return;
    }
    if (this.requestedEventId === eventId && (this.socket || this.reconnectTimer !== null)) {
      return;
    }

    this.stopConnection();
    this.requestedEventId = eventId;
    this.reconnectAttempt = 0;
    if (document.visibilityState !== 'visible') {
      this._connectionState.set('disconnected');
      return;
    }
    this.openSocket(false);
  }

  /** Stops the requested connection and prevents any further reconnects. */
  close(): void {
    this.stopConnection();
  }

  /** Stops the client and releases its browser lifecycle listener. */
  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.stopConnection();
    if (this.visibilityListener) {
      document.removeEventListener('visibilitychange', this.visibilityListener);
      this.visibilityListener = null;
    }
    this.messageSubject.complete();
  }

  private bindVisibility(): void {
    this.visibilityListener = () => {
      if (document.visibilityState === 'hidden') {
        this.stopSocketOnly();
        this._connectionState.set('disconnected');
        return;
      }
      if (this.requestedEventId !== null && !this.socket && this.reconnectTimer === null) {
        this.reconnectAttempt = 0;
        this.openSocket(false);
      }
    };
    document.addEventListener('visibilitychange', this.visibilityListener);
  }

  private openSocket(isReconnect: boolean): void {
    const eventId = this.requestedEventId;
    if (eventId === null || this.destroyed || !this.isPageVisible()) {
      return;
    }

    const browserWindow = window;
    if (typeof browserWindow.WebSocket !== 'function') {
      this._connectionState.set('error');
      return;
    }

    this._connectionState.set(isReconnect ? 'reconnecting' : 'connecting');
    const connectionId = ++this.connectionId;
    let socket: WebSocket;
    try {
      socket = new browserWindow.WebSocket(this.rosterLiveUrl(eventId));
    } catch {
      this._connectionState.set('error');
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      if (!this.isCurrentConnection(connectionId, socket)) {
        return;
      }
      this.reconnectAttempt = 0;
      this._connectionState.set('connected');
    };
    socket.onmessage = (event: MessageEvent<unknown>) => {
      if (!this.isCurrentConnection(connectionId, socket)) {
        return;
      }
      const message = parseRosterRealtimeMessage(event.data);
      if (message && message.event_id === this.requestedEventId) {
        this.messageSubject.next(message);
      }
    };
    socket.onerror = () => {
      if (this.isCurrentConnection(connectionId, socket)) {
        this._connectionState.set('error');
      }
    };
    socket.onclose = () => {
      if (!this.isCurrentConnection(connectionId, socket)) {
        return;
      }
      this.socket = null;
      if (this.requestedEventId === null || this.destroyed || !this.isPageVisible()) {
        this._connectionState.set('disconnected');
        return;
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.requestedEventId === null || this.destroyed || this.reconnectTimer !== null) {
      return;
    }
    const delay = Math.min(
      INITIAL_RECONNECT_DELAY_MS * 2 ** this.reconnectAttempt,
      MAX_RECONNECT_DELAY_MS,
    );
    this.reconnectAttempt += 1;
    this._connectionState.set('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket(true);
    }, delay);
  }

  private stopConnection(): void {
    this.requestedEventId = null;
    this.reconnectAttempt = 0;
    this.stopSocketOnly();
    this._connectionState.set('disconnected');
  }

  private stopSocketOnly(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    ++this.connectionId;
    if (socket && socket.readyState < WebSocket.CLOSING) {
      socket.close();
    }
  }

  private isCurrentConnection(connectionId: number, socket: WebSocket): boolean {
    return this.connectionId === connectionId && this.socket === socket;
  }

  private isPageVisible(): boolean {
    return document.visibilityState === 'visible';
  }

  private rosterLiveUrl(eventId: number): string {
    const base = this.apiBaseUrl.replace(/\/$/, '');
    const httpUrl = new URL(`${base}/api/events/${eventId}/roster/live`, window.location.origin);
    httpUrl.protocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    return httpUrl.toString();
  }
}

function parseRosterRealtimeMessage(data: unknown): RosterRealtimeMessage | null {
  if (typeof data !== 'string') {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRosterMessageType(parsed['type'])) {
    return null;
  }
  const eventId = parsed['event_id'];
  const rosterVersion = parsed['roster_version'];
  if (!isNonNegativeSafeInteger(eventId) || !isNonNegativeSafeInteger(rosterVersion)) {
    return null;
  }
  return { type: parsed['type'], event_id: eventId, roster_version: rosterVersion };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRosterMessageType(value: unknown): value is RosterRealtimeMessage['type'] {
  return value === 'ready' || value === 'roster_changed' || value === 'resync_required';
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
