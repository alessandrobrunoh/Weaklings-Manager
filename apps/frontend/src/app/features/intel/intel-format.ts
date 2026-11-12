import { Injectable, inject } from '@angular/core';

import { TranslateService } from '../../core/services/translate.service';

/**
 * Number, date and label formatting shared by the Intel pages.
 *
 * Every figure the API may leave out arrives as `null`; those render as an em dash so a
 * missing value is never mistaken for zero.
 */
@Injectable({ providedIn: 'root' })
export class IntelFormat {
  private readonly translate = inject(TranslateService);

  /** A whole number with thousands separators. */
  int(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) {
      return '—';
    }
    return new Intl.NumberFormat(this.translate.locale(), { maximumFractionDigits: 0 }).format(value);
  }

  /** A number with at most `digits` decimals. */
  dec(value: number | null | undefined, digits = 1): string {
    if (value === null || value === undefined || !Number.isFinite(value)) {
      return '—';
    }
    return new Intl.NumberFormat(this.translate.locale(), { maximumFractionDigits: digits }).format(value);
  }

  /** Fixed two-decimal ratio, for K/D. */
  ratio(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) {
      return '—';
    }
    return new Intl.NumberFormat(this.translate.locale(), {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  }

  /** A 0..100 percentage, or an em dash when the denominator was empty. */
  pct(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) {
      return '—';
    }
    return `${this.dec(value, 1)}%`;
  }

  /** Compact silver / fame figures such as `1.2M`. */
  compact(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) {
      return '—';
    }
    return new Intl.NumberFormat(this.translate.locale(), {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(value);
  }

  /** Signed difference, `+3` or `-2`. */
  signed(value: number, digits = 0): string {
    const rounded = Number(value.toFixed(digits));
    const text = new Intl.NumberFormat(this.translate.locale(), {
      maximumFractionDigits: digits,
    }).format(Math.abs(rounded));
    if (rounded > 0) {
      return `+${text}`;
    }
    return rounded < 0 ? `-${text}` : text;
  }

  date(iso: string | null | undefined): string {
    const date = this.parse(iso);
    return date
      ? new Intl.DateTimeFormat(this.translate.locale(), {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        }).format(date)
      : '—';
  }

  dateTime(iso: string | null | undefined): string {
    const date = this.parse(iso);
    return date
      ? new Intl.DateTimeFormat(this.translate.locale(), {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }).format(date)
      : '—';
  }

  /** Short month and day, for chart axes. */
  shortDate(iso: string | null | undefined): string {
    const date = this.parse(iso);
    return date
      ? new Intl.DateTimeFormat(this.translate.locale(), { month: 'short', day: 'numeric' }).format(date)
      : '—';
  }

  /** `T8_2H_HAMMER` becomes `Hammer`; null stays an em dash. */
  weapon(id: string | null | undefined): string {
    if (!id) {
      return '—';
    }
    return id
      .replace(/^T\d+_/, '')
      .replace(/^(MAIN|2H|OFF)_/, '')
      .split('_')
      .filter((part) => part.length > 0)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(' ');
  }

  /** `heavy_tank` becomes `Heavy Tank`. */
  role(role: string | null | undefined): string {
    if (!role) {
      return '—';
    }
    return role.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
  }

  private parse(iso: string | null | undefined): Date | null {
    if (!iso) {
      return null;
    }
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? null : date;
  }
}
