import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { expect, it } from 'vitest';

import { TranslateService } from '../../../core/services/translate.service';
import type { Language } from '../../../core/services/translate.service';
import { EquipmentGrid } from './equipment-grid';

it('localizes equipment slot labels when the active language changes', async () => {
  await TestBed.configureTestingModule({
    imports: [EquipmentGrid],
    providers: [provideZonelessChangeDetection()],
  }).compileComponents();

  const fixture = TestBed.createComponent(EquipmentGrid);
  const translate = TestBed.inject(TranslateService);
  const labels: Record<Language, string> = {
    en: 'Bag',
    es: 'Bolsa',
    fr: 'Sac',
    it: 'Borsa',
    uk: 'Сумка',
  };

  for (const [language, expected] of Object.entries(labels) as [Language, string][]) {
    translate.use(language);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.equipment-slot--bag .equipment-slot__label')?.textContent.trim())
      .toBe(expected);
  }

  translate.use('en');
});

/** jsdom has no modal dialogs; the picker only needs the element to exist. */
function stubModalDialogs(): void {
  const proto = HTMLDialogElement.prototype as Partial<HTMLDialogElement>;
  proto.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  proto.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
}

async function renderEditing(inputs: Record<string, unknown>) {
  stubModalDialogs();
  await TestBed.configureTestingModule({
    imports: [EquipmentGrid],
    providers: [provideZonelessChangeDetection()],
  }).compileComponents();
  const fixture = TestBed.createComponent(EquipmentGrid);
  fixture.componentRef.setInput('canManage', true);
  fixture.componentRef.setInput('editingSlot', 'weapon');
  for (const [name, value] of Object.entries(inputs)) {
    fixture.componentRef.setInput(name, value);
  }
  fixture.detectChanges();
  return fixture;
}

it('shows the draft tier, enchantment and quality in the open picker instead of the first option', async () => {
  const fixture = await renderEditing({ draftTier: 'T6', draftEnchantment: 2, draftQuality: 3 });
  const root = fixture.nativeElement as HTMLElement;

  const selects = [...root.querySelectorAll('select')] as HTMLSelectElement[];
  expect(selects).toHaveLength(3);
  expect(selects[0].value).toBe('T6');
  expect(selects[1].value).toBe('2');
  expect(selects[2].value).toBe('3');

  fixture.destroy();
  TestBed.resetTestingModule();
});

it('lists search results as pressable buttons, not as a listbox it does not implement', async () => {
  const fixture = await renderEditing({
    draftItemId: '1',
    searchResults: [
      {
        id: 1,
        name: 'Bow',
        tier: '8',
        type: 'weapon',
        category_id: null,
        subcategory_id: null,
        identifier: 'T8_2H_BOW',
        icon: 'https://render.albiononline.com/v1/item/T8_2H_BOW.png',
      },
    ],
  });
  const root = fixture.nativeElement as HTMLElement;

  expect(root.querySelector('[role="listbox"]')).toBeNull();
  expect(root.querySelector('[role="option"]')).toBeNull();
  const result = root.querySelector('.equipment-picker__option');
  expect(result?.getAttribute('aria-pressed')).toBe('true');
  // The tier reads as a tier, not as the raw catalogue identifier.
  expect(result?.textContent).toContain('T8');
  expect(result?.textContent).not.toContain('T8_2H_BOW');

  fixture.destroy();
  TestBed.resetTestingModule();
});
