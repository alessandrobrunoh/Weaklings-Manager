import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FeatureCatalogItem, TenantRankView } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import { PlatformRanks } from './platform-ranks';

const catalog: FeatureCatalogItem[] = [
  { key: 'splits', display_name: 'Splits', description: null },
  { key: 'events', display_name: 'Events', description: null },
];

const gold: TenantRankView = {
  id: 'rank-1',
  name: 'Gold',
  description: null,
  feature_keys: ['splits'],
  is_default: true,
  created_at: '2026-01-01',
};

const silver: TenantRankView = {
  id: 'rank-2',
  name: 'Silver',
  description: null,
  feature_keys: [],
  is_default: false,
  created_at: '2026-01-02',
};

describe('PlatformRanks', () => {
  let fixture: ComponentFixture<PlatformRanks>;
  let api: {
    get: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
    patch: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    api = {
      get: vi.fn((path: string) => {
        if (path === 'api/platform/features') {
          return of(catalog);
        }
        return of([gold, silver]);
      }),
      post: vi.fn().mockReturnValue(
        of({
          id: 'rank-3',
          name: 'Bronze',
          description: null,
          feature_keys: [],
          is_default: false,
          created_at: '2026-01-03',
        } satisfies TenantRankView),
      ),
      put: vi.fn().mockReturnValue(of({ ...gold, feature_keys: ['splits', 'events'] })),
      patch: vi.fn().mockReturnValue(of({ ...silver, is_default: true })),
      delete: vi.fn().mockReturnValue(of(null)),
    };

    await TestBed.configureTestingModule({
      imports: [PlatformRanks],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiService, useValue: api },
        { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
        { provide: TranslateService, useValue: { t: (key: string) => key } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(PlatformRanks);
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('lists ranks and can create a new one', async () => {
    expect(api.get).toHaveBeenCalledWith('api/platform/ranks');
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.textContent).toContain('Gold');

    const name = compiled.querySelector('#rank-name') as HTMLInputElement;
    name.value = 'Bronze';
    name.dispatchEvent(new Event('input'));
    const form = compiled.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(api.post).toHaveBeenCalledWith('api/platform/ranks', {
      name: 'Bronze',
      description: undefined,
    });
    expect(compiled.textContent).toContain('Bronze');
  });

  it('moves the default flag onto the rank whose button was pressed', async () => {
    const compiled = fixture.nativeElement as HTMLElement;
    const setDefault = [...compiled.querySelectorAll('button')].filter(
      (button) => button.textContent?.trim() === 'platform.ranks.setDefault',
    );
    // Only the non-default rank offers the action.
    expect(setDefault).toHaveLength(1);

    setDefault[0].click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(api.patch).toHaveBeenCalledWith('api/platform/ranks/rank-2', { is_default: true });
    const remaining = [...compiled.querySelectorAll('button')].filter(
      (button) => button.textContent?.trim() === 'platform.ranks.setDefault',
    );
    expect(remaining).toHaveLength(1);
    expect(compiled.querySelectorAll('.chip--success')).toHaveLength(1);
  });
});
