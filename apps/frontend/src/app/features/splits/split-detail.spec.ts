import { provideZonelessChangeDetection, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { describe, expect, it } from 'vitest';

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
  await fixture.whenStable();
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
