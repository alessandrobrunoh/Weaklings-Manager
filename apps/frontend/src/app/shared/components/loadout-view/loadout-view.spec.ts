import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BuildItemSlot, OpenAlbionItemAbilities } from '../../../core/models/api.models';
import { TranslateService } from '../../../core/services/translate.service';
import { AlbionAbilitiesService } from '../../services/albion-abilities.service';
import { LoadoutView } from './loadout-view';

function item(overrides: Partial<BuildItemSlot> & Pick<BuildItemSlot, 'slot'>): BuildItemSlot {
  return {
    loadout: 'main',
    openalbion_item_type: 'equipment',
    openalbion_item_id: 1,
    openalbion_item_name: 'Item',
    openalbion_item_icon: 'https://render.albiononline.com/v1/item/T8_MAIN_SWORD.png?quality=1&size=64',
    openalbion_item_tier: 'T8',
    openalbion_item_quality: 4,
    openalbion_item_enchantment: 0,
    ...overrides,
  };
}

const CATALOG: Record<string, OpenAlbionItemAbilities> = {
  MAIN_SWORD: {
    label: 'Sword',
    slot_type: 'weapon',
    two_handed: false,
    active_slots: 3,
    passive_slots: 1,
    active: {
      '1': [{ id: 'SPELL_Q', name: 'Slash' }],
      '2': [{ id: 'SPELL_W', name: 'Parry' }],
      '3': [{ id: 'SPELL_E', name: 'Charge' }],
    },
    passive: { '1': [{ id: 'SPELL_P', name: 'Resolve' }] },
  },
};

async function render(
  items: BuildItemSlot[] | null,
  inputs: { loading?: boolean; unavailable?: boolean } = {},
) {
  const fixture = TestBed.createComponent(LoadoutView);
  fixture.componentRef.setInput('items', items);
  if (inputs.loading !== undefined) fixture.componentRef.setInput('loading', inputs.loading);
  if (inputs.unavailable !== undefined) fixture.componentRef.setInput('unavailable', inputs.unavailable);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture;
}

function rowsOf(root: HTMLElement, section = 0): string[] {
  const lists = root.querySelectorAll('.loadout__section');
  return Array.from(lists[section]?.querySelectorAll('.slot__label') ?? [], (node) =>
    node.textContent?.trim() ?? '',
  );
}

describe('LoadoutView', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [LoadoutView],
      providers: [
        provideZonelessChangeDetection(),
        TranslateService,
        { provide: AlbionAbilitiesService, useValue: { load: vi.fn(() => Promise.resolve(CATALOG)) } },
      ],
    });
    TestBed.inject(TranslateService).use('en');
  });

  it('lists slots in reading order and skips optional slots that are empty', async () => {
    const fixture = await render([
      item({ slot: 'mount', openalbion_item_name: 'Horse' }),
      item({ slot: 'head', openalbion_item_name: 'Hood' }),
      item({ slot: 'weapon', openalbion_item_name: 'Blade' }),
      item({ slot: 'food', openalbion_item_name: 'Pie' }),
      item({ slot: 'armor', openalbion_item_name: 'Robe' }),
      item({ slot: 'shoes', openalbion_item_name: 'Sandals' }),
    ]);

    expect(rowsOf(fixture.nativeElement)).toEqual([
      'Weapon',
      'Helmet',
      'Armor',
      'Boots',
      'Food',
      'Mount',
    ]);
  });

  it('marks an empty core slot as not set instead of hiding it', async () => {
    const fixture = await render([item({ slot: 'weapon', openalbion_item_name: 'Blade' })]);
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';

    expect(rowsOf(fixture.nativeElement)).toEqual(['Weapon', 'Helmet', 'Armor', 'Boots']);
    expect(text).toContain('Not set');
  });

  it('writes tier and enchantment the way the game does, without a doubled T', async () => {
    const fixture = await render([
      item({ slot: 'weapon', openalbion_item_tier: 'T8', openalbion_item_enchantment: 3 }),
      item({ slot: 'head', openalbion_item_tier: '6', openalbion_item_enchantment: 0 }),
    ]);
    const tiers = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('.slot__tier'),
      (node) => node.textContent?.trim(),
    );

    expect(tiers[0]).toBe('T8.3');
    expect(tiers[1]).toBe('T6');
    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('TT8');
  });

  it('shows quality as text only when it is not the default Excellent', async () => {
    const fixture = await render([
      item({ slot: 'weapon', openalbion_item_quality: 4 }),
      item({ slot: 'head', openalbion_item_quality: 1 }),
      item({ slot: 'armor', openalbion_item_quality: null }),
      item({
        slot: 'food',
        openalbion_item_quality: 1,
        openalbion_item_icon: 'https://render.albiononline.com/v1/item/T7_MEAL_PIE.png?quality=1',
      }),
    ]);
    const qualities = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('.slot__quality'),
      (node) => node.textContent?.trim(),
    );

    expect(qualities).toEqual(['Normal']);
  });

  it('gives every chosen spell an accessible name and a visible name on focus', async () => {
    const fixture = await render([
      item({
        slot: 'weapon',
        spells: { active: { '1': 'SPELL_Q', '3': 'SPELL_E' }, passive: { '1': 'SPELL_P' } },
      }),
    ]);
    const root = fixture.nativeElement as HTMLElement;
    const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('.spell'));

    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Q: Slash',
      'E: Charge',
      'Passive: Resolve',
    ]);
    // A real button, so a keyboard user can reach it; the tip's visibility is CSS on :focus.
    expect(buttons.every((button) => button.tabIndex === 0)).toBe(true);
    expect(buttons[0].querySelector('.spell__tip')?.textContent).toContain('Slash');
  });

  it('pins a spell name open on tap and closes it on Escape', async () => {
    const fixture = await render([
      item({ slot: 'weapon', spells: { active: { '1': 'SPELL_Q' }, passive: {} } }),
    ]);
    const root = fixture.nativeElement as HTMLElement;
    const spell = root.querySelector<HTMLButtonElement>('.spell')!;

    spell.click();
    fixture.detectChanges();
    expect(spell.classList.contains('spell--open')).toBe(true);

    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    expect(spell.classList.contains('spell--open')).toBe(false);
  });

  it('falls back to a letter when an item image fails to load', async () => {
    const fixture = await render([item({ slot: 'weapon', openalbion_item_name: 'Blade' })]);
    const root = fixture.nativeElement as HTMLElement;
    const image = root.querySelector<HTMLImageElement>('.slot__icon img')!;

    image.dispatchEvent(new Event('error'));
    fixture.detectChanges();

    expect(root.querySelector('.slot__icon img')).toBeNull();
    expect(root.querySelector('.slot__icon span')?.textContent?.trim()).toBe('B');
  });

  it('shows only the swap slots that are defined, naming what each replaces', async () => {
    const fixture = await render([
      item({ slot: 'weapon', openalbion_item_name: 'Blade' }),
      item({ slot: 'off_hand', openalbion_item_name: 'Shield' }),
      item({ slot: 'weapon', loadout: 'swap', openalbion_item_name: 'Hammer' }),
    ]);
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelectorAll('.loadout__section')).toHaveLength(2);
    expect(rowsOf(root, 1)).toEqual(['Weapon']);
    expect(root.querySelector('.loadout__grid--paired')).not.toBeNull();
    expect(root.querySelectorAll('.loadout__section')[1].textContent).toContain('Replaces Blade');
    expect(root.textContent).toContain('Swap');
  });

  it('renders one section and no paired layout when there is no swap', async () => {
    const fixture = await render([item({ slot: 'weapon' })]);
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelectorAll('.loadout__section')).toHaveLength(1);
    expect(root.querySelector('.loadout__grid--paired')).toBeNull();
  });

  it('shows a busy skeleton while loading', async () => {
    const fixture = await render(null, { loading: true });
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(root.querySelector('[role="status"]')?.textContent).toContain('Loading');
    expect(root.querySelector('.slot')).toBeNull();
  });

  it('says so when the loadout is unavailable or empty', async () => {
    const unavailable = await render(null, { unavailable: true });
    expect(unavailable.nativeElement.textContent).toContain('Loadout unavailable');

    const empty = await render([]);
    expect(empty.nativeElement.textContent).toContain('No equipment');
  });

  it('translates its labels', async () => {
    const fixture = await render([item({ slot: 'weapon' })]);
    TestBed.inject(TranslateService).use('it');
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Arma');
  });
});
