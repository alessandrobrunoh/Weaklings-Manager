import {
  ChannelType,
  type Client,
  type ForumChannel,
  type ThreadChannel,
} from "discord.js";
import type { ApiClient } from "../api/client.js";
import type {
  SplitDiscordSyncState,
  SplitSyncItem,
  SplitSyncLog,
} from "../api/types.js";
import {
  buildSplitSummary,
  buildSplitThreadName,
  chunkSplitLog,
} from "./split-summary.js";

const SYNC_STATE_PATH = (id: number) => `api/bot/splits/${id}/sync-state`;

/** Discord-only adapter. It never derives split or payment data; the backend is authoritative. */
export class SplitForumAdapter {
  constructor(
    private readonly client: Client,
    private readonly api: ApiClient,
    private readonly forumChannelId: string,
  ) {}

  async sync(item: SplitSyncItem): Promise<boolean> {
    const version = item.split.updated_at ?? item.split.created_at;
    let state = item.sync;
    let thread: ThreadChannel | null = null;

    if (state.thread_id) {
      thread = await this.fetchThread(state.thread_id);
    }

    if (!thread) {
      thread = await this.createThread(item);
      if (!thread) return false;
      const summary = buildSplitSummary(item.split);
      const summaryMessage = await thread.fetchStarterMessage() ?? await thread.send(summary);
      const savedState = await this.saveState(item.split.id, {
        split_id: item.split.id,
        thread_id: thread.id,
        summary_message_id: summaryMessage.id,
        summary_version: version,
        log_cursor: state.log_cursor,
      });
      if (!savedState) return false;
      state = savedState;
    } else if (state.summary_message_id && state.summary_version !== version) {
      if (!await this.updateSummary(thread, state.summary_message_id, item)) return false;
      const savedState = await this.saveState(item.split.id, {
        ...state,
        thread_id: thread.id,
        summary_message_id: state.summary_message_id,
        summary_version: version,
      });
      if (!savedState) return false;
      state = savedState;
    }

    if (item.logs_available && !await this.syncLogs(thread, item.split.id, state)) {
      return false;
    }
    return true;
  }

  private async createThread(item: SplitSyncItem): Promise<ThreadChannel | null> {
    try {
      const channel = await this.client.channels.fetch(this.forumChannelId);
      if (!channel || channel.type !== ChannelType.GuildForum) {
        console.warn(`[SplitForum] ${this.forumChannelId} is missing or is not a Forum Channel`);
        return null;
      }
      const forum = channel as ForumChannel;
      return await forum.threads.create({
        name: buildSplitThreadName(item.split),
        message: buildSplitSummary(item.split),
        reason: `Create split #${item.split.id} forum post`,
      });
    } catch (error) {
      console.warn(`[SplitForum] Could not create thread for split #${item.split.id}:`, error);
      return null;
    }
  }

  private async fetchThread(threadId: string): Promise<ThreadChannel | null> {
    try {
      const channel = await this.client.channels.fetch(threadId);
      return channel?.isThread() ? channel : null;
    } catch (error) {
      console.warn(`[SplitForum] Could not fetch thread ${threadId}:`, error);
      return null;
    }
  }

  private async updateSummary(
    thread: ThreadChannel,
    messageId: string,
    item: SplitSyncItem,
  ): Promise<boolean> {
    try {
      const message = await thread.messages.fetch(messageId);
      await message.edit(buildSplitSummary(item.split));
      return true;
    } catch (error) {
      console.warn(`[SplitForum] Could not update summary for split #${item.split.id}:`, error);
      return false;
    }
  }

  private async syncLogs(
    thread: ThreadChannel,
    splitId: number,
    state: SplitDiscordSyncState,
  ): Promise<boolean> {
    try {
      const batch = await this.api.get<{ items: SplitSyncLog[]; next_cursor: string | null }>(
        `api/bot/splits/${splitId}/logs`,
        undefined,
        { limit: 100, ...(state.log_cursor ? { cursor: state.log_cursor } : {}) },
      );
      for (const log of batch.items) {
        for (const content of chunkSplitLog(`[${log.occurred_at}] ${log.kind}: ${log.message}`)) {
          await thread.send({ content, allowedMentions: { parse: [] } });
        }
        const savedState = await this.saveState(splitId, {
          ...state,
          log_cursor: log.id,
          summary_version: state.summary_version,
        });
        if (!savedState) return false;
        state = savedState;
      }
      if (batch.next_cursor && batch.next_cursor !== state.log_cursor) {
        if (!await this.saveState(splitId, { ...state, log_cursor: batch.next_cursor })) return false;
      }
      return true;
    } catch (error) {
      // Logs are best-effort. Summary synchronization must remain healthy.
      console.warn(`[SplitForum] Could not sync logs for split #${splitId}:`, error);
      return false;
    }
  }

  private async saveState(
    splitId: number,
    state: SplitDiscordSyncState,
  ): Promise<SplitDiscordSyncState | null> {
    try {
      return await this.api.patch<SplitDiscordSyncState>(SYNC_STATE_PATH(splitId), state);
    } catch (error) {
      console.warn(`[SplitForum] Could not persist sync state for split #${splitId}:`, error);
      return null;
    }
  }
}
