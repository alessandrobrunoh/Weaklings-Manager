import { signal, type Signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { NEVER, of } from 'rxjs';
import { describe, expect, it } from 'vitest';

import type { EventRosterSeat, EventRosterView } from '../../core/models/api.models';
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
}

function seat(partyNumber: number, position: number, userId: number | null): EventRosterSeat {
  return {
    key: `${partyNumber}:${position}`,
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
        { provide: ApiService, useValue: { get: () => of({ items: [] }) } },
        {
          provide: AuthService,
          useValue: { hasPermission: () => false, profile: () => ({ user_id: 42 }) },
        },
        {
          provide: ActivatedRoute,
          useValue: { paramMap: of(convertToParamMap({})) },
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
});
