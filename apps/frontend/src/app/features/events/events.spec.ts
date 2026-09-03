import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import { Events } from './events';

describe('Events', () => {
  let fixture: ComponentFixture<Events>;
  let component: Events;

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
      created_by_username: 'Galvdon',
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
      return of([]);
    }),
    delete: vi.fn().mockReturnValue(of({})),
    post: vi.fn().mockReturnValue(of({})),
  };

  const mockAuthService = {
    hasPermission: vi.fn().mockReturnValue(true),
  };

  const mockToastService = {
    success: vi.fn(),
    error: vi.fn(),
  };

  beforeEach(async () => {
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
  });

  it('renders the 4 KPI stat cards with correct titles', () => {
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('TOTAL EVENTS');
    expect(text).toContain('LIVE EVENTS');
    expect(text).toContain('SCHEDULED');
    expect(text).toContain('CALL TO ARMS');
  });

  it('renders the search box and status dropdown', () => {
    const searchInput = fixture.nativeElement.querySelector('input[placeholder="Search events..."]');
    expect(searchInput).toBeTruthy();

    const select = fixture.nativeElement.querySelector('select');
    expect(select).toBeTruthy();
  });

  it('renders all 4 status tabs with counts', () => {
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('All');
    expect(text).toContain('Live');
    expect(text).toContain('Scheduled');
    expect(text).toContain('Finished');
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
    expect(text).toContain('Join');
    expect(text).toContain('Delete');
  });

  it('renders the pagination footer with correct item counts and page buttons', () => {
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Showing 1 to 10 of 17 events');
    expect(text).toContain('10 per page');
  });
});
