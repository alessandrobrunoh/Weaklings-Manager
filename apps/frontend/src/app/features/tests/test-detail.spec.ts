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

interface Page {
  scenario: () => ScenarioDetail | null;
  draft: () => { casts: ScenarioDeclaredCast[] };
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
});
