import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserWeapon } from '../../../core/models/api.models';
import { ApiService } from '../../../core/services/api.service';
import { ToastService } from '../../../core/services/toast.service';
import { TranslateService } from '../../../core/services/translate.service';
import { AlbionCatalogService } from '../../services/albion-catalog.service';
import { WeaponRoster } from './weapon-roster';

const POLE = 'weapon:2H_POLEHAMMER';
const HOLY = 'weapon:MAIN_HOLYSTAFF';
const BOW = 'weapon:2H_BOW';
const LONGBOW = 'weapon:2H_LONGBOW';

function row(
  weapon_key: string,
  weapon_name: string,
  proficiency: UserWeapon['proficiency'],
  locked = false,
): UserWeapon {
  return { weapon_key, weapon_name, proficiency, locked, updated_at: '2026-11-11T00:00:00Z' };
}

const catalog = [
  ['T8_2H_POLEHAMMER', 'Polehammer'],
  ['T8_MAIN_HOLYSTAFF', 'Holy Staff'],
  ['T8_2H_BOW', 'Bow'],
  ['T8_2H_LONGBOW', 'Longbow'],
].map(([identifier, name], index) => ({
  id: index + 1,
  name,
  tier: 'T8',
  type: 'weapon',
  category_id: null,
  subcategory_id: null,
  identifier,
  icon: null,
}));

describe('WeaponRoster', () => {
  let fixture: ComponentFixture<WeaponRoster>;
  let get: ReturnType<typeof vi.fn>;
  let put: ReturnType<typeof vi.fn>;

  async function create(
    rows: UserWeapon[],
    inputs: { mode?: 'self' | 'manage'; userId?: number; editable?: boolean } = {},
  ): Promise<WeaponRoster> {
    get = vi.fn().mockReturnValue(of(rows));
    put = vi.fn().mockReturnValue(of(rows));
    await TestBed.configureTestingModule({
      imports: [WeaponRoster],
      providers: [
        provideZonelessChangeDetection(),
        TranslateService,
        { provide: ApiService, useValue: { get, put } },
        { provide: ToastService, useValue: { error: vi.fn(), success: vi.fn(), info: vi.fn() } },
        { provide: AlbionCatalogService, useValue: { load: () => Promise.resolve(catalog) } },
      ],
    }).compileComponents();
    TestBed.inject(TranslateService).use('en');
    fixture = TestBed.createComponent(WeaponRoster);
    for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value);
    fixture.detectChanges();
    await settle();
    return fixture.componentInstance;
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 10; i += 1) {
      fixture.detectChanges();
      await fixture.whenStable();
      await Promise.resolve();
    }
  }

  const host = () => fixture.nativeElement as HTMLElement;
  const names = () =>
    [...host().querySelectorAll('.wr__name')].map((name) => name.textContent?.trim());
  const radio = (key: string, level: string) =>
    host().querySelector<HTMLInputElement>(`input[name="weapon-level-${key}"][value="${level}"]`);
  const checkedLevel = (key: string) =>
    host().querySelector<HTMLInputElement>(`input[name="weapon-level-${key}"]:checked`)?.value;
  const button = (text: string) =>
    [...host().querySelectorAll<HTMLButtonElement>('button')].find((candidate) =>
      candidate.textContent?.includes(text),
    );
  const count = () => host().querySelector('.wr__count')?.textContent?.replace(/\s+/g, ' ').trim();

  async function type(value: string): Promise<void> {
    const search = host().querySelector<HTMLInputElement>('input[type="search"]');
    if (!search) throw new Error('search input missing');
    search.value = value;
    search.dispatchEvent(new Event('input'));
    await settle();
  }

  async function choose(select: HTMLSelectElement | null, value: string): Promise<void> {
    if (!select) throw new Error('select missing');
    select.value = value;
    select.dispatchEvent(new Event('change'));
    await settle();
  }

  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => fixture.destroy());

  it('lists the whole catalog at once with each declared level selected and the rest on None', async () => {
    await create([row(POLE, 'Polehammer', 'main'), row(HOLY, 'Holy Staff', 'basic')]);

    expect(get).toHaveBeenCalledWith('api/users/me/weapons');
    expect(names()).toEqual(['Polehammer', 'Bow', 'Longbow', 'Holy Staff']);
    expect(checkedLevel(POLE)).toBe('main');
    expect(checkedLevel(HOLY)).toBe('basic');
    expect(checkedLevel(BOW)).toBe('none');
    expect(checkedLevel(LONGBOW)).toBe('none');
    // No add-weapon step any more.
    expect(host().textContent).not.toContain('Add weapon');
    expect(host().querySelectorAll('.wr__row--on')).toHaveLength(2);
  });

  it('offers None, Basic, Good and Main as a radio group per weapon', async () => {
    await create([]);

    const group = host().querySelector('fieldset.wr__levels');
    const labels = [...(group?.querySelectorAll('label') ?? [])].map((label) =>
      label.textContent?.trim(),
    );
    expect(labels).toEqual(['None', 'Basic', 'Good', 'Main']);
    expect(group?.querySelector('legend')?.textContent).toContain('Level for');
  });

  it('declares a weapon in one click and saves only declared, unlocked weapons', async () => {
    await create([row(POLE, 'Polehammer', 'main'), row(HOLY, 'Holy Staff', null, true)]);

    expect(button('Save weapons')).toBeUndefined();
    radio(BOW, 'good')?.click();
    await settle();

    expect(host().querySelector('.wr__dirty')?.textContent).toContain('Unsaved changes: 1');
    button('Save weapons')?.click();
    await settle();

    expect(put).toHaveBeenCalledWith('api/users/me/weapons', {
      weapons: [
        { weapon_key: POLE, proficiency: 'main' },
        { weapon_key: BOW, proficiency: 'good' },
      ],
    });
  });

  it('clears a declaration with None', async () => {
    await create([row(POLE, 'Polehammer', 'main'), row(BOW, 'Bow', 'basic')]);

    radio(POLE, 'none')?.click();
    await settle();
    expect(checkedLevel(POLE)).toBe('none');
    button('Save weapons')?.click();
    await settle();

    expect(put).toHaveBeenCalledWith('api/users/me/weapons', {
      weapons: [{ weapon_key: BOW, proficiency: 'basic' }],
    });
  });

  it('keeps rows in place and shows no unsaved changes after a change is reverted', async () => {
    await create([row(POLE, 'Polehammer', 'main')]);
    const before = names();

    radio(POLE, 'good')?.click();
    await settle();
    expect(names()).toEqual(before);
    expect(host().querySelector('.wr__bar')).not.toBeNull();

    radio(POLE, 'main')?.click();
    await settle();
    expect(host().querySelector('.wr__bar')).toBeNull();
  });

  it('discards unsaved changes', async () => {
    await create([row(POLE, 'Polehammer', 'main')]);

    radio(BOW, 'main')?.click();
    await settle();
    button('Discard')?.click();
    await settle();

    expect(checkedLevel(BOW)).toBe('none');
    expect(host().querySelector('.wr__bar')).toBeNull();
    expect(host().querySelector('.sr-only[aria-live="polite"]')?.textContent).toContain(
      'Changes discarded',
    );
  });

  it('shows a locked weapon with a quiet lock state and no way to change it', async () => {
    await create([row(POLE, 'Polehammer', 'good', true)]);

    expect(host().textContent).toContain('Locked by an officer');
    expect(host().querySelector('.wr__row--locked')).not.toBeNull();
    const locked = host().querySelector<HTMLInputElement>(`input[name="weapon-level-${POLE}"]`);
    expect(locked?.closest('fieldset')?.disabled).toBe(true);
    expect(checkedLevel(POLE)).toBe('good');
    expect(host().querySelector('button[aria-pressed][aria-label^="Lock"]')).toBeNull();
  });

  it('groups weapons by family, alphabetical inside, and collapses and expands groups', async () => {
    await create([]);

    const titles = [...host().querySelectorAll('.wr__group-toggle')].map((title) =>
      title.textContent?.replace(/\s+/g, ' ').trim(),
    );
    expect(titles[0]).toContain('Hammers');
    expect(titles[1]).toContain('Bows');
    expect(titles[2]).toContain('Holy Staffs');
    expect(names()).toEqual(['Polehammer', 'Bow', 'Longbow', 'Holy Staff']);

    host().querySelector<HTMLButtonElement>('.wr__group-toggle')?.click();
    await settle();
    expect(names()).toEqual(['Bow', 'Longbow', 'Holy Staff']);
    expect(
      host().querySelector('.wr__group-toggle')?.getAttribute('aria-expanded'),
    ).toBe('false');

    button('Collapse all')?.click();
    await settle();
    expect(names()).toEqual([]);

    button('Expand all')?.click();
    await settle();
    expect(names()).toHaveLength(4);
  });

  it('summarises how many weapons sit at each level', async () => {
    await create([
      row(POLE, 'Polehammer', 'main'),
      row(HOLY, 'Holy Staff', 'main', true),
      row(BOW, 'Bow', 'basic'),
    ]);

    const summary = host().querySelector('.wr__summary')?.textContent?.replace(/\s+/g, ' ') ?? '';
    expect(summary).toContain('Main 2');
    expect(summary).toContain('Good 0');
    expect(summary).toContain('Basic 1');
    expect(summary).toContain('1 locked');
  });

  it('filters by name and reports the result count', async () => {
    await create([]);
    expect(count()).toBe('Showing 4 of 4 weapons');

    await type('  LONG');
    expect(names()).toEqual(['Longbow']);
    expect(count()).toBe('Showing 1 of 4 weapons');
  });

  it('filters by family and by level, and shows only declared weapons on request', async () => {
    await create([row(POLE, 'Polehammer', 'main'), row(BOW, 'Bow', 'good')]);

    const selects = host().querySelectorAll<HTMLSelectElement>('select');
    await choose(selects[0], 'bows');
    expect(names()).toEqual(['Bow', 'Longbow']);

    await choose(selects[1], 'undeclared');
    expect(names()).toEqual(['Longbow']);

    await choose(selects[0], 'all');
    await choose(selects[1], 'all');
    const toggle = button('Declared only');
    expect(toggle?.getAttribute('aria-pressed')).toBe('false');
    toggle?.click();
    await settle();
    expect(toggle?.getAttribute('aria-pressed')).toBe('true');
    expect(names()).toEqual(['Polehammer', 'Bow']);
  });

  it('shows an empty state with a clear-filters action when nothing matches', async () => {
    await create([row(POLE, 'Polehammer', 'main')]);

    await type('zzz');
    expect(names()).toEqual([]);
    expect(host().textContent).toContain('No weapons match these filters');
    const clear = [...host().querySelectorAll<HTMLButtonElement>('.wr__empty button')].find(
      (candidate) => candidate.textContent?.includes('Clear filters'),
    );
    clear?.click();
    await settle();

    expect(names()).toHaveLength(4);
    expect(host().querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe('');
  });

  it('expands collapsed groups when a filter changes so results are never hidden', async () => {
    await create([]);

    button('Collapse all')?.click();
    await settle();
    expect(names()).toEqual([]);

    await type('bow');
    expect(names()).toEqual(['Bow', 'Longbow']);
  });

  it('lets an officer set levels and lock a weapon the member never declared', async () => {
    await create([row(POLE, 'Polehammer', 'main')], { mode: 'manage', userId: 9 });

    expect(get).toHaveBeenCalledWith('api/users/9/weapons');
    const lock = host().querySelector<HTMLButtonElement>('button[aria-label="Lock Bow"]');
    expect(lock?.getAttribute('aria-pressed')).toBe('false');
    lock?.click();
    await settle();
    expect(host().querySelector('button[aria-label="Lock Bow"]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    button('Save weapons')?.click();
    await settle();

    expect(put).toHaveBeenCalledWith('api/users/9/weapons', {
      weapons: [
        { weapon_key: POLE, proficiency: 'main', locked: false },
        { weapon_key: BOW, proficiency: null, locked: true },
      ],
    });
  });

  it('drops a lock-only row when the officer unlocks it again', async () => {
    await create([row(BOW, 'Bow', null, true)], { mode: 'manage', userId: 9 });

    host().querySelector<HTMLButtonElement>('button[aria-label="Lock Bow"]')?.click();
    await settle();
    button('Save weapons')?.click();
    await settle();

    expect(put).toHaveBeenCalledWith('api/users/9/weapons', { weapons: [] });
  });

  it('is read-only for an officer without the manage permission and starts on declared weapons', async () => {
    await create([row(POLE, 'Polehammer', 'main')], { mode: 'manage', userId: 9, editable: false });

    expect(names()).toEqual(['Polehammer']);
    expect(host().querySelector('button[aria-pressed][aria-label^="Lock"]')).toBeNull();
    expect(host().querySelector('fieldset')?.disabled).toBe(true);
    expect(host().textContent).not.toContain('Save weapons');
  });

  it('says so when a read-only view has nothing declared', async () => {
    await create([], { mode: 'manage', userId: 9, editable: false });

    expect(host().textContent).toContain('This member has not declared any weapon.');
    expect(host().querySelector('.wr__row')).toBeNull();
  });
});
