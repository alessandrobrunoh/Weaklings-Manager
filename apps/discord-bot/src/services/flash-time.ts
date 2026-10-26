/**
 * Parses the `/flash` "When" field: relative minutes/hours or a wall-clock
 * time resolved in the guild timezone.
 *
 * Accepted forms (the modal placeholder shows exactly these):
 * - `30m`, `1h`, `1h30m`, `90m` — relative from now
 * - `21:00`, `21.15`, `2100` — wall clock in the guild timezone; a time that
 *   already passed today is read as tomorrow.
 *
 * Anything else is rejected with a reason the caller can show the user; a
 * wrong mass time pings a whole role, so guessing is never ok.
 *
 * Flash masses are minutes-to-hours content: anything over 12h ahead is
 * rejected — that is a planned event and belongs in `/event-create`.
 */
export interface ParsedFlashWhen {
  /** UTC instant the mass gathering starts. */
  massAt: Date;
  /** Human-readable interpretation shown back to the author before/after send. */
  interpretation: string;
}

export interface FlashWhenError {
  error: string;
}

/** Wall-clock times resolve against this zone until a guild setting exists. */
export const FLASH_GUILD_TIMEZONE = 'Europe/Rome';

const MAX_RELATIVE_MS = 12 * 60 * 60 * 1000;

export function parseFlashWhen(
  input: string,
  now: Date = new Date(),
  timeZone: string = FLASH_GUILD_TIMEZONE,
): ParsedFlashWhen | FlashWhenError {
  const raw = input.trim().toLowerCase();
  if (raw.length === 0) {
    return { error: 'empty' };
  }

  const relative = parseRelative(raw, now);
  if (relative) {
    return relative;
  }

  const wallClock = parseWallClock(raw, now, timeZone);
  if (wallClock) {
    return wallClock;
  }

  return {
    error:
      'unrecognized — use a relative time like `30m` or `1h30m`, or a wall clock like `21:00`',
  };
}

function parseRelative(raw: string, now: Date): ParsedFlashWhen | FlashWhenError | null {
  const match = /^((\d+)h)?((\d+)m)?$/.exec(raw);
  if (!match) return null;
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[4] ?? 0);
  if (hours === 0 && minutes === 0) return null;
  if (!/^\d/.test(raw)) return null;

  const deltaMs = (hours * 60 + minutes) * 60 * 1000;
  if (deltaMs > MAX_RELATIVE_MS) {
    return {
      error: 'too far ahead — over 12h is a planned event, use /event-create',
    };
  }
  const massAt = new Date(now.getTime() + deltaMs);
  return {
    massAt,
    interpretation: `in ${hours > 0 ? `${hours}h` : ''}${hours > 0 && minutes > 0 ? ' ' : ''}${minutes > 0 ? `${minutes}m` : ''}`,
  };
}

const WALL_CLOCK = /^(\d{1,2})[.:h]?(\d{2})$/;

function parseWallClock(
  raw: string,
  now: Date,
  timeZone: string,
): ParsedFlashWhen | FlashWhenError | null {
  const match = WALL_CLOCK.exec(raw);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    return { error: `that is not a valid time (${raw})` };
  }

  // Try today, then tomorrow, in the guild timezone.
  let candidate: Date;
  try {
    const today = zonedTimeToUtc(now, hours, minutes, timeZone);
    candidate = today.getTime() > now.getTime()
      ? today
      : zonedTimeToUtc(
          new Date(now.getTime() + 24 * 60 * 60 * 1000),
          hours,
          minutes,
          timeZone,
        );
  } catch {
    return {
      error: `the configured guild timezone "${timeZone}" is not a valid IANA timezone; an admin should fix it in Discord settings`,
    };
  }

  return {
    massAt: candidate,
    interpretation: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')} (${timeZone})`,
  };
}

/** UTC instant of `hours:minutes` on the calendar day `day` falls on in `timeZone`. */
function zonedTimeToUtc(day: Date, hours: number, minutes: number, timeZone: string): Date {
  const desiredWallClock = new Date(
    Date.UTC(
      day.getUTCFullYear(),
      day.getUTCMonth(),
      day.getUTCDate(),
      hours,
      minutes,
    ),
  );
  let guess = desiredWallClock;
  // Two-pass offset correction: the tz offset at the naive instant and at the
  // corrected instant can differ (DST); the second pass converges for the
  // hour-level precision a mass time needs.
  for (let pass = 0; pass < 2; pass++) {
    const asZoned = new Date(formatInZone(guess, timeZone) + 'Z');
    const offset = asZoned.getTime() - guess.getTime();
    guess = new Date(desiredWallClock.getTime() - offset);
  }
  return guess;
}

function formatInZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? '0');
  const hour = get('hour');
  // en-CA with hour12: false can yield "24" for midnight depending on the runtime.
  const normalizedHour = hour === 24 ? 0 : hour;
  return [
    `${get('year')}-${String(get('month')).padStart(2, '0')}-${String(get('day')).padStart(2, '0')}`,
    `T${String(normalizedHour).padStart(2, '0')}:${String(get('minute')).padStart(2, '0')}:${String(get('second')).padStart(2, '0')}`,
  ].join('');
}
