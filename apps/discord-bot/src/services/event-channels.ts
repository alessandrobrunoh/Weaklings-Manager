import type { EventView } from '../api/types.js';

/**
 * The one place an event's announcement channel is decided.
 *
 * Routing keys on `event_kind` only — a leftover `if (call_to_arms)` after the
 * channel reorganization would silently misroute events, so every
 * destination question goes through this pure function (announce loop and
 * calendars both call it; they must never disagree).
 *
 * `call_to_arms` is importance *inside* the organized system, never a route.
 * Flash masses have no fallback: an unconfigured flash channel blocks the
 * announcement loudly instead of leaking flash content into the events or
 * CTA channel.
 */
export interface EventChannelRoutes {
  events: string | null;
  callToArms: string | null;
  flashMass: string | null;
}

export function destinationChannel(
  event: Pick<EventView, 'event_kind' | 'call_to_arms'>,
  routes: EventChannelRoutes,
): string | null {
  if (event.event_kind === 'flash') {
    return routes.flashMass;
  }
  // The old CTA channel is deliberately ignored: all organized events share
  // the one Call to Arms channel/calendar. The flag only changes importance.
  return routes.events;
}

/** Channel label for logs and admin-facing "not configured" warnings. */
export function destinationChannelLabel(
  event: Pick<EventView, 'event_kind' | 'call_to_arms'>,
): string {
  if (event.event_kind === 'flash') return 'flash mass';
  return event.call_to_arms ? 'Call to Arms (priority)' : 'Call to Arms';
}

/** Channels that may host a persistent calendar, in stable order. */
export function calendarChannelIds(routes: EventChannelRoutes): string[] {
  return [...new Set([routes.events, routes.flashMass].filter(Boolean) as string[])];
}
