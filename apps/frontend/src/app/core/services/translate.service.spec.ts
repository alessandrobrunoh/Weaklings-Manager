import { TestBed } from '@angular/core/testing';

import { en } from '../../i18n/en';
import { es } from '../../i18n/es';
import { fr } from '../../i18n/fr';
import { it as italian } from '../../i18n/it';
import { uk } from '../../i18n/uk';
import { TranslateService } from './translate.service';

describe('TranslateService', () => {
  let service: TranslateService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [TranslateService] });
    service = TestBed.inject(TranslateService);
  });

  it('keeps every locale aligned with the English source dictionary', () => {
    const sourceKeys = Object.keys(en).sort();

    for (const dictionary of [italian, es, fr, uk]) {
      expect(Object.keys(dictionary).sort()).toEqual(sourceKeys);
    }
  });

  it('updates translated text when the active language changes', () => {
    service.use('en');
    expect(service.t('common.loading')).toBe(en['common.loading']);
    expect(document.documentElement.lang).toBe('en-US');

    service.use('it');
    expect(service.t('common.loading')).toBe(italian['common.loading']);
    expect(document.documentElement.lang).toBe('it-IT');

    service.use('uk');
    expect(service.t('common.loading')).toBe(uk['common.loading']);
    expect(document.documentElement.lang).toBe('uk-UA');
  });

  it('sets <html lang> to the full BCP 47 locale tag', () => {
    service.use('en');
    expect(service.locale()).toBe('en-US');
    expect(document.documentElement.lang).toBe('en-US');

    service.use('it');
    expect(service.locale()).toBe('it-IT');
    expect(document.documentElement.lang).toBe('it-IT');

    service.use('es');
    expect(service.locale()).toBe('es-ES');
    expect(document.documentElement.lang).toBe('es-ES');

    service.use('fr');
    expect(service.locale()).toBe('fr-FR');
    expect(document.documentElement.lang).toBe('fr-FR');

    service.use('uk');
    expect(service.locale()).toBe('uk-UA');
    expect(document.documentElement.lang).toBe('uk-UA');
  });
});
