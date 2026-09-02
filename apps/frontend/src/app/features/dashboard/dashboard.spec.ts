import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { NotificationService } from '../../core/services/notification.service';
import { TranslateService } from '../../core/services/translate.service';
import { Dashboard } from './dashboard';

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

  it('renders the "RECENT SPLITS" section with 4 transaction cards', () => {
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('RECENT SPLITS');
    expect(text).toContain('View all');
    expect(text).toContain('+10.80M');
    expect(text).toContain('+4.85M');
    expect(text).toContain('+30.34M');
  });

  it('formats numbers to compact silver notation correctly', () => {
    expect(component.formatCompactSilver(1_700_000)).toBe('1.70M');
    expect(component.formatCompactSilver(40_820_000)).toBe('40.82M');
    expect(component.formatCompactSilver(10_800_000, true)).toBe('+10.80M');
    expect(component.formatCompactSilver(500)).toBe('500');
    expect(component.formatCompactSilver(null)).toBe('—');
  });
});
