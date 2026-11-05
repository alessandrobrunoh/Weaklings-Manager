import { provideZonelessChangeDetection, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { SplitSummary } from '../../core/models/api.models';
import {
  Splits,
  addCurrentUserToParticipants,
  evenParticipantWeight,
  isSplitAwaitingEvent,
  isSplitBatchSelectable,
  participantWeightsAreValid,
  redistributeWeights,
  upgradeLegacyUnitShares,
} from './splits';
import { actionablePendingSplits, canActOnSplit } from './split-access';

describe('split creation participants', () => {
  it('adds the authenticated user and redistributes everyone to a full share each', () => {
    const participants = addCurrentUserToParticipants(
      [
        { raw_name: 'Alice', user_id: 10, username: 'Alice', weight: 100 },
        { raw_name: 'Bob', user_id: 11, username: 'Bob', weight: 0 },
      ],
      { user_id: 12, username: 'CurrentUser' },
    );

    expect(participants).toEqual([
      { raw_name: 'Alice', user_id: 10, username: 'Alice', weight: 100 },
      { raw_name: 'Bob', user_id: 11, username: 'Bob', weight: 100 },
      { raw_name: 'CurrentUser', user_id: 12, username: 'CurrentUser', weight: 100 },
    ]);
  });

  it('gives every participant a full share (100) regardless of headcount', () => {
    const participants = redistributeWeights(
      Array.from({ length: 6 }, (_, index) => ({
        raw_name: `P${index}`,
        user_id: index + 1,
        username: `P${index}`,
        weight: 1,
      })),
    );
    expect(participants.every((participant) => participant.weight === 100)).toBe(true);
    expect(evenParticipantWeight(6)).toBe(100);
    expect(participantWeightsAreValid(participants.map((participant) => participant.weight))).toBe(
      true,
    );
  });

  it('accepts unequal weights that do not sum to 100 — each is a relative share', () => {
    // A full share (100) and a half share (50): the backend normalizes by the sum of weights,
    // so this must be just as valid as two people splitting 50/50.
    expect(participantWeightsAreValid([100, 50])).toBe(true);
    expect(participantWeightsAreValid([100, 50, 25])).toBe(true);
  });

  it('rejects a zero or negative weight', () => {
    expect(participantWeightsAreValid([100, 0])).toBe(false);
    expect(participantWeightsAreValid([100, -1])).toBe(false);
    expect(participantWeightsAreValid([])).toBe(false);
  });

  it('upgrades a roster of unit shares (1) to full 100% shares', () => {
    expect(
      upgradeLegacyUnitShares([
        { user_id: 1, weight: 1 },
        { user_id: 2, weight: 1 },
      ]),
    ).toEqual([
      { user_id: 1, weight: 100 },
      { user_id: 2, weight: 100 },
    ]);
  });

  it('leaves mixed weights alone so a real 1% share is not rewritten', () => {
    const mixed = [
      { user_id: 1, weight: 1 },
      { user_id: 2, weight: 100 },
    ];
    expect(upgradeLegacyUnitShares(mixed)).toEqual(mixed);
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

describe('split action ownership', () => {
  const owned = { created_by_id: 7 };
  const stranger = { created_by_id: 8 };

  it('allows the creator without a global edit permission and denies a stranger', () => {
    expect(canActOnSplit(owned, 7, false)).toBe(true);
    expect(canActOnSplit(stranger, 7, false)).toBe(false);
  });

  it('allows users with the global edit permission regardless of creator', () => {
    expect(canActOnSplit(stranger, 7, true)).toBe(true);
  });

  it('selects only actionable rows in mixed batches and preserves alliance read-only behavior', () => {
    const splits = [
      { id: 1, created_by_id: 7, status: 'pending' as const, origin_read_only: false },
      { id: 2, created_by_id: 8, status: 'pending' as const, origin_read_only: false },
      { id: 3, created_by_id: 7, status: 'awaiting_event' as const, origin_read_only: false },
      { id: 4, created_by_id: 7, status: 'pending' as const, origin_read_only: true },
    ];

    expect(actionablePendingSplits(splits, 7, false, false).map((split) => split.id)).toEqual([1]);
    expect(actionablePendingSplits(splits, 7, true, false).map((split) => split.id)).toEqual([1, 2]);
    expect(actionablePendingSplits(splits, 7, true, true)).toEqual([]);
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

  const profile = signal({
    id: '123',
    user_id: 123,
    username: 'Galvdon',
    tenant_kind: 'guild' as string,
    permissions: ['splits.create', 'splits.edit', 'splits.delete', 'splits.islands.manage'],
  });
  const mockAuthService = {
    profile,
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
    profile.set({
      id: '123',
      user_id: 123,
      username: 'Galvdon',
      tenant_kind: 'guild',
      permissions: ['splits.create', 'splits.edit', 'splits.delete', 'splits.islands.manage'],
    });
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

  it('uses the configured default fee and preserves a manually edited fee on refresh', async () => {
    const page = fixture.componentInstance as unknown as {
      draftFeeInput: () => string;
      onFeeChange: (event: Event) => void;
      refreshNow: () => Promise<void>;
    };
    const original = mockApiService.get.getMockImplementation()!;
    mockApiService.get.mockImplementation((url: string) =>
      url.includes('summary')
        ? of({ default_split_fee: '15.00' })
        : original(url),
    );
    try {
      await page.refreshNow();
      expect(page.draftFeeInput()).toBe('15.00');
      page.onFeeChange({ target: { value: '20' } } as unknown as Event);
      await page.refreshNow();
      expect(page.draftFeeInput()).toBe('20');
    } finally {
      mockApiService.get.mockImplementation(original);
    }
  });

  it('submits the fee shown in the creation form', async () => {
    const page = fixture.componentInstance as unknown as {
      draftTitle: { set: (value: string) => void };
      draftTabId: { set: (value: string) => void };
      participants: { set: (value: Array<{ raw_name: string; user_id: number; username: string; weight: number }>) => void };
      onFeeChange: (event: Event) => void;
      createSplit: () => Promise<void>;
    };
    page.draftTitle.set('Test split');
    page.draftTabId.set('2');
    page.participants.set([{ raw_name: 'Galvdon', user_id: 123, username: 'Galvdon', weight: 100 }]);
    page.onFeeChange({ target: { value: '20' } } as unknown as Event);
    mockApiService.post.mockClear();

    await page.createSplit();

    expect(mockApiService.post).toHaveBeenCalledWith(
      'api/splits',
      expect.objectContaining({ fee: 20 }),
    );
  });

  it('shows and associates an inline fee error when the fee is invalid', () => {
    const showModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value: function (this: HTMLDialogElement) { this.open = true; },
    });
    const page = fixture.componentInstance as unknown as {
      openCreateDialog: () => void;
      onFeeChange: (event: Event) => void;
    };
    try {
      page.openCreateDialog();
      page.onFeeChange({ target: { value: '101' } } as unknown as Event);
      fixture.detectChanges();

      const feeInput = fixture.nativeElement.querySelector(
        '[aria-describedby="split-fee-error"]',
      ) as HTMLInputElement;
      expect(feeInput.getAttribute('aria-invalid')).toBe('true');
      expect(fixture.nativeElement.querySelector('#split-fee-error')?.textContent).toContain(
        'Fee must be between 0 and 100%.',
      );
    } finally {
      if (showModal) {
        Object.defineProperty(HTMLDialogElement.prototype, 'showModal', showModal);
      } else {
        Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
      }
    }
  });

  it('renders the status column filter and quick actions', () => {
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
    expect(options).toContain('Pending');
    expect(options).toContain('Awaiting event');
    expect(options).toContain('Completed');
    expect(fixture.nativeElement.querySelectorAll('nav button').length).toBe(0);
  });

  it('renders the batch selection action strip when pending splits exist', () => {
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Select all pending');
    expect(text).toContain('Complete selected');
  });

  it('labels synchronized read-only copies in the split list', () => {
    const page = fixture.componentInstance as unknown as {
      splits: { (): SplitSummary[]; set(value: SplitSummary[]): void };
    };
    page.splits.set(page.splits().map((split) => ({ ...split, origin_read_only: true })));
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Read-only synchronized copy');
  });

  it('hides create and batch actions on an alliance tenant', () => {
    profile.set({
      id: '123',
      user_id: 123,
      username: 'Galvdon',
      tenant_kind: 'alliance',
      permissions: ['splits.create', 'splits.edit', 'splits.delete', 'splits.islands.manage'],
    });
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent;
    expect(text).not.toContain('New split');
    expect(text).not.toContain('Select all pending');
    expect(text).not.toContain('Complete selected');
  });

  it('requests pending splits when the status filter changes', async () => {
    mockApiService.get.mockClear();
    const statusTrigger = Array.from(
      fixture.nativeElement.querySelectorAll(
        'app-select button[role="combobox"]',
      ) as NodeListOf<HTMLButtonElement>,
    ).find((trigger) =>
      trigger.getAttribute('aria-label')?.toLowerCase().includes('status'),
    );
    expect(statusTrigger).toBeTruthy();
    statusTrigger!.click();
    fixture.detectChanges();
    const pendingOption = Array.from(
      fixture.nativeElement.querySelectorAll(
        'app-select [role="option"]',
      ) as NodeListOf<HTMLButtonElement>,
    ).find((option) => option.textContent?.includes('Pending')) as
      | HTMLButtonElement
      | undefined;
    expect(pendingOption).toBeTruthy();
    pendingOption!.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(mockApiService.get).toHaveBeenCalledWith(
      'api/splits',
      expect.objectContaining({ status: 'pending' }),
    );
  });

  it('clears the status filter when the table pages without one', async () => {
    const component = fixture.componentInstance as unknown as {
      onPageChange: (event: {
        page: number;
        pageSize: number;
        search: string;
        sort: null;
        columnFilters: Record<string, string>;
      }) => void;
    };
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
      expect.objectContaining({ search: 'castle', page: 2 }),
    );
    expect(mockApiService.get).not.toHaveBeenCalledWith(
      'api/splits',
      expect.objectContaining({ status: 'awaiting_event' }),
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


