import type { ApiClient } from '../api/client.js';
import type { EventView } from '../api/types.js';
import { fetchTenantStatus } from './tenant-gate.js';

/** How a server posts an event announcement. */
export type EventDelivery = 'calendar' | 'message' | 'forum';

/**
 * Whether an event reaches more than one Discord server.
 *
 * A shared event is one event owned by the tenant that created it. Its owner announces it, and
 * every other tenant (the alliance for a guild's event, each member guild for an alliance event)
 * holds a link that its own bot announces. `is_link` marks such a link; `ping_alliance` marks a
 * guild event that is shared with the alliance; an alliance's own events are always shared with
 * its member guilds.
 */
export function eventIsShared(
  event: Pick<EventView, 'is_link' | 'ping_alliance'>,
  tenantKind?: string | null,
): boolean {
  return Boolean(event.is_link || event.ping_alliance || tenantKind === 'alliance');
}

/**
 * The delivery an event is announced with on this server.
 *
 * `calendar` keeps an organized event off the public channel (a private discussion thread
 * opened from the calendar panel). A shared event is meant to be seen by the other side, so it
 * is announced publicly (`message`) whatever the server's setting is. `forum` is unaffected.
 */
export function effectiveEventDelivery(
  serverDelivery: EventDelivery,
  shared: boolean,
): EventDelivery {
  return shared && serverDelivery === 'calendar' ? 'message' : serverDelivery;
}

/** The kind (`guild` or `alliance`) of the server `api` speaks for; null when unknown. Never throws. */
export async function tenantKindOf(api: ApiClient): Promise<string | null> {
  const guildId = api.guildId;
  if (!guildId) return null;
  try {
    return (await fetchTenantStatus(api, guildId)).kind ?? null;
  } catch {
    return null;
  }
}

/**
 * The role ids an announcement of `event` pings on this server.
 *
 * A link carries none of the owner's roles (they are roles of another Discord server), so the
 * server pings its own configured event role instead. Events a server owns keep the roles their
 * creator picked.
 */
export function announcementRoleIds(
  event: Pick<EventView, 'is_link' | 'discord_role_ids'>,
  serverEventRoleId: string | null,
): string[] {
  const own = [...new Set(event.discord_role_ids ?? [])];
  if (!event.is_link) return own;
  return serverEventRoleId ? [serverEventRoleId] : [];
}
