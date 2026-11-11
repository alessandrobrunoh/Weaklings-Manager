import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserWeapon } from '../../../core/models/api.models';
import { ApiService } from '../../../core/services/api.service';
import { ToastService } from '../../../core/services/toast.service';
import { TranslateService } from '../../../core/services/translate.service';
import type { DestinyItemNode } from '../../data/albion-destiny-board';
import { AlbionCatalogService } from '../../services/albion-catalog.service';
import { WeaponRoster } from './weapon-roster';

const POLE = 'weapon:2H_POLEHAMMER';
const HOLY = 'weapon:MAIN_HOLYSTAFF';

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
  let info: ReturnType<typeof vi.fn>;

  async function create(
    rows: UserWeapon[],
    inputs: { mode?: 'self' | 'manage'; userId?: number; editable?: boolean; specNodes?: DestinyItemNode[] } = {},
  ): Promise<WeaponRoster> {
    get = vi.fn().mockReturnValue(of(rows));
    put = vi.fn().mockReturnValue(of(rows));
    info = vi.fn();
    await TestBed.configureTestingModule({
      imports: [WeaponRoster],
      providers: [
        provideZonelessChangeDetection(),
        TranslateService,
        { provide: ApiService, useValue: { get, put } },
        { provide: ToastService, useValue: { error: vi.fn(), success: vi.fn(), info } },
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

  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => fixture.destroy());

  it('loads the caller list and renders each weapon with its level selected', async () => {
    await create([row(POLE, 'Polehammer', 'main'), row(HOLY, 'Holy Staff', 'basic')]);

    expect(get).toHaveBeenCalledWith('api/users/me/weapons');
    const text = host().textContent ?? '';
    expect(text).toContain('Polehammer');
    expect(text).toContain('Holy Staff');
    const checked = [...host().querySelectorAll<HTMLInputElement>('input[type="radio"]:checked')];
    expect(checked.map((input) => input.value)).toEqual(['main', 'basic']);
  });

  it('saves only declared, unlocked weapons through PUT /me/weapons', async () => {
    await create([row(POLE, 'Polehammer', 'main'), row(HOLY, 'Holy Staff', null, true)]);

    const good = host().querySelector<HTMLInputElement>(
      `input[name="weapon-level-${POLE}"][value="good"]`,
    );
    good?.click();
    await settle();
    const save = [...host().querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('Save weapons'),
    );
    expect(save?.disabled).toBe(false);
    save?.click();
    await settle();

    expect(put).toHaveBeenCalledWith('api/users/me/weapons', {
      weapons: [{ weapon_key: POLE, proficiency: 'good' }],
    });
  });

  it('shows a locked weapon with a badge and no way to change or remove it', async () => {
    await create([row(POLE, 'Polehammer', 'good', true)]);

    expect(host().textContent).toContain('Locked');
    expect(host().querySelector('fieldset')?.disabled).toBe(true);
    expect(host().querySelector('button[aria-label^="Remove"]')).toBeNull();
  });

  it('imports undeclared weapons from the Destiny Board without saving', async () => {
    const nodes: DestinyItemNode[] = [
      { node_key: POLE, node_name: 'Polehammer', category: 'weapon', level: 100, icon: null, identifier: '2H_POLEHAMMER' },
      { node_key: HOLY, node_name: 'Holy Staff', category: 'weapon', level: 50, icon: null, identifier: 'MAIN_HOLYSTAFF' },
    ];
    await create([], { specNodes: nodes });

    const importButton = [...host().querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('Import from Destiny Board'),
    );
    importButton?.click();
    await settle();

    const checked = [...host().querySelectorAll<HTMLInputElement>('input[type="radio"]:checked')];
    expect(checked.map((input) => input.value)).toEqual(['main', 'good']);
    expect(put).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalled();
  });

  it('lets an officer lock a weapon and sends levels and locks to the member endpoint', async () => {
    await create([row(POLE, 'Polehammer', 'main')], { mode: 'manage', userId: 9 });

    expect(get).toHaveBeenCalledWith('api/users/9/weapons');
    const lock = host().querySelector<HTMLInputElement>('input[type="checkbox"]');
    lock?.click();
    await settle();
    const save = [...host().querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('Save weapons'),
    );
    save?.click();
    await settle();

    expect(put).toHaveBeenCalledWith('api/users/9/weapons', {
      weapons: [{ weapon_key: POLE, proficiency: 'main', locked: true }],
    });
  });

  it('is read-only for an officer without the manage permission', async () => {
    await create([row(POLE, 'Polehammer', 'main')], { mode: 'manage', userId: 9, editable: false });

    expect(host().querySelector('input[type="checkbox"]')).toBeNull();
    expect(host().querySelector('app-searchable-select')).toBeNull();
    expect(host().textContent).not.toContain('Save weapons');
  });
});
