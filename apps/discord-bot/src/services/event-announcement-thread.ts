import { Message, ThreadAutoArchiveDuration } from "discord.js";
import type { EventView } from "../api/types.js";
import {
  buildEventEmbed,
  buildEventManageActionRow,
} from "../embeds/event.embed.js";

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

/**
 * Posts the interactive signup card inside an event thread.
 *
 * The announcement message remains clean in the parent channel, while thread participants get the
 * same `Manage Participation` workflow used by `/event-join`. Discord failures are isolated to this
 * follow-up so the event and parent announcement still exist.
 *
 * @example
 * const thread = await createEventAnnouncementThread(message, event, 'Poller');
 * if (thread) await sendEventSignupMessage(thread, event, 'Poller');
 */
export async function sendEventSignupMessage(
  thread: EventAnnouncementThread,
  event: EventView,
  sourceLabel: string,
): Promise<boolean> {
  try {
    await thread.send({
      content: "✅ **Join / Change Build** to sign up or swap builds — 🚪 **Leave Event** to drop out.",
      embeds: [buildEventEmbed(event)],
      components: [buildEventManageActionRow(event.id)],
    });
    console.log(
      `[${sourceLabel}] Published signup message in thread for event #${event.id}`,
    );
    return true;
  } catch (error: unknown) {
    console.warn(
      `[${sourceLabel}] Failed to publish signup message in thread for event #${event.id}:`,
      error,
    );
    return false;
  }
}
