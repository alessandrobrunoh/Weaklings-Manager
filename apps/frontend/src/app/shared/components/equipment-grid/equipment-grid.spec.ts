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
