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

  it('shows a locked weapon with a quiet lock state and no way to change or remove it', async () => {
    await create([row(POLE, 'Polehammer', 'good', true)]);

    expect(host().textContent).toContain('Locked by an officer');
    expect(host().querySelector('.wr__row--locked')).not.toBeNull();
    expect(host().querySelector('fieldset')?.disabled).toBe(true);
    expect(host().querySelector('button[aria-label^="Remove"]')).toBeNull();
    expect(host().textContent).toContain('Locked by an officer');
  });

  it('groups weapons by family and keeps a row in place when its level changes', async () => {
    await create([
      row(POLE, 'Polehammer', 'main'),
      row('weapon:2H_BOW', 'Bow', 'basic'),
      row('weapon:2H_LONGBOW', 'Longbow', 'good'),
    ]);

    const titles = [...host().querySelectorAll('.wr__group-title')].map((title) =>
      title.textContent?.replace(/\s+/g, ' ').trim(),
    );
    expect(titles).toEqual(['Hammers 1', 'Bows 2']);
    const names = () =>
      [...host().querySelectorAll('.wr__name')].map((name) => name.textContent?.trim());
    const before = names();

    host()
      .querySelector<HTMLInputElement>('input[name="weapon-level-weapon:2H_BOW"][value="main"]')
      ?.click();
    await settle();

    expect(names()).toEqual(before);
    const bow = host().querySelector<HTMLInputElement>(
      'input[name="weapon-level-weapon:2H_BOW"]:checked',
    );
    expect(bow?.value).toBe('main');
  });

  it('summarises how many weapons sit at each level', async () => {
    await create([row(POLE, 'Polehammer', 'main'), row(HOLY, 'Holy Staff', 'main', true)]);

    const summary = host().querySelector('.wr__summary')?.textContent?.replace(/\s+/g, ' ') ?? '';
    expect(summary).toContain('Main 2');
    expect(summary).toContain('1 locked');
    expect(summary).not.toContain('Basic');
  });

  it('shows an empty state with guidance and announces an added weapon', async () => {
    const cmp = await create([]);

    expect(host().textContent).toContain('No weapons declared yet');
    expect(host().querySelector('.wr__empty')).not.toBeNull();

    (cmp as unknown as { addWeapon(key: string): void }).addWeapon(POLE);
    await settle();

    expect(host().querySelector('.wr__empty')).toBeNull();
    expect(host().querySelector('.sr-only[aria-live="polite"]')?.textContent).toContain(
      'Polehammer added',
    );
    const discard = [...host().querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('Discard'),
    );
    discard?.click();
    await settle();
    expect(host().textContent).toContain('No weapons declared yet');
  });

  it('lets an officer lock a weapon and sends levels and locks to the member endpoint', async () => {
    await create([row(POLE, 'Polehammer', 'main')], { mode: 'manage', userId: 9 });

    expect(get).toHaveBeenCalledWith('api/users/9/weapons');
    const lock = host().querySelector<HTMLButtonElement>('button[aria-label="Lock Polehammer"]');
    expect(lock?.getAttribute('aria-pressed')).toBe('false');
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

    expect(host().querySelector('button[aria-pressed]')).toBeNull();
    expect(host().querySelector('app-searchable-select')).toBeNull();
    expect(host().textContent).not.toContain('Save weapons');
  });
});
