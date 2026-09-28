import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PaginatedData, TransactionView } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import { Bank } from './bank';

const pendingCredits = [
  transaction(237, 2_906_418),
  transaction(209, 1_036_320),
  transaction(204, 737_297),
];

function transaction(id: number, amount: number): TransactionView {
  return {
    id,
    from_user_id: null,
    from_label: 'Guild Bank',
    to_user_id: 7,
    to_username: 'Galvdon',
    to_label: 'Galvdon',
    to_guild_bank: false,
    amount,
    status: 'pending',
    type: 'split_credit',
    split_id: id,
    created_at: '2026-09-27T23:57:00Z',
    requested_at: null,
    withdrawn_at: null,
  };
}

function page(items: TransactionView[]): PaginatedData<TransactionView> {
  return {
    items,
    total_items: items.length,
    total_pages: 1,
    current_page: 1,
    limit: 1000,
  };
}

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

describe('Bank withdrawal credit selection', () => {
  let fixture: ComponentFixture<Bank>;
  let apiPost: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    stubDialogApi();
    const apiGet = vi.fn((path: string, params?: Record<string, string | number | boolean>) => {
      if (path === 'api/bank/balance') {
        return of({
          user_id: 7,
          pending_total: 2_906_418,
          pending_count: 3,
          requested_total: 0,
          requested_count: 0,
        });
      }
      if (path === 'api/bank/transactions' && params?.['status'] === 'pending') {
        return of(page(pendingCredits));
      }
      if (path === 'api/bank/transactions' && params?.['status'] === 'rejected') {
        return of(page([]));
      }
      return of(page([]));
    });
    apiPost = vi.fn().mockReturnValue(of([]));

    await TestBed.configureTestingModule({
      imports: [Bank],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        TranslateService,
        {
          provide: ApiService,
          useValue: { get: apiGet, post: apiPost },
        },
        {
          provide: AuthService,
          useValue: {
            profile: vi.fn().mockReturnValue({ tenant_kind: 'guild' }),
            hasPermission: vi.fn().mockReturnValue(false),
          },
        },
        {
          provide: ToastService,
          useValue: { success: vi.fn(), error: vi.fn() },
        },
      ],
    }).compileComponents();

    TestBed.inject(TranslateService).use('en');
    fixture = TestBed.createComponent(Bank);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('requests only selected credits that fit the net balance', async () => {
    const requestButton = [...fixture.nativeElement.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Request withdrawal'),
    ) as HTMLButtonElement;
    requestButton.click();
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    const largestCredit = fixture.nativeElement.querySelector(
      '#withdrawal-credit-237',
    ) as HTMLInputElement;
    const smallerCredits = [
      fixture.nativeElement.querySelector('#withdrawal-credit-209') as HTMLInputElement,
      fixture.nativeElement.querySelector('#withdrawal-credit-204') as HTMLInputElement,
    ];
    expect(largestCredit.disabled).toBe(false);
    largestCredit.click();
    fixture.detectChanges();

    expect(smallerCredits.every((credit) => credit.disabled)).toBe(true);

    const confirmButton = [...fixture.nativeElement.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Confirm',
    ) as HTMLButtonElement;
    confirmButton.click();
    await fixture.whenStable();

    expect(apiPost).toHaveBeenCalledWith('api/bank/transactions/withdraw', {
      transaction_ids: [237],
    });
  });
});
