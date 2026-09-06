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
