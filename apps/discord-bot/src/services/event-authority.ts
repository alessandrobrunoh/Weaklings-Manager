import { ApiError, type ApiClient } from "../api/client.js";
import type { EventManagementAuthorityView } from "../api/types.js";
import { createResponseEmbed } from "../embeds/theme.js";
import {
  buildWebsiteAccountRequiredReply,
  isUnregisteredWebsiteUserError,
} from "./website-account.js";

/** Thread controls that change or broadcast an event, not join/leave. */
export const EVENT_MANAGEMENT_ACTIONS = [
  "ping",
  "start",
  "stop",
  "cancel",
  "uncancel",
] as const;

export type EventManagementAction = (typeof EVENT_MANAGEMENT_ACTIONS)[number];

interface ManagementReply {
  user: { id: string };
  editReply(payload: unknown): Promise<unknown>;
}

/**
 * Refuses start/stop/cancel/reopen/ping unless the caller created the event
 * or holds a role that grants `events.edit` (including the legacy
 * `events.manage` permission, which implies it).
 *
 * Returns true when the caller may proceed. A 404 means this backend predates
 * the authority endpoint; the mutation itself still enforces the same rule.
 */
export async function ensureEventManagementAllowed(
  interaction: ManagementReply,
  api: ApiClient,
  eventId: number,
): Promise<boolean> {
  let authority: EventManagementAuthorityView;
  try {
    authority = await api.get<EventManagementAuthorityView>(
      `api/events/${eventId}/management-authority`,
      interaction.user.id,
    );
  } catch (error) {
    if (isUnregisteredWebsiteUserError(error)) {
      await interaction.editReply(buildWebsiteAccountRequiredReply());
      return false;
    }
    if (error instanceof ApiError && error.status === 404) {
      return true;
    }
    throw error;
  }

  if (authority.can_manage) {
    return true;
  }

  await interaction.editReply({
    embeds: [
      createResponseEmbed(
        "warning",
        "Not Allowed",
        "Only the event organizer, or a role with the Events Manage permission, can start, stop, cancel, reopen, or ping this event.",
        "GUILD EVENT",
      ),
    ],
  });
  return false;
}
