import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import type { ApiClient } from '../api/client.js';
import type { EventDetailView } from '../api/types.js';
import { buildEventEmbed } from '../embeds/event.embed.js';
import { createResponseEmbed } from '../embeds/theme.js';

export const data = new SlashCommandBuilder()
  .setName('event-start')
  .setDescription('▶️ Start a scheduled event (Officer+ only)')
  .addIntegerOption((opt) =>
    opt.setName('event_id').setDescription('Event ID').setRequired(true).setMinValue(1),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
): Promise<void> {
  await interaction.deferReply({ flags: ['Ephemeral'] });

  const eventId = interaction.options.getInteger('event_id', true);

  const event = await api.post<EventDetailView>(
    `api/events/${eventId}/start`,
    {},
    interaction.user.id,
  );

  const embed = buildEventEmbed(event);

  // Try to find the thread to update the message and ping the role
  try {
    const { config } = await import('../config.js');
    const channelId = config.DISCORD_EVENTS_CHANNEL_ID;
    const channel = await interaction.client.channels.fetch(channelId);
    
    if (channel && channel.isTextBased() && !channel.isDMBased() && 'threads' in channel) {
      const activeThreads = await channel.threads.fetchActive();
      const thread = activeThreads.threads.find(t => t.name.startsWith(`Event #${event.id}`));
      
      if (thread) {
        // Ping the role
        if (config.EVENT_PING_ROLE_ID) {
          await thread.send(`🚨 <@&${config.EVENT_PING_ROLE_ID}> L'evento **${event.title}** è **INIZIATO (LIVE)** 🟢!`);
        }
        
        // Update the COMP embed in the thread
        const msgs = await thread.messages.fetch({ limit: 10 });
        const botMsg = msgs.find(m => m.author.id === interaction.client.user?.id && m.components.length > 0);
        if (botMsg) {
          await botMsg.edit({ embeds: [embed] });
        }
      }
    }
  } catch (err) {
    console.error('Failed to update thread on event start', err);
  }

  const noticeEmbed = createResponseEmbed(
    'success',
    'Event Started',
    `Event **#${eventId}** is now **LIVE**! 🟢`,
    'GUILD EVENT',
  );

  await interaction.editReply({
    embeds: [noticeEmbed],
  });
}
