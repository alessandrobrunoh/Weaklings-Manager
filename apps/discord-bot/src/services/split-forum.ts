import {
  ChannelType,
  PermissionFlagsBits,
  type Client,
  type ForumChannel,
  type ThreadChannel,
} from "discord.js";
import type { ApiClient } from "../api/client.js";
import type {
  SplitDiscordSync,
  UpdateSplitDiscordSyncState,
} from "../api/types.js";
import {
  buildSplitSummary,
  buildSplitThreadName,
} from "./split-summary.js";
import { getSettingsService } from "./settings.js";
import {
  isUnknownDiscordChannel,
  lockAndArchiveThread,
  withUnarchivedThread,
} from "./discord-thread.js";

/** Creates and maintains Discord Forum posts. It never creates message-based text-channel threads. */
export class SplitForumAdapter {
  constructor(
    private readonly client: Client,
    private readonly api: ApiClient,
    private readonly forumChannelId: string,
  ) {}

  async sync(item: SplitDiscordSync): Promise<boolean> {
    let thread = item.thread_id ? await this.fetchThread(item.thread_id) : null;
    let summaryMessageId = item.summary_message_id;
    const archived = Boolean(item.detail.archived_at);
    const terminal = ["completed", "not_completed", "lost"].includes(item.detail.status);

    // Archiving hides a still-pending split. Delete the Forum post so it does not stay in the
    // active list as an open loot thread. Completed/lost history is closed below, not deleted.
    if (archived && !terminal) {
      if (thread && !await this.deleteForumPost(thread, item.split_id)) return false;
      return this.saveState(item.split_id, {
        last_audit_id: item.next_audit_cursor,
        last_transaction_id: item.next_transaction_cursor,
      });
    }

    if (!thread) {
      thread = await this.createForumPost(item);
      if (!thread) return false;

      // Persist the post ID immediately so a transient starter-message fetch failure cannot
      // create a duplicate Forum post on the next poll.
      if (!await this.saveState(item.split_id, { thread_id: thread.id })) return false;
      summaryMessageId = thread.id;
    }

    if (!summaryMessageId) {
      const starterMessage = await thread.fetchStarterMessage();
      summaryMessageId = starterMessage?.id ?? thread.id;
    }

    if (!await this.updateSummary(thread, summaryMessageId, item)) return false;
    if (!await this.updateForumTag(thread, item)) return false;

    // A finalized split remains available as history, but its Forum post must no longer accept
    // replies. Locking prevents writes while archiving removes it from the active post list.
    if (terminal && !await this.closeForumPost(thread, item.split_id)) {
      return false;
    }

    // The summary is the only Discord message maintained for a split. Advance both backend
    // cursors only after it is current, so a failed summary update is retried without losing
    // the opportunity to reconcile it. Persisting both cursors also prevents the backend's
    // incremental endpoint from returning the same audit/transaction rows forever.
    return this.saveState(item.split_id, {
      thread_id: thread.id,
      summary_message_id: summaryMessageId,
      last_audit_id: item.next_audit_cursor,
      last_transaction_id: item.next_transaction_cursor,
    });
  }

  private async createForumPost(item: SplitDiscordSync): Promise<ThreadChannel | null> {
    try {
      const channel = await this.client.channels.fetch(this.forumChannelId);
      if (!channel || channel.type !== ChannelType.GuildForum) {
        console.warn(`[SplitForum] ${this.forumChannelId} is missing or is not a Discord Forum Channel`);
        return null;
      }

      const forum = channel as ForumChannel;
      const bot = this.client.user;
      const permissions = bot ? forum.permissionsFor(bot) : null;
      if (!permissions) {
        console.warn(`[SplitForum] Could not resolve bot permissions for Forum Channel ${forum.id}`);
        return null;
      }
      const missingPermissions = [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.SendMessagesInThreads,
        PermissionFlagsBits.ReadMessageHistory,
      ].filter((permission) => !permissions.has(permission));
      if (missingPermissions.length > 0) {
        console.warn(
          `[SplitForum] Bot lacks permissions required to create and maintain posts in Forum Channel ${forum.id}`,
        );
        return null;
      }

      let appliedTags: string[] | undefined;
      if (forum.flags.has("RequireTag")) {
        const canManageThreads = permissions.has(PermissionFlagsBits.ManageThreads);
        const tag = forum.availableTags.find((candidate) => !candidate.moderated || canManageThreads);
        if (!tag) {
          console.warn(`[SplitForum] Forum Channel ${forum.id} requires a tag, but no usable tag is available`);
          return null;
        }
        appliedTags = [tag.id];
      }

      // In a Forum Channel Discord creates the starter message and its Forum post atomically.
      // This is intentionally not Message#startThread(), which belongs to regular text channels.
      return await forum.threads.create({
        name: buildSplitThreadName(item.detail),
        message: buildSplitSummary(item.detail),
        ...(appliedTags ? { appliedTags } : {}),
        reason: `Create split #${item.split_id} Forum post`,
      });
    } catch (error) {
      console.warn(`[SplitForum] Could not create Forum post for split #${item.split_id}:`, error);
      return null;
    }
  }

  private async fetchThread(threadId: string): Promise<ThreadChannel | null> {
    try {
      const channel = await this.client.channels.fetch(threadId);
      if (!channel?.isThread() || channel.parentId !== this.forumChannelId) {
        console.warn(`[SplitForum] ${threadId} is not a post in configured Forum Channel ${this.forumChannelId}`);
        return null;
      }
      return channel;
    } catch (error) {
      console.warn(`[SplitForum] Could not fetch Forum post ${threadId}:`, error);
      return null;
    }
  }

  private async updateSummary(
    thread: ThreadChannel,
    messageId: string,
    item: SplitDiscordSync,
  ): Promise<boolean> {
    try {
      await withUnarchivedThread(
        thread,
        `Update split #${item.split_id} Forum post`,
        async (active) => {
          const message = await active.messages.fetch(messageId);
          await message.edit(buildSplitSummary(item.detail));
          if (active.name !== buildSplitThreadName(item.detail)) {
            await active.setName(
              buildSplitThreadName(item.detail),
              `Update split #${item.split_id} Forum post`,
            );
          }
        },
      );
      return true;
    } catch (error) {
      console.warn(`[SplitForum] Could not update summary for split #${item.split_id}:`, error);
      return false;
    }
  }


  private async updateForumTag(thread: ThreadChannel, item: SplitDiscordSync): Promise<boolean> {
    try {
      let tagId: string | null;
      try {
        tagId = await getSettingsService().splitTagId(item.detail.status);
      } catch (error) {
        // Unit callers can use the adapter without bootstrapping the process-wide settings service.
        // The real bot initializes it before the poller starts.
        if (error instanceof Error && error.message.startsWith("SettingsService not initialized")) {
          return true;
        }
        throw error;
      }
      // An unset tag means this lifecycle state is intentionally not configured yet.
      if (!tagId) return true;
      if (!thread.appliedTags.includes(tagId)) {
        await withUnarchivedThread(
          thread,
          `Set split #${item.split_id} status tag`,
          (active) => active.setAppliedTags([tagId], `Set split #${item.split_id} status tag`),
        );
      }
      return true;
    } catch (error) {
      console.warn(`[SplitForum] Could not update status tag for split #${item.split_id}:`, error);
      return false;
    }
  }

  private async closeForumPost(thread: ThreadChannel, splitId: number): Promise<boolean> {
    try {
      await lockAndArchiveThread(thread, `Split #${splitId} closed`);
      return true;
    } catch (error) {
      if (isUnknownDiscordChannel(error)) return true;
      console.warn(`[SplitForum] Could not close Forum post for split #${splitId}:`, error);
      return false;
    }
  }

  /** Removes an archived pending split from the Forum. Falls back to lock+archive if delete fails. */
  private async deleteForumPost(thread: ThreadChannel, splitId: number): Promise<boolean> {
    try {
      await thread.delete(`Split #${splitId} archived`);
      return true;
    } catch (error) {
      if (isUnknownDiscordChannel(error)) return true;
      console.warn(
        `[SplitForum] Could not delete Forum post for split #${splitId}; closing instead:`,
        error,
      );
      return this.closeForumPost(thread, splitId);
    }
  }

  private async saveState(
    splitId: number,
    state: UpdateSplitDiscordSyncState,
  ): Promise<boolean> {
    try {
      await this.api.put<UpdateSplitDiscordSyncState>(
        `api/splits/${splitId}/discord-sync`,
        state,
      );
      return true;
    } catch (error) {
      console.warn(`[SplitForum] Could not persist sync state for split #${splitId}:`, error);
      return false;
    }
  }
}
