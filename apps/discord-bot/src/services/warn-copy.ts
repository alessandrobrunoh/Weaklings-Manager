import { buildAsciiBar } from '../embeds/theme.js';

/** Discord embed field values must be at most 1024 characters. */
export const DISCORD_FIELD_VALUE_LIMIT = 1024;

export function clampDiscordField(value: string): string {
  if (value.length <= DISCORD_FIELD_VALUE_LIMIT) return value;
  return `${value.slice(0, DISCORD_FIELD_VALUE_LIMIT - 1)}…`;
}

/** Labels the severities the API actually stores (`note`, `warn`, `strike`). */
export function warnSeverityBadge(severity: string): string {
  switch (severity.toLowerCase()) {
    case 'note': return '📝 NOTE';
    case 'warn': return '⚠️ WARN';
    case 'strike': return '🔴 STRIKE';
    case 'high': return '🔴 HIGH';
    case 'medium': return '🟡 MEDIUM';
    case 'low': return '⚪ LOW';
    default: return `⚠️ ${severity.toUpperCase()}`;
  }
}

/**
 * Gauge copy for `/warns`.
 *
 * The backend opens an officer escalation at `warn_threshold`. It does not kick
 * at a fixed count of 4, so the bot must not claim that.
 */
export function warnEscalationGauge(activeWarns: number, threshold: number | null): string {
  if (threshold === null || !Number.isFinite(threshold) || threshold < 1) {
    return [
      `Active warns: ${activeWarns}`,
      'Action: escalation threshold is unavailable; no automatic kick is assumed.',
    ].join('\n');
  }
  const safeThreshold = Math.floor(threshold);
  const bar = buildAsciiBar(activeWarns, safeThreshold, 14);
  const pct = Math.min(100, Math.round((activeWarns / safeThreshold) * 100));
  return [
    `Warn Level  ${bar}  ${activeWarns} / ${safeThreshold} Active Warns (${pct}%)`,
    `Action: Officer escalation opens at ${safeThreshold} active warns`,
  ].join('\n');
}
