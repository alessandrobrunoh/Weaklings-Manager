import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import {
  Splits,
  addCurrentUserToParticipants,
  evenParticipantWeight,
  isSplitAwaitingEvent,
  isSplitBatchSelectable,
  participantWeightsAreValid,
  redistributeWeights,
} from './splits';

describe('split creation participants', () => {
  it('adds the authenticated user and redistributes weights to 100%', () => {
    const participants = addCurrentUserToParticipants(
      [
        { raw_name: 'Alice', user_id: 10, username: 'Alice', weight: 100 },
        { raw_name: 'Bob', user_id: 11, username: 'Bob', weight: 0 },
      ],
      { user_id: 12, username: 'CurrentUser' },
    );

    expect(participants).toEqual([
      { raw_name: 'Alice', user_id: 10, username: 'Alice', weight: 33.33 },
      { raw_name: 'Bob', user_id: 11, username: 'Bob', weight: 33.33 },
      { raw_name: 'CurrentUser', user_id: 12, username: 'CurrentUser', weight: 33.33 },
    ]);
  });

  it('gives every participant the same even weight instead of 16.67 vs 16.66', () => {
    const participants = redistributeWeights(
      Array.from({ length: 6 }, (_, index) => ({
        raw_name: `P${index}`,
        user_id: index + 1,
        username: `P${index}`,
        weight: 1,
      })),
    );
    expect(participants.every((participant) => participant.weight === 16.67)).toBe(true);
    expect(evenParticipantWeight(6)).toBe(16.67);
    expect(participantWeightsAreValid(participants.map((participant) => participant.weight))).toBe(
      true,
    );
  });

  it('does not duplicate the authenticated user when reopening the dialog', () => {
    const participants = [
      { raw_name: 'CurrentUser', user_id: 12, username: 'CurrentUser', weight: 100 },
    ];

    expect(
      addCurrentUserToParticipants(participants, { user_id: 12, username: 'CurrentUser' }),
    ).toEqual(participants);
  });

  it('leaves the draft unchanged when no authenticated profile is available', () => {
    const participants = [{ raw_name: 'Alice', user_id: 10, username: 'Alice', weight: 100 }];

    expect(addCurrentUserToParticipants(participants, null)).toEqual(participants);
  });
});

describe('linked event split actions', () => {
  it('excludes awaiting_event splits from batch completion', () => {
    expect(isSplitBatchSelectable('pending')).toBe(true);
    expect(isSplitBatchSelectable('awaiting_event')).toBe(false);
  });

  it('identifies the state that must show the event-waiting message', () => {
    expect(isSplitAwaitingEvent('awaiting_event')).toBe(true);
    expect(isSplitAwaitingEvent('pending')).toBe(false);
  });
});

describe('Splits Component', () => {
  let fixture: ComponentFixture<Splits>;

  const mockApiService = {
    get: vi.fn().mockImplementation((url: string) => {
      if (url.includes('summary')) {
        return of({
          total_net_distributed: 24_500_000,
          completed_count: 12,
          pending_count: 3,
          total_estimated_volume: 32_000_000,
          total_participants: 28,
        });
      }
      if (url.includes('islands')) {
        return of([]);
      }
      return of({
        items: [
          {
            id: 1,
            note: 'Castle Fight & Outpost Loot',
            status: 'pending',
            estimated_market_value: 10_000_000,
            fee: 20,
            repair_value: 0,
            bags_value: 0,
            net_value: 8_000_000,
            participant_count: 10,
            created_at: new Date().toISOString(),
          },
        ],
        total_items: 1,
        total_pages: 1,
        current_page: 1,
        limit: 10,
      });
    }),
    post: vi.fn().mockReturnValue(of({})),
    delete: vi.fn().mockReturnValue(of({})),
  };

  const mockAuthService = {
    profile: vi.fn().mockReturnValue({
      id: '123',
      user_id: 123,
      username: 'Galvdon',
      permissions: ['splits.create', 'splits.edit', 'splits.delete', 'splits.islands.manage'],
    }),
    hasPermission: vi.fn().mockReturnValue(true),
  };

  const mockToastService = {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Splits],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: ApiService, useValue: mockApiService },
        { provide: AuthService, useValue: mockAuthService },
        { provide: ToastService, useValue: mockToastService },
        TranslateService,
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(Splits);
    await (fixture.componentInstance as unknown as { refreshNow: () => Promise<void> }).refreshNow();
    fixture.detectChanges();
    await fixture.whenStable();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('renders all 4 modern KPI cards with formatted values', () => {
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Total Net Distributed');
    expect(text).toContain('24.50M');
    expect(text).toContain('Pending splits');
    expect(text).toContain('3');
    expect(text).toContain('Total Silver Volume');
    expect(text).toContain('32.00M');
    expect(text).toContain('Participants');
    expect(text).toContain('28');
  });

  it('renders the status filter tabs and quick actions', () => {
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('All');
    expect(text).toContain('Pending');
    expect(text).toContain('Awaiting event');
    expect(text).toContain('Completed');
  });

  it('renders the batch selection action strip when pending splits exist', () => {
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Select all pending');
    expect(text).toContain('Complete selected');
  });

  it('requests pending splits when the Pending tab is clicked', async () => {
    mockApiService.get.mockClear();
    const pendingTab = tabButton(fixture.nativeElement, 'Pending');
    expect(pendingTab).toBeTruthy();
    pendingTab!.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(mockApiService.get).toHaveBeenCalledWith(
      'api/splits',
      expect.objectContaining({ status: 'pending' }),
    );
  });

  it('keeps the status tab when the table pages without a status column filter', async () => {
    const component = fixture.componentInstance as unknown as {
      setStatusFilter: (status: string) => void;
      onPageChange: (event: {
        page: number;
        pageSize: number;
        search: string;
        sort: null;
        columnFilters: Record<string, string>;
      }) => void;
    };
    component.setStatusFilter('awaiting_event');
    mockApiService.get.mockClear();

    component.onPageChange({
      page: 2,
      pageSize: 10,
      search: 'castle',
      sort: null,
      columnFilters: {},
    });
    await fixture.whenStable();

    expect(mockApiService.get).toHaveBeenCalledWith(
      'api/splits',
      expect.objectContaining({ status: 'awaiting_event', search: 'castle', page: 2 }),
    );
  });

  it('adds, edits, and removes individual bags on the create form', () => {
    const page = fixture.componentInstance as Splits & {
      addBag: () => void;
      removeBag: (key: number) => void;
      onBagAmountChange: (key: number, event: Event) => void;
      draftBagRows: () => Array<{ key: number; amount: number }>;
      draftBags: () => number;
    };
    page.addBag();
    page.addBag();
    const [first, second] = page.draftBagRows();
    page.onBagAmountChange(first.key, { target: { value: '150000' } } as unknown as Event);
    page.onBagAmountChange(second.key, { target: { value: '80000' } } as unknown as Event);
    expect(page.draftBags()).toBe(230000);
    page.removeBag(first.key);
    expect(page.draftBagRows()).toHaveLength(1);
    expect(page.draftBags()).toBe(80000);
  });
});

function tabButton(root: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll('nav button')).find((button) =>
    button.textContent?.includes(label),
  ) as HTMLButtonElement | undefined;
}
