import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  OnDestroy,
  signal,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { BrandColors } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { BrandingService, normalizeHex } from '../../core/services/branding.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Icon } from '../../shared/components/icon/icon';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';

/** The three editable slots, in the order they read on the page. */
const SLOTS = [
  { key: 'primary', labelKey: 'admin.general.primary', hintKey: 'admin.general.primaryHint' },
  { key: 'secondary', labelKey: 'admin.general.secondary', hintKey: 'admin.general.secondaryHint' },
  { key: 'tertiary', labelKey: 'admin.general.tertiary', hintKey: 'admin.general.tertiaryHint' },
] as const satisfies readonly {
  key: keyof BrandColors;
  labelKey: TranslationKey;
  hintKey: TranslationKey;
}[];

/** Fallbacks shown in the colour inputs when a slot is on the product default. */
const DEFAULTS: Record<keyof BrandColors, string> = {
  primary: '#5865f2',
  secondary: '#8b31a0',
  tertiary: '#eb459e',
};

/**
 * General server settings: the guild's own brand colours.
 *
 * Editing previews live across the whole app — the rail, the sidebar, the
 * buttons — because that is the only honest way to judge a colour, and the
 * preview is dropped again if the admin leaves without saving.
 */
@Component({
  selector: 'app-admin-general',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, PageHeader, PageStack],
  styles: `
    .slot {
      display: flex;
      align-items: flex-start;
      gap: 1rem;
      padding: 1rem 0;
      border-bottom: 1px solid var(--color-border);
    }
    .slot:last-of-type {
      border-bottom: none;
    }
    /* A colour input styled as a swatch: the native control is the picker, so
       it stays the thing that opens, and only its chrome is replaced. */
    .slot__swatch {
      inline-size: 3rem;
      block-size: 3rem;
      flex-shrink: 0;
      padding: 0;
      border: 1px solid var(--color-border-strong);
      border-radius: var(--radius-inputs);
      background: transparent;
      cursor: pointer;
    }
    .slot__swatch::-webkit-color-swatch-wrapper {
      padding: 2px;
    }
    .slot__swatch::-webkit-color-swatch,
    .slot__swatch::-moz-color-swatch {
      border: none;
      border-radius: calc(var(--radius-inputs) - 2px);
    }
    .slot__hex {
      inline-size: 8rem;
      font-family: var(--font-mono);
      text-transform: lowercase;
    }
    .preview {
      border-radius: var(--radius-panels);
      padding: 1.5rem;
      background: var(--gradient-brand);
      color: var(--color-on-primary);
    }
    .preview__title {
      margin: 0;
      font-family: var(--font-display);
      font-weight: 800;
      text-transform: uppercase;
      font-size: 1.5rem;
      letter-spacing: -0.01em;
    }
  `,
  template: `
    <app-page-header
      [title]="t('admin.general.title')"
      [subtitle]="t('admin.general.subtitle')"
      [badge]="auth.profile()?.tenant_name ?? ''"
    />

    <app-page-stack>
      @if (loadFailed()) {
        <p class="text-sm text-[var(--color-error)]">{{ t('common.error') }}</p>
        <button type="button" class="btn btn--outline btn--sm" (click)="load()">
          {{ t('common.retry') }}
        </button>
      } @else {
        <section class="card p-5" aria-labelledby="brand-colors-heading">
          <h2 id="brand-colors-heading" class="text-base font-bold text-[var(--color-text)]">
            {{ t('admin.general.colorsTitle') }}
          </h2>
          <p class="mt-1 text-sm text-[var(--color-text-secondary)]">
            {{ t('admin.general.colorsHint') }}
          </p>

          <form class="mt-4" (submit)="onSave($event)">
            @for (slot of slots; track slot.key) {
              <div class="slot">
                <input
                  type="color"
                  class="slot__swatch"
                  [id]="'brand-' + slot.key"
                  [value]="swatchValue(slot.key)"
                  [attr.aria-label]="t(slot.labelKey)"
                  (input)="onColor(slot.key, $event)"
                />
                <div class="min-w-0 flex-1">
                  <label class="block text-sm font-semibold text-[var(--color-text)]" [attr.for]="'brand-' + slot.key">
                    {{ t(slot.labelKey) }}
                  </label>
                  <p class="mt-0.5 text-xs text-[var(--color-text-secondary)]">{{ t(slot.hintKey) }}</p>
                  <div class="mt-2 flex flex-wrap items-center gap-2">
                    <input
                      type="text"
                      class="input input--sm slot__hex"
                      spellcheck="false"
                      autocomplete="off"
                      [value]="draft()[slot.key] ?? ''"
                      [attr.placeholder]="defaults[slot.key]"
                      [attr.aria-label]="t(slot.labelKey)"
                      (input)="onHex(slot.key, $event)"
                    />
                    @if (draft()[slot.key]) {
                      <button
                        type="button"
                        class="btn btn--ghost btn--sm"
                        (click)="onReset(slot.key)"
                      >
                        {{ t('admin.general.useDefault') }}
                      </button>
                    } @else {
                      <span class="chip chip--neutral">{{ t('admin.general.defaultChip') }}</span>
                    }
                  </div>
                </div>
              </div>
            }

            @if (invalid()) {
              <p class="mt-3 text-sm text-[var(--color-error)]" role="alert">
                {{ t('admin.general.invalid') }}
              </p>
            }

            <div class="mt-4 flex flex-wrap gap-2">
              <button
                type="submit"
                class="btn btn--primary btn--sm"
                [disabled]="saving() || loading() || invalid() || !dirty()"
              >
                {{ saving() ? t('common.loading') : t('common.save') }}
              </button>
              <button
                type="button"
                class="btn btn--ghost btn--sm"
                [disabled]="!dirty() || saving()"
                (click)="onRevert()"
              >
                {{ t('common.cancel') }}
              </button>
            </div>
          </form>
        </section>

        <section class="preview" aria-labelledby="brand-preview-heading">
          <p class="eyebrow" style="color: inherit; opacity: 0.8">
            {{ t('admin.general.previewLabel') }}
          </p>
          <h2 id="brand-preview-heading" class="preview__title mt-2">
            {{ auth.profile()?.tenant_name ?? t('app.title') }}
          </h2>
          <p class="mt-2 max-w-prose text-sm" style="opacity: 0.9">
            {{ t('admin.general.previewHint') }}
          </p>
        </section>

        <section class="card p-5" aria-labelledby="brand-where-heading">
          <h2 id="brand-where-heading" class="text-base font-bold text-[var(--color-text)]">
            {{ t('admin.general.whereTitle') }}
          </h2>
          <ul class="mt-3 grid gap-2" role="list">
            @for (key of whereKeys; track key) {
              <li class="flex items-start gap-2 text-sm text-[var(--color-text-secondary)]">
                <app-icon name="check" size="1rem" class="mt-0.5 shrink-0 text-[var(--color-primary)]" />
                <span>{{ t(key) }}</span>
              </li>
            }
          </ul>
        </section>
      }
    </app-page-stack>
  `,
})
export class AdminGeneral implements OnDestroy {
  private readonly api = inject(ApiService);
  private readonly branding = inject(BrandingService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);
  protected readonly auth = inject(AuthService);

  protected readonly slots = SLOTS;
  protected readonly defaults = DEFAULTS;
  protected readonly whereKeys: readonly TranslationKey[] = [
    'admin.general.wherePrimary',
    'admin.general.whereSecondary',
    'admin.general.whereTheme',
  ];

  /** Colours as last read from the server. */
  private readonly saved = signal<BrandColors>({});
  /** Colours as edited, `null`/absent meaning "product default". */
  protected readonly draft = signal<BrandColors>({});
  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly saving = signal(false);

  protected readonly dirty = computed(
    () => SLOTS.some((slot) => (this.draft()[slot.key] ?? '') !== (this.saved()[slot.key] ?? '')),
  );

  /** True while any slot holds something that is not a hex colour. */
  protected readonly invalid = computed(() =>
    SLOTS.some((slot) => {
      const value = this.draft()[slot.key];
      return !!value && !normalizeHex(value);
    }),
  );

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.load();
  }

  ngOnDestroy(): void {
    // Leaving without saving must not keep the app in a colour nobody picked.
    this.branding.clearPreview();
  }

  /** Native colour inputs need a concrete value, so an empty slot shows the default. */
  protected swatchValue(key: keyof BrandColors): string {
    return normalizeHex(this.draft()[key]) ?? this.defaults[key];
  }

  protected onColor(key: keyof BrandColors, event: Event): void {
    this.setSlot(key, (event.target as HTMLInputElement).value);
  }

  protected onHex(key: keyof BrandColors, event: Event): void {
    this.setSlot(key, (event.target as HTMLInputElement).value);
  }

  protected onReset(key: keyof BrandColors): void {
    this.setSlot(key, '');
  }

  protected onRevert(): void {
    this.draft.set({ ...this.saved() });
    this.branding.clearPreview();
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const colors = await firstValueFrom(this.api.get<BrandColors>('api/admin/branding'));
      this.saved.set(colors ?? {});
      this.draft.set({ ...(colors ?? {}) });
    } catch {
      this.loadFailed.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  protected async onSave(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (this.invalid()) {
      return;
    }
    this.saving.set(true);
    try {
      // `""` is the API's "clear it", which is not the same as omitting the
      // field — omitting would leave the old colour in place.
      const body = Object.fromEntries(
        SLOTS.map((slot) => [slot.key, this.draft()[slot.key] ?? '']),
      );
      const colors = await firstValueFrom(this.api.put<BrandColors>('api/admin/branding', body));
      this.saved.set(colors ?? {});
      this.draft.set({ ...(colors ?? {}) });
      // The session profile still carries the old colours; keep the preview so
      // the app stays painted until the next `/auth/me` refreshes them.
      this.branding.preview(colors ?? {});
      this.toasts.success(this.t('admin.general.saved'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  private setSlot(key: keyof BrandColors, raw: string): void {
    const value = raw.trim();
    this.draft.update((current) => ({ ...current, [key]: value || null }));
    this.branding.preview(this.draft());
  }
}
