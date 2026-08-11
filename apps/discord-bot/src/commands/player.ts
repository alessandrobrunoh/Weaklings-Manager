import { ChatInputCommandInteraction, EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import type { ApiClient } from '../api/client.js';
import type { AlbionSearchResult, AlbionPlayer } from '../api/types.js';

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
  await interaction.deferReply({ ephemeral: true });

  const name = interaction.options.getString('name', true);

  // Step 1: search
  const results = await api.get<AlbionSearchResult>(
    'api/albion/search',
    interaction.user.id,
    { q: name },
  );

  if (results.players.length === 0) {
    await interaction.editReply({ content: `No player found matching **${name}**.` });
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

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setAuthor({ name: 'Albion Online — Player' })
    .setTitle(player?.name ?? match.name)
    .setFooter({ text: `ID: ${match.id}` });

  if (player) {
    embed.addFields(
      { name: 'Guild',      value: player.guildName ?? '*Guildless*',         inline: true },
      { name: 'Alliance',   value: player.allianceName ?? '—',                inline: true },
      { name: '\u200b',     value: '\u200b',                                   inline: true },
      { name: 'PvP Kill Fame',  value: fmt(player.killFame),                  inline: true },
      { name: 'Death Fame',     value: fmt(player.deathFame),                 inline: true },
      { name: 'PvE Fame',       value: fmt(player.pveFame),                   inline: true },
      { name: 'Gathering',      value: fmt(player.gatheringFame),             inline: true },
      { name: 'Crafting',       value: fmt(player.craftingFame),              inline: true },
      { name: '\u200b',         value: '\u200b',                               inline: true },
    );
  } else {
    embed.setDescription(`*Could not fetch full profile — showing search result only.*`);
  }

  // Mostra altri match se ci sono
  if (results.players.length > 1) {
    const others = results.players
      .slice(1, 6)
      .map((p) => p.name)
      .join(', ');
    embed.setFooter({ text: `ID: ${match.id} · Other matches: ${others}` });
  }

  await interaction.editReply({ embeds: [embed] });
}
