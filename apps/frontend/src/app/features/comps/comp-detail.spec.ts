import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BuildSummary, CompDetail, CompReadiness } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import { AlbionAbilitiesService } from '../../shared/services/albion-abilities.service';
import { CompDetailPage } from './comp-detail';
import { COMP_PARTY_SIZE } from './comp-parties';

function build(id: number, name: string, role: BuildSummary['role'] = 'dps'): BuildSummary {
  return {
    id,
    name,
    description: null,
    role,
    category_id: 1,
    version: 1,
    category_name: 'ZvZ',
    created_by_username: 'officer',
    updated_at: '2026-09-01T00:00:00Z',
    item_count: 1,
    archived_at: null,
  };
}

const tank = build(1, 'Great Hammer', 'tank');
const healer = build(2, 'Hallowfall', 'healer');
const extra = build(3, 'Permafrost Prism', 'dps');

const comp: CompDetail = {
  id: 1,
  name: 'Main ZvZ',
  description: null,
  category_id: 1,
  version: 1,
  category_name: 'ZvZ',
  created_by_username: 'officer',
  created_at: '2026-09-01T00:00:00Z',
  build_count: 2,
  total_quantity: 25,
  parent_id: null,
  archived_at: null,
  builds: [
    { build_id: 1, build: tank, quantity: 10 },
    { build_id: 2, build: healer, quantity: 15 },
  ],
};

async function settleComp(fixture: { detectChanges(): void; whenStable(): Promise<void>; componentInstance: unknown }): Promise<void> {
  for (let i = 0; i < 20; i++) {
    fixture.detectChanges();
    await fixture.whenStable();
    await Promise.resolve();
    const page = fixture.componentInstance as { comp: () => CompDetail | null };
    if (page.comp()) {
      fixture.detectChanges();
      return;
    }
  }
}

describe('CompDetailPage roster', () => {
  const apiGet = vi.fn();

  beforeEach(async () => {
    apiGet.mockReset();
    apiGet.mockImplementation((path: string) => {
      if (path === `api/comps/${comp.id}`) return of(comp);
      if (path === `api/comps/${comp.id}/performance`) return of(null);
      if (path === 'api/comps/builds') {
        return of({
          items: [tank, healer, extra],
          total_items: 3,
          total_pages: 1,
          current_page: 1,
          limit: 200,
        });
      }
      if (path.startsWith('api/comps/builds/')) {
        return of({ ...tank, items: [] });
      }
      return of({ items: [] });
    });

    await TestBed.configureTestingModule({
      imports: [CompDetailPage],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiService, useValue: { get: apiGet, post: vi.fn(), patch: vi.fn(), delete: vi.fn() } },
        {
          provide: AuthService,
          useValue: {
            hasPermission: (perm: string) => perm === 'comps.comps.edit',
            profile: () => ({ user_id: 1 }),
          },
        },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { paramMap: convertToParamMap({ compId: '1' }) },
            paramMap: of(convertToParamMap({ compId: '1' })),
          },
        },
        { provide: Router, useValue: { navigate: () => Promise.resolve(true) } },
        { provide: ToastService, useValue: { error: vi.fn(), success: vi.fn() } },
        TranslateService,
        { provide: AlbionAbilitiesService, useValue: { load: () => Promise.resolve({}) } },
      ],
    }).compileComponents();
  });

  it('chunks the roster into 20-player parties', async () => {
    const fixture = TestBed.createComponent(CompDetailPage);
    await settleComp(fixture);

    const page = fixture.componentInstance as unknown as {
      partySimulation: () => { partyNumber: number; seats: unknown[] }[];
    };
    const parties = page.partySimulation();
    expect(parties).toHaveLength(2);
    expect(parties[0]?.seats).toHaveLength(COMP_PARTY_SIZE);
    expect(parties[1]?.seats).toHaveLength(5);
    expect(fixture.nativeElement.textContent).toContain('/20');
    expect(fixture.nativeElement.textContent).not.toMatch(/\/5\b/);
  });

  it('loads available builds when opening the add-build dialog', async () => {
    const fixture = TestBed.createComponent(CompDetailPage);
    await settleComp(fixture);

    const addButton = [...fixture.nativeElement.querySelectorAll('button')].find((button) =>
      (button as HTMLButtonElement).textContent?.includes('Add build'),
    ) as HTMLButtonElement | undefined;
    expect(addButton).toBeTruthy();

    const page = fixture.componentInstance as unknown as {
      openAddBuildModal: () => Promise<void>;
      filteredAvailableBuilds: () => { name: string }[];
    };
    await page.openAddBuildModal();

    expect(apiGet).toHaveBeenCalledWith(
      'api/comps/builds',
      expect.objectContaining({ sort: 'name', order: 'asc' }),
    );
    expect(page.filteredAvailableBuilds().map((item) => item.name)).toEqual(['Permafrost Prism']);
  });
});

describe('CompDetailPage readiness tab', () => {
  const readiness: CompReadiness = {
    seat_count: 2,
    avg_item_power_now: 900,
    avg_item_power_at_max: 1500,
    readiness_pct: 0.6,
    weakest_seats: [
      {
        seat_key: 'build:2:1',
        build_id: 2,
        build_name: 'Hallowfall',
        best_candidate_user_id: null,
        best_candidate_username: '',
        best_candidate_item_power: 0,
        max_item_power: 1500,
        readiness: 0,
        item_power_gap: 1500,
        qualified_members: 0,
      },
    ],
    bench_coverage: [
      { build_id: 1, build_name: 'Great Hammer', seat_count: 1, qualified_members: 1 },
      { build_id: 2, build_name: 'Hallowfall', seat_count: 1, qualified_members: 0 },
    ],
    uncovered_seats: ['build:2:1'],
    mastery_levels_known: false,
  };

  const apiGet = vi.fn();

  beforeEach(async () => {
    apiGet.mockReset();
    apiGet.mockImplementation((path: string) => {
      if (path === `api/comps/${comp.id}`) return of(comp);
      if (path === `api/comps/${comp.id}/performance`) return of(null);
      if (path === `api/comps/${comp.id}/readiness`) return of(readiness);
      if (path.startsWith('api/comps/builds/')) return of({ ...tank, items: [] });
      return of({ items: [] });
    });

    await TestBed.configureTestingModule({
      imports: [CompDetailPage],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiService, useValue: { get: apiGet, post: vi.fn(), patch: vi.fn(), delete: vi.fn() } },
        {
          provide: AuthService,
          useValue: {
            hasPermission: (perm: string) => perm === 'combat.readiness.view',
            profile: () => ({ user_id: 1 }),
          },
        },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { paramMap: convertToParamMap({ compId: '1' }) },
            paramMap: of(convertToParamMap({ compId: '1' })),
          },
        },
        { provide: Router, useValue: { navigate: () => Promise.resolve(true) } },
        { provide: ToastService, useValue: { error: vi.fn(), success: vi.fn() } },
        TranslateService,
        { provide: AlbionAbilitiesService, useValue: { load: () => Promise.resolve({}) } },
      ],
    }).compileComponents();
  });

  it('fetches readiness only when the viewer can see it, and renders the roll-up', async () => {
    const fixture = TestBed.createComponent(CompDetailPage);
    await settleComp(fixture);

    expect(apiGet).toHaveBeenCalledWith(`api/comps/${comp.id}/readiness`);

    const page = fixture.componentInstance as unknown as {
      viewMode: { set(value: string): void };
    };
    page.viewMode.set('readiness');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Hallowfall');
    expect(text).toContain('900');
    expect(text).toContain('1500');
  });
});
