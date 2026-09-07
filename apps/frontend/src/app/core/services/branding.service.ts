import { effect, inject, Injectable, PLATFORM_ID, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

import type { BrandColors } from '../models/api.models';
import { AuthService } from './auth.service';

/** The `--brand-*` custom properties the stylesheet reads. */
const BRAND_VARIABLES = {
  primary: '--brand-primary',
  secondary: '--brand-secondary',
  tertiary: '--brand-tertiary',
} as const;

/** `#rgb` or `#rrggbb` — the only shape allowed anywhere near a style attribute. */
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * Paints the active tenant's brand colours onto the document.
 *
 * The stylesheet derives every accent — hover, active, containers, focus
 * rings, the gradient ramp — from `--color-primary` / `--color-secondary` /
 * `--color-tertiary`, and those fall back to the product's blurple when the
 * `--brand-*` variables below are absent. So theming a server is only ever
 * three custom properties, and the theme, surfaces and dark/light split stay
 * exactly where they were.
 *
 * The override is deliberately `--brand-*` rather than `--color-primary`: an
 * inline `--color-primary` would beat the light theme's rule and skip the
 * contrast adjustment it makes for white surfaces.
 *
 * # Example
 * ```ts
 * // Preview a colour without saving it, then drop back to the tenant's own.
 * branding.preview({ primary: '#dc2626' });
 * branding.clearPreview();
 * ```
 */
@Injectable({ providedIn: 'root' })
export class BrandingService {
  private readonly auth = inject(AuthService);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  /** Unsaved colours being tried out by the settings screen. */
  private readonly previewed = signal<BrandColors | null>(null);

  constructor() {
    effect(() => {
      const colors = this.previewed() ?? this.auth.profile()?.brand ?? null;
      this.paint(colors);
    });
  }

  /** Show `colors` immediately, without saving them. */
  preview(colors: BrandColors | null): void {
    this.previewed.set(colors);
  }

  /** Drop the preview and go back to the tenant's saved colours. */
  clearPreview(): void {
    this.previewed.set(null);
  }

  private paint(colors: BrandColors | null): void {
    if (!this.isBrowser) {
      return;
    }
    const root = document.documentElement;
    let primary: string | null = null;

    for (const [key, variable] of Object.entries(BRAND_VARIABLES)) {
      const value = normalizeHex(colors?.[key as keyof BrandColors]);
      if (value) {
        root.style.setProperty(variable, value);
      } else {
        root.style.removeProperty(variable);
      }
      if (key === 'primary') {
        primary = value;
      }
    }

    // Contrast is the one thing CSS cannot decide here: text on a filled
    // button has to flip to near-black once the fill gets light enough, and
    // there is no `color-contrast()` to lean on yet.
    if (primary) {
      root.style.setProperty('--color-on-primary', readableInkOn(primary));
    } else {
      root.style.removeProperty('--color-on-primary');
    }
  }
}

/**
 * A hex colour safe to hand to `setProperty`, or `null`.
 *
 * The value travels from another admin's settings form through the database,
 * so it is treated as untrusted right up to the point it becomes CSS: only a
 * literal hex triplet gets through, never a `var()`, a function, or anything
 * else that could smuggle in a declaration.
 */
export function normalizeHex(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || !HEX_COLOR.test(trimmed)) {
    return null;
  }
  return trimmed.toLowerCase();
}

/**
 * Near-black or white, whichever stays legible on `hex`.
 *
 * Uses WCAG relative luminance with a threshold biased towards white: a
 * mid-tone brand fill reads better with white on it, which is also what the
 * default blurple does.
 */
export function readableInkOn(hex: string): string {
  const digits =
    hex.length === 4
      ? hex
          .slice(1)
          .split('')
          .map((c) => c + c)
          .join('')
      : hex.slice(1);
  const channel = (offset: number) => {
    const value = Number.parseInt(digits.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  return luminance > 0.55 ? '#1d1e26' : '#ffffff';
}
