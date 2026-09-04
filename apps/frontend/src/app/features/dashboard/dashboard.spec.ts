import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { TranslateService } from '../../core/services/translate.service';
import { Dashboard, selectNextMass } from './dashboard';
import type {
  AlbionLinkStatus,
  BalanceSummary,
  EventView,
  ProgressionMeView,
  UserMetrics,
} from '../../core/models/api.models';

describe('Dashboard', () => {
  let fixture: ComponentFixture<Dashboard>;
  let component: Dashboard;

  const mockBalance: BalanceSummary = {
    user_id: 7,
    pending_total: 1_700_000,
    pending_count: 3,
    requested_total: 400_000,
    requested_count: 1,
  };

  const mockMetrics: UserMetrics = {
    events_total: 20,
    attendance_rate: 80,
    attendance_streak: 3,
    next_event_title: 'Outposts',
    next_event_at: '2026-09-04T19:30:00Z',
    battles_fought: 10,
    kills: 40,
    deaths: 12,
    kill_fame: 100_000,
    regears_claimed: 2,
    regears_pending: 1,
    regears_approved: 1,
    regear_silver: 50_000,
    splits_joined: 5,
    split_earnings: 2_500_000,
    most_played_build: 'Kite',
    events_attended: 16,
    total_estimated_loss: 100_000,
    top_estimated_loss: 20_000,
  };

  const mockProgression: ProgressionMeView = {
    season: {
      id: 1,
      name: 'Season 8',
      starts_at: '2026-01-01T00:00:00Z',
      ends_at: '2026-12-31T00:00:00Z',
      is_active: true,
    },
    level: 12,
    xp: 840,
    xp_to_next: 360,
    next_level_at: 1200,
    rank: 8,
    multiplier: 1,
    lifetime_xp: 9000,
  };

  const mockAlbion: AlbionLinkStatus = {
    linked: true,
    albion_player_name: 'GalvdonAO',
  };

  const mockApiService = {
    get: vi.fn().mockImplementation((path: string) => {
      switch (path) {
        case 'api/bank/balance':
          return of(mockBalance);
        case 'api/users/me/metrics':
          return of(mockMetrics);
        case 'api/progression/me':
          return of(mockProgression);
        case 'api/albion/link/me':
          return of(mockAlbion);
        default:
          return of({ items: [], total_items: 0, total_pages: 0, current_page: 1, limit: 10 });
      }
    }),
  };

  const mockAuthService = {
    profile: vi.fn().mockReturnValue({
      id: '123456',
      username: 'Galvdon',
      avatar: null,
      email: null,
      user_id: 7,
      roles: ['Guild Master'],
      highest_role: 'Guild Master',
      is_superadmin: false,
      permissions: ['bank.withdraw.accept'],
    }),
    hasPermission: vi.fn().mockImplementation((perm: string) => perm === 'bank.withdraw.accept'),
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Dashboard],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: ApiService, useValue: mockApiService },
        { provide: AuthService, useValue: mockAuthService },
        TranslateService,
      ],
    }).compileComponents();

    TestBed.inject(TranslateService).use('en');

    fixture = TestBed.createComponent(Dashboard);
    component = fixture.componentInstance;
    await (component as Dashboard & { refreshNow: () => Promise<void> }).refreshNow();
    fixture.detectChanges();
    await fixture.whenStable();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('renders the personalized greeting with the username', () => {
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Galvdon');
    expect(text).toContain('Your balance, season, and next mass.');
  });

  it('renders personal identity, albion character, and season progress', () => {
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Guild Master');
    expect(text).toContain('GalvdonAO');
    expect(text).toContain('Season 8');
    expect(text).toContain('Level 12');
    expect(text).toContain('Rank #8');
  });

  it('renders personal KPI cards instead of guild totals', () => {
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Bank pending');
    expect(text).toContain('Bank requested');
    expect(text).toContain('Split earnings');
    expect(text).toContain('Attendance');
    expect(text).toContain('1.70M');
    expect(text).toContain('2.50M');
    expect(text).toContain('80%');
    expect(text).not.toContain('Guild paid out');
    expect(text).not.toContain('Splits completed');
    expect(text).not.toContain('Splits pending');
    expect(text).not.toContain("Here's what's happening with Weaklings.");
  });

  it('renders personal attention items and hides the caught-up banner', () => {
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Requires your attention');
    expect(text).toContain('silver available to request');
    expect(text).toContain('withdrawals awaiting payout');
    expect(text).toContain('regear requests pending');
    expect(text).not.toContain("You're all caught up");
    expect(text).not.toContain('bank request awaiting approval');
  });

  it('renders an empty next-mass state when nothing is scheduled', () => {
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Next mass');
    expect(text).toContain('No mass scheduled');
    expect(text).not.toContain('Launch Terry Grove');
    expect(text).not.toContain('Composition ready');
    expect(text).not.toContain('Build assigned');
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

  it('shows the caught-up banner when there is nothing personal to do', () => {
    const dash = component as Dashboard & {
      bankBalance: { set(value: BalanceSummary): void };
      metrics: { set(value: UserMetrics): void };
      albionLink: { set(value: AlbionLinkStatus): void };
      recentEvents: { set(value: EventView[]): void };
    };
    dash.bankBalance.set({
      user_id: 7,
      pending_total: 0,
      pending_count: 0,
      requested_total: 0,
      requested_count: 0,
    });
    dash.metrics.set({ ...mockMetrics, regears_pending: 0 });
    dash.albionLink.set({ linked: true, albion_player_name: 'GalvdonAO' });
    dash.recentEvents.set([]);
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain("You're all caught up");
    expect(text).not.toContain('silver available to request');
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
