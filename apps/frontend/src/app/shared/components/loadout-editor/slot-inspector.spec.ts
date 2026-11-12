import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import type { BuildItemSlot, OpenAlbionItem } from '../../../core/models/api.models';
import { SlotInspector } from './slot-inspector';

const BOW: OpenAlbionItem = {
  id: 1,
  name: 'Bow',
  tier: '8',
  type: 'weapon',
  category_id: null,
  subcategory_id: null,
  identifier: 'T8_2H_BOW',
  icon: 'https://render.albiononline.com/v1/item/T8_2H_BOW.png',
};
const CLAYMORE: OpenAlbionItem = { ...BOW, id: 2, name: 'Claymore', identifier: 'T8_2H_CLAYMORE' };

const CURRENT: BuildItemSlot = {
  loadout: 'main',
  slot: 'weapon',
  openalbion_item_type: 'weapon',
  openalbion_item_id: 1,
  openalbion_item_name: 'Bow',
  openalbion_item_icon: BOW.icon,
  openalbion_item_tier: 'T8',
  openalbion_item_quality: 3,
  openalbion_item_enchantment: 1,
};

function render(inputs: Record<string, unknown> = {}) {
  TestBed.configureTestingModule({
    imports: [SlotInspector],
    providers: [provideZonelessChangeDetection()],
  });
  const fixture = TestBed.createComponent(SlotInspector);
  fixture.componentRef.setInput('slot', 'weapon');
  fixture.componentRef.setInput('tiers', ['T4', 'T5', 'T6', 'T7', 'T8']);
  fixture.componentRef.setInput('searchTier', 'T8');
  for (const [name, value] of Object.entries(inputs)) {
    fixture.componentRef.setInput(name, value);
  }
  fixture.detectChanges();
  return fixture;
}

const root = (fixture: ReturnType<typeof render>) => fixture.nativeElement as HTMLElement;
const search = (fixture: ReturnType<typeof render>) =>
  root(fixture).querySelector<HTMLInputElement>('input[role="combobox"]')!;
const key = (target: HTMLElement, name: string) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));

describe('SlotInspector', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('names the slot and the loadout it belongs to', () => {
    const fixture = render({ loadout: 'swap' });

    expect(root(fixture).querySelector('.sheet__title')?.textContent?.trim()).toBe('Weapon');
    expect(root(fixture).querySelector('.sheet__sub')?.textContent?.trim()).toBe('Swap');
    const dialog = root(fixture).querySelector('dialog')!;
    expect(dialog.getAttribute('aria-labelledby')).toBe(root(fixture).querySelector('.sheet__title')?.id);
  });

  it('starts with an empty search box, whatever the item is', () => {
    const fixture = render({ item: CURRENT });

    expect(search(fixture).value).toBe('');
  });

  it('reflects the current item in the tier, enchantment and quality controls', () => {
    const fixture = render({ item: CURRENT, searchTier: 'T8' });
    const checked = (label: string) =>
      root(fixture)
        .querySelector(`[role="radiogroup"][aria-label="${label}"] [aria-checked="true"]`)
        ?.textContent?.trim();

    expect(checked('Tier')).toBe('T8');
    expect(checked('Enchantment')).toBe('.1');
    expect(checked('Quality')).toBe('Outstanding');
  });

  it('hides enchantment, quality and abilities until there is an item to apply them to', () => {
    const fixture = render({ item: null });

    expect(root(fixture).querySelector('[aria-label="Enchantment"]')).toBeNull();
    expect(root(fixture).querySelector('[aria-label="Quality"]')).toBeNull();
    expect(root(fixture).querySelector('.abilities')).toBeNull();
  });

  it('is a combobox over a listbox, and says how many items it found', () => {
    const fixture = render({ results: [BOW, CLAYMORE] });

    expect(search(fixture).getAttribute('aria-controls')).toBe(
      root(fixture).querySelector('[role="listbox"]')?.id,
    );
    expect(root(fixture).querySelectorAll('[role="option"]')).toHaveLength(2);
    expect(root(fixture).querySelector('.results__note')?.textContent?.trim()).toBe('Results: 2');
  });

  it('says so when the list is capped, rather than implying it is complete', () => {
    const fixture = render({ results: [BOW, CLAYMORE], resultCap: 2 });

    expect(root(fixture).querySelector('.results__note')?.textContent).toContain('first 2');
  });

  it('reports a failed catalog load instead of an empty list', () => {
    const fixture = render({ searchFailed: true });

    expect(root(fixture).querySelector('[role="alert"]')?.textContent).toContain('could not be loaded');
  });

  it('moves through the results with the arrow keys while focus stays in the search box', () => {
    const fixture = render({ results: [BOW, CLAYMORE] });
    const picked: OpenAlbionItem[] = [];
    fixture.componentInstance.itemPick.subscribe((item) => picked.push(item));

    key(search(fixture), 'ArrowDown');
    key(search(fixture), 'ArrowDown');
    fixture.detectChanges();
    expect(search(fixture).getAttribute('aria-activedescendant')).toBe(
      root(fixture).querySelectorAll('[role="option"]')[1].id,
    );

    key(search(fixture), 'Enter');
    expect(picked).toEqual([CLAYMORE]);
  });

  it('picks a result on click and reports the typed query', () => {
    const fixture = render({ results: [BOW, CLAYMORE] });
    const picked: OpenAlbionItem[] = [];
    const queries: string[] = [];
    fixture.componentInstance.itemPick.subscribe((item) => picked.push(item));
    fixture.componentInstance.queryChange.subscribe((value) => queries.push(value));

    search(fixture).value = 'claym';
    search(fixture).dispatchEvent(new Event('input', { bubbles: true }));
    (root(fixture).querySelectorAll('[role="option"]')[0] as HTMLElement).click();

    expect(queries).toEqual(['claym']);
    expect(picked).toEqual([BOW]);
  });

  it('marks the result that is the current item', () => {
    const fixture = render({ item: CURRENT, results: [BOW, CLAYMORE] });

    const options = root(fixture).querySelectorAll('[role="option"]');
    expect(options[0].getAttribute('aria-selected')).toBe('true');
    expect(options[1].getAttribute('aria-selected')).toBe('false');
  });

  it('offers "Clear slot" on the main loadout and "Same as main" on the swap', () => {
    const footerButton = (fixture: ReturnType<typeof render>) =>
      root(fixture).querySelector('.sheet__footer-actions button')?.textContent?.trim();

    expect(footerButton(render({ item: CURRENT, loadout: 'main' }))).toBe('Clear slot');
    TestBed.resetTestingModule();
    expect(footerButton(render({ item: CURRENT, loadout: 'swap' }))).toBe('Same as main');
  });

  it('offers to start from the main item only for an empty swap slot', () => {
    const fixture = render({ loadout: 'swap', item: null, mainItem: CURRENT });
    const starts: unknown[] = [];
    fixture.componentInstance.copyFromMain.subscribe(() => starts.push(true));

    const button = root(fixture).querySelector<HTMLButtonElement>('.sheet__footer-actions button')!;
    expect(button.textContent?.trim()).toBe('Start from main item');
    button.click();

    expect(starts).toHaveLength(1);
  });

  it('emits the abilities the user picks', () => {
    const fixture = render({
      item: CURRENT,
      abilitySlots: [
        {
          kind: 'active',
          index: 1,
          label: 'Q',
          selected: null,
          choices: [{ id: 'SPREAD', name: 'Spread Shot' }],
        },
      ],
    });
    const changes: unknown[] = [];
    fixture.componentInstance.abilityChange.subscribe((change) => changes.push(change));

    root(fixture)
      .querySelectorAll<HTMLElement>('[role="radiogroup"][aria-label="Ability Q"] [role="radio"]')[1]
      .click();

    expect(changes).toEqual([{ kind: 'active', index: 1, spellId: 'SPREAD' }]);
  });
});
