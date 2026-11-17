import type { BankLogLinkTarget } from '../../core/models/api.models';

/** Reads a numeric string field; anything that is not a finite number counts as 0. */
export function numeric(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Whole silver, e.g. "7,414,881". */
export function formatSilver(locale: string, value: string | number | null | undefined): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(numeric(value));
}

/** Whole silver with an explicit sign, e.g. "−7,414,881". */
export function formatSignedSilver(locale: string, value: string | number | null | undefined): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0, signDisplay: 'exceptZero' }).format(
    numeric(value),
  );
}

/** Date and time in UTC, the timezone the game log is written in: "16 Nov, 23:10 UTC". */
export function formatUtc(locale: string, iso: string | null | undefined): string {
  if (!iso) {
    return '—';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  const formatted = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  }).format(date);
  return `${formatted} UTC`;
}

/** A span of minutes in its largest sensible unit: "3 min", "5 h", "2 days". */
export function formatSpan(locale: string, minutes: number): string {
  const abs = Math.abs(minutes);
  const unit = (value: number, name: 'minute' | 'hour' | 'day') =>
    new Intl.NumberFormat(locale, { style: 'unit', unit: name, unitDisplay: 'short', maximumFractionDigits: 0 }).format(
      value,
    );
  if (abs < 60) {
    return unit(abs, 'minute');
  }
  if (abs < 48 * 60) {
    return unit(Math.round(abs / 60), 'hour');
  }
  return unit(Math.round(abs / 1440), 'day');
}

/** Minutes from the log row to the Manager record, from the row's and the record's times. */
export function minutesBetween(rowIso: string, recordIso: string | null | undefined): number | null {
  if (!recordIso) {
    return null;
  }
  const row = new Date(rowIso).getTime();
  const record = new Date(recordIso).getTime();
  if (Number.isNaN(row) || Number.isNaN(record)) {
    return null;
  }
  return Math.round((record - row) / 60_000);
}

/** The person a target is about (payout member), else its own label. */
export function targetTitle(target: BankLogLinkTarget): string {
  return target.member_username ?? target.label;
}
