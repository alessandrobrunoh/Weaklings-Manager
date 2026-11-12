import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BuildSummary, CompDetail } from '../../core/models/api.models';
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
    created_by_id: 1,
    created_by_username: 'officer',
    updated_at: '2026-09-01T00:00:00Z',
    item_count: 1,
    main_item_count: 1,
    archived_at: null,
    weapon_key: null,
    weapon_name: null,
  };
}

const tank = build(1, 'Great Hammer', 'tank');
const healer = build(2, 'Hallowfall', 'healer');

const comp: CompDetail = {
  id: 1,
  name: 'Main ZvZ',
  description: null,
  category_id: 1,
  version: 1,
  category_name: 'ZvZ',
  created_by_id: 1,
  created_by_username: 'officer',
  created_at: '2026-09-01T00:00:00Z',
  build_count: 2,
  total_quantity: 25,
  parent_id: null,
  archived_at: null,
  builds: [
    // Listed healer-first on purpose: the roster orders by role, not by insertion.
    { build_id: 2, build: healer, quantity: 15 },
    { build_id: 1, build: tank, quantity: 10 },
  ],
};

type Fixture = ReturnType<typeof TestBed.createComponent<CompDetailPage>>;

/** Runs change detection until the composition (or a terminal error state) has rendered. */
async function settle(fixture: Fixture, rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    fixture.detectChanges();
    await fixture.whenStable();
    await Promise.resolve();
  }
  fixture.detectChanges();
}

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll('button')).find((button) => button.textContent?.trim() === text);
}

/** Patches `showModal` for the test, since jsdom does not implement it. Returns the restore function. */
function patchShowModal(): () => void {
  const original = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    },
  });
  return () => {
    if (original) {
      Object.defineProperty(HTMLDialogElement.prototype, 'showModal', original);
    } else {
      Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
    }
  };
}

interface PageApi {
  comp: () => CompDetail | null;
  parties: () => { partyNumber: number; seats: unknown[] }[];
  menuItems: () => { id: string; danger?: boolean }[];
  displayedQuantity: (entry: CompDetail['builds'][number]) => number;
  step: (entry: CompDetail['builds'][number], delta: number) => void;
  onMenu: (id: string) => void;
  openAdd: () => void;
  shareWithAlliance: () => Promise<void>;
  unshareWithAlliance: () => Promise<void>;
}

function api(fixture: Fixture): PageApi {
  return fixture.componentInstance as unknown as PageApi;
}

describe('CompDetailPage', () => {
  const apiGet = vi.fn();
  const apiPost = vi.fn();
  const apiPatch = vi.fn();
  const apiDelete = vi.fn();
  const toasts = { error: vi.fn(), success: vi.fn() };
  let permissions: string[];
  let tenantKind: string | undefined;

  beforeEach(async () => {
    permissions = ['comps.comps.edit'];
    tenantKind = 'guild';
    for (const mock of [apiGet, apiPost, apiPatch, apiDelete, toasts.error, toasts.success]) {
      mock.mockReset();
    }
    apiGet.mockImplementation((path: string) => {
      if (path === `api/comps/${comp.id}`) return of(comp);
      if (path === `api/comps/${comp.id}/performance`) {
        return of({
          comp_id: comp.id,
          comp_name: comp.name,
          events_with_battles: 0,
          stats: {
            total_battles: 0,
            wins: 0,
            losses: 0,
            win_rate: 0,
            total_kills: 0,
            total_deaths: 0,
            kill_death_ratio: 0,
            total_kill_fame: 0,
            average_guild_players: 0,
            top_opponents: [],
          },
        });
      }
      if (path === 'api/comps/comp-categories') return of([{ id: 1, name: 'ZvZ' }]);
      if (path === `api/comps/${comp.id}/price`) return of({ total: '0', builds: [] });
      if (path === `api/alliance/shares/comp/${comp.id}`) return of({ shared: false });
      if (path === 'api/comps/builds/1') {
        return of({
          ...tank,
          items: [
            {
              loadout: 'main',
              slot: 'weapon',
              openalbion_item_type: 'weapon',
              openalbion_item_id: 1,
              openalbion_item_name: 'Polehammer',
              openalbion_item_icon: '/T8_MAIN_HAMMER.png',
              spells: { active: { '1': 'SPELL_ONE' }, passive: {} },
            },
            {
              loadout: 'swap',
              slot: 'weapon',
              openalbion_item_type: 'weapon',
              openalbion_item_id: 2,
              openalbion_item_name: 'Swap weapon',
              spells: { active: {}, passive: {} },
            },
          ],
        });
      }
      if (path === 'api/comps/builds/2') return throwError(() => new Error('unavailable'));
      return of({ items: [] });
    });
    apiPost.mockReturnValue(of({ published_id: 99, shared_at: '2026-09-01T00:00:00Z' }));
    apiDelete.mockReturnValue(of(null));
    apiPatch.mockReturnValue(of(comp));

    await TestBed.configureTestingModule({
      imports: [CompDetailPage],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        {
          provide: ApiService,
          useValue: { get: apiGet, post: apiPost, patch: apiPatch, delete: apiDelete },
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
        { provide: ToastService, useValue: toasts },
        TranslateService,
        { provide: AlbionAbilitiesService, useValue: { load: () => Promise.resolve({}) } },
      ],
    }).compileComponents();
    // The page only needs `navigate`; keep the real router for `routerLink` but make navigation inert.
    vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('summary and roster', () => {
    it('leads with the name and the key numbers', async () => {
      const fixture = TestBed.createComponent(CompDetailPage);
      await settle(fixture);
      const root = fixture.nativeElement as HTMLElement;

      expect(root.querySelector('h1')?.textContent?.trim()).toBe('Main ZvZ');
      const stats = root.querySelector('dl')?.textContent ?? '';
      expect(stats).toContain('25');
      expect(stats).toContain('Last party: 5 of 20');
      // No battles recorded: never a 0% win rate.
      expect(stats).not.toContain('0%');
      expect(stats).toContain('No battles yet');
    });

    it('chunks the roster into 20-player parties', async () => {
      const fixture = TestBed.createComponent(CompDetailPage);
      await settle(fixture);

      const parties = api(fixture).parties();
      expect(parties).toHaveLength(2);
      expect(parties[0]?.seats).toHaveLength(COMP_PARTY_SIZE);
      expect(parties[1]?.seats).toHaveLength(5);
    });

    it('offers exactly the roster, parties and analytics views', async () => {
      const fixture = TestBed.createComponent(CompDetailPage);
      await settle(fixture);

      const tablist = (fixture.nativeElement as HTMLElement).querySelector('[role="tablist"]')!;
      const labels = Array.from(tablist.querySelectorAll('[role="tab"]')).map((tab) => tab.textContent?.trim());
      expect(labels).toEqual(['Roster', 'Parties', 'Analytics']);
    });

    it('lists builds front line first and fetches no loadout until a row is opened', async () => {
      const fixture = TestBed.createComponent(CompDetailPage);
      await settle(fixture);
      const root = fixture.nativeElement as HTMLElement;

      const names = Array.from(root.querySelectorAll('tbody .cd-build__name')).map((cell) =>
        cell.textContent?.replace(/\s+/g, ' ').trim(),
      );
      expect(names).toEqual(['Great Hammer v1', 'Hallowfall v1']);
      expect(apiGet).not.toHaveBeenCalledWith('api/comps/builds/1');
    });

    it('expands a row on demand, caches the loadout and collapses again', async () => {
      const fixture = TestBed.createComponent(CompDetailPage);
      await settle(fixture);
      const root = fixture.nativeElement as HTMLElement;

      const toggle = root.querySelector('.cd-toggle') as HTMLButtonElement;
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      toggle.click();
      await settle(fixture);

      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      const detail = root.querySelector(`#${toggle.getAttribute('aria-controls')}`) as HTMLElement;
      expect(detail.textContent).toContain('Polehammer');
      expect(detail.textContent).toContain('Swap weapon');

      toggle.click();
      await settle(fixture);
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      toggle.click();
      await settle(fixture);
      expect(apiGet.mock.calls.filter(([path]) => path === 'api/comps/builds/1')).toHaveLength(1);
    });

    it('says when a loadout could not be loaded instead of staying blank', async () => {
      const fixture = TestBed.createComponent(CompDetailPage);
      await settle(fixture);
      const root = fixture.nativeElement as HTMLElement;

      const toggles = root.querySelectorAll<HTMLButtonElement>('.cd-toggle');
      toggles[1]!.click();
      await settle(fixture);

      const t = TestBed.inject(TranslateService);
      const detail = root.querySelector(`#${toggles[1]!.getAttribute('aria-controls')}`) as HTMLElement;
      expect(detail.textContent).toContain(t.t('loadout.unavailable'));
    });
  });

  describe('editing', () => {
    it('switches one Edit action into a Done action with steppers, a single hint and an Add build button', async () => {
      const fixture = TestBed.createComponent(CompDetailPage);
      await settle(fixture);
      const root = fixture.nativeElement as HTMLElement;

      expect(root.querySelector('[aria-label^="Increase quantity of"]')).toBeNull();
      buttonByText(root, 'Edit')!.click();
      await settle(fixture);

      expect(buttonByText(root, 'Done')).toBeDefined();
      expect(buttonByText(root, 'Edit')).toBeUndefined();
      expect(root.querySelector('[aria-label="Increase quantity of Great Hammer"]')).not.toBeNull();
      expect(root.querySelector('[aria-label="Decrease quantity of Great Hammer"]')).not.toBeNull();
      expect(root.querySelector('input[type="number"]')).toBeNull();
      expect(root.textContent).toContain('Quantity changes save as you make them.');
      expect(buttonByText(root, 'Add build')).toBeDefined();
      expect(root.querySelector('[aria-label="Remove Great Hammer from the composition"]')).not.toBeNull();
    });

    it('hides every edit control from someone who cannot change the composition', async () => {
      permissions = [];
      const fixture = TestBed.createComponent(CompDetailPage);
      await settle(fixture);
      const root = fixture.nativeElement as HTMLElement;

      expect(buttonByText(root, 'Edit')).toBeUndefined();
      expect(api(fixture).menuItems().map((item) => item.id)).toEqual([]);
    });

    it('shows a stepped quantity at once and saves it once after the clicks stop', async () => {
      vi.useFakeTimers();
      const fixture = TestBed.createComponent(CompDetailPage);
      await settle(fixture);
      const page = api(fixture);
      const entry = comp.builds[1]!;

      page.step(entry, 1);
      page.step(entry, 1);
      expect(page.displayedQuantity(entry)).toBe(12);
      expect(apiPatch).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(600);
      expect(apiPatch).toHaveBeenCalledTimes(1);
      expect(apiPatch).toHaveBeenCalledWith('api/comps/1/builds/1', { quantity: 12 });
    });

    it('never steps below one player', async () => {
      const fixture = TestBed.createComponent(CompDetailPage);
      await settle(fixture);
      const page = api(fixture);
      const entry = { ...comp.builds[1]!, quantity: 1 };

      page.step(entry, -1);

      expect(page.displayedQuantity(entry)).toBe(1);
    });

    it('opens the add-build dialog from the empty state', async () => {
      const restore = patchShowModal();
      try {
        apiGet.mockImplementation((path: string) => {
          if (path === `api/comps/${comp.id}`) return of({ ...comp, builds: [], total_quantity: 0, build_count: 0 });
          if (path === `api/comps/${comp.id}/performance`) return of(null);
          return of({ items: [], total_items: 0, total_pages: 1, current_page: 1, limit: 200 });
        });
        const fixture = TestBed.createComponent(CompDetailPage);
        await settle(fixture);
        const root = fixture.nativeElement as HTMLElement;

        expect(root.textContent).toContain('No builds yet.');
        buttonByText(root, 'Add build')!.click();
        await settle(fixture);

        expect(root.querySelector('app-comp-add-build-dialog')).not.toBeNull();
      } finally {
        restore();
      }
    });

    it('requires a category when editing composition details and offers no uncategorized value', async () => {
      const restore = patchShowModal();
      try {
        const fixture = TestBed.createComponent(CompDetailPage);
        await settle(fixture);
        const root = fixture.nativeElement as HTMLElement;

        api(fixture).onMenu('editDetails');
        await settle(fixture);

        const categorySelect = Array.from(root.querySelectorAll('select')).find((select) =>
          select.closest('label')?.textContent?.includes('Category'),
        );
        expect(categorySelect?.required).toBe(true);
        expect(categorySelect?.labels?.[0]?.querySelector('[aria-hidden="true"]')?.textContent).toBe('*');
        expect(Array.from(categorySelect?.options ?? []).some((option) => option.value === '')).toBe(false);
        expect(root.textContent).toContain(
          'A category is required. Builds and compositions cannot be uncategorized.',
        );
      } finally {
        restore();
      }
    });

    it('toasts a translated message, never raw API text, when a save fails', async () => {
      apiPatch.mockReturnValue(throwError(() => new ApiError(500, 'pq: connection refused')));
      vi.useFakeTimers();
      const fixture = TestBed.createComponent(CompDetailPage);
      await settle(fixture);
      const page = api(fixture);

      page.step(comp.builds[1]!, 1);
      await vi.advanceTimersByTimeAsync(600);

      expect(toasts.error).toHaveBeenCalledWith(TestBed.inject(TranslateService).t('compDetail.error.save'));
      expect(toasts.error).not.toHaveBeenCalledWith(expect.stringContaining('pq:'));
    });
  });

  describe('overflow menu', () => {
    it('offers manage actions and a separated, dangerous Archive', async () => {
      permissions = ['comps.comps.edit', 'comps.comps.delete', 'comps.comps.create'];
      const fixture = TestBed.createComponent(CompDetailPage);
      await settle(fixture);

      const items = api(fixture).menuItems();
      expect(items.map((item) => item.id)).toEqual(['editDetails', 'clone', 'newVersion', 'archive']);
      expect(items.find((item) => item.id === 'archive')?.danger).toBe(true);
    });

    it('offers Compare versions only when there is another version', async () => {
      apiGet.mockImplementation((path: string) => {
        if (path === `api/comps/${comp.id}`) {
          return of({
            ...comp,
            versions: [
              { id: 1, version: 1 },
              { id: 5, version: 2 },
            ],
          });
        }
        if (path === `api/comps/${comp.id}/performance`) return of(null);
        return of({ items: [] });
      });
      const fixture = TestBed.createComponent(CompDetailPage);
      await settle(fixture);

      expect(api(fixture).menuItems().map((item) => item.id)).toContain('compare');
    });

    it('swaps Archive for Unarchive on an archived composition', async () => {
      permissions = ['comps.comps.edit', 'comps.comps.delete'];
      apiGet.mockImplementation((path: string) => {
        if (path === `api/comps/${comp.id}`) return of({ ...comp, archived_at: '2026-09-02T00:00:00Z' });
        if (path === `api/comps/${comp.id}/performance`) return of(null);
        return of({ items: [] });
      });
      const fixture = TestBed.createComponent(CompDetailPage);
      await settle(fixture);

      const ids = api(fixture).menuItems().map((item) => item.id);
      expect(ids).toContain('unarchive');
      expect(ids).not.toContain('archive');
      expect((fixture.nativeElement as HTMLElement).textContent).toContain('Archived');
    });
  });

  describe('load states', () => {
    it('shows a not-found state, not a generic error, for a missing composition', async () => {
      apiGet.mockImplementation((path: string) => {
        if (path === `api/comps/${comp.id}`) return throwError(() => new ApiError(404, 'not found'));
        return of(null);
      });
      const fixture = TestBed.createComponent(CompDetailPage);
      await settle(fixture);
      const root = fixture.nativeElement as HTMLElement;

      expect(root.textContent).toContain('Composition not found');
      expect(root.querySelector('[role="alert"]')).toBeNull();
      expect(root.querySelector('a[href="/comps"]')).not.toBeNull();
    });

    it('shows a retryable error for any other failure', async () => {
      apiGet.mockImplementation((path: string) => {
        if (path === `api/comps/${comp.id}`) return throwError(() => new ApiError(500, 'boom'));
        return of(null);
      });
      const fixture = TestBed.createComponent(CompDetailPage);
      await settle(fixture);
      const root = fixture.nativeElement as HTMLElement;

      expect(root.querySelector('[role="alert"]')).not.toBeNull();
      expect(root.textContent).not.toContain('Composition not found');
      expect(buttonByText(root, 'Retry')).toBeDefined();
    });
  });

  describe('alliance share', () => {
    beforeEach(() => {
      permissions = ['alliance.share'];
      apiGet.mockImplementation((path: string) => {
        if (path === `api/comps/${comp.id}`) return of(comp);
        if (path === `api/comps/${comp.id}/performance`) return of(null);
        if (path === `api/alliance/shares/comp/${comp.id}`) {
          return of({ shared: true, share: { published_id: 99, shared_at: '2026-09-01T00:00:00Z' } });
        }
        return of({ items: [] });
      });
    });

    it('shows the shared badge and offers Unshare', async () => {
      const fixture = TestBed.createComponent(CompDetailPage);
      await settle(fixture);

      expect(apiGet).toHaveBeenCalledWith(`api/alliance/shares/comp/${comp.id}`);
      expect((fixture.nativeElement as HTMLElement).textContent).toContain('Shared with alliance');
      expect(api(fixture).menuItems().map((item) => item.id)).toContain('unshare');
    });

    it('posts type=comp from a guild officer', async () => {
      const fixture = TestBed.createComponent(CompDetailPage);
      await settle(fixture);

      await api(fixture).shareWithAlliance();

      expect(apiPost).toHaveBeenCalledWith('api/alliance/shares', { type: 'comp', id: comp.id });
      expect(toasts.success).toHaveBeenCalled();
    });

    it('answers an unexpected conflict with the generic message, not the raw API text', async () => {
      const fixture = TestBed.createComponent(CompDetailPage);
      await settle(fixture);
      apiPost.mockReturnValue(throwError(() => new ApiError(409, 'That value is already in use.')));

      await api(fixture).shareWithAlliance();

      expect(toasts.error).toHaveBeenCalledWith(TestBed.inject(TranslateService).t('compDetail.error.action'));
    });

    it('still translates the specific missing active membership conflict', async () => {
      const fixture = TestBed.createComponent(CompDetailPage);
      await settle(fixture);
      apiPost.mockReturnValue(
        throwError(() => new ApiError(409, 'guild is not an active member of an alliance')),
      );

      await api(fixture).shareWithAlliance();

      expect(toasts.error).toHaveBeenCalledWith(TestBed.inject(TranslateService).t('comps.shareNoAlliance'));
    });

    it('unshares the composition without touching build endpoints', async () => {
      const fixture = TestBed.createComponent(CompDetailPage);
      await settle(fixture);

      await api(fixture).unshareWithAlliance();

      expect(apiDelete).toHaveBeenCalledWith(`api/alliance/shares/comp/${comp.id}`);
      expect(apiDelete).not.toHaveBeenCalledWith(expect.stringContaining('/shares/build/'));
    });

    it('hides share actions on an alliance tenant', async () => {
      tenantKind = 'alliance';
      const fixture = TestBed.createComponent(CompDetailPage);
      await settle(fixture);

      expect(api(fixture).menuItems().map((item) => item.id)).not.toContain('share');
      expect(api(fixture).menuItems().map((item) => item.id)).not.toContain('unshare');
      expect(apiGet).not.toHaveBeenCalledWith(`api/alliance/shares/comp/${comp.id}`);
    });
  });
});
