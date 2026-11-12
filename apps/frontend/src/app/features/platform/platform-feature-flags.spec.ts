import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of, Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TenantFeaturesView } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import { PlatformFeatureFlags } from './platform-feature-flags';

const mockView: TenantFeaturesView = {
  catalog: [
    { key: 'regolamento', display_name: 'Rules', description: 'Guild rules' },
    { key: 'splits.paid', display_name: 'Paid splits', description: null },
  ],
  flags: [{ key: 'regolamento', enabled: true }],
  rank_id: 'rank-1',
  rank_name: 'Pro',
  allowed_keys: ['regolamento'],
};

const SPLITS = '[id="flag-splits.paid"]';
const RULES = '#flag-regolamento';

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

describe('PlatformFeatureFlags', () => {
  let fixture: ComponentFixture<PlatformFeatureFlags>;
  let api: { get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> };
  let toasts: { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  const page = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const saveButton = (): HTMLButtonElement =>
    page().querySelector('button[form="platform-feature-flags-form"]') as HTMLButtonElement;
  const submitForm = (): void => {
    (page().querySelector('form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
  };
  const toggle = (selector: string): void => {
    (page().querySelector(selector) as HTMLInputElement).click();
    fixture.detectChanges();
  };

  beforeEach(async () => {
    stubDialogApi();
    api = {
      get: vi.fn().mockReturnValue(of(mockView)),
      put: vi.fn().mockReturnValue(
        of({
          ...mockView,
          flags: [
            { key: 'regolamento', enabled: false },
            { key: 'splits.paid', enabled: true },
          ],
        } satisfies TenantFeaturesView),
      ),
    };
    toasts = { success: vi.fn(), error: vi.fn() };

    await TestBed.configureTestingModule({
      imports: [PlatformFeatureFlags],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: ApiService, useValue: api },
        { provide: ToastService, useValue: toasts },
        { provide: TranslateService, useValue: { t: (key: string) => key } },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { paramMap: convertToParamMap({ tenantId: '111' }) },
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(PlatformFeatureFlags);
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('loads the catalog into a table with rank and source columns', () => {
    expect(api.get).toHaveBeenCalledWith('api/platform/tenants/111/features');
    expect(page().textContent).toContain('Rules');
    expect(page().textContent).toContain('Paid splits');
    expect(page().textContent).toContain('regolamento');
    expect(page().textContent).toContain('platform.features.rankAllows');
    expect(page().textContent).toContain('platform.features.sourceOverride');
    expect(page().querySelector('table')).not.toBeNull();

    expect((page().querySelector(RULES) as HTMLInputElement).checked).toBe(true);
    expect((page().querySelector(SPLITS) as HTMLInputElement).checked).toBe(false);
  });

  it('keeps save disabled until a flag changes', () => {
    expect(saveButton().disabled).toBe(true);
    toggle(SPLITS);
    expect(saveButton().disabled).toBe(false);
  });

  it('saves additions without confirmation', async () => {
    toggle(SPLITS);
    submitForm();
    await fixture.whenStable();
    expect(api.put).toHaveBeenCalledWith('api/platform/tenants/111/features', {
      flags: [
        { key: 'regolamento', enabled: true },
        { key: 'splits.paid', enabled: true },
      ],
    });
    expect(toasts.success).toHaveBeenCalledWith('platform.features.saved');
  });

  it('asks for confirmation before turning a feature off', async () => {
    toggle(RULES);
    submitForm();
    fixture.detectChanges();
    expect(api.put).not.toHaveBeenCalled();
    const dialog = page().querySelector('app-dialog');
    expect(dialog?.textContent).toContain('Rules');

    const confirm = Array.from(page().querySelectorAll('button')).find((button) =>
      button.textContent?.includes('platform.features.confirmAction'),
    ) as HTMLButtonElement;
    confirm.click();
    await fixture.whenStable();
    expect(api.put).toHaveBeenCalledWith('api/platform/tenants/111/features', {
      flags: [
        { key: 'regolamento', enabled: false },
        { key: 'splits.paid', enabled: false },
      ],
    });
  });

  it('filters rows by search text and by changed state', () => {
    const component = fixture.componentInstance as unknown as Record<string, { set: (v: unknown) => void }>;
    component['query'].set('paid');
    fixture.detectChanges();
    expect(page().querySelector(RULES)).toBeNull();
    expect(page().querySelector(SPLITS)).not.toBeNull();

    component['query'].set('');
    component['changedOnly'].set(true);
    fixture.detectChanges();
    expect(page().querySelector(RULES)).toBeNull();
    expect(page().querySelector(SPLITS)).toBeNull();
  });

  it('shows loading until the catalog arrives', async () => {
    fixture.destroy();
    const request = new Subject<TenantFeaturesView>();
    api.get.mockReturnValue(request);
    fixture = TestBed.createComponent(PlatformFeatureFlags);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe('common.loading');
    expect(root.querySelector('form')).toBeNull();
    request.next(mockView);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(root.textContent).toContain('Rules');
  });

  it('prevents edits during save and keeps changes after failure', async () => {
    const request = new Subject<TenantFeaturesView>();
    api.put.mockReturnValue(request);
    toggle(SPLITS);
    submitForm();
    fixture.detectChanges();
    expect((page().querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(true);
    request.error(new Error('offline'));
    await fixture.whenStable();
    fixture.detectChanges();
    expect((page().querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(false);
    expect((page().querySelector(SPLITS) as HTMLInputElement).checked).toBe(true);
    expect(toasts.error).toHaveBeenCalledWith('platform.features.saveFailed');
  });
});
