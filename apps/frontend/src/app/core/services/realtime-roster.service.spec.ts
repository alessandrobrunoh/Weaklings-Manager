import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import type { RosterRealtimeMessage } from '../models/api.models';
import { API_BASE_URL } from '../tokens/api-base.token';
import { RealtimeRosterService } from './realtime-roster.service';

class MockWebSocket {
  static readonly instances: MockWebSocket[] = [];

  readonly url: string;
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  message(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent('close'));
  }
}

function createService(): RealtimeRosterService {
  MockWebSocket.instances.length = 0;
  vi.stubGlobal('WebSocket', MockWebSocket);
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [{ provide: API_BASE_URL, useValue: '' }],
  });
  return TestBed.inject(RealtimeRosterService);
}

describe('RealtimeRosterService', () => {
  it('ignores malformed and other-event messages while publishing valid notifications', () => {
    const service = createService();
    const received: string[] = [];
    service.messages.subscribe((message) => received.push(message.type));

    service.connect(42);
    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.message('{not-json');
    socket.message(JSON.stringify({ type: 'ready', event_id: 7, roster_version: 1 }));
    socket.message(JSON.stringify({ type: 'ready', event_id: 42, roster_version: 1 }));

    expect(received).toEqual(['ready']);
    expect(service.connectionState()).toBe('connected');
    service.destroy();
  });

  it('preserves valid change metadata and leaves stale-version handling to the page', () => {
    const service = createService();
    const received: RosterRealtimeMessage[] = [];
    service.messages.subscribe((message) => received.push(message));

    service.connect(42);
    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.message(
      JSON.stringify({
        type: 'roster_changed',
        event_id: 42,
        roster_version: 8,
        change_kind: 'assigned',
        changed_seat_keys: ['1:1'],
      }),
    );
    socket.message(
      JSON.stringify({
        type: 'roster_changed',
        event_id: 42,
        roster_version: 3,
        change_kind: 12,
        changed_seat_keys: ['1:2', 3],
      }),
    );

    expect(received).toEqual([
      {
        type: 'roster_changed',
        event_id: 42,
        roster_version: 8,
        change_kind: 'assigned',
        changed_seat_keys: ['1:1'],
      },
      { type: 'roster_changed', event_id: 42, roster_version: 3 },
    ]);
    service.destroy();
  });

  it('reconnects after an unexpected close while the event remains requested', () => {
    vi.useFakeTimers();
    const service = createService();

    service.connect(42);
    MockWebSocket.instances[0].open();
    MockWebSocket.instances[0].close();
    expect(service.connectionState()).toBe('reconnecting');

    vi.advanceTimersByTime(1_000);

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[1].url).toMatch(/^ws:\/\/.*\/api\/events\/42\/roster\/live$/);
    service.destroy();
    vi.useRealTimers();
  });

  it('closes the socket and cancels pending reconnects on destroy', () => {
    vi.useFakeTimers();
    const service = createService();

    service.connect(42);
    MockWebSocket.instances[0].open();
    MockWebSocket.instances[0].close();
    service.destroy();
    vi.advanceTimersByTime(30_000);

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(service.connectionState()).toBe('disconnected');
    vi.useRealTimers();
  });
});
