import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { ThemeService, type ThemePreference } from '../../core/services/theme.service';
import { TranslateService, type Language } from '../../core/services/translate.service';
import { ToastService } from '../../core/services/toast.service';
import { PageHeader } from '../../shared/components/page-header/page-header';
import type { TranslationKey } from '../../i18n/en';

/**
 * User preferences page.
 *
 * Self-contained: holds the theme preference (light / dark / system) and the
 * UI language. Both controls persist their choice via the underlying services
 * and apply instantly across the whole shell.
 */
@Component({
  selector: 'app-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PageHeader],
  template: `
    <app-page-header
      [title]="t('settings.title')"
      [subtitle]="t('settings.subtitle')"
      [actions]="false"
    />

    <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <!-- Appearance -->
      <section class="card p-6">
        <h2 class="settings__title">{{ t('settings.appearance') }}</h2>
        <fieldset class="settings__list">
          <legend class="sr-only">{{ t('settings.appearance') }}</legend>
          @for (option of themeOptions; track option.value) {
            <label
              class="settings__option"
              [class.settings__option--active]="theme.preference() === option.value"
            >
              <input
                class="settings__input"
                type="radio"
                name="theme"
                [value]="option.value"
                [checked]="theme.preference() === option.value"
                (change)="onThemeChange(option.value)"
              />
              <span class="settings__indicator" aria-hidden="true"></span>
              <span class="settings__label">{{ t(option.labelKey) }}</span>
            </label>
          }
        </fieldset>
      </section>

      <!-- Language -->
      <section class="card p-6">
        <h2 class="settings__title">{{ t('settings.language') }}</h2>
        <fieldset class="settings__list">
          <legend class="sr-only">{{ t('settings.language') }}</legend>
          @for (lang of translate.supportedLanguages; track lang) {
            <label
              class="settings__option"
              [class.settings__option--active]="translate.language() === lang"
            >
              <input
                class="settings__input"
                type="radio"
                name="language"
                [value]="lang"
                [checked]="translate.language() === lang"
                (change)="onLanguageChange(lang)"
              />
              <span class="settings__indicator" aria-hidden="true"></span>
              <span class="settings__label">{{ translate.languageLabels[lang] }}</span>
            </label>
          }
        </fieldset>
      </section>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }

      .settings__title {
        margin-bottom: 1rem;
        font-size: 1rem;
        font-weight: 600;
        color: var(--color-text);
      }

      .settings__list {
        display: flex;
        flex-direction: column;
        gap: 0.375rem;
        margin: 0;
        padding: 0;
        border: 0;
      }

      /*
       * Selectable row: hidden native radio + custom circular indicator.
       * The native input stays in the a11y tree but is visually replaced by
       * .settings__indicator so the control matches the Material token palette.
       */
      .settings__option {
        display: flex;
        align-items: center;
        gap: 0.875rem;
        padding: 0.625rem 0.875rem;
        border-radius: var(--radius-md);
        border: 1px solid transparent;
        cursor: pointer;
        user-select: none;
        transition:
          background-color 140ms ease,
          border-color 140ms ease,
          box-shadow 140ms ease;
      }

      .settings__option:hover {
        background-color: var(--color-surface-hover);
      }

      .settings__option--active {
        background-color: var(--color-primary-container);
        border-color: color-mix(in srgb, var(--color-primary) 22%, transparent);
      }

      .settings__label {
        flex: 1;
        font-size: 0.9375rem;
        color: var(--color-text);
      }

      /* Visually hidden input — keyboard still reaches it. */
      .settings__input {
        position: absolute;
        width: 1px;
        height: 1px;
        margin: 0;
        padding: 0;
        overflow: hidden;
        clip: rect(0 0 0 0);
        clip-path: inset(50%);
        white-space: nowrap;
        border: 0;
        opacity: 0;
      }

      .settings__input:focus-visible + .settings__indicator {
        box-shadow:
          0 0 0 3px var(--color-primary-container),
          0 0 0 5px var(--color-primary);
      }

      /*
       * Radio dot: outer ring always visible, inner dot appears when the
       * sibling input is checked (:checked) or when the row is active.
       */
      .settings__indicator {
        position: relative;
        flex: 0 0 auto;
        width: 20px;
        height: 20px;
        border-radius: var(--radius-full);
        border: 2px solid var(--color-border-strong);
        background-color: transparent;
        transition:
          border-color 140ms ease,
          background-color 140ms ease;
      }

      .settings__indicator::after {
        content: '';
        position: absolute;
        inset: 0;
        margin: auto;
        width: 10px;
        height: 10px;
        border-radius: var(--radius-full);
        background-color: var(--color-primary);
        transform: scale(0);
        transition: transform 140ms ease;
      }

      .settings__input:checked + .settings__indicator {
        border-color: var(--color-primary);
      }

      .settings__input:checked + .settings__indicator::after {
        transform: scale(1);
      }
    `,
  ],
})
export class Settings {
  protected readonly theme = inject(ThemeService);
  protected readonly translate = inject(TranslateService);
  private readonly toasts = inject(ToastService);

  protected t = (key: TranslationKey) => this.translate.t(key);

  protected readonly themeOptions: ReadonlyArray<{
    value: ThemePreference;
    labelKey: TranslationKey;
  }> = [
    { value: 'light', labelKey: 'theme.light' },
    { value: 'dark', labelKey: 'theme.dark' },
    { value: 'system', labelKey: 'theme.system' },
  ];

  protected onThemeChange(value: ThemePreference): void {
    this.theme.setPreference(value);
    this.toasts.success(
      this.translate.t(
        value === 'light' ? 'theme.light' : value === 'dark' ? 'theme.dark' : 'theme.system',
      ),
    );
  }

  protected onLanguageChange(value: Language): void {
    this.translate.use(value);
    this.toasts.success(this.translate.languageLabels[value]);
  }
}
