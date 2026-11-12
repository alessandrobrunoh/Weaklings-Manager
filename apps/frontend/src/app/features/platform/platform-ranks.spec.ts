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

function stubDialogApi(): void {
  if (typeof HTMLDialogElement === 'undefined') return;
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
}

/** Menu triggers are icon-only and labelled with the rank name; the stub translator returns keys. */
function menuTriggers(root: HTMLElement): HTMLButtonElement[] {
  return [...root.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]')];
}

function buttonsWithText(root: ParentNode, text: string): HTMLButtonElement[] {
  return [...root.querySelectorAll<HTMLButtonElement>('button')].filter(
    (button) => button.textContent?.trim() === text,
  );
}

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
    stubDialogApi();
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

  it('lists ranks with the modules each one unlocks', () => {
    expect(api.get).toHaveBeenCalledWith('api/platform/ranks');
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.textContent).toContain('Gold');
    expect(compiled.querySelector('app-data-table')).not.toBeNull();
    expect(compiled.querySelectorAll('app-status-chip')).toHaveLength(1);
  });

  it('creates a rank from the dialog and then opens its module editor', async () => {
    const compiled = fixture.nativeElement as HTMLElement;
    compiled.querySelector('app-page-header button')?.dispatchEvent(new Event('click'));
    fixture.detectChanges();

    const name = compiled.querySelector('#rank-name') as HTMLInputElement;
    name.value = 'Bronze';
    name.dispatchEvent(new Event('input'));
    const form = compiled.querySelector('#create-rank-form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(api.post).toHaveBeenCalledWith('api/platform/ranks', {
      name: 'Bronze',
      description: undefined,
    });
    expect(compiled.querySelector('#create-rank-form')).toBeNull();
    expect(compiled.querySelector('#edit-rank-form')).not.toBeNull();
    expect(compiled.textContent).toContain('Bronze');
  });

  it('moves the default flag onto the rank chosen from its menu', async () => {
    const compiled = fixture.nativeElement as HTMLElement;
    // Gold is already default, so only Silver's menu offers the action.
    const silverMenu = menuTriggers(compiled)[1];
    silverMenu.click();
    fixture.detectChanges();
    const setDefault = buttonsWithText(document.body, 'platform.ranks.setDefault');
    expect(setDefault).toHaveLength(1);

    setDefault[0].click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(api.patch).toHaveBeenCalledWith('api/platform/ranks/rank-2', { is_default: true });
    expect(compiled.querySelectorAll('app-status-chip')).toHaveLength(1);
  });

  it('saves the modules a rank unlocks from its edit dialog', async () => {
    const compiled = fixture.nativeElement as HTMLElement;
    buttonsWithText(compiled, 'platform.ranks.edit')[0].click();
    fixture.detectChanges();

    const events = compiled.querySelector('#rank-feat-events') as HTMLInputElement;
    events.checked = true;
    events.dispatchEvent(new Event('change'));
    const form = compiled.querySelector('#edit-rank-form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(api.put).toHaveBeenCalledWith('api/platform/ranks/rank-1/features', {
      keys: ['splits', 'events'],
    });
    expect(compiled.querySelector('#edit-rank-form')).toBeNull();
  });

  it('confirms before deleting a rank', async () => {
    const compiled = fixture.nativeElement as HTMLElement;
    menuTriggers(compiled)[1].click();
    fixture.detectChanges();
    buttonsWithText(document.body, 'common.delete')[0]?.click();
    fixture.detectChanges();

    expect(api.delete).not.toHaveBeenCalled();
    const confirm = buttonsWithText(document.body, 'common.delete').find((button) =>
      button.classList.contains('btn--danger'),
    );
    expect(confirm).toBeDefined();
    confirm?.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(api.delete).toHaveBeenCalledWith('api/platform/ranks/rank-2');
    expect(compiled.textContent).not.toContain('Silver');
  });
});
