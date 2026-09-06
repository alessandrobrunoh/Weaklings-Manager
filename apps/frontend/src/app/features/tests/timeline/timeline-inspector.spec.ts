import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScenarioDeclaredCast, ScenarioUnitGroup } from '../../../core/models/api.models';
import { TranslateService } from '../../../core/services/translate.service';
import { TimelineInspector } from './timeline-inspector';

const GROUPS: ScenarioUnitGroup[] = [
  { id: 'ally', side: 'ally', label: 'Polehammer', item_id: null, count: 1, hit_points: 1200 },
  { id: 'enemy', side: 'enemy', label: 'Guardian', item_id: null, count: 3, hit_points: 1200 },
];

const CAST: ScenarioDeclaredCast = {
  caster_group_id: 'ally',
  spell_id: 'WHIRL',
  cast_at: 1,
  target_ids: ['enemy#0'],
  attacker_style: 'melee',
};

describe('TimelineInspector', () => {
  let fixture: ComponentFixture<TimelineInspector>;
  const patched = vi.fn();

  beforeEach(async () => {
    patched.mockReset();
    await TestBed.configureTestingModule({
      imports: [TimelineInspector],
      providers: [provideZonelessChangeDetection(), TranslateService],
    }).compileComponents();

    TestBed.inject(TranslateService).use('en');
    fixture = TestBed.createComponent(TimelineInspector);
    fixture.componentRef.setInput('cast', CAST);
    fixture.componentRef.setInput('castIndex', 0);
    fixture.componentRef.setInput('groups', GROUPS);
    fixture.componentRef.setInput('canManage', true);
    fixture.componentInstance.patched.subscribe(patched);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  afterEach(() => {
    fixture.destroy();
  });

  function button(text: string): HTMLButtonElement {
    const found = [...fixture.nativeElement.querySelectorAll('button')].find((el) =>
      (el as HTMLElement).textContent?.includes(text),
    );
    if (!found) throw new Error(`no button reading "${text}"`);
    return found as HTMLButtonElement;
  }

  it('says how many units the cast names', () => {
    expect(fixture.nativeElement.textContent).toContain('1 selected');
  });

  it('targets every enemy unit instance in one click', () => {
    button('All enemies').click();
    expect(patched).toHaveBeenCalledWith({
      index: 0,
      patch: { target_ids: ['enemy#0', 'enemy#1', 'enemy#2'] },
    });
  });

  it('clears the targets', () => {
    button('Clear').click();
    expect(patched).toHaveBeenCalledWith({ index: 0, patch: { target_ids: [] } });
  });

  it('reports a partly-targeted group as mixed, and filling it in completes it', () => {
    const toggle = fixture.nativeElement.querySelector(
      '[role="checkbox"][aria-checked="mixed"]',
    ) as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    toggle.click();
    expect(patched).toHaveBeenCalledWith({
      index: 0,
      patch: { target_ids: ['enemy#0', 'enemy#1', 'enemy#2'] },
    });
  });

  it('toggles one unit off without touching the rest', () => {
    const checkboxes = [
      ...fixture.nativeElement.querySelectorAll('input[type="checkbox"]'),
    ] as HTMLInputElement[];
    const first = checkboxes.find((box) => box.checked);
    first?.dispatchEvent(new Event('change'));
    expect(patched).toHaveBeenCalledWith({ index: 0, patch: { target_ids: [] } });
  });

  it('snaps a hand-typed time onto the grid', () => {
    const input = fixture.nativeElement.querySelector(
      'input[type="number"]',
    ) as HTMLInputElement;
    input.value = '1.234';
    input.dispatchEvent(new Event('change'));
    expect(patched).toHaveBeenCalledWith({ index: 0, patch: { cast_at: 1.2 } });
  });

  describe('the caster weapon', () => {
    it('offers the build and weapon pickers instead of leaving only a text field', () => {
      expect(fixture.nativeElement.textContent).toContain('No weapon picked');
      expect(fixture.nativeElement.textContent).toContain(
        'Pick a build or weapon above to choose from its abilities.',
      );
      expect(() => button('From build')).not.toThrow();
      expect(() => button('Pick weapon')).not.toThrow();
    });

    it('asks the page to open its build search', () => {
      const requested = vi.fn();
      fixture.componentInstance.buildRequested.subscribe(requested);
      button('From build').click();
      expect(requested).toHaveBeenCalled();
    });

    it('asks the page to open its weapon picker', () => {
      const requested = vi.fn();
      fixture.componentInstance.weaponRequested.subscribe(requested);
      button('Pick weapon').click();
      expect(requested).toHaveBeenCalled();
    });

    it('shows the weapon the caster already has, and offers to change it', async () => {
      fixture.componentRef.setInput('casterGroup', {
        ...GROUPS[0],
        item_id: '2H_POLEHAMMER',
        label: 'Polehammer',
      });
      fixture.detectChanges();
      await fixture.whenStable();
      expect(fixture.nativeElement.textContent).not.toContain('No weapon picked');
      expect(fixture.nativeElement.querySelector('img')).not.toBeNull();
      expect(() => button('Change')).not.toThrow();
    });

    it('drops the pickers for a reader who cannot manage the test', async () => {
      fixture.componentRef.setInput('canManage', false);
      fixture.detectChanges();
      await fixture.whenStable();
      expect(() => button('From build')).toThrow();
    });
  });

  it('flags a spell the caster group cannot actually cast', async () => {
    fixture.componentRef.setInput('knownSpellIds', new Set(['SOMETHING_ELSE']));
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('Not on this group');
  });

  it('stays quiet about a foreign spell when the group has no weapon at all', async () => {
    fixture.componentRef.setInput('knownSpellIds', new Set<string>());
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).not.toContain('Not on this group');
  });

  it('asks nothing of an empty selection', async () => {
    fixture.componentRef.setInput('cast', null);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('Select a cast to edit it.');
  });
});

describe('TimelineInspector spell select', () => {
  let fixture: ComponentFixture<TimelineInspector>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TimelineInspector],
      providers: [provideZonelessChangeDetection(), TranslateService],
    }).compileComponents();
    TestBed.inject(TranslateService).use('en');
    fixture = TestBed.createComponent(TimelineInspector);
    fixture.componentRef.setInput('cast', CAST);
    fixture.componentRef.setInput('castIndex', 0);
    fixture.componentRef.setInput('groups', GROUPS);
    fixture.componentRef.setInput('canManage', true);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  /**
   * The ability catalog is fetched, so the options always arrive after the cast they describe.
   * A `[value]` binding on the select is applied while the option does not exist yet and is never
   * re-applied, which showed the card as if no spell had been chosen.
   */
  it('shows the chosen spell once its options arrive', async () => {
    fixture.componentRef.setInput('spellOptions', [
      { group: 'Q', options: [{ value: 'WHIRL', label: 'Earth Shatter' }] },
      { group: 'W', options: [{ value: 'SMASH', label: 'Shocking Smash' }] },
    ]);
    fixture.detectChanges();
    await fixture.whenStable();

    const select = fixture.nativeElement.querySelector('select') as HTMLSelectElement;
    expect(select.value).toBe('WHIRL');
  });

  it('shows the caster group the cast already names', () => {
    const casterSelect = [...fixture.nativeElement.querySelectorAll('select')].find((el) =>
      [...(el as HTMLSelectElement).options].some((option) => option.value === 'ally'),
    ) as HTMLSelectElement;
    expect(casterSelect.value).toBe('ally');
  });
});

describe('TimelineInspector run outcome', () => {
  let fixture: ComponentFixture<TimelineInspector>;

  function log(change: number, unsupported: string[]) {
    return {
      caster_group_id: 'ally',
      spell_id: 'WHIRL',
      land_at: 1.4,
      target_ids: ['enemy#0'],
      concurrent_attackers: 1,
      prior_cc_stacks: 0,
      escalation_multiplier: 1,
      focus_fire_reduction: 0,
      per_target_health_change: change,
      crowd_control: [],
      unsupported,
    };
  }

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TimelineInspector],
      providers: [provideZonelessChangeDetection(), TranslateService],
    }).compileComponents();
    TestBed.inject(TranslateService).use('en');
    fixture = TestBed.createComponent(TimelineInspector);
    fixture.componentRef.setInput('cast', CAST);
    fixture.componentRef.setInput('castIndex', 0);
    fixture.componentRef.setInput('groups', GROUPS);
    fixture.componentRef.setInput('canManage', true);
  });

  async function withResolved(change: number, unsupported: string[]): Promise<void> {
    fixture.componentRef.setInput('resolved', log(change, unsupported));
    fixture.detectChanges();
    await fixture.whenStable();
  }

  it('reports what the cast actually did to each target', async () => {
    await withResolved(-412.5, []);
    expect(fixture.nativeElement.textContent).toContain('-412.5');
  });

  /**
   * The complaint this answers: a cast lands, the numbers stay at zero, and nothing on screen says
   * why. The engine already names the effect keys it does not model — this just shows them.
   */
  it('explains a cast that landed and changed nothing', async () => {
    await withResolved(0, ['HAMMER_SHOVE:dash', 'HAMMER_SHOVE:aura', 'HAMMER_SHOVE:dash']);
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('does not model');
    // Keys only, de-duplicated: the spell id is already on screen and each link repeats its key.
    expect(text).toContain('dash, aura');
    expect(text).not.toContain('HAMMER_SHOVE:dash');
  });

  it('stays quiet when a zero is not the engine giving up', async () => {
    await withResolved(0, []);
    expect(fixture.nativeElement.textContent).not.toContain('does not model');
  });

  it('says nothing at all before the test has been run', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).not.toContain('Last run');
  });
});
