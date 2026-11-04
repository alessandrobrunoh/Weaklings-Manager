import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { Subject, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BuildSummary, CompDetail, CompReadiness } from '../../core/models/api.models';
import { ApiError, ApiService } from '../../core/services/api.service';
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
/** A second, newer version of `extra` — same `(name, category_id)` group, higher `version`. */
const extraV2: BuildSummary = { ...extra, id: 4, version: 2 };

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

  it('clearly separates editing composition details from editing the roster', async () => {
    const fixture = TestBed.createComponent(CompDetailPage);
    await settleComp(fixture);

    const buttons = Array.from(fixture.nativeElement.querySelectorAll('button')) as HTMLButtonElement[];
    expect(buttons.filter((button) => button.textContent?.trim() === 'Edit composition details')).toHaveLength(1);
    const editRoster = buttons.find((button) => button.textContent?.includes('Edit roster'));
    expect(editRoster).toBeDefined();
    editRoster!.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Done editing');
    expect(fixture.nativeElement.textContent).toContain('Quantity changes are saved individually');
    expect(fixture.nativeElement.querySelector('input[type="number"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[aria-label="Edit Quantity to add: Great Hammer"]')).not.toBeNull();
  });

  it('requires a category when editing composition details and does not offer an uncategorized value', async () => {
    const fixture = TestBed.createComponent(CompDetailPage);
    await settleComp(fixture);
    const original = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value: function (this: HTMLDialogElement) { this.setAttribute('open', ''); },
    });
    try {
      const root = fixture.nativeElement as HTMLElement;
      const editDetails = Array.from(root.querySelectorAll('button'))
        .find((button) => button.textContent?.trim() === 'Edit composition details');
      editDetails!.click();
      fixture.detectChanges();

      const categorySelect = Array.from(root.querySelectorAll('select'))
        .find((select) => select.closest('label')?.textContent?.includes('Category'));
      expect(categorySelect?.required).toBe(true);
      expect(categorySelect?.labels?.[0]?.querySelector('[aria-hidden="true"]')?.textContent).toBe('*');
      expect(Array.from(categorySelect?.options ?? []).some((option) => option.value === '')).toBe(false);
      expect(root.textContent).toContain(
        'A category is required. Builds and compositions cannot be uncategorized.',
      );
    } finally {
      fixture.destroy();
      if (original) {
        Object.defineProperty(HTMLDialogElement.prototype, 'showModal', original);
      } else {
        Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
      }
    }
  });

  it('shows main and configured swap equipment and selected abilities without inspecting', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === `api/comps/${comp.id}`) return of(comp);
      if (path === `api/comps/${comp.id}/performance`) return of(null);
      if (path === 'api/comps/builds/1') return of({
        ...tank,
        items: [
          { loadout: 'main', slot: 'weapon', openalbion_item_type: 'weapon', openalbion_item_id: 1,
            openalbion_item_name: 'Polehammer', openalbion_item_icon: '/T8_MAIN_HAMMER.png',
            spells: { active: { '1': 'SPELL_ONE' }, passive: {} } },
          { loadout: 'swap', slot: 'weapon', openalbion_item_type: 'weapon', openalbion_item_id: 2,
            openalbion_item_name: 'Swap weapon', spells: { active: { '1': 'SWAP_SPELL' }, passive: {} } },
        ],
      });
      if (path === 'api/comps/builds/2') return throwError(() => new Error('unavailable'));
      return of({ items: [] });
    });
    const fixture = TestBed.createComponent(CompDetailPage);
    await settleComp(fixture);
    await fixture.whenStable();
    fixture.detectChanges();

    const section = fixture.nativeElement.querySelector('[aria-labelledby="composition-builds-heading"]') as HTMLElement;
    expect(section.querySelectorAll('article')).toHaveLength(2);
    expect(section.textContent).toContain('Polehammer');
    expect(section.textContent).toContain('SPELL_ONE');
    expect(section.textContent).toContain('Swap weapon');
    expect(section.textContent).toContain('SWAP_SPELL');
    expect(section.textContent).toContain('Build details unavailable');
    expect(fixture.nativeElement.querySelector('app-dialog')).toBeNull();
    const translations = TestBed.inject(TranslateService);
    translations.use('it');
    fixture.detectChanges();
    expect(section.textContent).toContain('Abilità selezionate');
    expect(section.textContent).toContain('Attiva 1');
    translations.use('en');
    fixture.detectChanges();

    const page = fixture.componentInstance as unknown as {
      abilityCatalog: { set(value: unknown): void };
      overviewBuilds: () => Map<number, unknown>;
    };
    page.abilityCatalog.set({
      MAIN_HAMMER: {
        label: 'Hammer', slot_type: 'weapon', two_handed: true, active_slots: 2, passive_slots: 0,
        active: { '1': [{ id: 'SPELL_ONE', name: 'Chosen spell' }], '2': [{ id: 'SPELL_TWO', name: 'Unchosen spell' }] },
        passive: {},
      },
    });
    fixture.detectChanges();
    const model = page.overviewBuilds().get(1);
    fixture.detectChanges();
    expect(page.overviewBuilds().get(1)).toBe(model);
    expect(section.textContent).toContain('Chosen spell');
    expect(section.textContent).not.toContain('Unchosen spell');
    expect(section.querySelectorAll('app-ability-bar .ability-bar__slot')).toHaveLength(2);
  });

  it('ignores older detail responses and keeps the latest roster loading', async () => {
    const fixture = TestBed.createComponent(CompDetailPage);
    await settleComp(fixture);
    const older = new Subject<unknown>();
    const newer = new Subject<unknown>();
    apiGet.mockReset().mockReturnValueOnce(older).mockReturnValueOnce(newer);
    const page = fixture.componentInstance as unknown as {
      loadBuildDetails: (value: CompDetail) => Promise<void>;
      buildDetails: () => ReadonlyMap<number, unknown>;
      buildDetailsLoading: () => boolean;
    };
    const oldRequest = page.loadBuildDetails({ ...comp, builds: [comp.builds[0]] });
    const newRequest = page.loadBuildDetails({ ...comp, builds: [comp.builds[1]] });
    older.next({ ...tank, items: [] });
    older.complete();
    await oldRequest;
    expect(page.buildDetailsLoading()).toBe(true);
    newer.next({ ...healer, items: [] });
    newer.complete();
    await newRequest;
    expect([...page.buildDetails().keys()]).toEqual([2]);
    expect(page.buildDetailsLoading()).toBe(false);

    const stale = new Subject<unknown>();
    const latest = new Subject<unknown>();
    apiGet.mockReturnValueOnce(stale).mockReturnValueOnce(latest);
    const staleRequest = page.loadBuildDetails({ ...comp, builds: [comp.builds[0]] });
    const latestRequest = page.loadBuildDetails({ ...comp, builds: [comp.builds[1]] });
    latest.next({ ...healer, items: [] });
    latest.complete();
    await latestRequest;
    stale.next({ ...tank, items: [] });
    stale.complete();
    await staleRequest;
    expect([...page.buildDetails().keys()]).toEqual([2]);
    expect(page.buildDetailsLoading()).toBe(false);
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
      expect.objectContaining({ sort: 'name', order: 'asc', mine: true }),
    );
    expect(page.filteredAvailableBuilds().map((item) => item.name)).toEqual(['Permafrost Prism']);
  });

  it('groups build versions in the add-build picker and preselects the latest on expand', async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === `api/comps/${comp.id}`) return of(comp);
      if (path === `api/comps/${comp.id}/performance`) return of(null);
      if (path === 'api/comps/builds') {
        return of({
          items: [tank, healer, extra, extraV2],
          total_items: 4,
          total_pages: 1,
          current_page: 1,
          limit: 200,
        });
      }
      if (path.startsWith('api/comps/builds/')) return of({ ...tank, items: [] });
      return of({ items: [] });
    });

    const fixture = TestBed.createComponent(CompDetailPage);
    await settleComp(fixture);

    const page = fixture.componentInstance as unknown as {
      openAddBuildModal: () => Promise<void>;
      availableBuildGroups: () => { key: string; versions: { id: number; version: number }[] }[];
      toggleBuildGroup: (group: { key: string; versions: { id: number }[] }) => void;
      newBuildId: () => string;
    };
    await page.openAddBuildModal();

    const groups = page.availableBuildGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].versions.map((v) => v.version)).toEqual([2, 1]);
    expect(page.newBuildId()).toBe('');

    page.toggleBuildGroup(groups[0]);
    expect(page.newBuildId()).toBe(String(extraV2.id));
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

describe('CompDetailPage alliance share', () => {
  const apiGet = vi.fn();
  const apiPost = vi.fn();
  const apiDelete = vi.fn();
  const toasts = { error: vi.fn(), success: vi.fn() };
  let permissions: string[];
  let tenantKind: string | undefined;

  beforeEach(async () => {
    permissions = ['alliance.share'];
    tenantKind = 'guild';
    apiGet.mockReset();
    apiPost.mockReset();
    apiDelete.mockReset();
    toasts.error.mockReset();
    toasts.success.mockReset();
    apiPost.mockReturnValue(of({ published_id: 99, shared_at: '2026-09-01T00:00:00Z' }));
    apiDelete.mockReturnValue(of(null));
    apiGet.mockImplementation((path: string) => {
      if (path === `api/comps/${comp.id}`) return of(comp);
      if (path === `api/comps/${comp.id}/performance`) return of(null);
      if (path === `api/alliance/shares/comp/${comp.id}`) {
        return of({ shared: true, share: { published_id: 99, shared_at: '2026-09-01T00:00:00Z' } });
      }
      if (path.startsWith('api/comps/builds/')) return of({ ...tank, items: [] });
      return of({ items: [] });
    });

    await TestBed.configureTestingModule({
      imports: [CompDetailPage],
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: ApiService,
          useValue: { get: apiGet, post: apiPost, patch: vi.fn(), delete: apiDelete },
        },
        {
          provide: AuthService,
          useValue: {
            hasPermission: (perm: string) => permissions.includes(perm),
            profile: () => ({ user_id: 1, tenant_kind: tenantKind }),
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
        { provide: ToastService, useValue: toasts },
        TranslateService,
        { provide: AlbionAbilitiesService, useValue: { load: () => Promise.resolve({}) } },
      ],
    }).compileComponents();
  });

  it('shows the shared badge and posts type=comp from a guild officer', async () => {
    const fixture = TestBed.createComponent(CompDetailPage);
    await settleComp(fixture);

    expect(apiGet).toHaveBeenCalledWith(`api/alliance/shares/comp/${comp.id}`);
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Shared with alliance');
    expect(text).toContain('Share with alliance');

    const page = fixture.componentInstance as unknown as {
      shareWithAlliance: () => Promise<void>;
    };
    await page.shareWithAlliance();
    expect(apiPost).toHaveBeenCalledWith('api/alliance/shares', { type: 'comp', id: comp.id });
    expect(toasts.success).toHaveBeenCalled();
  });

  it('shows the actual conflict instead of claiming every conflict means no alliance', async () => {
    const fixture = TestBed.createComponent(CompDetailPage);
    await settleComp(fixture);
    apiPost.mockReturnValue(throwError(() => new ApiError(409, 'That value is already in use.')));

    const page = fixture.componentInstance as unknown as { shareWithAlliance: () => Promise<void> };
    await page.shareWithAlliance();

    expect(toasts.error).toHaveBeenCalledWith('That value is already in use.');
  });

  it('still translates the specific missing active membership conflict', async () => {
    const fixture = TestBed.createComponent(CompDetailPage);
    await settleComp(fixture);
    apiPost.mockReturnValue(throwError(() =>
      new ApiError(409, 'guild is not an active member of an alliance'),
    ));

    const page = fixture.componentInstance as unknown as { shareWithAlliance: () => Promise<void> };
    await page.shareWithAlliance();

    expect(toasts.error).toHaveBeenCalledWith(TestBed.inject(TranslateService).t('comps.shareNoAlliance'));
  });

  it('unshares the composition without touching build endpoints', async () => {
    const fixture = TestBed.createComponent(CompDetailPage);
    await settleComp(fixture);

    const page = fixture.componentInstance as unknown as {
      unshareWithAlliance: () => Promise<void>;
    };
    await page.unshareWithAlliance();
    expect(apiDelete).toHaveBeenCalledWith(`api/alliance/shares/comp/${comp.id}`);
    expect(apiDelete).not.toHaveBeenCalledWith(expect.stringContaining('/shares/build/'));
  });

  it('hides share actions on an alliance tenant', async () => {
    tenantKind = 'alliance';
    const fixture = TestBed.createComponent(CompDetailPage);
    await settleComp(fixture);
    const text = fixture.nativeElement.textContent as string;
    expect(text).not.toContain('Share with alliance');
    expect(apiGet).not.toHaveBeenCalledWith(`api/alliance/shares/comp/${comp.id}`);
  });
});
