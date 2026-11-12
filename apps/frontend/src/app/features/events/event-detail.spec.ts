import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal, type Signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { NEVER, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import type {
  EventDetailView,
  EventParticipant,
  EventRosterParticipant,
  EventRosterSeat,
  EventRosterView,
  EventSignupOptions,
  ParticipationGuildOption,
  RosterSuggestions,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { API_BASE_URL } from '../../core/tokens/api-base.token';
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

interface EventDetailPermissionAccess {
  readonly event: WritableSignal<EventDetailView | null>;
  readonly canEdit: Signal<boolean>;
  readonly canDelete: Signal<boolean>;
  readonly linkCanManage: WritableSignal<boolean>;
}

function seat(
  partyNumber: number,
  position: number,
  userId: number | null,
  role: EventRosterSeat['role'] = 'dps',
): EventRosterSeat {
  return {
    key: `party:${partyNumber}:build:${position}:1`,
    party_id: partyNumber,
    party_name: null,
    party_position: partyNumber,
    party_number: partyNumber,
    position,
    build_id: position,
    build_name: `Build ${position}`,
    build_version: 1,
    role,
    weapon_key: null,
    participant:
      userId === null
        ? null
        : {
            user_id: userId,
            username: `Member ${userId}`,
            discord_id: null,
            weapons: [],
            primary_build_id: position,
            primary_build_name: `Build ${position}`,
            secondary_build_id: null,
            secondary_build_name: null,
          },
  };
}

describe('EventDetailPage roster room', () => {
  it('lets the event creator manage their own event and keeps edit/delete grants separate', () => {
    const permissions = signal(new Set<string>());
    const profile = signal({ user_id: 42 });
    TestBed.configureTestingModule({
      imports: [EventDetailPage],
      providers: [
        { provide: ApiService, useValue: { get: () => of({ items: [] }) } },
        {
          provide: AuthService,
          useValue: {
            hasPermission: (permission: string) => permissions().has(permission),
            profile,
          },
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
    const page = fixture.componentInstance as unknown as EventDetailPermissionAccess;
    page.event.set({ created_by: 42 } as EventDetailView);

    expect(page.canEdit()).toBe(true);
    expect(page.canDelete()).toBe(true);

    page.event.set({ created_by: 43 } as EventDetailView);
    expect(page.canEdit()).toBe(false);
    expect(page.canDelete()).toBe(false);

    // edit/delete cover the holder's own events only.
    permissions.set(new Set(['events.edit', 'events.delete']));
    expect(page.canEdit()).toBe(false);
    expect(page.canDelete()).toBe(false);

    // events.manage is the administrator override.
    permissions.set(new Set(['events.manage']));
    expect(page.canEdit()).toBe(true);
    expect(page.canDelete()).toBe(true);

    // A link answers with the owner's management authority, not the local permissions.
    page.event.set({
      created_by: 42,
      source_event_id: 9,
      source_tenant_id: 'source',
      is_link: true,
    } as EventDetailView);
    permissions.set(new Set(['events.manage']));
    page.linkCanManage.set(false);
    expect(page.canEdit()).toBe(false);
    expect(page.canDelete()).toBe(false);
    page.linkCanManage.set(true);
    expect(page.canEdit()).toBe(true);
    expect(page.canDelete()).toBe(true);

    page.event.set({
      created_by: 42,
      source_event_id: 9,
      source_tenant_id: 'source',
      is_link: false,
    } as EventDetailView);
    expect(page.canEdit()).toBe(true);
    expect(page.canDelete()).toBe(true);
  });

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
      parties: [],
      seats: [seat(2, 1, 7, 'healer'), seat(1, 3, null), seat(2, 2, 42, 'support')],
      bench: [],
    });

    expect(page.ownRosterSeat()?.party_number).toBe(2);
    expect(page.ownRosterSeat()?.position).toBe(2);
    expect(page.rosterParties().map((party) => party.partyNumber)).toEqual([1, 2]);
    // Healer before support: the party reads in the app's role order (tank, healer, support, dps…).
    expect(page.rosterParties()[1].seats.map((entry) => entry.position)).toEqual([1, 2]);
  }, 15_000);

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
      parties: [],
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
      weapons: [],
      primary_build_id: 1,
      primary_build_name: 'Build 1',
      secondary_build_id: null,
      secondary_build_name: null,
    };

    const snapshotData = {
      event_id: 10,
      roster_version: 1,
      active_comp_id: 1,
      parties: [],
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
      parties: [],
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

interface EventDetailCommandAccess {
  readonly rosterSnapshot: WritableSignal<EventRosterView | null>;
  readonly rosterSnapshotState: Signal<'loading' | 'ready' | 'error'>;
  clearServerRosterSeat(seat: EventRosterSeat): Promise<void>;
}

describe('EventDetailPage seat commands', () => {
  it('folds the command response in without ever leaving the ready state', async () => {
    const seated = seat(1, 1, 101);
    const cleared = { ...seated, participant: null };
    const before: EventRosterView = {
      event_id: 10,
      roster_version: 4,
      active_comp_id: 1,
      parties: [],
      seats: [seated],
      bench: [],
    };
    const after: EventRosterView = {
      ...before,
      roster_version: 5,
      seats: [cleared],
      bench: [seated.participant as EventRosterParticipant],
    };

    const getSpy = vi.fn((path: string) => {
      if (path === 'api/events/10') {
        return of({
          id: 10,
          title: 'Event',
          status: 'scheduled',
          event_date_utc: new Date().toISOString(),
          battles: [],
          participants: [],
          roster_roles: [],
          splits: [],
          fights: [],
        });
      }
      if (path === 'api/events/10/roster') {
        return of(before);
      }
      return of({ items: [] });
    });
    const deleteSpy = vi.fn().mockReturnValue(of(after));

    TestBed.configureTestingModule({
      imports: [EventDetailPage],
      providers: [
        {
          provide: ApiService,
          useValue: { get: getSpy, post: () => of({}), put: () => of({}), delete: deleteSpy },
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
    const page = fixture.componentInstance as unknown as EventDetailCommandAccess;
    // Let the constructor's initial load settle so it cannot land on top of the assertions.
    await new Promise((resolve) => setTimeout(resolve, 0));
    page.rosterSnapshot.set(before);
    getSpy.mockClear();

    await page.clearServerRosterSeat(seated);

    // The roster panel must stay mounted: dropping to 'loading' unmounts it, collapsing the page
    // and throwing the officer back to the top on every assignment.
    expect(page.rosterSnapshotState()).toBe('ready');
    expect(page.rosterSnapshot()?.roster_version).toBe(5);
    expect(page.rosterSnapshot()?.bench.length).toBe(1);
    // The response is already the fresh snapshot, so no roster refetch should follow.
    expect(getSpy.mock.calls.map(([path]) => path)).not.toContain('api/events/10/roster');
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

interface EventDetailRosterSuggestionsAccess {
  readonly rosterSnapshot: WritableSignal<EventRosterView | null>;
  readonly rosterSuggestions: WritableSignal<RosterSuggestions | null>;
  readonly rosterSuggestionRows: Signal<
    ReadonlyArray<{
      seatKey: string;
      buildName: string;
      username: string;
      proficiency: { tone: string; label: string } | null;
      preferenceLabel: string;
    }>
  >;
}

describe('EventDetailPage roster suggestions', () => {
  function createPage(): EventDetailRosterSuggestionsAccess {
    TestBed.configureTestingModule({
      imports: [EventDetailPage],
      providers: [
        { provide: ApiService, useValue: { get: () => of({ items: [] }) } },
        {
          provide: AuthService,
          useValue: { hasPermission: () => true, profile: () => ({ user_id: 1 }) },
        },
        { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ id: '1' })) } },
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
    return fixture.componentInstance as unknown as EventDetailRosterSuggestionsAccess;
  }

  it('enriches a placement with the seat, build and member names the raw response omits', () => {
    const page = createPage();
    page.rosterSnapshot.set({
      event_id: 1,
      roster_version: 1,
      active_comp_id: 9,
      parties: [],
      seats: [seat(1, 3, null, 'healer')],
      bench: [
        {
          user_id: 7,
          username: 'Tacos',
          discord_id: null,
          weapons: [],
          primary_build_id: 3,
          primary_build_name: 'Build 3',
          secondary_build_id: null,
          secondary_build_name: null,
        },
      ],
    });
    page.rosterSuggestions.set({
      placements: [
        {
          seat_key: 'party:1:build:3:1',
          user_id: 7,
          score: { proficiency: 'main', preference: 'primary', blocking: [], score: 3.5 },
        },
      ],
      unplaced_members: [],
      unfilled_seats: [],
    });

    const rows = page.rosterSuggestionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      seatKey: 'party:1:build:3:1',
      buildName: 'Build 3',
      username: 'Tacos',
      proficiency: { tone: 'success', label: 'weapons.proficiency.main' },
      preferenceLabel: 'events.detail.preferencePrimary',
    });
  });

  it('falls back to a bare id when the member is not found on the roster snapshot', () => {
    const page = createPage();
    page.rosterSnapshot.set({
      event_id: 1,
      roster_version: 1,
      active_comp_id: 9,
      parties: [],
      seats: [seat(1, 1, null)],
      bench: [],
    });
    page.rosterSuggestions.set({
      placements: [
        {
          seat_key: 'party:1:build:1:1',
          user_id: 99,
          score: { proficiency: null, preference: 'none', blocking: [], score: 0.5 },
        },
      ],
      unplaced_members: [],
      unfilled_seats: [],
    });

    expect(page.rosterSuggestionRows()[0].username).toBe('#99');
    expect(page.rosterSuggestionRows()[0].proficiency).toBeNull();
  });

  it('drops a placement whose seat no longer exists rather than throwing', () => {
    const page = createPage();
    page.rosterSnapshot.set({
      event_id: 1,
      roster_version: 1,
      active_comp_id: 9,
      parties: [],
      seats: [],
      bench: [],
    });
    page.rosterSuggestions.set({
      placements: [
        {
          seat_key: 'party:1:build:1:1',
          user_id: 1,
          score: { proficiency: null, preference: 'none', blocking: [], score: 0.5 },
        },
      ],
      unplaced_members: [],
      unfilled_seats: [],
    });

    expect(page.rosterSuggestionRows()).toHaveLength(0);
  });

  it('is empty before any suggestions have been fetched', () => {
    const page = createPage();
    page.rosterSnapshot.set({
      event_id: 1,
      roster_version: 1,
      active_comp_id: 9,
      parties: [],
      seats: [seat(1, 1, null)],
      bench: [],
    });
    expect(page.rosterSuggestionRows()).toHaveLength(0);
  });
});

interface EventDetailGuildAttributionAccess {
  readonly event: WritableSignal<EventDetailView | null>;
  readonly participationGuilds: WritableSignal<ParticipationGuildOption[]>;
  readonly participationGuildsState: WritableSignal<
    'idle' | 'loading' | 'ready' | 'error'
  >;
  readonly selectedGuildTenantId: WritableSignal<string>;
  readonly guildChoiceBlocked: Signal<boolean>;
  readonly requiresGuildChoice: Signal<boolean>;
  onSplitSelected(option: { id: number }): Promise<void>;
  performUnlinkSplit(splitId: number): Promise<void>;
  readonly joinError: WritableSignal<string | null>;
  readonly showJoinConfirm: WritableSignal<boolean>;
  readonly draftPrimaryBuildId: WritableSignal<string>;
  readonly draftSecondaryBuildId: WritableSignal<string>;
  readonly fillValue: string;
  readonly showWeaponsHint: Signal<boolean>;
  buildBlockReason(buildId: number): string | null;
  toggleJoinForm(): void;
  loadParticipationGuilds(): Promise<void>;
  onJoinSubmit(submit: SubmitEvent): Promise<void>;
  confirmJoin(): Promise<void>;
}

describe('EventDetailPage guild attribution', () => {
  const submitEvent = { preventDefault: () => undefined } as SubmitEvent;

  // The join flow opens `<app-dialog>`, whose open-state effect calls the native
  // `showModal()`; the test DOM lacks it, so stub it the same way `dialog.spec.ts` does.
  beforeEach(() => {
    if (typeof HTMLDialogElement === 'undefined') return;
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
  });

  function createPage(options: {
    tenantKind: string;
    guilds?: ParticipationGuildOption[] | Error;
    /** Use the real ApiService (and its envelope unwrapping) over HttpTestingController. */
    realApi?: boolean;
    signupOptions?: EventSignupOptions | Error;
  }): {
    page: EventDetailGuildAttributionAccess;
    fixture: { nativeElement: HTMLElement; detectChanges(): void };
    get: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
    patch: ReturnType<typeof vi.fn>;
  } {
    const get = vi.fn((path: string) => {
      if (path.endsWith('/participation-guilds')) {
        return options.guilds instanceof Error ? throwError(() => options.guilds) : of(options.guilds ?? []);
      }
      if (path.endsWith('/signup-options') && options.signupOptions) {
        return options.signupOptions instanceof Error
          ? throwError(() => options.signupOptions)
          : of(options.signupOptions);
      }
      return of({ items: [] });
    });
    const post = vi.fn().mockReturnValue(of({}));
    const patch = vi.fn().mockReturnValue(of({}));
    const profile = signal({ user_id: 7, tenant_kind: options.tenantKind });

    TestBed.configureTestingModule({
      imports: [EventDetailPage],
      providers: [
        ...(options.realApi
          ? [
              provideHttpClient(),
              provideHttpClientTesting(),
              { provide: API_BASE_URL, useValue: '' },
            ]
          : [{ provide: ApiService, useValue: { get, post, patch, delete: () => of({}) } }]),
        {
          provide: AuthService,
          useValue: {
            hasPermission: () => false,
            profile,
          },
        },
        {
          provide: ActivatedRoute,
          useValue: { paramMap: of(convertToParamMap({ id: '5' })) },
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
    const page = fixture.componentInstance as unknown as EventDetailGuildAttributionAccess;
    page.event.set({ id: 5, participants: [], battles: [], splits: [] } as unknown as EventDetailView);
    return { page, fixture, get, post, patch };
  }

  it('in a guild tenant, signs up without a guild prompt or guild_tenant_id', async () => {
    const { page, get, post } = createPage({ tenantKind: 'guild' });

    page.toggleJoinForm();
    await Promise.resolve();

    expect(page.participationGuildsState()).toBe('idle');
    expect(get).not.toHaveBeenCalledWith(expect.stringContaining('participation-guilds'));

    page.draftPrimaryBuildId.set('7');
    await page.onJoinSubmit(submitEvent);
    expect(page.showJoinConfirm()).toBe(true);
    await page.confirmJoin();

    expect(post).toHaveBeenCalledWith('api/events/5/participate', expect.anything());
  });

  it('in an alliance tenant with zero eligible guilds, blocks signup with an actionable state', async () => {
    const { page } = createPage({ tenantKind: 'alliance', guilds: [] });

    page.toggleJoinForm();
    await vi.waitFor(() => expect(page.participationGuildsState()).toBe('ready'));

    expect(page.participationGuilds()).toHaveLength(0);
    expect(page.guildChoiceBlocked()).toBe(true);
    expect(page.requiresGuildChoice()).toBe(false);
  });

  it('in an alliance tenant with one guild, preselects it and submits it automatically', async () => {
    const { page, post } = createPage({
      tenantKind: 'alliance',
      guilds: [{ tenant_id: 'g1', name: 'Alpha' }],
    });

    page.toggleJoinForm();
    await vi.waitFor(() => expect(page.participationGuildsState()).toBe('ready'));

    expect(page.selectedGuildTenantId()).toBe('g1');
    expect(page.requiresGuildChoice()).toBe(false);
    expect(page.guildChoiceBlocked()).toBe(false);

    page.draftPrimaryBuildId.set('7');
    await page.onJoinSubmit(submitEvent);
    await page.confirmJoin();

    expect(post).toHaveBeenCalledWith(
      'api/events/5/participate?guild_tenant_id=g1',
      expect.anything(),
    );
  });

  it('in an alliance tenant with multiple guilds, requires an explicit choice before signup', async () => {
    const { page, post } = createPage({
      tenantKind: 'alliance',
      guilds: [
        { tenant_id: 'g1', name: 'Alpha' },
        { tenant_id: 'g2', name: 'Beta' },
      ],
    });

    page.toggleJoinForm();
    await vi.waitFor(() => expect(page.participationGuildsState()).toBe('ready'));

    expect(page.requiresGuildChoice()).toBe(true);
    expect(page.selectedGuildTenantId()).toBe('');

    page.draftPrimaryBuildId.set('7');
    await page.onJoinSubmit(submitEvent);
    expect(page.showJoinConfirm()).toBe(false);
    expect(page.joinError()).toBe('events.detail.join_guild_required');

    page.selectedGuildTenantId.set('g2');
    page.joinError.set(null);
    await page.onJoinSubmit(submitEvent);
    expect(page.showJoinConfirm()).toBe(true);
    await page.confirmJoin();

    expect(post).toHaveBeenCalledWith(
      'api/events/5/participate?guild_tenant_id=g2',
      expect.anything(),
    );
  });

  it('labels the custom guild picker and associates its help text', async () => {
    const { page, fixture } = createPage({
      tenantKind: 'alliance',
      guilds: [
        { tenant_id: 'g1', name: 'Alpha' },
        { tenant_id: 'g2', name: 'Beta' },
      ],
    });
    page.toggleJoinForm();
    await vi.waitFor(() => expect(page.participationGuildsState()).toBe('ready'));
    fixture.detectChanges();

    const trigger = fixture.nativeElement.querySelector(
      'app-select button[role="combobox"]',
    );
    expect(trigger?.getAttribute('aria-labelledby')).toBe('join-guild-choice-title');
    expect(trigger?.getAttribute('aria-describedby')).toBe('join-guild-choice-hint');
  });

  it('in an alliance tenant, surfaces a guild-list backend failure and stays blocked', async () => {
    const { page } = createPage({ tenantKind: 'alliance', guilds: new Error('boom') });

    page.toggleJoinForm();
    await vi.waitFor(() => expect(page.participationGuildsState()).toBe('error'));

    expect(page.participationGuilds()).toHaveLength(0);
    expect(page.selectedGuildTenantId()).toBe('');
    expect(page.guildChoiceBlocked()).toBe(true);
  });

  it('loads the participation guilds through the real API envelope (bare array after unwrapping)', async () => {
    const { page } = createPage({ tenantKind: 'alliance', realApi: true });
    const http = TestBed.inject(HttpTestingController);

    page.toggleJoinForm();
    http
      .expectOne('/api/events/5/participation-guilds')
      .flush({ status: 'success', data: [{ tenant_id: 'g1', name: 'Alpha' }] });
    await vi.waitFor(() => expect(page.participationGuildsState()).toBe('ready'));

    expect(page.participationGuilds()).toEqual([{ tenant_id: 'g1', name: 'Alpha' }]);
    expect(page.selectedGuildTenantId()).toBe('g1');
    expect(page.guildChoiceBlocked()).toBe(false);
  });

  describe('weapon gating', () => {
    function signupOptions(hasDeclaredWeapons: boolean): EventSignupOptions {
      const build = (build_id: number, availability: EventSignupOptions['builds'][number]['availability']) => ({
        build_id,
        name: `Build ${build_id}`,
        role: 'dps' as const,
        quantity: 1,
        weapon_key: `weapon:W${build_id}`,
        weapon_name: `Weapon ${build_id}`,
        availability,
      });
      return {
        active_comp_id: 1,
        active_comp_name: 'Comp',
        active_comp_capacity: 20,
        is_already_registered: false,
        has_declared_weapons: hasDeclaredWeapons,
        builds: [build(7, 'allowed'), build(8, 'not_declared'), build(9, 'locked')],
        parties: [],
      };
    }

    it('explains why a build is unavailable and leaves the others open', async () => {
      const { page, get } = createPage({ tenantKind: 'guild', signupOptions: signupOptions(true) });

      page.toggleJoinForm();
      await vi.waitFor(() => expect(get).toHaveBeenCalledWith('api/events/5/signup-options'));
      await vi.waitFor(() => expect(page.buildBlockReason(8)).not.toBeNull());

      expect(page.buildBlockReason(7)).toBeNull();
      expect(page.buildBlockReason(8)).toBe('events.detail.build_not_declared');
      expect(page.buildBlockReason(9)).toBe('events.detail.build_locked');
      expect(page.showWeaponsHint()).toBe(false);
    });

    it('refuses a blocked primary or secondary build but always accepts Fill', async () => {
      const { page } = createPage({ tenantKind: 'guild', signupOptions: signupOptions(true) });
      page.toggleJoinForm();
      await vi.waitFor(() => expect(page.buildBlockReason(8)).not.toBeNull());

      page.draftPrimaryBuildId.set('8');
      await page.onJoinSubmit(submitEvent);
      expect(page.showJoinConfirm()).toBe(false);
      expect(page.joinError()).toBe('events.detail.build_not_declared');

      page.joinError.set(null);
      page.draftPrimaryBuildId.set('7');
      page.draftSecondaryBuildId.set('9');
      await page.onJoinSubmit(submitEvent);
      expect(page.showJoinConfirm()).toBe(false);
      expect(page.joinError()).toBe('events.detail.build_locked');

      page.joinError.set(null);
      page.draftPrimaryBuildId.set(page.fillValue);
      page.draftSecondaryBuildId.set('');
      await page.onJoinSubmit(submitEvent);
      expect(page.showJoinConfirm()).toBe(true);
    });

    it('nudges a member who declared nothing towards My weapons', async () => {
      const { page } = createPage({ tenantKind: 'guild', signupOptions: signupOptions(false) });

      page.toggleJoinForm();
      await vi.waitFor(() => expect(page.showWeaponsHint()).toBe(true));
    });

    it('leaves every build selectable when the options cannot be loaded', async () => {
      const { page, get } = createPage({ tenantKind: 'guild', signupOptions: new Error('boom') });

      page.toggleJoinForm();
      await vi.waitFor(() => expect(get).toHaveBeenCalledWith('api/events/5/signup-options'));

      expect(page.buildBlockReason(8)).toBeNull();
      expect(page.showWeaponsHint()).toBe(false);
    });
  });

  it('links a split to the event with PATCH (the splits API has no PUT route)', async () => {
    const { page, patch } = createPage({ tenantKind: 'guild' });

    await page.onSplitSelected({ id: 77 });

    expect(patch).toHaveBeenCalledWith('api/splits/77', { event_id: expect.any(Number) });
  });

  it('unlinks a split from the event with PATCH and a null event_id', async () => {
    const { page, patch } = createPage({ tenantKind: 'guild' });

    await page.performUnlinkSplit(77);

    expect(patch).toHaveBeenCalledWith('api/splits/77', { event_id: null });
  });
});

interface EventDetailWeaponBoardAccess {
  readonly rosterSnapshot: WritableSignal<EventRosterView | null>;
  readonly rosterAssignTarget: WritableSignal<EventRosterSeat | null>;
  readonly filteredRosterBench: Signal<readonly EventParticipant[]>;
  benchFit(member: EventParticipant): { tone: string; label: string; icon: string | null } | null;
  seatWarning(seat: EventRosterSeat): 'locked' | 'not_declared' | null;
}

describe('EventDetailPage weapon fit on the Parties board', () => {
  const POLE = 'weapon:2H_POLEHAMMER';
  const HOLY = 'weapon:MAIN_HOLYSTAFF';

  function createPage(): EventDetailWeaponBoardAccess {
    TestBed.configureTestingModule({
      imports: [EventDetailPage],
      providers: [
        { provide: ApiService, useValue: { get: () => of({ items: [] }) } },
        {
          provide: AuthService,
          useValue: { hasPermission: () => true, profile: () => ({ user_id: 1 }) },
        },
        { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ id: '1' })) } },
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
    return fixture.componentInstance as unknown as EventDetailWeaponBoardAccess;
  }

  function member(
    userId: number,
    weapons: EventRosterParticipant['weapons'],
  ): EventRosterParticipant {
    return {
      user_id: userId,
      username: `Member ${userId}`,
      discord_id: null,
      weapons,
      primary_build_id: 1,
      primary_build_name: 'Build 1',
      secondary_build_id: null,
      secondary_build_name: null,
    };
  }

  function weaponSeat(
    weaponKey: string | null,
    occupant: EventRosterParticipant | null,
  ): EventRosterSeat {
    return { ...seat(1, 1, null), weapon_key: weaponKey, participant: occupant };
  }

  it('orders the waiting list by fit for the picked seat and shows the level on each card', () => {
    const page = createPage();
    const locked = member(1, [{ weapon_key: POLE, proficiency: 'main', locked: true }]);
    const none = member(2, []);
    const basic = member(3, [{ weapon_key: POLE, proficiency: 'basic', locked: false }]);
    const main = member(4, [{ weapon_key: POLE, proficiency: 'main', locked: false }]);
    const other = member(5, [{ weapon_key: HOLY, proficiency: 'main', locked: false }]);
    const target = weaponSeat(POLE, null);
    page.rosterSnapshot.set({
      event_id: 1,
      roster_version: 1,
      active_comp_id: 1,
      seats: [target],
      bench: [locked, none, basic, main, other],
      parties: [],
    });

    expect(page.filteredRosterBench().map((entry) => entry.user_id)).toEqual([1, 2, 3, 4, 5]);
    expect(page.benchFit(main as EventParticipant)).toBeNull();

    page.rosterAssignTarget.set(target);

    expect(page.filteredRosterBench().map((entry) => entry.user_id)).toEqual([4, 3, 2, 5, 1]);
    expect(page.benchFit(main as EventParticipant)).toMatchObject({
      tone: 'success',
      label: 'weapons.proficiency.main',
    });
    expect(page.benchFit(other as EventParticipant)).toMatchObject({
      tone: 'warning',
      label: 'weapons.notDeclared',
    });
    expect(page.benchFit(locked as EventParticipant)).toMatchObject({
      tone: 'error',
      label: 'weapons.locked',
      icon: 'lock',
    });
  });

  it('warns on a seat held by someone who locked or never declared its weapon', () => {
    const page = createPage();
    const lockedOccupant = member(1, [{ weapon_key: POLE, proficiency: null, locked: true }]);
    const undeclaredOccupant = member(2, [{ weapon_key: HOLY, proficiency: 'good', locked: false }]);
    const fineOccupant = member(3, [{ weapon_key: POLE, proficiency: 'basic', locked: false }]);
    const newcomer = member(4, []);

    expect(page.seatWarning(weaponSeat(POLE, lockedOccupant))).toBe('locked');
    expect(page.seatWarning(weaponSeat(POLE, undeclaredOccupant))).toBe('not_declared');
    expect(page.seatWarning(weaponSeat(POLE, fineOccupant))).toBeNull();
    expect(page.seatWarning(weaponSeat(POLE, newcomer))).toBeNull();
    expect(page.seatWarning(weaponSeat(null, lockedOccupant))).toBeNull();
    expect(page.seatWarning(weaponSeat(POLE, null))).toBeNull();
  });
});
