import { provideZonelessChangeDetection, type WritableSignal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TransactionView } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import { AdminTransactions } from './admin-transactions';

function stubDialogApi(): void {
  if (typeof HTMLDialogElement === 'undefined') {
    return;
  }
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
    Object.defineProperty(this, 'open', { configurable: true, get: () => true });
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
    Object.defineProperty(this, 'open', { configurable: true, get: () => false });
    this.dispatchEvent(new Event('close'));
  };
}

/** The ledger state and derived values the specs read, typed without exposing them publicly. */
interface LedgerView {
  memberQuery: WritableSignal<string>;
  statusFilter: WritableSignal<string>;
  typeFilter: WritableSignal<string>;
  dateFrom: WritableSignal<string>;
  dateTo: WritableSignal<string>;
  filtered: () => TransactionView[];
  summary: () => {
    outstanding: number;
    outstandingCount: number;
    paid: number;
    paidCount: number;
    donated: number;
    donatedCount: number;
  };
  netTotal: () => number;
  rowMenu: (row: TransactionView) => { id: string; danger?: boolean; separatorBefore?: boolean }[];
}

function transaction(overrides: Partial<TransactionView>): TransactionView {
  return {
    id: 1,
    from_user_id: null,
    from_label: 'Guild Bank',
    to_user_id: 7,
    to_username: 'Gálvdon',
    to_label: 'Gálvdon',
    to_guild_bank: false,
    amount: 100,
    status: 'pending',
    type: 'manual_adjustment',
    split_id: null,
    created_at: '2026-11-03T12:00:00Z',
    requested_at: null,
    withdrawn_at: null,
    guild_tenant_id: null,
    guild_name: null,
    ...overrides,
  };
}

async function createComponent(ledger: TransactionView[] = []): Promise<{
  fixture: ComponentFixture<AdminTransactions>;
  api: { get: ReturnType<typeof vi.fn> };
}> {
  stubDialogApi();
  const api = {
    get: vi.fn().mockImplementation((path: string) =>
      path === 'api/bank/transactions'
        ? of({ items: ledger, total_items: ledger.length })
        : of({ items: [], total_items: 0 }),
    ),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  };

  await TestBed.configureTestingModule({
    imports: [AdminTransactions],
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: ApiService, useValue: api },
      { provide: AuthService, useValue: { hasPermission: () => true } },
      { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
      { provide: TranslateService, useValue: { t: (key: string) => key, locale: () => 'en' } },
    ],
  }).compileComponents();

  const fixture = TestBed.createComponent(AdminTransactions);
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, api };
}

describe('AdminTransactions recipient search', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('searches app members by name and keeps their numeric user id', async () => {
    const { fixture, api } = await createComponent();
    api.get.mockImplementation((path: string) =>
      path === 'api/users'
        ? of({ items: [{ id: 7, username: 'Gálvdon' }], total_items: 1 })
        : of({ items: [], total_items: 0 }),
    );
    const cmp = fixture.componentInstance as unknown as {
      openRosterSearch: (target: 'create-to') => void;
      onRosterSearchFilter: (filters: { search: string; dateFrom: string; dateTo: string }) => Promise<void>;
      onRosterSelect: (option: { id: string; title: string }) => void;
      rosterSearchOptions: () => { id: string; title: string }[];
      newToUserId: () => number | null;
    };
    cmp.openRosterSearch('create-to');
    await cmp.onRosterSearchFilter({ search: ' galvdon ', dateFrom: '', dateTo: '' });
    expect(api.get).toHaveBeenCalledWith('api/users', { username: 'galvdon', limit: 25 });
    expect(cmp.rosterSearchOptions()).toEqual([{ id: '7', title: 'Gálvdon' }]);
    cmp.onRosterSelect(cmp.rosterSearchOptions()[0]);
    expect(cmp.newToUserId()).toBe(7);
  });
});

describe('AdminTransactions ledger', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('reads the whole ledger once and filters, totals and orders it on the client', async () => {
    const { fixture, api } = await createComponent([
      transaction({ id: 1, to_username: 'Gálvdon', amount: 100, status: 'pending', created_at: '2026-11-03T12:00:00Z' }),
      transaction({
        id: 2,
        to_username: 'Mira',
        amount: 50,
        status: 'withdrawn',
        type: 'split_donation',
        created_at: '2026-11-10T12:00:00Z',
      }),
      transaction({ id: 3, to_username: 'Mira', amount: -20, status: 'donated', created_at: '2026-11-10T12:00:00Z' }),
    ]);
    expect(api.get).toHaveBeenCalledWith('api/bank/transactions', { global: true, page: 1, limit: 1000 });

    const cmp = fixture.componentInstance as unknown as LedgerView;
    expect(cmp.filtered().map((row) => row.id)).toEqual([1, 2, 3]);
    expect(cmp.summary()).toEqual({
      outstanding: 100,
      outstandingCount: 1,
      paid: 50,
      paidCount: 1,
      donated: -20,
      donatedCount: 1,
    });
    expect(cmp.netTotal()).toBe(130);

    cmp.memberQuery.set('mira');
    expect(cmp.filtered().map((row) => row.id)).toEqual([2, 3]);
    expect(cmp.netTotal()).toBe(30);

    cmp.memberQuery.set('');
    cmp.typeFilter.set('split_donation');
    expect(cmp.filtered().map((row) => row.id)).toEqual([2]);

    cmp.typeFilter.set('');
    cmp.dateFrom.set('2026-11-10');
    cmp.dateTo.set('2026-11-10');
    expect(cmp.filtered().map((row) => row.id)).toEqual([2, 3]);

    cmp.statusFilter.set('donated');
    expect(cmp.filtered().map((row) => row.id)).toEqual([3]);
    expect(cmp.summary().donated).toBe(-20);
  });

  it('offers edit and delete as row actions, with delete last and marked as danger', async () => {
    const { fixture } = await createComponent([transaction({ id: 9 })]);
    const cmp = fixture.componentInstance as unknown as LedgerView;
    const menu = cmp.rowMenu(transaction({ id: 9 }));
    expect(menu.map((item) => item.id)).toEqual(['edit', 'delete']);
    expect(menu[1]).toMatchObject({ danger: true, separatorBefore: true });
  });
});

describe('AdminTransactions required fields', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('exposes recipient and amount requirements and contextual recipient errors in create and edit', async () => {
    const { fixture } = await createComponent();
    const compiled = fixture.nativeElement as HTMLElement;
    const createButton = [...compiled.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('admin.transactions.create'),
    );
    createButton?.click();
    fixture.detectChanges();

    const createForm = compiled.querySelector('#create-transaction-form') as HTMLFormElement;
    const createRecipient = createForm.querySelector('[role="group"]') as HTMLElement;
    const createAmount = createForm.querySelector('input[type="number"]') as HTMLInputElement;
    expect(createForm.textContent).toContain('validation.requiredLegend');
    expect(createRecipient.getAttribute('aria-labelledby')).toBe('create-transaction-recipient-label');
    expect(createRecipient.getAttribute('aria-describedby')).toBe('create-transaction-recipient-required');
    expect(createForm.querySelector('#create-transaction-recipient-required')?.textContent).toContain(
      'validation.required',
    );
    expect(createForm.querySelector('#create-transaction-recipient-label [aria-hidden="true"]')?.textContent).toBe('*');
    expect(createAmount.required).toBe(true);
    expect(createAmount.labels?.[0]?.querySelector('[aria-hidden="true"]')?.textContent).toBe('*');

    fixture.componentInstance['newAmount'].set(25);
    await fixture.componentInstance['onCreate'](new Event('submit', { cancelable: true }) as SubmitEvent);
    fixture.detectChanges();
    expect(createRecipient.getAttribute('aria-invalid')).toBe('true');
    expect(createRecipient.getAttribute('aria-describedby')).toBe(
      'create-transaction-recipient-required create-transaction-recipient-error',
    );
    expect(createForm.querySelector('#create-transaction-recipient-error')?.textContent).toContain(
      'admin.transactions.fields.pickUser',
    );

    fixture.componentInstance['editTarget'].set({ id: 7 } as TransactionView);
    fixture.componentInstance['editToUserId'].set(null);
    fixture.componentInstance['editToUserName'].set('');
    fixture.detectChanges();
    const editForm = compiled.querySelector('#edit-transaction-form') as HTMLFormElement;
    const editRecipient = editForm.querySelector('[role="group"]') as HTMLElement;
    const editAmount = editForm.querySelector('input[type="number"]') as HTMLInputElement;
    expect(editForm.textContent).toContain('validation.requiredLegend');
    expect(editRecipient.getAttribute('aria-labelledby')).toBe('edit-transaction-recipient-label');
    expect(editRecipient.getAttribute('aria-describedby')).toBe('edit-transaction-recipient-required');
    expect(editForm.querySelector('#edit-transaction-recipient-required')?.textContent).toContain(
      'validation.required',
    );
    expect(editForm.querySelector('#edit-transaction-recipient-label [aria-hidden="true"]')?.textContent).toBe('*');
    expect(editAmount.required).toBe(true);
    expect(editAmount.labels?.[0]?.querySelector('[aria-hidden="true"]')?.textContent).toBe('*');

    await fixture.componentInstance['onEditSubmit'](
      new Event('submit', { cancelable: true }) as SubmitEvent,
    );
    fixture.detectChanges();
    expect(editRecipient.getAttribute('aria-invalid')).toBe('true');
    expect(editRecipient.getAttribute('aria-describedby')).toBe(
      'edit-transaction-recipient-required edit-transaction-recipient-error',
    );
    expect(editForm.querySelector('#edit-transaction-recipient-error')?.textContent).toContain(
      'admin.transactions.fields.pickUser',
    );
  });
});
