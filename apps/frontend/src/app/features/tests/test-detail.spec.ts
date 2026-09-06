import { provideZonelessChangeDetection } from '@angular/core';
import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScenarioDeclaredCast, ScenarioDetail } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import { AlbionAbilitiesService } from '../../shared/services/albion-abilities.service';
import { AlbionCatalogService } from '../../shared/services/albion-catalog.service';
import { TestDetailPage } from './test-detail';

/**
 * The definition as the server sends it: keys in a different order from the page's own literals,
 * and `attacker_style` omitted — the exact shape that used to leave `dirty()` stuck on.
 */
const SCENARIO = {
  id: 1,
  name: 'Burst check',
  version: 1,
  created_by: 1,
  created_by_username: 'officer',
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
  archived_at: null,
  run_count: 0,
  versions: [],
  definition: {
    groups: [
      { side: 'ally', label: 'Polehammer', id: 'ally-hammer', count: 2, hit_points: 1200 },
      { side: 'enemy', label: 'Guardian', id: 'enemy-plate', count: 1, hit_points: 1200 },
    ],
    casts: [{ cast_at: 1, spell_id: 'WHIRL', caster_group_id: 'ally-hammer', target_ids: [] }],
  },
} as unknown as ScenarioDetail;

/** A build whose main weapon is what the cast inspector should adopt. */
const BUILD = {
  id: 7,
  name: 'Polehammer ZvZ',
  items: [
    {
      slot: 'weapon',
      openalbion_item_name: 'Polehammer',
      openalbion_item_icon: 'https://render.albiononline.com/v1/item/T8_2H_POLEHAMMER.png?quality=1',
    },
  ],
};

interface Page {
  scenario: () => ScenarioDetail | null;
  draft: () => {
    casts: ScenarioDeclaredCast[];
    groups: { id: string; label: string; item_id?: string | null }[];
  };
  dirty: () => boolean;
  selectedCastIndex: () => number | null;
  activeTab: { set(tab: 'setup' | 'timeline' | 'results'): void };
  timelineView: { set(view: 'timeline' | 'table'): void };
  onTimelineCastCreated(event: {
    casterGroupId: string;
    spellId: string;
    castAt: number;
  }): void;
  onTimelineCastMoved(event: { index: number; castAt: number; casterGroupId: string }): void;
  onCastPatched(event: { index: number; patch: Partial<ScenarioDeclaredCast> }): void;
  removeCast(index: number): void;
  openBuildPickerForCaster(): void;
  openBuildImport(): void;
  onBuildSelected(option: { id: number; title: string }): Promise<void>;
  openWeaponPickerForCaster(): void;
  onWeaponSelected(option: { id: string; title: string }): void;
  selectedCasterGroup: () => { id: string; item_id?: string | null } | null;
}

async function settle(fixture: ComponentFixture<TestDetailPage>): Promise<Page> {
  for (let i = 0; i < 20; i += 1) {
    fixture.detectChanges();
    await fixture.whenStable();
    await Promise.resolve();
    const page = fixture.componentInstance as unknown as Page;
    if (page.scenario()) {
      fixture.detectChanges();
      return page;
    }
  }
  throw new Error('the scenario never loaded');
}

describe('TestDetailPage timeline tab', () => {
  const apiGet = vi.fn();
  const apiPatch = vi.fn();

  beforeEach(async () => {
    apiGet.mockReset();
    apiPatch.mockReset();
    apiGet.mockImplementation((path: string) => {
      if (path === 'api/combat/tests/1') return of(SCENARIO);
      if (path === 'api/combat/tests/1/runs') return of([]);
      if (path === 'api/comps/builds/7') return of(BUILD);
      return of([]);
    });
    apiPatch.mockImplementation(() => of(SCENARIO));

    await TestBed.configureTestingModule({
      imports: [TestDetailPage],
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: ApiService,
          useValue: { get: apiGet, post: vi.fn(), patch: apiPatch, delete: vi.fn() },
        },
        { provide: AuthService, useValue: { hasPermission: () => true, profile: () => ({ user_id: 1 }) } },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { paramMap: convertToParamMap({ testId: '1' }) },
            paramMap: of(convertToParamMap({ testId: '1' })),
          },
        },
        { provide: Router, useValue: { navigate: () => Promise.resolve(true) } },
        { provide: ToastService, useValue: { error: vi.fn(), success: vi.fn() } },
        TranslateService,
        { provide: AlbionAbilitiesService, useValue: { load: () => Promise.resolve({}) } },
        { provide: AlbionCatalogService, useValue: { load: () => Promise.resolve([]) } },
      ],
    }).compileComponents();

    TestBed.inject(TranslateService).use('en');
  });

  async function openTimeline(): Promise<{
    fixture: ComponentFixture<TestDetailPage>;
    page: Page;
  }> {
    const fixture = TestBed.createComponent(TestDetailPage);
    const page = await settle(fixture);
    page.activeTab.set('timeline');
    fixture.detectChanges();
    await fixture.whenStable();
    return { fixture, page };
  }

  it('shows the visual timeline by default, with one lane per group', async () => {
    const { fixture } = await openTimeline();
    expect(fixture.nativeElement.querySelector('app-timeline-editor')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('app-cast-table')).toBeNull();
    expect(fixture.nativeElement.querySelectorAll('[data-lane-index]')).toHaveLength(2);
  });

  it('swaps to the table without disturbing the draft', async () => {
    const { fixture, page } = await openTimeline();
    const before = JSON.stringify(page.draft());
    page.timelineView.set('table');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('app-cast-table')).not.toBeNull();
    expect(JSON.stringify(page.draft())).toBe(before);
  });

  it('starts clean even though the server sent its own key order and no attacker style', async () => {
    const { page } = await openTimeline();
    expect(page.dirty()).toBe(false);
  });

  it('stays clean when an edit sets a field to the value it already had', async () => {
    const { page } = await openTimeline();
    page.onCastPatched({ index: 0, patch: { cast_at: 1 } });
    page.onTimelineCastMoved({ index: 0, castAt: 1, casterGroupId: 'ally-hammer' });
    expect(page.dirty()).toBe(false);
  });

  it('stays clean after a nudge lands back where it started, float dust and all', async () => {
    const { page } = await openTimeline();
    page.onTimelineCastMoved({ index: 0, castAt: 1.1 + 0.1, casterGroupId: 'ally-hammer' });
    page.onTimelineCastMoved({ index: 0, castAt: 1.2 - 0.2, casterGroupId: 'ally-hammer' });
    page.onTimelineCastMoved({ index: 0, castAt: 1, casterGroupId: 'ally-hammer' });
    expect(page.dirty()).toBe(false);
  });

  it('adds a cast where it was dropped and selects it', async () => {
    const { page } = await openTimeline();
    page.onTimelineCastCreated({ casterGroupId: 'enemy-plate', spellId: 'SMASH', castAt: 2.34 });
    expect(page.draft().casts).toHaveLength(2);
    expect(page.draft().casts[1]).toEqual({
      caster_group_id: 'enemy-plate',
      spell_id: 'SMASH',
      cast_at: 2.3,
      target_ids: [],
      attacker_style: 'melee',
    });
    expect(page.selectedCastIndex()).toBe(1);
    expect(page.dirty()).toBe(true);
  });

  it('keeps the spell when a cast is dragged onto a group whose weapon does not have it', async () => {
    const { page } = await openTimeline();
    page.onTimelineCastMoved({ index: 0, castAt: 1, casterGroupId: 'enemy-plate' });
    expect(page.draft().casts[0]).toMatchObject({
      caster_group_id: 'enemy-plate',
      spell_id: 'WHIRL',
      cast_at: 1,
    });
  });

  it('re-points the selection when an earlier cast is removed', async () => {
    const { page } = await openTimeline();
    page.onTimelineCastCreated({ casterGroupId: 'ally-hammer', spellId: 'SMASH', castAt: 3 });
    expect(page.selectedCastIndex()).toBe(1);
    page.removeCast(0);
    expect(page.selectedCastIndex()).toBe(0);
    expect(page.draft().casts[0].spell_id).toBe('SMASH');
  });

  it('drops the selection when the selected cast itself is removed', async () => {
    const { page } = await openTimeline();
    page.onTimelineCastCreated({ casterGroupId: 'ally-hammer', spellId: 'SMASH', castAt: 3 });
    page.removeCast(1);
    expect(page.selectedCastIndex()).toBeNull();
  });

  describe('picking the caster weapon from the cast inspector', () => {
    it('assigns the build weapon to the caster instead of adding a group', async () => {
      const { page } = await openTimeline();
      const groupsBefore = page.draft().casts.length;
      page.onTimelineCastCreated({ casterGroupId: 'ally-hammer', spellId: '', castAt: 0 });
      expect(page.selectedCasterGroup()?.item_id).toBeFalsy();

      page.openBuildPickerForCaster();
      await page.onBuildSelected({ id: 7, title: 'Polehammer ZvZ' });

      expect(page.selectedCasterGroup()?.item_id).toBe('2H_POLEHAMMER');
      // Two groups before, two groups after: this path assigns, it does not import.
      expect(page.draft().groups).toHaveLength(2);
      expect(page.draft().casts.length).toBe(groupsBefore + 1);
    });

    it('still imports a new group when the same dialog is opened from Setup', async () => {
      const { page } = await openTimeline();
      page.openBuildImport();
      await page.onBuildSelected({ id: 7, title: 'Polehammer ZvZ' });
      expect(page.draft().groups).toHaveLength(3);
    });

    it('keeps a label the user chose when the weapon changes', async () => {
      const { page } = await openTimeline();
      page.onTimelineCastCreated({ casterGroupId: 'ally-hammer', spellId: '', castAt: 0 });
      page.openWeaponPickerForCaster();
      page.onWeaponSelected({ id: 'MAIN_SWORD', title: 'Broadsword' });
      const caster = page.draft().groups.find((group) => group.id === 'ally-hammer');
      expect(caster?.item_id).toBe('MAIN_SWORD');
      expect(caster?.label).toBe('Polehammer');
    });

    it('leaves a spell the new weapon does not have rather than clearing it', async () => {
      const { page } = await openTimeline();
      page.onCastPatched({ index: 0, patch: {} });
      expect(page.draft().casts[0].spell_id).toBe('WHIRL');

      page.selectedCastIndex();
      page.onTimelineCastMoved({ index: 0, castAt: 1, casterGroupId: 'ally-hammer' });
      page.openWeaponPickerForCaster();
      page.onWeaponSelected({ id: 'MAIN_SWORD', title: 'Broadsword' });

      // The engine resolves a spell id on its own; item_id is only a UI hint, so a mis-pick must
      // not silently destroy the id the user chose.
      expect(page.draft().casts[0].spell_id).toBe('WHIRL');
    });
  });
});
