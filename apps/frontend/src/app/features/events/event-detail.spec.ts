import { signal, type Signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { NEVER, of } from 'rxjs';
import { describe, expect, it } from 'vitest';

import type {
  EventParticipant,
  EventRosterParticipant,
  EventRosterSeat,
  EventRosterView,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { RealtimeRosterService } from '../../core/services/realtime-roster.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import { AlbionCatalogService } from '../../shared/services/albion-catalog.service';
import { EventDetailPage } from './event-detail';

interface EventDetailRosterAccess {
  readonly ownRosterSeat: Signal<EventRosterSeat | null>;
  readonly rosterParties: Signal<
    ReadonlyArray<{ partyNumber: number; seats: readonly EventRosterSeat[] }>
  >;
  readonly rosterSnapshot: WritableSignal<EventRosterView | null>;
  readonly draggedSeat: Signal<EventRosterSeat | null>;
  readonly draggedBenchMember: Signal<EventParticipant | null>;
  readonly dropTargetSeatKey: Signal<string | null>;
  readonly isDropTargetBench: Signal<boolean>;
  onSeatDragStart(event: DragEvent, seat: EventRosterSeat): void;
  onSeatDragOver(event: DragEvent, seat: EventRosterSeat): void;
  onSeatDrop(event: DragEvent, targetSeat: EventRosterSeat): Promise<void>;
  onBenchMemberDragStart(event: DragEvent, member: EventParticipant): void;
  onBenchDragOver(event: DragEvent): void;
  onBenchDrop(event: DragEvent): Promise<void>;
  onDragEnd(): void;
}

function seat(partyNumber: number, position: number, userId: number | null): EventRosterSeat {
  return {
    key: `build:${partyNumber}:${position}`,
    party_number: partyNumber,
    position,
    build_id: position,
    build_name: `Build ${position}`,
    build_version: 1,
    role: 'dps',
    participant:
      userId === null
        ? null
        : {
            user_id: userId,
            username: `Member ${userId}`,
            discord_id: null,
            specializations: {},
            primary_build_id: position,
            primary_build_name: `Build ${position}`,
            secondary_build_id: null,
            secondary_build_name: null,
          },
  };
}

describe('EventDetailPage roster room', () => {
  it('uses the snapshot party and seat position for the current member assignment', () => {
    TestBed.configureTestingModule({
      imports: [EventDetailPage],
      providers: [
        {
          provide: ApiService,
          useValue: {
            get: () => of({ items: [] }),
            post: () => of({}),
            put: () => of({}),
            delete: () => of({}),
          },
        },
        {
          provide: AuthService,
          useValue: { hasPermission: () => true, profile: () => ({ user_id: 42 }) },
        },
        {
          provide: ActivatedRoute,
          useValue: { paramMap: of(convertToParamMap({ id: '1' })) },
        },
        { provide: Router, useValue: { navigate: () => Promise.resolve(true) } },
        { provide: ToastService, useValue: { error: () => undefined, success: () => undefined } },
        { provide: TranslateService, useValue: { t: (key: string) => key } },
        { provide: AlbionCatalogService, useValue: { load: () => Promise.resolve([]) } },
        {
          provide: RealtimeRosterService,
          useValue: {
            close: () => undefined,
            connect: () => undefined,
            messages: NEVER,
            connectionState: signal('disconnected'),
          },
        },
      ],
    });

    const fixture = TestBed.createComponent(EventDetailPage);
    const page = fixture.componentInstance as unknown as EventDetailRosterAccess;
    page.rosterSnapshot.set({
      event_id: 1,
      roster_version: 3,
      active_comp_id: 9,
      seats: [seat(2, 2, 42), seat(1, 3, null), seat(2, 1, 7)],
      bench: [],
    });

    expect(page.ownRosterSeat()?.party_number).toBe(2);
    expect(page.ownRosterSeat()?.position).toBe(2);
    expect(page.rosterParties().map((party) => party.partyNumber)).toEqual([1, 2]);
    expect(page.rosterParties()[1].seats.map((entry) => entry.position)).toEqual([1, 2]);
  });

  it('correctly groups up to 20 seats per party', () => {
    TestBed.configureTestingModule({
      imports: [EventDetailPage],
      providers: [
        { provide: ApiService, useValue: { get: () => of({ items: [] }) } },
        {
          provide: AuthService,
          useValue: { hasPermission: () => true, profile: () => ({ user_id: 1 }) },
        },
        {
          provide: ActivatedRoute,
          useValue: { paramMap: of(convertToParamMap({ id: '1' })) },
        },
        { provide: Router, useValue: { navigate: () => Promise.resolve(true) } },
        { provide: ToastService, useValue: { error: () => undefined, success: () => undefined } },
        { provide: TranslateService, useValue: { t: (key: string) => key } },
        { provide: AlbionCatalogService, useValue: { load: () => Promise.resolve([]) } },
        {
          provide: RealtimeRosterService,
          useValue: {
            close: () => undefined,
            connect: () => undefined,
            messages: NEVER,
            connectionState: signal('disconnected'),
          },
        },
      ],
    });

    const fixture = TestBed.createComponent(EventDetailPage);
    const page = fixture.componentInstance as unknown as EventDetailRosterAccess;
    const seats: EventRosterSeat[] = [];
    for (let i = 1; i <= 25; i++) {
      const partyNumber = Math.floor((i - 1) / 20) + 1;
      const position = ((i - 1) % 20) + 1;
      seats.push(seat(partyNumber, position, i));
    }
    page.rosterSnapshot.set({
      event_id: 1,
      roster_version: 1,
      active_comp_id: 1,
      seats,
      bench: [],
    });

    const parties = page.rosterParties();
    expect(parties.length).toBe(2);
    expect(parties[0].partyNumber).toBe(1);
    expect(parties[0].seats.length).toBe(20);
    expect(parties[1].partyNumber).toBe(2);
    expect(parties[1].seats.length).toBe(5);
  });

  it('handles drag and drop state transitions for seats and bench', async () => {
    const postSpy = vi.fn().mockReturnValue(of({}));
    const deleteSpy = vi.fn().mockReturnValue(of({}));
    const putSpy = vi.fn().mockReturnValue(of({}));

    const seat1 = seat(1, 1, 101);
    const seat2 = seat(1, 2, 102);
    const benchUser: EventRosterParticipant = {
      user_id: 201,
      username: 'BenchGuy',
      discord_id: null,
      specializations: {},
      primary_build_id: 1,
      primary_build_name: 'Build 1',
      secondary_build_id: null,
      secondary_build_name: null,
    };

    const snapshotData = {
      event_id: 10,
      roster_version: 1,
      active_comp_id: 1,
      seats: [seat1, seat2],
      bench: [benchUser],
      items: [],
    };

    TestBed.configureTestingModule({
      imports: [EventDetailPage],
      providers: [
        {
          provide: ApiService,
          useValue: {
            get: () => of(snapshotData),
            post: postSpy,
            delete: deleteSpy,
            put: putSpy,
          },
        },
        {
          provide: AuthService,
          useValue: { hasPermission: () => true, profile: () => ({ user_id: 1 }) },
        },
        {
          provide: ActivatedRoute,
          useValue: { paramMap: of(convertToParamMap({ eventId: '10' })) },
        },
        { provide: Router, useValue: { navigate: () => Promise.resolve(true) } },
        { provide: ToastService, useValue: { error: () => undefined, success: () => undefined } },
        { provide: TranslateService, useValue: { t: (key: string) => key } },
        { provide: AlbionCatalogService, useValue: { load: () => Promise.resolve([]) } },
        {
          provide: RealtimeRosterService,
          useValue: {
            close: () => undefined,
            connect: () => undefined,
            messages: NEVER,
            connectionState: signal('disconnected'),
          },
        },
      ],
    });

    const fixture = TestBed.createComponent(EventDetailPage);
    const page = fixture.componentInstance as unknown as EventDetailRosterAccess;

    page.rosterSnapshot.set({
      event_id: 10,
      roster_version: 1,
      active_comp_id: 1,
      seats: [seat1, seat2],
      bench: [benchUser],
    });

    const mockDataTransfer = {
      setData: vi.fn(),
      effectAllowed: 'uninitialized',
      dropEffect: 'none',
    } as unknown as DataTransfer;

    const dragStartEvent = {
      dataTransfer: mockDataTransfer,
      preventDefault: vi.fn(),
    } as unknown as DragEvent;

    // 1. Drag seat1 to seat2 (swap)
    page.onSeatDragStart(dragStartEvent, seat1);
    expect(page.draggedSeat()).toEqual(seat1);

    const dragOverEvent = {
      dataTransfer: mockDataTransfer,
      preventDefault: vi.fn(),
    } as unknown as DragEvent;

    page.onSeatDragOver(dragOverEvent, seat2);
    expect(page.dropTargetSeatKey()).toBe(seat2.key);

    const dropEvent = {
      dataTransfer: mockDataTransfer,
      preventDefault: vi.fn(),
    } as unknown as DragEvent;

    await page.onSeatDrop(dropEvent, seat2);
    expect(postSpy).toHaveBeenCalledWith('api/events/10/roster/swaps', {
      source_seat_key: seat1.key,
      target_seat_key: seat2.key,
      expected_roster_version: 1,
    });

    // 2. Drag seat1 to Bench (clear seat)
    page.onSeatDragStart(dragStartEvent, seat1);
    page.onBenchDragOver(dragOverEvent);
    expect(page.isDropTargetBench()).toBe(true);
    await page.onBenchDrop(dropEvent);
    expect(deleteSpy).toHaveBeenCalledWith(
      `api/events/10/roster/seats/${encodeURIComponent(seat1.key)}`,
      { expected_roster_version: 1 },
    );

    // 3. Drag Bench member to seat2 (assign)
    page.onBenchMemberDragStart(dragStartEvent, benchUser);
    expect(page.draggedBenchMember()).toEqual(benchUser);
    await page.onSeatDrop(dropEvent, seat2);
    expect(putSpy).toHaveBeenCalledWith(
      `api/events/10/roster/seats/${encodeURIComponent(seat2.key)}`,
      { user_id: 201, expected_roster_version: 1 },
    );
  });
});

interface EventDetailLoadAccess {
  readonly loading: Signal<boolean>;
  load(silent?: boolean): Promise<void>;
}

describe('EventDetailPage page spinner', () => {
  it('lowers the spinner when a silent realtime reload supersedes the initial load', async () => {
    TestBed.configureTestingModule({
      imports: [EventDetailPage],
      providers: [
        { provide: ApiService, useValue: { get: () => of({ items: [] }) } },
        {
          provide: AuthService,
          useValue: { hasPermission: () => true, profile: () => ({ user_id: 1 }) },
        },
        {
          provide: ActivatedRoute,
          useValue: { paramMap: of(convertToParamMap({ eventId: '1' })) },
        },
        { provide: Router, useValue: { navigate: () => Promise.resolve(true) } },
        { provide: ToastService, useValue: { error: () => undefined, success: () => undefined } },
        { provide: TranslateService, useValue: { t: (key: string) => key } },
        { provide: AlbionCatalogService, useValue: { load: () => Promise.resolve([]) } },
        {
          provide: RealtimeRosterService,
          useValue: {
            close: () => undefined,
            connect: () => undefined,
            messages: NEVER,
            connectionState: signal('disconnected'),
          },
        },
      ],
    });

    const fixture = TestBed.createComponent(EventDetailPage);
    const page = fixture.componentInstance as unknown as EventDetailLoadAccess;

    // The roster socket pushes its first message while the initial load is still in flight, so a
    // silent reload starts and bumps the load generation. The silent path never touches the
    // spinner, so the load that raised it must still lower it.
    const initial = page.load();
    void page.load(true);
    await initial;

    expect(page.loading()).toBe(false);
  });
});
