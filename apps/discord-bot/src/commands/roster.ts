import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from 'discord.js';
import type { ApiClient } from '../api/client.js';
import type { PaginatedData } from '../api/types.js';

interface AlbionRosterMember {
  id: string;
  name: string;
}

export const data = new SlashCommandBuilder()
  .setName('roster')
  .setDescription('Browse the guild roster from Albion Online')
  .addStringOption((opt) =>
    opt.setName('search').setDescription('Filter by player name').setRequired(false),
  )
  .addIntegerOption((opt) =>
    opt.setName('page').setDescription('Page number').setMinValue(1).setRequired(false),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const search = interaction.options.getString('search') ?? undefined;
  const page   = interaction.options.getInteger('page') ?? 1;

  const params: Record<string, string | number> = { page, limit: 25 };
  if (search) params['q'] = search;

  const result = await api.get<PaginatedData<AlbionRosterMember>>(
    'api/albion/guild/roster',
    interaction.user.id,
    params,
  );

  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setAuthor({ name: 'Albion Online — Guild Roster' })
    .setTitle(`${result.total_items} members in guild`)
    .setFooter({ text: `Page ${result.current_page} of ${result.total_pages}` })
    .setTimestamp();

  if (result.items.length === 0) {
    embed.setDescription('*No members found.*');
  } else {
    const cols = chunkArray(result.items, Math.ceil(result.items.length / 2));
    for (const col of cols) {
      embed.addFields({
        name: '\u200b',
        value: col.map((m) => m.name).join('\n'),
        inline: true,
      });
    }
  }

  await interaction.editReply({ embeds: [embed] });
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}
