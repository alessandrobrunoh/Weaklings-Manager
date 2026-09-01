import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AbilitySlotView } from '../../data/albion-abilities';
import { AbilityBar } from './ability-bar';

function slot(
  kind: 'active' | 'passive',
  index: number,
  label: string,
  selected: string | null = null,
): AbilitySlotView {
  return {
    kind,
    index,
    label,
    selected,
    choices: [
      { id: 'HEROICSTRIKE2', name: 'Heroic Strike' },
      { id: 'CLEAVE', name: 'Heroic Cleave' },
    ],
  };
}

function render(slots: AbilitySlotView[], canManage: boolean) {
  const fixture = TestBed.createComponent(AbilityBar);
  fixture.componentRef.setInput('slots', slots);
  fixture.componentRef.setInput('canManage', canManage);
  fixture.componentRef.setInput('emptyLabel', 'None');
  fixture.detectChanges();
  return fixture;
}

describe('AbilityBar', () => {
  beforeEach(() => TestBed.configureTestingModule({ imports: [AbilityBar] }));

  it('renders one picker per slot, and no more', () => {
    const fixture = render([slot('active', 1, 'Q'), slot('active', 2, 'W')], true);

    expect(fixture.nativeElement.querySelectorAll('select')).toHaveLength(2);
  });

  it('renders nothing at all for an item with no ability slots', () => {
    const fixture = render([], true);

    expect(fixture.nativeElement.querySelector('.ability-bar')).toBeNull();
  });

  it('shows the in-game key for each slot so the bar is readable without colour', () => {
    const fixture = render([slot('active', 1, 'Q'), slot('passive', 1, 'Passive')], false);

    const keys = [...fixture.nativeElement.querySelectorAll('.ability-bar__key')].map(
      (node: Element) => node.textContent?.trim(),
    );
    expect(keys).toEqual(['Q', 'Passive']);
  });

  it('shows the chosen ability by name, not only as an icon', () => {
    const fixture = render([slot('active', 1, 'Q', 'CLEAVE')], false);

    expect(fixture.nativeElement.querySelector('.ability-bar__name').textContent).toContain(
      'Heroic Cleave',
    );
  });

  it('offers no picker when the viewer cannot manage the build', () => {
    const fixture = render([slot('active', 1, 'Q', 'CLEAVE')], false);

    expect(fixture.nativeElement.querySelector('select')).toBeNull();
  });

  it('emits the slot that changed, and null when the choice is cleared', () => {
    const fixture = render([slot('active', 2, 'W')], true);
    const emitted: unknown[] = [];
    fixture.componentInstance.choiceChange.subscribe((change) => emitted.push(change));

    const select: HTMLSelectElement = fixture.nativeElement.querySelector('select');
    select.value = 'CLEAVE';
    select.dispatchEvent(new Event('change'));
    select.value = '';
    select.dispatchEvent(new Event('change'));

    expect(emitted).toEqual([
      { kind: 'active', index: 2, spellId: 'CLEAVE' },
      { kind: 'active', index: 2, spellId: null },
    ]);
  });
});
