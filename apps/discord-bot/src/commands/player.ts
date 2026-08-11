import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import type { ApiClient } from '../api/client.js';
import type { AlbionSearchResult, AlbionPlayer } from '../api/types.js';
import { BOT_COLORS, createBaseEmbed, createResponseEmbed } from '../embeds/theme.js';

export const data = new SlashCommandBuilder()
  .setName('player')
  .setDescription('Look up an Albion Online player')
  .addStringOption((opt) =>
    opt.setName('name').setDescription('Player name to search').setRequired(true),
  );

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

export async function execute(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
): Promise<void> {
  await interaction.deferReply({ flags: ['Ephemeral'] });

  const name = interaction.options.getString('name', true);

  // Step 1: search
  const results = await api.get<AlbionSearchResult>(
    'api/albion/search',
    interaction.user.id,
    { q: name },
  );

  if (results.players.length === 0) {
    const errEmbed = createResponseEmbed(
      'error',
      'Player Not Found',
      `No Albion Online player matching **${name}** was found.`,
      'PLAYER LOOKUP',
    );
    await interaction.editReply({ embeds: [errEmbed] });
    return;
  }

  // Step 2: get first match profile
  const match  = results.players[0];
  let player: AlbionPlayer | null = null;

  try {
    player = await api.get<AlbionPlayer>(
      `api/albion/players/${match.id}`,
      interaction.user.id,
    );
  } catch {
    // Fallback to search result only
  }

  const playerName = player?.name ?? match.name;
  const guildName  = player?.guildName ?? '*Guildless*';
  const allyName   = player?.allianceName ? `[${player.allianceName}]` : '';

  let footer = `ID: ${match.id} • Weaklings Guild Manager`;
  if (results.players.length > 1) {
    const others = results.players.slice(1, 6).map((p) => p.name).join(', ');
    footer = `ID: ${match.id} · Other matches: ${others}`;
  }

  const embed = createBaseEmbed({
    category: 'PLAYER LOOKUP',
    title: `⚔️ ${playerName}`,
    description: `*Guild:* **${guildName}** ${allyName}`,
    color: BOT_COLORS.BRAND,
    footerText: footer,
  });

  if (player) {
    embed.addFields(
      {
        name: '🗡️ Combat Fame',
        value: `• **PvP Kill Fame:** **${fmt(player.killFame)}**\n• **Death Fame:** **${fmt(player.deathFame)}**`,
        inline: true,
      },
      {
        name: '⛏️ Activity Fame',
        value: `• **PvE Fame:** **${fmt(player.pveFame)}**\n• **Gathering:** **${fmt(player.gatheringFame)}**\n• **Crafting:** **${fmt(player.craftingFame)}**`,
        inline: true,
      },
    );
  } else {
    embed.setDescription(`*Guild:* **${guildName}** ${allyName}\n\n*Could not fetch full stats profile — showing basic search match.*`);
  }

  await interaction.editReply({ embeds: [embed] });
}
