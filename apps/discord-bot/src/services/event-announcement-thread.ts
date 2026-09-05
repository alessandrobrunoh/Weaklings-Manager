import { Message, ThreadAutoArchiveDuration, type ThreadChannel } from "discord.js";
import type { EventDetailView, EventView } from "../api/types.js";
import {
  buildEventEmbed,
  buildEventThreadActionRows,
} from "../embeds/event.embed.js";
import {
  isUnknownDiscordChannel,
  lockAndArchiveThread,
  withUnarchivedThread,
} from "./discord-thread.js";

export type EventAnnouncementThread = Awaited<
  ReturnType<Message["startThread"]>
>;

/**
 * Discord thread names are capped at 100 characters, so event titles must be trimmed without
 * slicing through UTF-16 surrogate pairs. Keeping this helper shared prevents the slash command and
 * poller from drifting when both announce the same event type.
 *
 * @example
 * const name = buildEventThreadName('Bomb with ally');
 * // "Event: Bomb with ally"
 */
export function buildEventThreadName(eventTitle: string): string {
  const maxThreadNameCharacters = 100;
  const normalizedTitle = eventTitle.trim() || "Call to Arms";
  const threadName = `Event: ${normalizedTitle}`;

  return Array.from(threadName).slice(0, maxThreadNameCharacters).join("");
}

/**
 * Opens the tactical discussion thread on the announcement message users can already see.
 *
 * Discord can accept the announcement but reject the thread when the bot lacks `Create Public
 * Threads` or `Send Messages in Threads`. Returning `null` lets callers keep the event creation
 * successful while skipping thread-only follow-up messages.
 *
 * @example
 * const thread = await createEventAnnouncementThread(message, event, 'Poller');
 * if (thread) await thread.send('Pick your role below.');
 */
export async function createEventAnnouncementThread(
  message: Message,
  event: EventView,
  sourceLabel: string,
): Promise<EventAnnouncementThread | null> {
  try {
    const thread = await message.startThread({
      name: buildEventThreadName(event.title),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      reason: `Event #${event.id} ${sourceLabel} discussion`,
    });
    console.log(
      `[${sourceLabel}] Created Discord thread for event #${event.id} on message ${message.id}`,
    );
    return thread;
  } catch (error: unknown) {
    console.warn(
      `[${sourceLabel}] Failed to create Discord thread for event #${event.id} on message ${message.id}:`,
      error,
    );
    return null;
  }
}

/** Archives and locks an event discussion thread without deleting its history. */
export async function closeEventAnnouncementThread(
  thread: ThreadChannel,
  eventId: number,
  sourceLabel: string,
): Promise<boolean> {
  const reason = `Event #${eventId} closed (${sourceLabel})`;
  try {
    await lockAndArchiveThread(thread, reason);
    console.log(`[${sourceLabel}] Closed Discord thread for event #${eventId}`);
    return true;
  } catch (error: unknown) {
    if (isUnknownDiscordChannel(error)) {
      console.warn(
        `[${sourceLabel}] Discord thread for event #${eventId} is already gone`,
      );
      return true;
    }
    console.warn(`[${sourceLabel}] Failed to close Discord thread for event #${eventId}:`, error);
    return false;
  }
}

/**
 * Deletes the parent announcement message (and its discussion thread) when an event is archived.
 *
 * Stopped/cancelled events keep locked history. Archive means the call should disappear from the
 * events channel; if Discord rejects the delete, the thread is closed instead.
 */
export async function deleteEventAnnouncement(
  thread: ThreadChannel,
  eventId: number,
  sourceLabel: string,
): Promise<boolean> {
  const reason = `Event #${eventId} archived (${sourceLabel})`;
  try {
    const starter = await thread.fetchStarterMessage().catch(() => null);
    if (starter) {
      await starter.delete();
    } else {
      await thread.delete(reason);
    }
    console.log(`[${sourceLabel}] Deleted Discord announcement for event #${eventId}`);
    return true;
  } catch (error: unknown) {
    if (isUnknownDiscordChannel(error)) {
      console.warn(
        `[${sourceLabel}] Discord announcement for event #${eventId} is already gone`,
      );
      return true;
    }
    console.warn(
      `[${sourceLabel}] Failed to delete Discord announcement for event #${eventId}; closing instead:`,
      error,
    );
    return closeEventAnnouncementThread(thread, eventId, sourceLabel);
  }
}

/**
 * Posts the interactive signup card inside an event thread.
 *
 * The parent announcement stays a text ping with a linked thread. Roster, join/leave, Ping,
 * Start and Stop live only in this follow-up so they are not duplicated in the parent channel.
 *
 * @example
 * const thread = await createEventAnnouncementThread(message, event, 'Poller');
 * if (thread) await sendEventSignupMessage(thread, event, 'Poller');
 */
export async function sendEventSignupMessage(
  thread: EventAnnouncementThread,
  event: EventView,
  sourceLabel: string,
): Promise<string | null> {
  try {
    const message = await thread.send({
      content: "Use the controls below to manage participation or operate the event.",
      embeds: [buildEventEmbed(event)],
      components: buildEventThreadActionRows(event),
    });
    console.log(
      `[${sourceLabel}] Published signup message in thread for event #${event.id}`,
    );
    return message.id;
  } catch (error: unknown) {
    console.warn(
      `[${sourceLabel}] Failed to publish signup message in thread for event #${event.id}:`,
      error,
    );
    return null;
  }
}

function isEventSignupMessage(message: Message, eventId: number): boolean {
  const joinId = `event:join:${eventId}`;
  return message.components.some((row) => {
    if (!("components" in row) || !Array.isArray(row.components)) return false;
    return row.components.some(
      (component) => "customId" in component && component.customId === joinId,
    );
  });
}

async function findEventSignupMessage(
  thread: ThreadChannel,
  eventId: number,
  messageId?: string | null,
): Promise<Message | null> {
  if (!thread.messages) return null;
  if (messageId) {
    try {
      const stored = await thread.messages.fetch(messageId);
      if (isEventSignupMessage(stored, eventId)) return stored;
    } catch {
      // Fall through to a scan of recent thread messages.
    }
  }
  const fetched = await thread.messages.fetch({ limit: 50 });
  for (const message of fetched.values()) {
    if (isEventSignupMessage(message, eventId)) return message;
  }
  return null;
}

/**
 * Rewrites the interactive signup card so website roster changes appear on Discord.
 *
 * Returns the message id that was edited, or `null` when the card could not be found.
 */
export async function refreshEventSignupCard(
  thread: ThreadChannel,
  event: EventView | EventDetailView,
  sourceLabel: string,
  messageId?: string | null,
): Promise<string | null> {
  try {
    return await withUnarchivedThread(
      thread,
      `Refresh event #${event.id} signup card (${sourceLabel})`,
      async (active) => {
        const message = await findEventSignupMessage(active, event.id, messageId);
        if (!message) {
          console.warn(
            `[${sourceLabel}] No signup card found in thread for event #${event.id}`,
          );
          return null;
        }
        await message.edit({
          embeds: [buildEventEmbed(event)],
          components: buildEventThreadActionRows(event),
        });
        return message.id;
      },
    );
  } catch (error: unknown) {
    console.warn(
      `[${sourceLabel}] Failed to refresh signup card for event #${event.id}:`,
      error,
    );
    return null;
  }
}

/**
 * Reminder, signup controls, and lifecycle notices belong in the event discussion thread.
 *
 * A leftover Ping button on the parent starter message still resolves to that thread instead of
 * posting a second reminder in the events channel.
 */
export function resolveEventReminderThread(interaction: {
  channel: { isThread(): boolean } | null;
  message: { thread?: ThreadChannel | null };
}): ThreadChannel {
  if (interaction.channel?.isThread()) {
    return interaction.channel as ThreadChannel;
  }
  if (interaction.message.thread) {
    return interaction.message.thread;
  }
  throw new Error("Event reminders can only be sent from the event thread.");
}
