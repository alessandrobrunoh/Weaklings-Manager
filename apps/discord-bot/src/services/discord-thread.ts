import type { ThreadChannel } from "discord.js";

/** Discord JSON error: the requested channel no longer exists. */
export const DISCORD_UNKNOWN_CHANNEL = 10003;
/** Discord JSON error: mutating an archived thread without unarchiving it first. */
export const DISCORD_INVALID_ACTION_ON_ARCHIVED_THREAD = 50083;

/**
 * Reads a Discord REST error code from discord.js or a plain `{ code }` object.
 *
 * @example
 * discordErrorCode({ code: 50083 }) === 50083
 */
export function discordErrorCode(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  const code = (error as { code: unknown }).code;
  if (typeof code === "number") return code;
  if (typeof code === "string" && /^\d+$/.test(code)) return Number(code);
  return null;
}

export function isUnknownDiscordChannel(error: unknown): boolean {
  return discordErrorCode(error) === DISCORD_UNKNOWN_CHANNEL;
}

export function isInvalidActionOnArchivedThread(error: unknown): boolean {
  return discordErrorCode(error) === DISCORD_INVALID_ACTION_ON_ARCHIVED_THREAD;
}

/**
 * Discord rejects every mutation on an archived thread except unarchiving
 * (`InvalidActionOnArchivedThread` / 50083). Event announcement threads and
 * Forum posts both auto-archive, so callers that edit, lock, tag, or send
 * must bring the thread back first.
 */
export async function unarchiveThread(
  thread: ThreadChannel,
  reason?: string,
): Promise<ThreadChannel> {
  if (!thread.archived) return thread;
  return thread.setArchived(false, reason);
}

/**
 * Runs `action` on an active thread, unarchiving first and retrying once when
 * Discord reports 50083. The retry covers a stale cache that still thinks the
 * thread is active after auto-archive.
 */
export async function withUnarchivedThread<T>(
  thread: ThreadChannel,
  reason: string,
  action: (active: ThreadChannel) => Promise<T>,
): Promise<T> {
  const active = await unarchiveThread(thread, reason);
  try {
    return await action(active);
  } catch (error) {
    if (!isInvalidActionOnArchivedThread(error)) throw error;
    const recovered = await thread.setArchived(false, reason);
    return action(recovered);
  }
}

/** Unarchives if needed, locks, then archives so the thread stays read-only history. */
export async function lockAndArchiveThread(
  thread: ThreadChannel,
  reason: string,
): Promise<void> {
  await withUnarchivedThread(thread, reason, async (active) => {
    await active.setLocked(true, reason);
  });
  await thread.setArchived(true, reason);
}
