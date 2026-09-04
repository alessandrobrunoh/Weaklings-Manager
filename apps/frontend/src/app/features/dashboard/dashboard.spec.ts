import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { NotificationService } from '../../core/services/notification.service';
import { TranslateService } from '../../core/services/translate.service';
import { Dashboard, selectNextMass } from './dashboard';
import type { EventView } from '../../core/models/api.models';

describe('Dashboard', () => {
  let fixture: ComponentFixture<Dashboard>;
  let component: Dashboard;

  const mockApiService = {
    get: vi.fn().mockReturnValue(of({ items: [], total_items: 0, total_pages: 0, current_page: 1, limit: 10 })),
  };

  const mockAuthService = {
    profile: vi.fn().mockReturnValue({
      id: '123456',
      username: 'Galvdon',
      avatar: null,
      highest_role: 'Guild Master',
      permissions: ['bank.withdraw.accept'],
    }),
    hasPermission: vi.fn().mockImplementation((perm: string) => perm === 'bank.withdraw.accept'),
  };

  const mockNotificationService = {
    unreadCount: vi.fn().mockReturnValue(2),
    loading: vi.fn().mockReturnValue(false),
    error: vi.fn().mockReturnValue(null),
    items: vi.fn().mockReturnValue([]),
    loadInbox: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Dashboard],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: ApiService, useValue: mockApiService },
        { provide: AuthService, useValue: mockAuthService },
        { provide: NotificationService, useValue: mockNotificationService },
        TranslateService,
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(Dashboard);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('renders the personalized greeting with the username', () => {
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Galvdon');
    expect(text).toContain("Here's what's happening with Weaklings.");
  });

  it('renders all four KPI stat cards with correct titles', () => {
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Bank requested');
    expect(text).toContain('Splits completed');
    expect(text).toContain('Splits pending');
    expect(text).toContain('Season paid out');
  });

  it('renders the "Requires your attention" panel with alerts and caught up banner', () => {
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Requires your attention');
    expect(text).toContain('bank request awaiting approval');
    expect(text).toContain('split still needs to be completed');
    expect(text).toContain("You're all caught up!");
  });

  it('renders the "Next mass" section with date, event details, and CTA', () => {
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Next mass');
    expect(text).toContain('Launch Terry Grove');
    expect(text).toContain('Brawl 10v10');
    expect(text).toContain('Composition ready');
    expect(text).toContain('Build assigned');
    expect(text).toContain('Open event');
  });


  it('formats numbers to compact silver notation correctly', () => {
    expect(component.formatCompactSilver(1_700_000)).toBe('1.70M');
    expect(component.formatCompactSilver(40_820_000)).toBe('40.82M');
    expect(component.formatCompactSilver(10_800_000, true)).toBe('+10.80M');
    expect(component.formatCompactSilver(500)).toBe('500');
    expect(component.formatCompactSilver(null)).toBe('—');
  });

  it('shows the next mass of the day at its first (mass) time, not a later start', () => {
    const now = new Date('2026-09-04T10:00:00Z');
    const laterStart: EventView = eventFixture({
      id: 99,
      title: 'Night ZvZ',
      mass_time_utc: '2026-09-10T21:30:00Z',
      start_time_utc: '2026-09-10T22:00:00Z',
      event_date_utc: '2026-09-10T22:00:00Z',
      status: 'scheduled',
    });
    const firstToday: EventView = eventFixture({
      id: 7,
      title: 'Outposts',
      mass_time_utc: '2026-09-04T19:30:00Z',
      start_time_utc: '2026-09-04T20:00:00Z',
      event_date_utc: '2026-09-04T20:00:00Z',
      status: 'scheduled',
    });
    const secondToday: EventView = eventFixture({
      id: 8,
      title: 'Evening CTA',
      mass_time_utc: '2026-09-04T21:30:00Z',
      start_time_utc: '2026-09-04T22:00:00Z',
      event_date_utc: '2026-09-04T22:00:00Z',
      status: 'scheduled',
    });

    expect(selectNextMass([laterStart, secondToday, firstToday], now)?.id).toBe(7);

    const duringFirstMass = new Date('2026-09-04T19:45:00Z');
    expect(selectNextMass([laterStart, secondToday, firstToday], duringFirstMass)?.id).toBe(7);

    const afterFirstStart = new Date('2026-09-04T20:05:00Z');
    expect(selectNextMass([laterStart, secondToday, firstToday], afterFirstStart)?.id).toBe(8);
  });

  it('keeps a live mass as next even after its mass time has passed', () => {
    const now = new Date('2026-09-04T21:50:00Z');
    const live = eventFixture({
      id: 3,
      title: 'Live mass',
      status: 'live',
      mass_time_utc: '2026-09-04T21:30:00Z',
      start_time_utc: '2026-09-04T22:00:00Z',
      event_date_utc: '2026-09-04T22:00:00Z',
    });
    const later = eventFixture({
      id: 4,
      title: 'Tomorrow',
      status: 'scheduled',
      mass_time_utc: '2026-09-05T21:30:00Z',
      start_time_utc: '2026-09-05T22:00:00Z',
      event_date_utc: '2026-09-05T22:00:00Z',
    });
    expect(selectNextMass([later, live], now)?.id).toBe(3);
  });

  it('renders the selected mass time on the dashboard card', () => {
    const firstToday = eventFixture({
      id: 7,
      title: 'Outposts',
      mass_time_utc: '2026-09-04T19:30:00Z',
      start_time_utc: '2026-09-04T20:00:00Z',
      event_date_utc: '2026-09-04T20:00:00Z',
      status: 'scheduled',
      comp_name: 'Kite 20',
    });
    (component as Dashboard & { recentEvents: { set(events: EventView[]): void } }).recentEvents.set([
      firstToday,
    ]);
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Outposts');
    expect(text).toContain('Kite 20');
    const expectedTime = new Date('2026-09-04T19:30:00Z').toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    expect(text).toContain(expectedTime);
    expect(text).not.toContain(
      new Date('2026-09-04T20:00:00Z').toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }),
    );
  });
});

function eventFixture(overrides: Partial<EventView> & Pick<EventView, 'id' | 'title' | 'status'>): EventView {
  return {
    description: null,
    call_to_arms: false,
    discord_role_ids: [],
    regear: false,
    comp_id: 1,
    comp_name: 'Main ZvZ',
    created_by: 1,
    created_by_username: 'Officer',
    created_at: '2026-09-01T10:00:00Z',
    updated_at: '2026-09-01T10:00:00Z',
    started_at: null,
    stopped_at: null,
    auto_stop_deadline: null,
    link_status: 'pending',
    link_attempts: 0,
    link_last_error: null,
    link_battles_completed_at: null,
    event_date_utc: '2026-09-04T22:00:00Z',
    mass_time_utc: '2026-09-04T21:30:00Z',
    start_time_utc: '2026-09-04T22:00:00Z',
    ...overrides,
  };
}
