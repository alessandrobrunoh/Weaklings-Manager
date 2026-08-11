import { computed, Injectable, signal } from '@angular/core';

import { en, type TranslationDict, type TranslationKey } from '../../i18n/en';
import { es } from '../../i18n/es';
import { it } from '../../i18n/it';

/**
 * Runtime-swappable translation service backed by signal state.
 *
 * Angular's built-in `@angular/localize` is compile-time only, which makes
 * language switching at runtime impossible without a full reload — so this
 * tiny home-rolled service keeps the dictionaries in memory and exposes the
 * active language and a translation function as signals, allowing templates
 * to react instantly when the user picks a new language.
 *
 * The user's choice is persisted in `localStorage` (`alm.lang`) and mirrored
 * onto `<html lang>` for accessibility / screen readers.
 */
export type Language = 'en' | 'it' | 'es';

const STORAGE_KEY = 'alm.lang';

const DICTIONARIES: Record<Language, TranslationDict> = { en, it, es };

const SUPPORTED: ReadonlyArray<Language> = ['en', 'it', 'es'];

function detectInitialLanguage(): Language {
  if (typeof localStorage !== 'undefined') {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && SUPPORTED.includes(saved as Language)) {
      return saved as Language;
    }
  }
  if (typeof navigator !== 'undefined') {
    const nav = navigator.language.slice(0, 2).toLowerCase();
    if (SUPPORTED.includes(nav as Language)) {
      return nav as Language;
    }
  }
  return 'en';
}

@Injectable({ providedIn: 'root' })
export class TranslateService {
  private readonly _language = signal<Language>(detectInitialLanguage());

  /** Currently active language code. */
  readonly language = this._language.asReadonly();

  /** Reactive dictionary for the active language. */
  readonly dict = computed<TranslationDict>(() => DICTIONARIES[this._language()]);

  /** All UI-selectable languages, in display order. */
  readonly supportedLanguages: ReadonlyArray<Language> = SUPPORTED;

  /** Human-readable label for each language (in its own tongue, for the picker). */
  readonly languageLabels: Record<Language, string> = {
    en: 'English',
    it: 'Italiano',
    es: 'Español',
  };

  constructor() {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = this._language();
    }
  }

  /**
   * Switch the active language, persisting the choice to `localStorage`.
   * Updates `<html lang>` for assistive technology.
   */
  use(language: Language): void {
    this._language.set(language);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, language);
    }
    if (typeof document !== 'undefined') {
      document.documentElement.lang = language;
    }
  }

  /**
   * Translate a key, substituting `{placeholder}` tokens with the provided params.
   * Falls back to English then to the key itself if no translation is found.
   *
   * @example
   * t('dashboard.welcome', { name: 'Alessandro' })
   */
  t(key: TranslationKey, params?: Record<string, string | number>): string {
    const dict = this.dict();
    const raw = dict[key] ?? DICTIONARIES.en[key] ?? key;
    if (!params) {
      return raw;
    }
    return raw.replace(/\{(\w+)\}/g, (_match, token: string) =>
      params[token] !== undefined ? String(params[token]) : `{${token}}`,
    );
  }
}
