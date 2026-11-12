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

  it('offers exactly one control per slot when managed, with a named chip per spell', () => {
    const fixture = render([slot('active', 1, 'Q'), slot('active', 2, 'W')], true);

    const groups = fixture.nativeElement.querySelectorAll('[role="radiogroup"]');
    expect(groups).toHaveLength(2);
    // "None" plus the two spells the slot accepts.
    expect(groups[0].querySelectorAll('[role="radio"]')).toHaveLength(3);
    const names = [...groups[0].querySelectorAll('.choice__label')].map((node: Element) =>
      node.textContent?.trim(),
    );
    expect(names).toEqual(['None', 'Heroic Strike', 'Heroic Cleave']);
  });

  it('no longer offers a modal picker or a second row of icon-only choices', () => {
    const fixture = render([slot('active', 1, 'Q')], true);

    expect(fixture.nativeElement.querySelector('app-dialog')).toBeNull();
    expect(fixture.nativeElement.querySelector('.ability-bar__picker-trigger')).toBeNull();
    expect(fixture.nativeElement.querySelector('.ability-bar__choice')).toBeNull();
  });

  it('keeps one Tab stop per slot', () => {
    const fixture = render([slot('active', 1, 'Q', 'CLEAVE'), slot('active', 2, 'W')], true);

    const tabbable = fixture.nativeElement.querySelectorAll('[role="radio"][tabindex="0"]');
    expect(tabbable).toHaveLength(2);
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
    expect(fixture.nativeElement.querySelectorAll('.ability-bar__key[aria-hidden="true"]')).toHaveLength(0);
  });

  it('shows the chosen ability by name, not only as an icon', () => {
    const fixture = render([slot('active', 1, 'Q', 'CLEAVE')], false);

    expect(fixture.nativeElement.querySelector('.ability-bar__name').textContent).toContain(
      'Heroic Cleave',
    );
  });

  it('offers no controls when the viewer cannot manage the build', () => {
    const fixture = render([slot('active', 1, 'Q', 'CLEAVE')], false);

    expect(fixture.nativeElement.querySelector('[role="radiogroup"]')).toBeNull();
  });

  it('names each group after its key, in the active language, for assistive technology', () => {
    const fixture = render([slot('active', 2, 'W')], true);

    expect(
      fixture.nativeElement.querySelector('[role="radiogroup"]').getAttribute('aria-label'),
    ).toBe('Ability W');
  });

  it('emits the slot that changed, and null when the choice is cleared', () => {
    const fixture = render([slot('active', 2, 'W', 'CLEAVE')], true);
    const emitted: unknown[] = [];
    fixture.componentInstance.choiceChange.subscribe((change) => emitted.push(change));

    const chips = fixture.nativeElement.querySelectorAll('[role="radio"]');
    chips[1].click();
    chips[0].click();

    expect(emitted).toEqual([
      { kind: 'active', index: 2, spellId: 'HEROICSTRIKE2' },
      { kind: 'active', index: 2, spellId: null },
    ]);
  });
});
