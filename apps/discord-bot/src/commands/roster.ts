import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from 'discord.js';
import type { ApiClient } from '../api/client.js';
import type { PaginatedData } from '../api/types.js';
import { BOT_COLORS, createBaseEmbed } from '../embeds/theme.js';

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
  await interaction.deferReply({ flags: ['Ephemeral'] });

  const search = interaction.options.getString('search') ?? undefined;
  const page   = interaction.options.getInteger('page') ?? 1;

  const params: Record<string, string | number> = { page, limit: 25 };
  if (search) params['q'] = search;

  const result = await api.get<PaginatedData<AlbionRosterMember>>(
    'api/albion/guild/roster',
    interaction.user.id,
    params,
  );

  const embed = createBaseEmbed({
    category: 'ALBION ROSTER',
    title: `🛡️ Guild Roster (${result.total_items} Members)`,
    description: search
      ? `*Filter: matching "${search}" · Showing ${result.items.length} members*`
      : '*Albion Online In-Game Guild Member Directory*',
    color: BOT_COLORS.BRAND,
    footerText: `Page ${result.current_page} of ${result.total_pages} • Weaklings Guild Manager`,
  });

  if (result.items.length === 0) {
    embed.setDescription('*No guild members found matching your criteria.*');
  } else {
    const cols = chunkArray(result.items, Math.ceil(result.items.length / 2));
    cols.forEach((col, idx) => {
      embed.addFields({
        name: idx === 0 ? '👥 Members (Part 1)' : '👥 Members (Part 2)',
        value: col.map((m) => `• ⚔️ **${m.name}**`).join('\n'),
        inline: true,
      });
    });
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
