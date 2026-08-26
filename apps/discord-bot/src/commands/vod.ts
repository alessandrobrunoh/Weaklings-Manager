import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import type { ApiClient } from '../api/client.js';
import type { SubmitVodRequest, VodReviewView } from '../api/types.js';
import { createResponseEmbed } from '../embeds/theme.js';

export const data = new SlashCommandBuilder()
  .setName('vod')
  .setDescription('Submit a VOD from inside your forum thread')
  .addStringOption((opt) =>
    opt.setName('url').setDescription('VOD URL').setRequired(true),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
): Promise<void> {
  await interaction.deferReply({ flags: ['Ephemeral'] });

  const channel = interaction.channel;
  if (!channel || !channel.isThread()) {
    const errEmbed = createResponseEmbed(
      'error',
      'Thread Required',
      'Use `/vod` **inside** your VOD forum thread.',
      'VOD REVIEW',
    );
    await interaction.editReply({ embeds: [errEmbed] });
    return;
  }

  const url = interaction.options.getString('url', true);
  const forumChannelId = channel.parentId;
  const threadOwnerId = channel.ownerId;
  if (!forumChannelId || !threadOwnerId) {
    const errEmbed = createResponseEmbed(
      'error',
      'Thread Required',
      'This thread is missing a parent forum or owner. Use `/vod` inside your VOD forum thread.',
      'VOD REVIEW',
    );
    await interaction.editReply({ embeds: [errEmbed] });
    return;
  }

  const body: SubmitVodRequest = {
    url,
    discord_thread_id: channel.id,
    discord_message_id: interaction.id,
    forum_channel_id: forumChannelId,
    thread_owner_discord_id: threadOwnerId,
  };

  try {
    await api.post<VodReviewView>('api/vods', body, interaction.user.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'VOD submission failed.';
    const errEmbed = createResponseEmbed('error', 'VOD Not Submitted', message, 'VOD REVIEW');
    await interaction.editReply({ embeds: [errEmbed] });
    return;
  }

  const embed = createResponseEmbed(
    'success',
    'VOD Submitted',
    `Recorded **${url}** for this thread.`,
    'VOD REVIEW',
  );
  await interaction.editReply({ embeds: [embed] });
}
