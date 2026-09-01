import {
  ChannelType,
  PermissionFlagsBits,
  type Client,
  type ForumChannel,
  type ThreadChannel,
} from "discord.js";
import type { ApiClient } from "../api/client.js";
import type {
  SplitAuditLog,
  SplitDiscordSync,
  TransactionView,
  UpdateSplitDiscordSyncState,
} from "../api/types.js";
import {
  buildSplitSummary,
  buildSplitThreadName,
  chunkSplitLog,
} from "./split-summary.js";

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
    if (!await this.saveState(item.split_id, {
      thread_id: thread.id,
      summary_message_id: summaryMessageId,
    })) return false;

    return this.syncLogs(thread, item);
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
      const message = await thread.messages.fetch(messageId);
      await message.edit(buildSplitSummary(item.detail));
      if (thread.name !== buildSplitThreadName(item.detail)) {
        await thread.setName(buildSplitThreadName(item.detail), `Update split #${item.split_id} Forum post`);
      }
      return true;
    } catch (error) {
      console.warn(`[SplitForum] Could not update summary for split #${item.split_id}:`, error);
      return false;
    }
  }

  private async syncLogs(thread: ThreadChannel, item: SplitDiscordSync): Promise<boolean> {
    try {
      for (const audit of item.audit) {
        if (!await this.sendLog(thread, formatAuditLog(audit))) return false;
        if (!await this.saveState(item.split_id, { last_audit_id: audit.id })) return false;
      }
      for (const transaction of item.transactions) {
        if (!await this.sendLog(thread, formatTransactionLog(transaction))) return false;
        if (!await this.saveState(item.split_id, { last_transaction_id: transaction.id })) return false;
      }
      return true;
    } catch (error) {
      console.warn(`[SplitForum] Could not sync logs for split #${item.split_id}:`, error);
      return false;
    }
  }

  private async sendLog(thread: ThreadChannel, message: string): Promise<boolean> {
    for (const content of chunkSplitLog(message)) {
      await thread.send({ content, allowedMentions: { parse: [] } });
    }
    return true;
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

function formatAuditLog(log: SplitAuditLog): string {
  const details = log.details == null ? "" : ` · ${JSON.stringify(log.details)}`;
  return `[${log.created_at}] ${log.action}${details}`;
}

function formatTransactionLog(transaction: TransactionView): string {
  return [
    `[${transaction.created_at}] Transaction #${transaction.id}`,
    `${transaction.type}: ${transaction.amount} silver`,
    `${transaction.from_label} → ${transaction.to_label}`,
    `status: ${transaction.status}`,
  ].join(" · ");
}
