import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TenantFeaturesView } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import { AdminFeatures } from './admin-features';

const mockView: TenantFeaturesView = {
  catalog: [
    { key: 'splits', display_name: 'Splits', description: null },
    { key: 'events', display_name: 'Events', description: null },
    { key: 'intel', display_name: 'Intel', description: null },
  ],
  flags: [
    { key: 'splits', enabled: true },
    { key: 'events', enabled: true },
  ],
  rank_name: 'Gold',
  allowed_keys: ['splits', 'events'],
};

describe('AdminFeatures', () => {
  let fixture: ComponentFixture<AdminFeatures>;
  let api: { get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    api = {
      get: vi.fn().mockReturnValue(of(mockView)),
      put: vi.fn().mockReturnValue(of({ ...mockView, flags: [{ key: 'splits', enabled: true }] })),
    };

    await TestBed.configureTestingModule({
      imports: [AdminFeatures],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiService, useValue: api },
        { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
        { provide: TranslateService, useValue: { t: (key: string) => key } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(AdminFeatures);
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('lists only Rank-allowed modules and can disable one', async () => {
    expect(api.get).toHaveBeenCalledWith('api/admin/features');
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.textContent).toContain('Splits');
    expect(compiled.textContent).toContain('Events');
    expect(compiled.textContent).not.toContain('Intel');

    const events = compiled.querySelector('#tenant-flag-events') as HTMLInputElement;
    events.checked = false;
    events.dispatchEvent(new Event('change'));
    const form = compiled.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await fixture.whenStable();
    expect(api.put).toHaveBeenCalledWith('api/admin/features', {
      flags: [
        { key: 'splits', enabled: true },
        { key: 'events', enabled: false },
      ],
    });
  });
});
