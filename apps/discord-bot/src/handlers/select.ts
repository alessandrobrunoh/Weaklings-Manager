import { StringSelectMenuInteraction } from 'discord.js';
import type { ApiClient } from '../api/client.js';

export async function handleSelectMenu(
  interaction: StringSelectMenuInteraction,
  api: ApiClient,
): Promise<void> {
  const parts = interaction.customId.split(':');
  const [ns, action, ...rest] = parts;

  try {
    if (ns === 'event' && action === 'join_build') {
      const eventId = Number(rest[0]);
      const buildId = Number(interaction.values[0]);

      await interaction.deferUpdate();

      await api.post(
        `api/events/${eventId}/participate`,
        { primary_build_id: buildId },
        interaction.user.id,
      );

      await interaction.editReply({
        content: `✅ You have successfully signed up for event **#${eventId}** with build ID **${buildId}**.`,
        components: [],
      });
      return;
    }

    await interaction.reply({ content: '❓ Unknown select menu action.', ephemeral: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'An unexpected error occurred.';
    const reply = { content: `❌ ${message}`, components: [] };
    
    // interaction.deferUpdate() fa si che interaction.replied/deferred non ci aiutino molto per un followUp
    // se non c'e' stato un deferReply, ma noi facciamo deferUpdate, quindi editReply e' la via.
    await interaction.editReply(reply).catch(() => interaction.followUp({ content: reply.content, ephemeral: true }));
  }
}
