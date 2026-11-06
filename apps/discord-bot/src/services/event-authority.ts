import { ApiError, type ApiClient } from "../api/client.js";
import type { EventManagementAuthorityView } from "../api/types.js";
import { createResponseEmbed } from "../embeds/theme.js";

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
 * Returns true only when the caller-scoped authority endpoint explicitly
 * authorizes the caller. Older backends cannot safely authorize Discord actions.
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
    await interaction.editReply({
      embeds: [
        createResponseEmbed(
          "warning",
          "Unable to Verify Event Authority",
          error instanceof ApiError && error.status === 404
            ? "This server cannot verify event management authority right now. Ask an administrator to update the bot backend; no event changes were made."
            : "Event management authority could not be verified right now. Please try again later; no event changes were made.",
          "GUILD EVENT",
        ),
      ],
    });
    return false;
  }

  if (
    authority &&
    typeof authority.is_organizer === "boolean" &&
    typeof authority.can_manage === "boolean" &&
    typeof authority.required_permission === "string" &&
    authority.can_manage
  ) {
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
