import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
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
      if (path === 'api/comps') {
        return of({ items: [], total_items: 0, total_pages: 0, current_page: 1, limit: 100 });
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

  function openCreateDialog(): HTMLFormElement {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value: function (this: HTMLDialogElement) { this.open = true; },
    });
    (component as any).openCreate();
    fixture.detectChanges();
    return fixture.nativeElement.querySelector('#create-event-form');
  }

  function submitCreate(): Promise<void> {
    return (component as any).onCreateSubmit(new Event('submit', { cancelable: true }));
  }

  it('updates create options and reveals split settings when selected', () => {
    const form = openCreateDialog();
    const split: HTMLInputElement = form.querySelector('#event-create-split')!;
    const cta: HTMLInputElement = form.querySelector('#event-call-to-arms')!;
    expect(split.checked).toBe(false);
    expect(form.querySelector('#event-island')).toBeNull();
    split.click();
    cta.click();
    fixture.detectChanges();
    expect((component as any).draftCreateSplit()).toBe(true);
    expect((component as any).draftCallToArms()).toBe(true);
    expect(form.querySelector('#event-island')).toBeTruthy();
    expect(form.textContent).toContain('Select island');
    split.click();
    fixture.detectChanges();
    expect((component as any).draftCreateSplit()).toBe(false);
    expect(form.querySelector('#event-island')).toBeNull();
  });

  it('groups the dialog into labelled sections', () => {
    const form = openCreateDialog();
    const headings = Array.from(form.querySelectorAll('section > h3, section > div > h3'), (h) =>
      h.textContent?.replace(/\s+/g, ' ').trim(),
    );
    expect(headings).toHaveLength(5);
    expect(headings[0]).toBe('Details');
    expect(headings[1]).toBe('Schedule');
    expect(headings[2]).toBe('Roster');
    expect(headings[3]).toContain('Discord');
    expect(headings[4]).toBe('Extras');
    for (const section of Array.from(form.querySelectorAll('section.ev-section'))) {
      expect(section.getAttribute('aria-labelledby')).toBeTruthy();
    }
  });

  it('labels every control and marks the required ones', () => {
    const form = openCreateDialog();
    expect(form.textContent).toContain('* indicates a required field.');
    const required = Array.from(
      form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[required], select[required]'),
    );
    expect(required.map((control) => control.id)).toEqual([
      'event-title',
      'event-date',
      'event-mass-time',
      'event-start-time',
      'event-comp',
    ]);
    for (const control of required) {
      const marker = control.labels?.[0]?.querySelector<HTMLElement>('[aria-hidden="true"]');
      expect(marker?.textContent).toBe('*');
    }
    for (const control of Array.from(form.querySelectorAll<HTMLElement>('input, select, textarea'))) {
      if ((control as HTMLInputElement).type === 'checkbox') continue;
      expect((control as HTMLInputElement).labels?.length, control.id).toBeGreaterThan(0);
    }
    expect(form.querySelector<HTMLTextAreaElement>('textarea')?.required).toBe(false);
    expect(form.querySelector<HTMLInputElement>('#event-player-cap')?.required).toBe(false);

    form.querySelector<HTMLInputElement>('#event-create-split')!.click();
    fixture.detectChanges();
    const splitSelects = Array.from(form.querySelectorAll<HTMLSelectElement>('select[required]')).filter(
      (control) => control.id === 'event-island' || control.id === 'event-tab',
    );
    expect(splitSelects).toHaveLength(2);
    for (const control of splitSelects) {
      expect(control.labels?.[0]?.querySelector('[aria-hidden="true"]')?.textContent).toBe('*');
    }
    expect(splitSelects[1].disabled).toBe(true);
    form.querySelector<HTMLInputElement>('#event-create-split')!.click();
    fixture.detectChanges();
    expect(form.querySelectorAll('select[required]')).toHaveLength(1);
  });

  it('collapses the Discord section and creates the VOD forum post only when asked', () => {
    const form = openCreateDialog();
    const toggle: HTMLButtonElement = form.querySelector('#event-section-discord')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe('event-discord-panel');
    expect(toggle.textContent).toContain('No extra pings or posts');
    expect(form.querySelector('#event-vod-forum-post')).toBeNull();

    toggle.click();
    fixture.detectChanges();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const vodForumPost: HTMLInputElement = form.querySelector('#event-vod-forum-post')!;
    expect(vodForumPost.checked).toBe(false);
    expect((component as any).draftVodForumPost()).toBe(false);

    vodForumPost.click();
    fixture.detectChanges();
    expect((component as any).draftVodForumPost()).toBe(true);
    expect(toggle.textContent).toContain('VOD post');
  });

  it('spells out the timezone next to the mass and start times', () => {
    const form = openCreateDialog();
    const note = form.querySelector('#event-schedule-note')!;
    expect(note.textContent).toContain('Times use your local timezone');
    expect(note.textContent).toContain('In game time (UTC): mass');
    for (const id of ['event-mass-time', 'event-start-time']) {
      expect(form.querySelector(`#${id}`)!.getAttribute('aria-describedby')).toContain(
        'event-schedule-note',
      );
    }
  });

  it('shows inline errors tied to their fields and a validation summary on submit', async () => {
    const form = openCreateDialog();
    mockApiService.post.mockClear();
    expect(form.querySelector('#event-error-summary')).toBeNull();
    expect(form.querySelector('#event-title-error')).toBeNull();

    await submitCreate();
    fixture.detectChanges();

    const summary = form.querySelector<HTMLElement>('#event-error-summary')!;
    expect(summary).toBeTruthy();
    expect(summary.textContent).toContain('Fix the following before creating the event:');
    expect(summary.textContent).toContain('Name: This field is required.');
    expect(summary.textContent).toContain('Composition: Composition is required.');
    const title = form.querySelector<HTMLInputElement>('#event-title')!;
    expect(title.getAttribute('aria-invalid')).toBe('true');
    expect(title.getAttribute('aria-describedby')).toBe('event-title-error');
    expect(form.querySelector('#event-title-error')?.textContent).toContain('This field is required.');
    const comp = form.querySelector<HTMLSelectElement>('#event-comp')!;
    expect(comp.getAttribute('aria-invalid')).toBe('true');
    expect(comp.getAttribute('aria-describedby')).toContain('event-comp-error');
    expect(mockApiService.post).not.toHaveBeenCalled();

    // A second failed attempt puts focus on the (already rendered) summary.
    await submitCreate();
    fixture.detectChanges();
    expect(document.activeElement).toBe(summary);

    // A summary entry moves focus to its field.
    summary.querySelector<HTMLButtonElement>('button')!.click();
    expect(document.activeElement).toBe(title);

    // Errors clear live once the field is fixed.
    (component as any).draftTitle.set('Outposts');
    fixture.detectChanges();
    expect(form.querySelector('#event-title-error')).toBeNull();
    expect(title.getAttribute('aria-invalid')).toBeNull();
  });

  it('rejects past dates, a mass time after the start and an invalid player cap', async () => {
    const form = openCreateDialog();
    mockApiService.post.mockClear();
    const page = component as any;
    page.draftTitle.set('Outposts');
    page.draftCompId.set('7');
    page.draftEventDate.set('2000-01-01');
    page.draftMassTime.set('21:00');
    page.draftStartTime.set('20:00');
    page.draftPlayerCap.set('0');

    await submitCreate();
    fixture.detectChanges();

    expect(form.querySelector('#event-date-error')?.textContent).toContain(
      'The date cannot be in the past.',
    );
    expect(form.querySelector('#event-mass-time-error')?.textContent).toContain(
      'Mass time must be at or before the start time.',
    );
    expect(form.querySelector('#event-player-cap-error')?.textContent).toContain(
      'Player cap must be a whole number greater than zero.',
    );
    expect(form.querySelector('#event-player-cap')!.getAttribute('aria-describedby')).toBe(
      'event-player-cap-hint event-player-cap-error',
    );
    expect(mockApiService.post).not.toHaveBeenCalled();
  });

  it('requires an island tab when a correlated split is requested', async () => {
    const form = openCreateDialog();
    const page = component as any;
    page.draftTitle.set('Outposts');
    page.draftCompId.set('7');
    page.draftCreateSplit.set(true);
    await submitCreate();
    fixture.detectChanges();
    expect(form.querySelector('#event-island-error')).toBeTruthy();
    expect(form.querySelector('#event-tab-error')).toBeNull();
  });

  it('creates the event with the VOD forum post off by default', async () => {
    openCreateDialog();
    const page = component as any;
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    mockApiService.post.mockClear();
    mockApiService.post.mockReturnValueOnce(of({ id: 9 }));
    page.draftTitle.set('  Outposts  ');
    page.draftCompId.set('7');

    await submitCreate();

    expect(mockApiService.post).toHaveBeenCalledTimes(1);
    const [path, body] = mockApiService.post.mock.calls[0];
    expect(path).toBe('api/events');
    expect(body).toMatchObject({
      title: 'Outposts',
      comp_id: 7,
      call_to_arms: false,
      regear: false,
      ping_alliance: false,
      vod_forum_post_enabled: false,
      discord_role_ids: [],
      create_split: false,
    });
    expect(Date.parse(body.mass_time_utc)).toBeLessThanOrEqual(Date.parse(body.start_time_utc));
    expect(navigate).toHaveBeenCalledWith(['/events', 9]);
  });

  it('resets the draft, including the VOD forum post, when the dialog opens again', () => {
    openCreateDialog();
    const page = component as any;
    page.draftVodForumPost.set(true);
    page.discordOpen.set(true);
    page.submitAttempted.set(true);
    page.openCreate();
    expect(page.draftVodForumPost()).toBe(false);
    expect(page.discordOpen()).toBe(false);
    expect(page.submitAttempted()).toBe(false);
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
