import { ChatInputCommandInteraction, EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import type { ApiClient } from '../api/client.js';
import type { EventDetailView } from '../api/types.js';
import { buildEventEmbed } from '../embeds/event.embed.js';

export const data = new SlashCommandBuilder()
  .setName('event-roster')
  .setDescription('View the full roster for a guild event')
  .addIntegerOption((opt) =>
    opt.setName('event_id').setDescription('Event ID').setRequired(true).setMinValue(1),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
): Promise<void> {
  await interaction.deferReply({ ephemeral: false }); // Pubblico — tutti possono vederlo

  const eventId = interaction.options.getInteger('event_id', true);
  const event   = await api.get<EventDetailView>(`api/events/${eventId}`, interaction.user.id);

  const eventEmbed = buildEventEmbed(event);

  // Crea embed separato per roster dettagliato se ci sono partecipanti
  const embeds = [eventEmbed];

  if (event.participants.length > 0) {
    // Raggruppa per ruolo build
    const byRole: Record<string, string[]> = {};
    for (const p of event.participants) {
      const role = p.primary_build_name;
      if (!byRole[role]) byRole[role] = [];
      byRole[role].push(p.username);
    }

    const rosterEmbed = new EmbedBuilder()
      .setColor(0x2b2d31)
      .setAuthor({ name: `Event #${event.id} — Roster` })
      .setTitle(`${event.participants.length} / ${event.active_comp_capacity} slots filled`)
      .setFooter({ text: event.active_comp_name });

    for (const [role, names] of Object.entries(byRole)) {
      rosterEmbed.addFields({
        name: role,
        value: names.map((n) => `• ${n}`).join('\n'),
        inline: true,
      });
    }

    embeds.push(rosterEmbed);
  }

  await interaction.editReply({ embeds });
}
