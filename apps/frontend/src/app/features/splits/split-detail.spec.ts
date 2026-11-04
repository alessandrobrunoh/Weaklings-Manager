import { provideZonelessChangeDetection, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import { SplitDetailPage } from './split-detail';

const islandCatalog = [
  {
    id: 1,
    name: 'HQ',
    city: 'lymhurst',
    tabs: [{ id: 2, name: 'Loot', sort_order: 0 }],
  },
];

const pendingSplit = {
  id: 7,
  created_by_username: 'officer',
  status: 'pending',
  estimated_market_value: 100,
  fee: 20,
  repair_value: 0,
  bags_value: 25,
  bags: ['15', '10'],
  net_value: null,
  note: 'Avalon chest',
  event_id: null,
  event_title: null,
  island_id: 1,
  island_name: 'HQ',
  island_city: 'lymhurst',
  island_tab_id: 2,
  island_tab_name: 'Loot',
  participant_count: 1,
  created_at: new Date().toISOString(),
  finalized_at: null,
  archived_at: null,
  origin_read_only: false,
  participants: [{ user_id: 12, username: 'alice', weight: 100, share_amount: null }],
};

async function render(
  tenantKind: 'guild' | 'alliance',
  split: typeof pendingSplit = pendingSplit,
): Promise<ComponentFixture<SplitDetailPage>> {
  const profile = signal({
    user_id: 1,
    username: 'officer',
    tenant_kind: tenantKind,
  });
  TestBed.resetTestingModule();
  await TestBed.configureTestingModule({
    imports: [SplitDetailPage],
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      {
        provide: ApiService,
        useValue: {
          get: (url: string) => {
            if (url.includes('islands')) {
              return of(islandCatalog);
            }
            if (url.includes('events') || url.includes('transactions') || url.includes('users')) {
              return of({ items: [], total_items: 0, total_pages: 0, current_page: 1, limit: 50 });
            }
            if (url.includes('alliance/shares/split')) {
              return of({ shared: false });
            }
            if (url.includes('api/splits/7') || url.endsWith('/splits/7')) {
              return of(split);
            }
            return of({ items: [] });
          },
          post: () => of({}),
          delete: () => of({}),
          patch: () => of({}),
        },
      },
      {
        provide: AuthService,
        useValue: {
          profile,
          hasPermission: () => true,
        },
      },
      {
        provide: ToastService,
        useValue: { success: () => undefined, error: () => undefined, info: () => undefined, warning: () => undefined },
      },
      TranslateService,
      {
        provide: ActivatedRoute,
        useValue: {
          paramMap: of(convertToParamMap({ splitId: '7' })),
          snapshot: { paramMap: convertToParamMap({ splitId: '7' }) },
        },
      },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(SplitDetailPage);
  const page = fixture.componentInstance as unknown as {
    reload: () => void;
    canShare: () => boolean;
    isReadOnly: () => boolean;
    canAct: () => boolean;
    isAllianceTenant: () => boolean;
  };
  page.reload();
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture;
}

type DetailApi = {
  canShare: () => boolean;
  isReadOnly: () => boolean;
  canAct: () => boolean;
  isAllianceTenant: () => boolean;
};

describe('SplitDetailPage alliance share', () => {
  it('shows a share button on a guild split', async () => {
    const fixture = await render('guild');
    const page = fixture.componentInstance as unknown as DetailApi;
    expect(page.isAllianceTenant()).toBe(false);
    expect(page.isReadOnly()).toBe(false);
    expect(page.canShare()).toBe(true);
    expect(page.canAct()).toBe(true);
    fixture.destroy();
  });

  it('is view-only on an alliance tenant', async () => {
    const fixture = await render('alliance');
    const page = fixture.componentInstance as unknown as DetailApi;
    expect(page.isAllianceTenant()).toBe(true);
    expect(page.isReadOnly()).toBe(true);
    expect(page.canShare()).toBe(false);
    expect(page.canAct()).toBe(false);
    fixture.destroy();
  });
});

describe('split completion wording', () => {
  it('shows the bank-credit lifecycle instead of calling pending credits paid', async () => {
    const fixture = await render('guild');
    TestBed.inject(TranslateService).use('en');
    const page = fixture.componentInstance as unknown as {
      payoutLifecycleLabel: (split: { status: string }) => string;
      splitTransactions: { set: (transactions: unknown[]) => void };
      transactionsComplete: { set: (complete: boolean) => void };
    };
    const completed = { ...pendingSplit, status: 'completed' };
    page.transactionsComplete.set(true);
    page.splitTransactions.set([{ status: 'pending' }]);
    expect(page.payoutLifecycleLabel(completed)).toBe('Pending');
    page.splitTransactions.set([{ status: 'requested' }]);
    expect(page.payoutLifecycleLabel(completed)).toBe('Awaiting payout');
    page.splitTransactions.set([{ status: 'withdrawn' }]);
    expect(page.payoutLifecycleLabel(completed)).toBe('Paid out');
    fixture.destroy();
  });

  it('does not claim all credits are paid when a page omits rows or a refresh fails', async () => {
    const fixture = await render('guild');
    TestBed.inject(TranslateService).use('en');
    const api = TestBed.inject(ApiService);
    const page = fixture.componentInstance as unknown as {
      loadTransactions: (id: number) => Promise<void>;
      payoutLifecycleLabel: (split: { status: string }) => string;
      splitPayoutComplete: () => boolean;
      splitTransactions: () => unknown[];
      transactionsComplete: () => boolean;
      transactionsLoadFailed: () => boolean;
    };
    const completed = { ...pendingSplit, status: 'completed' };
    const allWithdrawn = Array.from({ length: 100 }, (_, id) => ({ id, status: 'withdrawn' }));

    vi.spyOn(api, 'get').mockReturnValue(
      of({ items: allWithdrawn, total_items: 101, total_pages: 2, current_page: 1, limit: 100 }) as never,
    );
    await page.loadTransactions(7);
    expect(page.transactionsComplete()).toBe(false);
    expect(page.payoutLifecycleLabel(completed)).toBe('Completed');
    expect(page.splitPayoutComplete()).toBe(false);

    vi.mocked(api.get).mockReturnValue(
      of({
        items: [{ id: 1, status: 'withdrawn' }, { id: 2, status: 'pending' }],
        total_items: 2,
        total_pages: 1,
        current_page: 1,
        limit: 100,
      }) as never,
    );
    await page.loadTransactions(7);
    expect(page.transactionsComplete()).toBe(true);
    expect(page.payoutLifecycleLabel(completed)).toBe('Pending');
    expect(page.splitPayoutComplete()).toBe(false);

    vi.mocked(api.get).mockReturnValue(throwError(() => new Error('offline')) as never);
    await page.loadTransactions(7);
    expect(page.transactionsLoadFailed()).toBe(true);
    expect(page.transactionsComplete()).toBe(false);
    expect(page.splitTransactions()).toHaveLength(0);
    expect(page.payoutLifecycleLabel(completed)).toBe('Completed');
    expect(page.splitPayoutComplete()).toBe(false);
    fixture.destroy();
  });

  it('explains that completion creates pending credits rather than paying members', async () => {
    const showModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value: function (this: HTMLDialogElement) { this.open = true; },
    });
    try {
    const fixture = await render('guild');
    TestBed.inject(TranslateService).use('en');
    const page = fixture.componentInstance as unknown as {
      showCompleteConfirmDialog: { set: (open: boolean) => void };
    };
    page.showCompleteConfirmDialog.set(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('creates pending Guild Bank credits');
    expect(fixture.nativeElement.textContent).toContain('request withdrawal before an officer pays them');
    fixture.destroy();
    } finally {
      if (showModal) {
        Object.defineProperty(HTMLDialogElement.prototype, 'showModal', showModal);
      } else {
        Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
      }
    }
  });
});

type EditApi = {
  toggleMode: () => void;
  islands: { set: (value: typeof islandCatalog) => void };
  editParticipants: () => Array<{ user_id: number; weight: number }>;
};

function editSelects(fixture: ComponentFixture<SplitDetailPage>): HTMLSelectElement[] {
  return Array.from(fixture.nativeElement.querySelectorAll('select')) as HTMLSelectElement[];
}

describe('SplitDetailPage edit form', () => {
  it('keeps the saved island, tab, and 100% share visible in edit', async () => {
      const fixture = await render('guild');
      const page = fixture.componentInstance as unknown as EditApi;
      page.toggleMode();
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      const [islandSelect, tabSelect] = editSelects(fixture);
      expect(islandSelect?.value).toBe('1');
      expect(tabSelect?.value).toBe('2');
      const weightInput = fixture.nativeElement.querySelector(
        'input[placeholder="12,33"]',
      ) as HTMLInputElement | null;
      expect(weightInput?.value).toBe('100');
      fixture.destroy();
    });

  it('selects island and tab after the catalog arrives', async () => {
      const fixture = await render('guild');
      const page = fixture.componentInstance as unknown as EditApi;
      page.islands.set([]);
      page.toggleMode();
      fixture.detectChanges();
      await fixture.whenStable();

      page.islands.set(islandCatalog);
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      const [islandSelect, tabSelect] = editSelects(fixture);
      expect(islandSelect?.value).toBe('1');
      expect(tabSelect?.value).toBe('2');
      fixture.destroy();
    });

  it('shows a unit-share weight of 1 as 100%', async () => {
    const fixture = await render('guild', {
      ...pendingSplit,
      participants: [{ user_id: 12, username: 'alice', weight: 1, share_amount: null }],
    });
    const page = fixture.componentInstance as unknown as EditApi;
    page.toggleMode();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(page.editParticipants()[0]?.weight).toBe(100);
    const weightInput = fixture.nativeElement.querySelector(
      'input[placeholder="12,33"]',
    ) as HTMLInputElement | null;
    expect(weightInput?.value).toBe('100');
    fixture.destroy();
  });
});
