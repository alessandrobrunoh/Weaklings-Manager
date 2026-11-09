import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { EventView } from '../../core/models/api.models';
import { Events } from './events';

describe('Events', () => {
  let fixture: ComponentFixture<Events>;
  let component: Events;
  let currentUserId: number | undefined;
  let currentPermissions: Set<string>;
  let showModalDescriptor: PropertyDescriptor | undefined;

  const mockEvents = [
    {
      id: 1,
      title: 'Outposts',
      comp_name: 'Kite 20 Vs',
      event_date_utc: '2026-09-03T22:00:00Z',
      mass_time_utc: '2026-09-03T21:30:00Z',
      start_time_utc: '2026-09-03T22:00:00Z',
      status: 'scheduled',
      call_to_arms: false,
      regear: true,
      created_by: 100,
      created_by_username: 'Galvdon',
      source_tenant_id: 'source-guild',
      source_event_id: 88,
    },
    {
      id: 2,
      title: 'FRATELLI E SORELLE',
      comp_name: 'Brawl 10Vs',
      event_date_utc: '2026-09-01T22:00:00Z',
      mass_time_utc: '2026-09-01T21:30:00Z',
      start_time_utc: '2026-09-01T22:00:00Z',
      status: 'stopped',
      call_to_arms: true,
      regear: false,
      created_by: 100,
      created_by_username: 'Galvdon',
    },
    {
      id: 3,
      title: 'outpost',
      comp_name: 'Brawl 10Vs',
      event_date_utc: '2026-09-02T12:20:00Z',
      mass_time_utc: '2026-09-02T11:50:00Z',
      start_time_utc: '2026-09-02T12:20:00Z',
      status: 'cancelled',
      call_to_arms: false,
      regear: false,
      created_by: 200,
      created_by_username: 'Officer',
    },
  ];

  const mockApiService = {
    get: vi.fn().mockImplementation((path: string) => {
      if (path === 'api/events') {
        return of({
          items: mockEvents,
          total_items: 17,
          total_pages: 2,
          current_page: 1,
          limit: 10,
        });
      }
      if (path === 'api/events/summary') {
        return of({ total: 130, live: 3, scheduled: 127, call_to_arms: 13 });
      }
      return of([]);
    }),
    delete: vi.fn().mockReturnValue(of({})),
    post: vi.fn().mockReturnValue(of({})),
  };

  const mockAuthService = {
    hasPermission: vi.fn((permission: string) => currentPermissions.has(permission)),
    profile: () => ({ tenant_kind: 'guild', user_id: currentUserId }),
  };

  const mockToastService = {
    success: vi.fn(),
    error: vi.fn(),
  };

  beforeEach(async () => {
    showModalDescriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
    currentUserId = 100;
    currentPermissions = new Set(['events.create', 'events.edit', 'events.delete', 'events.manage']);
    await TestBed.configureTestingModule({
      imports: [Events],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: ApiService, useValue: mockApiService },
        { provide: AuthService, useValue: mockAuthService },
        { provide: ToastService, useValue: mockToastService },
        TranslateService,
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(Events);
    component = fixture.componentInstance;
    await (component as any).load();
    await (component as any).loadStats();
    fixture.detectChanges();
    await fixture.whenStable();
  });

  afterEach(() => {
    fixture.destroy();
    if (showModalDescriptor) {
      Object.defineProperty(HTMLDialogElement.prototype, 'showModal', showModalDescriptor);
    } else {
      Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
    }
  });

  it('updates create options and reveals split settings when selected', () => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value: function (this: HTMLDialogElement) { this.open = true; },
    });
    (component as any).openCreate();
    fixture.detectChanges();
    const split: HTMLInputElement = fixture.nativeElement.querySelector('#event-create-split');
    const cta: HTMLInputElement = fixture.nativeElement.querySelector('#event-call-to-arms');
    const vodForumPost: HTMLInputElement = fixture.nativeElement.querySelector('#event-vod-forum-post');
    expect(split.checked).toBe(false);
    expect(vodForumPost.checked).toBe(true);
    expect(fixture.nativeElement.textContent).not.toContain('Select island');
    split.click();
    cta.click();
    fixture.detectChanges();
    expect((component as any).draftCreateSplit()).toBe(true);
    expect((component as any).draftCallToArms()).toBe(true);
    expect(fixture.nativeElement.textContent).toContain('Select island');
    split.click();
    fixture.detectChanges();
    expect((component as any).draftCreateSplit()).toBe(false);
    expect(fixture.nativeElement.textContent).not.toContain('Select island');
  });

  it('marks required event fields and conditional split fields', () => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value: function (this: HTMLDialogElement) { this.open = true; },
    });
    (component as any).openCreate();
    fixture.detectChanges();
    const form: HTMLFormElement = fixture.nativeElement.querySelector('#create-event-form');
    expect(form.textContent).toContain('* indicates a required field.');
    const required = Array.from(form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[required], select[required]'));
    expect(required).toHaveLength(5);
    for (const control of required) {
      const marker = control.labels?.[0]?.querySelector<HTMLElement>('[aria-hidden="true"]');
      expect(marker?.textContent).toBe('*');
      expect(marker?.getAttribute('style')).toContain('var(--color-error)');
    }
    expect(form.querySelector<HTMLTextAreaElement>('textarea')?.required).toBe(false);
    expect(form.querySelector<HTMLInputElement>('#event-player-cap')?.required).toBe(false);

    form.querySelector<HTMLInputElement>('#event-create-split')!.click();
    fixture.detectChanges();
    const selects = Array.from(form.querySelectorAll<HTMLSelectElement>('select[required]'));
    expect(selects).toHaveLength(3);
    for (const control of selects) {
      expect(control.labels?.[0]?.querySelector('[aria-hidden="true"]')?.textContent).toBe('*');
    }
    expect((selects[2] as HTMLSelectElement).disabled).toBe(true);
    form.querySelector<HTMLInputElement>('#event-create-split')!.click();
    fixture.detectChanges();
    expect(form.querySelectorAll('select[required]')).toHaveLength(1);
  });

  it('renders the 4 KPI stat cards with correct titles', () => {
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('TOTAL EVENTS');
    expect(text).toContain('LIVE EVENTS');
    expect(text).toContain('Scheduled');
    expect(text).toContain('CALL TO ARMS');
  });

  it('labels synchronized read-only events in the list', () => {
    expect(fixture.nativeElement.textContent).toContain('Read-only copy');
  });

  it('renders the search box and status dropdown', () => {
    const searchInput = fixture.nativeElement.querySelector('input[placeholder="Search events..."]');
    expect(searchInput).toBeTruthy();

    const select = fixture.nativeElement.querySelector(
      'app-select button[role="combobox"]',
    );
    expect(select).toBeTruthy();
  });

  it('renders a status column filter instead of status tabs', () => {
    const triggers = Array.from(
      fixture.nativeElement.querySelectorAll(
        'app-select button[role="combobox"]',
      ) as NodeListOf<HTMLButtonElement>,
    );
    const statusTrigger = triggers.find((trigger) =>
      trigger.getAttribute('aria-label')?.toLowerCase().includes('status'),
    );
    expect(statusTrigger).toBeTruthy();
    statusTrigger!.click();
    fixture.detectChanges();
    const options = Array.from(
      fixture.nativeElement.querySelectorAll(
        'app-select [role="option"]',
      ) as NodeListOf<HTMLElement>,
      (option) => option.textContent ?? '',
    ).join(' ');
    expect(options).toContain('Live');
    expect(options).toContain('Scheduled');
    expect(options).toContain('Stopped');
    expect(options).toContain('Cancelled');
    expect(fixture.nativeElement.querySelectorAll('nav button').length).toBe(0);
  });

  it('renders the table headers correctly', () => {
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('EVENT');
    expect(text).toContain('DATE');
    expect(text).toContain('COMPOSITION');
    expect(text).toContain('STATUS');
    expect(text).toContain('ACTIONS');
  });

  it('renders event rows with CTA star, mass time, comp name, status pills, and action buttons', () => {
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Outposts');
    expect(text).toContain('Kite 20 Vs');
    expect(text).toContain('FRATELLI E SORELLE');
    expect(text).toContain('★');
    expect(text).toContain('Scheduled');
    expect(text).toContain('Cancelled');
    expect(text).toContain('Stopped');
    expect(text).toContain('Open');
    expect(text).toContain('Reopen');
    expect(text).toContain('Join');
    expect(text).toContain('Archive');
  });

  it('allows owners to manage their event but preserves separate permissions for other events', () => {
    currentPermissions = new Set();
    const page = component as unknown as {
      canEdit: (event?: EventView) => boolean;
      canDelete: (event?: EventView) => boolean;
    };

    const ownedEvent = { ...mockEvents[0], source_event_id: undefined, source_tenant_id: undefined } as EventView;
    expect(page.canEdit(ownedEvent)).toBe(true);
    expect(page.canDelete(ownedEvent)).toBe(true);
    expect(page.canEdit(mockEvents[0] as EventView)).toBe(false);
    expect(page.canDelete(mockEvents[0] as EventView)).toBe(false);
    const detachedCopy = {
      ...mockEvents[0],
      is_synchronized_copy: false,
    } as EventView;
    expect(page.canEdit(detachedCopy)).toBe(true);
    expect(page.canDelete(detachedCopy)).toBe(true);
    expect(page.canEdit(mockEvents[2] as EventView)).toBe(false);
    expect(page.canDelete(mockEvents[2] as EventView)).toBe(false);

    // edit/delete cover the holder's own events only; they never reach somebody else's.
    currentPermissions = new Set(['events.edit', 'events.delete']);
    expect(page.canEdit(mockEvents[2] as EventView)).toBe(false);
    expect(page.canDelete(mockEvents[2] as EventView)).toBe(false);

    // events.manage is the administrator override.
    currentPermissions = new Set(['events.manage']);
    expect(page.canEdit(mockEvents[2] as EventView)).toBe(true);
    expect(page.canDelete(mockEvents[2] as EventView)).toBe(true);
  });

  it('takes the stat tiles from the backend summary, not from one page of events', () => {
    const page = component as any;
    expect(mockApiService.get).toHaveBeenCalledWith('api/events/summary');
    expect(page.totalEventsCount()).toBe(130);
    expect(page.liveEventsCount()).toBe(3);
    expect(page.scheduledEventsCount()).toBe(127);
    expect(page.ctaEventsCount()).toBe(13);
  });

  it('renders the pagination footer with correct item counts and page buttons', () => {
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Showing 1 to 10 of 17 events');
    expect(text).toContain('10 per page');
  });

  it('hides the alliance Discord ping checkbox when the guild is not in an alliance', async () => {
    mockApiService.get.mockImplementation((path: string) => {
      if (path === 'api/events') {
        return of({
          items: mockEvents,
          total_items: 17,
          total_pages: 2,
          current_page: 1,
          limit: 10,
        });
      }
      if (path === 'api/alliances/me') {
        return of({ kind: 'guild', alliance_id: null, alliance_name: null, membership_status: null, members: [] });
      }
      if (path === 'api/comps') {
        return of({ items: [], total_items: 0, total_pages: 0, current_page: 1, limit: 100 });
      }
      if (path === 'api/splits/islands') {
        return of([]);
      }
      if (path === 'api/events/discord-roles') {
        return of([]);
      }
      return of([]);
    });
    await (component as any).loadCreateOptions();
    expect((component as any).allianceId()).toBeNull();
    expect((component as any).canPingAlliance()).toBe(false);
    expect((component as any).draftPingAlliance()).toBe(false);
  });

  it('shows the alliance Discord ping checkbox off by default for a guild in an alliance', async () => {
    mockApiService.get.mockImplementation((path: string) => {
      if (path === 'api/events') {
        return of({
          items: mockEvents,
          total_items: 17,
          total_pages: 2,
          current_page: 1,
          limit: 10,
        });
      }
      if (path === 'api/alliances/me') {
        return of({
          kind: 'guild',
          alliance_id: 'alliance-1',
          alliance_name: 'Allies',
          membership_status: 'active',
          members: [],
        });
      }
      if (path === 'api/comps') {
        return of({ items: [], total_items: 0, total_pages: 0, current_page: 1, limit: 100 });
      }
      if (path === 'api/splits/islands') {
        return of([]);
      }
      if (path === 'api/events/discord-roles') {
        return of([]);
      }
      return of([]);
    });
    await (component as any).loadCreateOptions();
    expect((component as any).allianceId()).toBe('alliance-1');
    expect((component as any).canPingAlliance()).toBe(true);
    expect((component as any).draftPingAlliance()).toBe(false);
  });
  it('keys alliance islands by member guild so equal ids from two guilds stay distinct', () => {
    const island = (guild: string | null, name: string) => ({
      id: 1,
      name,
      city: 'lymhurst',
      tabs: [{ id: 5, name: 'Loot', sort_order: 0 }],
      source_guild_tenant_id: guild,
    });
    (component as any).islands.set([island('guild-a', 'HQ A'), island('guild-b', 'HQ B')]);
    (component as any).draftIslandId.set('guild-b|1');
    expect((component as any).draftIsland().name).toBe('HQ B');
    expect((component as any).draftIsland().source_guild_tenant_id).toBe('guild-b');

    (component as any).islands.set([island(null, 'Own HQ')]);
    (component as any).draftIslandId.set('1');
    expect((component as any).draftIsland().name).toBe('Own HQ');
    expect((component as any).draftTabs()).toHaveLength(1);
  });
});
