import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import type { ApiClient } from '../api/client.js';
import type { AlbionSearchResult, AlbionPlayer } from '../api/types.js';
import { BOT_COLORS, createBaseEmbed, createResponseEmbed, buildAsciiChart, formatCompactNumber } from '../embeds/theme.js';

export const data = new SlashCommandBuilder()
  .setName('player')
  .setDescription('Look up an Albion Online player')
  .addStringOption((opt) =>
    opt.setName('name').setDescription('Player name to search').setRequired(true),
  );

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
  const match = results.players[0];
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
  const guildName = player?.guildName ? player.guildName : 'Guildless';
  const allyName = player?.allianceName ? `[${player.allianceName}]` : '';

  let footer = `ID: ${match.id} • Weaklings Guild Manager`;
  if (results.players.length > 1) {
    const others = results.players.slice(1, 6).map((p) => p.name).join(', ');
    footer = `ID: ${match.id} · Other matches: ${others}`;
  }

  const embed = createBaseEmbed({
    category: 'PLAYER LOOKUP',
    title: `⚔️ ${playerName} ${allyName}`.trim(),
    description: `*Guild: **${guildName}** · ID: \`${match.id}\`*`,
    color: BOT_COLORS.BRAND,
    footerText: footer,
  });

  if (player) {
    const kdRatio = player.deathFame > 0 ? (player.killFame / player.deathFame).toFixed(2) : player.killFame.toFixed(2);

    embed.addFields(
      {
        name: '🗡️ Combat Stats',
        value: [
          `• ⚔️ **PvP Kill Fame:** **${formatCompactNumber(player.killFame)}**`,
          `• 💀 **Death Fame:** **${formatCompactNumber(player.deathFame)}**`,
          `• 📊 **K/D Ratio:** **${kdRatio}**`,
        ].join('\n'),
        inline: true,
      },
      {
        name: '⛏️ Activity Stats',
        value: [
          `• 🌾 **PvE Fame:** **${formatCompactNumber(player.pveFame)}**`,
          `• 🪓 **Gathering:** **${formatCompactNumber(player.gatheringFame)}**`,
          `• 🔨 **Crafting:** **${formatCompactNumber(player.craftingFame)}**`,
        ].join('\n'),
        inline: true,
      },
    );

    const chartItems = [
      { label: 'PvP Kill', value: player.killFame, display: formatCompactNumber(player.killFame) },
      { label: 'PvE', value: player.pveFame, display: formatCompactNumber(player.pveFame) },
      { label: 'Death', value: player.deathFame, display: formatCompactNumber(player.deathFame) },
      { label: 'Gathering', value: player.gatheringFame, display: formatCompactNumber(player.gatheringFame) },
      { label: 'Crafting', value: player.craftingFame, display: formatCompactNumber(player.craftingFame) },
    ].filter((item) => item.value > 0);

    if (chartItems.length > 0) {
      embed.addFields({
        name: '⭐ FAME DISTRIBUTION',
        value: `\`\`\`\n${buildAsciiChart(chartItems, 10, 14)}\n\`\`\``,
        inline: false,
      });
    }
  } else {
    embed.setDescription(`*Guild: **${guildName}** ${allyName}*\n\n*Could not fetch full stats profile — showing basic search match.*`);
  }

  await interaction.editReply({ embeds: [embed] });
}
