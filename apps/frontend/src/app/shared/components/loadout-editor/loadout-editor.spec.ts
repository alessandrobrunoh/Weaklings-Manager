import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import type {
  BuildItemSlot,
  BuildSlot,
  OpenAlbionItem,
  OpenAlbionItemAbilities,
} from '../../../core/models/api.models';
import { AlbionAbilitiesService } from '../../services/albion-abilities.service';
import { AlbionCatalogService } from '../../services/albion-catalog.service';
import { LoadoutEditor, type LoadoutChange } from './loadout-editor';

function catalogItem(id: number, name: string, tier: string, identifier: string): OpenAlbionItem {
  return {
    id,
    name,
    tier,
    type: 'weapon',
    category_id: null,
    subcategory_id: null,
    identifier,
    icon: `https://render.albiononline.com/v1/item/${identifier}.png?quality=1&size=64`,
  };
}

const CATALOG: OpenAlbionItem[] = [
  catalogItem(1, 'Bow', '8', 'T8_2H_BOW'),
  catalogItem(2, 'Bow', '6', 'T6_2H_BOW'),
  catalogItem(3, 'Claymore', '8', 'T8_2H_CLAYMORE'),
  catalogItem(4, 'Knight Helmet', '8', 'T8_HEAD_PLATE_SET2'),
  catalogItem(5, 'Torch', '8', 'T8_OFF_TORCH'),
];

const ABILITIES: Record<string, OpenAlbionItemAbilities> = {
  '2H_BOW': {
    label: 'Bow',
    slot_type: 'mainhand',
    two_handed: true,
    active_slots: 1,
    passive_slots: 0,
    active: {
      '1': [
        { id: 'SPREAD', name: 'Spread Shot' },
        { id: 'BURST', name: 'Burst Shot' },
      ],
    },
    passive: {},
  },
};

function saved(
  slot: BuildSlot,
  item: OpenAlbionItem,
  extra: Partial<BuildItemSlot> = {},
  loadout: 'main' | 'swap' = 'main',
): BuildItemSlot {
  return {
    loadout,
    slot,
    openalbion_item_type: item.type,
    openalbion_item_id: item.id,
    openalbion_item_name: item.name,
    openalbion_item_icon: item.icon,
    openalbion_item_tier: `T${item.tier}`,
    openalbion_item_quality: 4,
    openalbion_item_enchantment: 0,
    spells: { active: {}, passive: {} },
    ...extra,
  };
}

async function setup(items: BuildItemSlot[]) {
  TestBed.configureTestingModule({
    imports: [LoadoutEditor],
    providers: [
      provideZonelessChangeDetection(),
      { provide: AlbionCatalogService, useValue: { load: () => Promise.resolve(CATALOG) } },
      { provide: AlbionAbilitiesService, useValue: { load: () => Promise.resolve(ABILITIES) } },
    ],
  });
  const fixture = TestBed.createComponent(LoadoutEditor);
  fixture.componentRef.setInput('items', items);
  const saves: (readonly LoadoutChange[])[] = [];
  const dirty: number[] = [];
  fixture.componentInstance.save.subscribe((changes) => saves.push(changes));
  fixture.componentInstance.dirtyChange.subscribe((count) => dirty.push(count));
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, saves, dirty, root: fixture.nativeElement as HTMLElement };
}

type Harness = Awaited<ReturnType<typeof setup>>;

async function settle({ fixture }: Harness): Promise<void> {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

const rowButtons = (root: HTMLElement) => [...root.querySelectorAll<HTMLButtonElement>('button.row')];
const radiosIn = (root: HTMLElement, label: string) =>
  [...root.querySelectorAll<HTMLElement>(`[role="radiogroup"][aria-label="${label}"] [role="radio"]`)];
const checkedLabel = (root: HTMLElement, label: string) =>
  radiosIn(root, label)
    .find((radio) => radio.getAttribute('aria-checked') === 'true')
    ?.textContent?.trim();
const saveButton = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLButtonElement>('.bar button')].find((button) =>
    button.textContent?.includes('Save loadout'),
  )!;

describe('LoadoutEditor', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('lists the slots in loadout order with one button, and so one Tab stop, per row', async () => {
    const harness = await setup([saved('weapon', CATALOG[0]), saved('head', CATALOG[3])]);

    const rows = rowButtons(harness.root);
    expect(rows).toHaveLength(10);
    const labels = rows.map((row) => row.querySelector('.row__label')?.textContent?.trim());
    expect(labels).toEqual([
      'Weapon',
      'Off-hand',
      'Helmet',
      'Armor',
      'Boots',
      'Cape',
      'Bag',
      'Food',
      'Potion',
      'Mount',
    ]);
    expect(rows[0].textContent).toContain('Bow');
    expect(rows[1].textContent).toContain('Not set');
    // Nothing else in the list is focusable.
    expect(harness.root.querySelectorAll('.le__rows button, .le__rows a, .le__rows input')).toHaveLength(10);
  });

  it('opens one inspector with an empty search and controls that show the real item values', async () => {
    const harness = await setup([
      saved('weapon', CATALOG[1], {
        openalbion_item_enchantment: 2,
        openalbion_item_quality: 3,
      }),
    ]);

    rowButtons(harness.root)[0].click();
    await settle(harness);

    expect(harness.root.querySelectorAll('app-slot-inspector')).toHaveLength(1);
    const search = harness.root.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    expect(search.value).toBe('');
    expect(checkedLabel(harness.root, 'Tier')).toBe('T6');
    expect(checkedLabel(harness.root, 'Enchantment')).toBe('.2');
    expect(checkedLabel(harness.root, 'Quality')).toBe('Outstanding');
  });

  it('offers the item results for the chosen tier, readable by name and tier', async () => {
    const harness = await setup([]);

    rowButtons(harness.root)[0].click();
    await settle(harness);

    const options = [...harness.root.querySelectorAll('[role="option"]')];
    expect(options.map((option) => option.querySelector('.result__name')?.textContent?.trim())).toEqual([
      'Bow',
      'Claymore',
    ]);
    expect(options[0].querySelector('.result__tier')?.textContent?.trim()).toBe('T8');
  });

  it('puts a picked item in the draft, marks the row edited and reports one change', async () => {
    const harness = await setup([]);

    rowButtons(harness.root)[0].click();
    await settle(harness);
    (harness.root.querySelectorAll('[role="option"]')[0] as HTMLElement).click();
    await settle(harness);

    expect(rowButtons(harness.root)[0].textContent).toContain('Bow');
    expect(rowButtons(harness.root)[0].textContent).toContain('Edited');
    expect(harness.dirty.at(-1)).toBe(1);

    saveButton(harness.root).click();
    expect(harness.saves).toHaveLength(1);
    expect(harness.saves[0]).toHaveLength(1);
    expect(harness.saves[0][0]).toMatchObject({
      loadout: 'main',
      slot: 'weapon',
      item: {
        openalbion_item_id: 1,
        openalbion_item_tier: 'T8',
        openalbion_item_quality: 4,
        openalbion_item_enchantment: 0,
      },
    });
  });

  it('moves the same weapon to another tier when the tier control changes', async () => {
    const harness = await setup([saved('weapon', CATALOG[0])]);

    rowButtons(harness.root)[0].click();
    await settle(harness);
    radiosIn(harness.root, 'Tier')
      .find((radio) => radio.textContent?.trim() === 'T6')!
      .click();
    await settle(harness);

    expect(harness.dirty.at(-1)).toBe(1);
    saveButton(harness.root).click();
    expect(harness.saves[0][0].item).toMatchObject({ openalbion_item_id: 2, openalbion_item_tier: 'T6' });
  });

  it('keeps the abilities when only the tier changes, because the family is the same', async () => {
    const harness = await setup([
      saved('weapon', CATALOG[0], { spells: { active: { '1': 'SPREAD' }, passive: {} } }),
    ]);

    rowButtons(harness.root)[0].click();
    await settle(harness);
    radiosIn(harness.root, 'Tier')
      .find((radio) => radio.textContent?.trim() === 'T6')!
      .click();
    await settle(harness);

    saveButton(harness.root).click();
    expect(harness.saves[0][0].item?.spells).toEqual({ active: { '1': 'SPREAD' }, passive: {} });
  });

  it('chooses an ability from one chip group per ability slot', async () => {
    const harness = await setup([saved('weapon', CATALOG[0])]);

    rowButtons(harness.root)[0].click();
    await settle(harness);
    const chips = radiosIn(harness.root, 'Ability Q');
    expect(chips.map((chip) => chip.textContent?.trim())).toEqual(['None', 'Spread Shot', 'Burst Shot']);
    chips[2].click();
    await settle(harness);

    expect(rowButtons(harness.root)[0].textContent).toContain('Q Burst Shot');
    saveButton(harness.root).click();
    expect(harness.saves[0][0].item?.spells).toEqual({ active: { '1': 'BURST' }, passive: {} });
  });

  it('counts a slot once and stops counting it when the draft matches the saved item again', async () => {
    const harness = await setup([saved('weapon', CATALOG[0])]);

    rowButtons(harness.root)[0].click();
    await settle(harness);
    radiosIn(harness.root, 'Quality')
      .find((radio) => radio.textContent?.trim() === 'Good')!
      .click();
    await settle(harness);
    expect(harness.dirty.at(-1)).toBe(1);

    radiosIn(harness.root, 'Quality')
      .find((radio) => radio.textContent?.trim() === 'Excellent')!
      .click();
    await settle(harness);
    expect(harness.dirty.at(-1)).toBe(0);
    expect(saveButton(harness.root).disabled).toBe(true);
  });

  it('clears a slot into the draft without calling anything', async () => {
    const harness = await setup([saved('weapon', CATALOG[0])]);

    rowButtons(harness.root)[0].click();
    await settle(harness);
    [...harness.root.querySelectorAll<HTMLButtonElement>('.sheet__footer button')]
      .find((button) => button.textContent?.includes('Clear slot'))!
      .click();
    await settle(harness);

    saveButton(harness.root).click();
    expect(harness.saves[0]).toEqual([{ loadout: 'main', slot: 'weapon', item: null }]);
  });

  it('shows the swap as differences from main and copies weapon and off-hand from it', async () => {
    const harness = await setup([saved('weapon', CATALOG[0]), saved('off_hand', CATALOG[4])]);

    const tabs = [...harness.root.querySelectorAll<HTMLElement>('[role="tab"]')];
    tabs.find((tab) => tab.textContent?.trim() === 'Swap')!.click();
    await settle(harness);

    const rows = rowButtons(harness.root);
    expect(rows[0].textContent).toContain('Same as main: Bow');
    expect(rows[1].textContent).toContain('Same as main: Torch');
    expect(rows[2].textContent).toContain('Same as main');

    [...harness.root.querySelectorAll<HTMLButtonElement>('.le__tools button')]
      .find((button) => button.textContent?.includes('Copy weapon and off-hand'))!
      .click();
    await settle(harness);

    saveButton(harness.root).click();
    expect(harness.saves[0].map((change) => [change.loadout, change.slot])).toEqual([
      ['swap', 'weapon'],
      ['swap', 'off_hand'],
    ]);
    expect(harness.saves[0][0].item).toMatchObject({ loadout: 'swap', openalbion_item_id: 1 });
  });

  it('reverts a swap slot to main with "Same as main"', async () => {
    const harness = await setup([
      saved('weapon', CATALOG[0]),
      saved('weapon', CATALOG[2], {}, 'swap'),
    ]);

    [...harness.root.querySelectorAll<HTMLElement>('[role="tab"]')]
      .find((tab) => tab.textContent?.trim() === 'Swap')!
      .click();
    await settle(harness);
    rowButtons(harness.root)[0].click();
    await settle(harness);
    [...harness.root.querySelectorAll<HTMLButtonElement>('.sheet__footer button')]
      .find((button) => button.textContent?.includes('Same as main'))!
      .click();
    await settle(harness);

    saveButton(harness.root).click();
    expect(harness.saves[0]).toEqual([{ loadout: 'swap', slot: 'weapon', item: null }]);
  });

  it('reports the unsaved count in words and emits discard from the bar', async () => {
    const harness = await setup([saved('weapon', CATALOG[0])]);
    let discarded = 0;
    harness.fixture.componentInstance.discard.subscribe(() => discarded++);

    expect(harness.root.querySelector('.bar__status')?.textContent?.trim()).toBe('No changes yet');
    rowButtons(harness.root)[0].click();
    await settle(harness);
    radiosIn(harness.root, 'Quality')[0].click();
    await settle(harness);
    expect(harness.root.querySelector('.bar__status')?.textContent?.trim()).toBe('Unsaved changes: 1');

    [...harness.root.querySelectorAll<HTMLButtonElement>('.bar button')]
      .find((button) => button.textContent?.includes('Discard'))!
      .click();
    expect(discarded).toBe(1);
  });

  it('drops the Save bar when the host owns saving and reports the draft instead', async () => {
    const harness = await setup([]);
    harness.fixture.componentRef.setInput('showActions', false);
    const drafts: (readonly BuildItemSlot[])[] = [];
    harness.fixture.componentInstance.itemsChange.subscribe((items) => drafts.push(items));
    await settle(harness);

    expect(harness.root.querySelector('.bar')).toBeNull();

    rowButtons(harness.root)[0].click();
    await settle(harness);
    (harness.root.querySelectorAll('[role="option"]')[1] as HTMLElement).click();
    await settle(harness);

    expect(drafts.at(-1)?.map((entry) => entry.openalbion_item_name)).toEqual(['Claymore']);
  });
});
