import { provideZonelessChangeDetection, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { ApiError, ApiService } from '../../core/services/api.service';
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

const toastError = vi.fn();

interface RenderOptions {
  /** Makes `GET api/splits/7` fail with this error. */
  loadError?: Error;
  /** Rows returned by `GET api/bank/transactions`. */
  transactions?: unknown[];
}

async function render(
  tenantKind: 'guild' | 'alliance',
  split: object = pendingSplit,
  options: RenderOptions = {},
): Promise<ComponentFixture<SplitDetailPage>> {
  const profile = signal({
    user_id: 1,
    username: 'officer',
    tenant_kind: tenantKind,
  });
  const transactions = options.transactions ?? [];
  toastError.mockClear();
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
            if (url.includes('transactions')) {
              return of({
                items: transactions,
                total_items: transactions.length,
                total_pages: 1,
                current_page: 1,
                limit: 100,
              });
            }
            if (url.includes('events') || url.includes('users')) {
              return of({ items: [], total_items: 0, total_pages: 0, current_page: 1, limit: 50 });
            }
            if (url.includes('alliance/shares/split')) {
              return of({ shared: false });
            }
            if (url.includes('api/splits/7') || url.endsWith('/splits/7')) {
              return options.loadError ? throwError(() => options.loadError) : of(split);
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
        useValue: { success: () => undefined, error: toastError, info: () => undefined, warning: () => undefined },
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
  TestBed.inject(TranslateService).use('en');
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
  it('labels synchronized copies and suppresses owner actions even with permissions', async () => {
    const fixture = await render('guild', { ...pendingSplit, origin_read_only: true });
    const page = fixture.componentInstance as unknown as DetailApi;
    await fixture.whenStable();
    fixture.detectChanges();
    expect(page.isReadOnly()).toBe(true);
    expect(page.canAct()).toBe(false);
    expect(fixture.nativeElement.textContent).toContain('Read-only synchronized copy');
    expect(fixture.nativeElement.textContent).not.toContain('splits.payout_complete');
    expect(fixture.nativeElement.textContent).not.toContain('common.edit');
    fixture.destroy();
  });

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
        'input[data-participant-weight]',
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
      'input[data-participant-weight]',
    ) as HTMLInputElement | null;
    expect(weightInput?.value).toBe('100');
    fixture.destroy();
  });
});

function text(fixture: ComponentFixture<SplitDetailPage>): string {
  return (fixture.nativeElement as HTMLElement).textContent ?? '';
}

function buttons(fixture: ComponentFixture<SplitDetailPage>, selector = 'button'): HTMLButtonElement[] {
  return Array.from((fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>(selector));
}

async function settle(fixture: ComponentFixture<SplitDetailPage>): Promise<void> {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

describe('SplitDetailPage load states', () => {
  it('shows a split-not-found state for a 404 without leaking API text', async () => {
    const fixture = await render('guild', pendingSplit, {
      loadError: new ApiError(404, 'raw backend detail'),
    });
    expect(text(fixture)).toContain('Split not found');
    expect(text(fixture)).not.toContain('raw backend detail');
    expect(fixture.nativeElement.querySelector('app-error-state')).toBeNull();
    expect(toastError).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('shows a retryable error, distinct from not-found, for other failures', async () => {
    const fixture = await render('guild', pendingSplit, {
      loadError: new ApiError(500, 'raw backend detail'),
    });
    expect(fixture.nativeElement.querySelector('app-error-state')).not.toBeNull();
    expect(text(fixture)).toContain('Could not load this split.');
    expect(text(fixture)).not.toContain('Split not found');
    expect(text(fixture)).not.toContain('raw backend detail');
    expect(toastError).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('never toasts raw API text when an action fails', async () => {
    const fixture = await render('guild');
    vi.spyOn(TestBed.inject(ApiService), 'post').mockReturnValue(
      throwError(() => new ApiError(500, 'raw backend detail')) as never,
    );
    const page = fixture.componentInstance as unknown as {
      closeSplit: (action: 'complete') => Promise<void>;
    };
    await page.closeSplit('complete');
    expect(toastError).toHaveBeenCalledWith('That did not work. Try again.');
    fixture.destroy();
  });
});

describe('SplitDetailPage header actions', () => {
  it('offers one primary action per state: complete while pending, edit once completed', async () => {
    const pending = await render('guild');
    const primaryLabels = buttons(pending, 'button.btn--primary').map((b) => b.textContent?.trim());
    expect(primaryLabels).toEqual(['Complete & Credit']);
    pending.destroy();

    const completed = await render('guild', { ...pendingSplit, status: 'completed' });
    const completedPrimary = buttons(completed, 'button.btn--primary').map((b) => b.textContent?.trim());
    expect(completedPrimary).toEqual(['Edit']);
    completed.destroy();
  });

  it('groups secondary actions in an overflow menu that closes with Escape', async () => {
    const fixture = await render('guild');
    const trigger = fixture.nativeElement.querySelector('.sd-menu-trigger') as HTMLButtonElement;
    expect(trigger.getAttribute('aria-label')).toBe('More actions');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(text(fixture)).not.toContain('Mark as lost');

    trigger.click();
    await settle(fixture);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(text(fixture)).toContain('Mark as not completed');
    expect(text(fixture)).toContain('Mark as lost');
    expect(text(fixture)).toContain('Archive');

    (fixture.nativeElement.querySelector('.sd-menu') as HTMLElement).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await settle(fixture);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(text(fixture)).not.toContain('Mark as lost');
    fixture.destroy();
  });

  it('offers restoring an archived split as its primary action', async () => {
    const fixture = await render('guild', { ...pendingSplit, archived_at: new Date().toISOString() });
    expect(buttons(fixture, 'button.btn--primary').map((b) => b.textContent?.trim())).toEqual(['Unarchive']);
    expect(text(fixture)).toContain('Archived');
    fixture.destroy();
  });
});

describe('SplitDetailPage money flow and participants', () => {
  it('lays out gross, deductions, fee and net with explicit signs and units', async () => {
    const fixture = await render('guild', { ...pendingSplit, repair_value: 40 });
    const ledger = (fixture.nativeElement.querySelector('.sd-ledger') as HTMLElement).textContent ?? '';
    // 100 estimated + 25 bags - 40 repairs = 85 before the 20% fee (17), leaving 68 to share.
    expect(ledger).toContain('+25');
    expect(ledger).toContain('−40');
    expect(ledger).toContain('85');
    expect(ledger).toContain('−17');
    expect(ledger).toContain('68');
    expect(text(fixture)).toContain('silver');
    fixture.destroy();
  });

  it('totals the participant table and sorts it with aria-sort', async () => {
    const fixture = await render('guild', {
      ...pendingSplit,
      repair_value: 0,
      participants: [
        { user_id: 12, username: 'alice', weight: 25, share_amount: null },
        { user_id: 13, username: 'bob', weight: 75, share_amount: null },
      ],
    });
    const names = () =>
      Array.from(
        (fixture.nativeElement as HTMLElement).querySelectorAll('tbody th[scope="row"]'),
      ).map((cell) => cell.textContent?.trim());
    expect(names()).toEqual(['alice', 'bob']);

    const footer = (fixture.nativeElement.querySelector('tfoot') as HTMLElement).textContent ?? '';
    expect(footer).toContain('Total');
    expect(footer).toContain('100');

    const amountHeader = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('th[aria-sort]'),
    ).find((th) => th.textContent?.includes('Amount')) as HTMLElement;
    expect(amountHeader.getAttribute('aria-sort')).toBe('none');
    (amountHeader.querySelector('button') as HTMLButtonElement).click();
    await settle(fixture);
    (amountHeader.querySelector('button') as HTMLButtonElement).click();
    await settle(fixture);
    expect(amountHeader.getAttribute('aria-sort')).toBe('descending');
    expect(names()).toEqual(['bob', 'alice']);
    fixture.destroy();
  });

  it('shows a paid or pending state per participant, with text, once credited', async () => {
    const fixture = await render(
      'guild',
      {
        ...pendingSplit,
        status: 'completed',
        participants: [
          { user_id: 12, username: 'alice', weight: 50, share_amount: 50 },
          { user_id: 13, username: 'bob', weight: 50, share_amount: 50 },
        ],
      },
      {
        transactions: [
          { id: 1, to_user_id: 12, to_username: 'alice', amount: 50, status: 'withdrawn', type: 'split_credit', created_at: new Date().toISOString() },
          { id: 2, to_user_id: 13, to_username: 'bob', amount: 50, status: 'pending', type: 'split_credit', created_at: new Date().toISOString() },
        ],
      },
    );
    await settle(fixture);
    const rows = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('tbody tr')).map(
      (row) => row.textContent ?? '',
    );
    const alice = rows.find((row) => row.includes('alice')) ?? '';
    const bob = rows.find((row) => row.includes('bob')) ?? '';
    expect(alice).toContain('Paid out');
    expect(bob).toContain('Pending');
    expect(text(fixture)).toContain('1 of 2 paid out');
    fixture.destroy();
  });

  it('offers a next step when the split has no participants', async () => {
    const fixture = await render('guild', { ...pendingSplit, participants: [] });
    expect(text(fixture)).toContain('No participants in the roster yet');
    const add = buttons(fixture).find((b) => b.textContent?.includes('Add participant'));
    expect(add).toBeDefined();
    fixture.destroy();
  });
});

describe('SplitDetailPage edit validation', () => {
  type SubmitApi = EditApi & { onEditSubmit: (event: Event) => Promise<void> };

  async function openEdit(): Promise<ComponentFixture<SplitDetailPage>> {
    const fixture = await render('guild');
    (fixture.componentInstance as unknown as SubmitApi).toggleMode();
    await settle(fixture);
    return fixture;
  }

  function type(fixture: ComponentFixture<SplitDetailPage>, selector: string, value: string): void {
    const input = fixture.nativeElement.querySelector(selector) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('ties an invalid fee to its field instead of a toast', async () => {
    const fixture = await openEdit();
    const patch = vi.spyOn(TestBed.inject(ApiService), 'patch');
    type(fixture, '#sd-edit-fee', '150');
    await (fixture.componentInstance as unknown as SubmitApi).onEditSubmit(new Event('submit'));
    await settle(fixture);

    const fee = fixture.nativeElement.querySelector('#sd-edit-fee') as HTMLInputElement;
    expect(fee.getAttribute('aria-invalid')).toBe('true');
    const errorId = fee.getAttribute('aria-describedby') ?? '';
    expect(fixture.nativeElement.querySelector(`#${errorId}`)?.textContent).toContain(
      'Fee must be between 0 and 100%.',
    );
    expect(patch).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('ties a non-positive weight to the participant row', async () => {
    const fixture = await openEdit();
    type(fixture, 'input[data-participant-weight]', '0');
    await (fixture.componentInstance as unknown as SubmitApi).onEditSubmit(new Event('submit'));
    await settle(fixture);

    const weight = fixture.nativeElement.querySelector('input[data-participant-weight]') as HTMLInputElement;
    expect(weight.getAttribute('aria-invalid')).toBe('true');
    expect(weight.getAttribute('aria-label')).toBe('Share weight for alice (%)');
    expect(fixture.nativeElement.querySelector('#sd-weight-error-12')?.textContent).toContain(
      'Must be a positive number.',
    );
    fixture.destroy();
  });

  it('shows a live net preview and returns to the view after saving', async () => {
    const fixture = await openEdit();
    const api = TestBed.inject(ApiService);
    vi.spyOn(api, 'patch').mockReturnValue(of(pendingSplit) as never);
    vi.spyOn(api, 'post').mockReturnValue(of(pendingSplit) as never);
    type(fixture, '#sd-edit-estimated', '200');
    await settle(fixture);
    expect(text(fixture)).toContain('Net to distribute');
    expect((fixture.nativeElement.querySelector('.sd-editbar') as HTMLElement).textContent).toContain('180');

    await (fixture.componentInstance as unknown as SubmitApi).onEditSubmit(new Event('submit'));
    await settle(fixture);
    expect(fixture.nativeElement.querySelector('#edit-split-form')).toBeNull();
    fixture.destroy();
  });
});
