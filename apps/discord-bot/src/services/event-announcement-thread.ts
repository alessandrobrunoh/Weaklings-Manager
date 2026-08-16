import { Message, ThreadAutoArchiveDuration } from "discord.js";
import type { EventView } from "../api/types.js";

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
 * Threads` or `Send Messages in Threads`. Returning `false` lets command handlers surface a user
 * warning, while pollers can keep their checkpoint logic independent from Discord permissions.
 *
 * @example
 * const wasCreated = await createEventAnnouncementThread(message, event, 'Poller');
 * if (!wasCreated) console.warn('Thread permissions need review');
 */
export async function createEventAnnouncementThread(
  message: Message,
  event: EventView,
  sourceLabel: string,
): Promise<boolean> {
  try {
    await message.startThread({
      name: buildEventThreadName(event.title),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      reason: `Event #${event.id} ${sourceLabel} discussion`,
    });
    console.log(
      `[${sourceLabel}] Created Discord thread for event #${event.id} on message ${message.id}`,
    );
    return true;
  } catch (error: unknown) {
    console.warn(
      `[${sourceLabel}] Failed to create Discord thread for event #${event.id} on message ${message.id}:`,
      error,
    );
    return false;
  }
}
