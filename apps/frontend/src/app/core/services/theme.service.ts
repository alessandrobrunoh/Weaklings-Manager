import { effect, Injectable, signal } from '@angular/core';

/** Light, Dark, or follow the OS preference. */
export type ThemePreference = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'alm.theme';

/**
 * Theme controller.
 *
 * Drives the `.dark` class on `<html>` (the variant used by `styles.css`).
 * The user's preference is persisted in `localStorage` and merged with the
 * OS-level `prefers-color-scheme` media query so that "system" mode tracks
 * OS changes live without a reload.
 *
 * Design decision: a single resolved signal (`isDark`) is exposed for templates;
 * the raw preference is exposed separately so the settings page can show all
 * three options.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly _preference = signal<ThemePreference>(this.loadPreference());
  private readonly _systemIsDark = signal<boolean>(this.readSystemIsDark());

  /** The user's explicit choice (or `system`). */
  readonly preference = this._preference.asReadonly();

  /** True when the resolved theme (after applying system preference) is dark. */
  readonly isDark = signal<boolean>(this.computeIsDark());

  constructor() {
    // React to OS-level theme changes when running in the browser.
    if (typeof window !== 'undefined' && window.matchMedia) {
      const mql = window.matchMedia('(prefers-color-scheme: dark)');
      mql.addEventListener('change', (event) => {
        this._systemIsDark.set(event.matches);
      });
    }

    // Whenever preference or system state changes, recompute and apply the class.
    effect(() => {
      const isDark = this.computeIsDark();
      this.isDark.set(isDark);
      if (typeof document !== 'undefined') {
        document.documentElement.classList.toggle('dark', isDark);
      }
    });
  }

  /** Switch to a new preference, persisting it. */
  setPreference(preference: ThemePreference): void {
    this._preference.set(preference);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, preference);
    }
  }

  /** Convenience toggle between light and dark (system collapses to dark). */
  toggle(): void {
    this.setPreference(this.isDark() ? 'light' : 'dark');
  }

  private computeIsDark(): boolean {
    const pref = this._preference();
    if (pref === 'system') {
      return this._systemIsDark();
    }
    return pref === 'dark';
  }

  private loadPreference(): ThemePreference {
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem(STORAGE_KEY) as ThemePreference | null;
      if (saved === 'light' || saved === 'dark' || saved === 'system') {
        return saved;
      }
    }
    return 'system';
  }

  private readSystemIsDark(): boolean {
    return typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-color-scheme: dark)').matches === true;
  }
}
