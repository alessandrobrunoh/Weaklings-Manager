import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import type { ApiClient } from '../api/client.js';
import type { PaginatedData, UserProfile } from '../api/types.js';
import { BOT_COLORS, createBaseEmbed } from '../embeds/theme.js';

export const data = new SlashCommandBuilder()
  .setName('users')
  .setDescription('Browse guild members')
  .addStringOption((opt) =>
    opt.setName('search').setDescription('Filter by username').setRequired(false),
  )
  .addIntegerOption((opt) =>
    opt.setName('page').setDescription('Page number').setMinValue(1).setRequired(false),
  );

const ROLE_BADGES: Record<string, string> = {
  SuperAdmin: '👑 **SuperAdmin**',
  Admin:      '🔴 **Admin**',
  Officer:    '🟡 **Officer**',
  User:       '🛡️ **User**',
};

export async function execute(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
): Promise<void> {
  await interaction.deferReply({ flags: ['Ephemeral'] });

  const search = interaction.options.getString('search') ?? undefined;
  const page   = interaction.options.getInteger('page') ?? 1;

  const params: Record<string, string | number> = { page, limit: 20 };
  if (search) params['username'] = search;

  const result = await api.get<PaginatedData<UserProfile>>(
    'api/users',
    interaction.user.id,
    params,
  );

  const embed = createBaseEmbed({
    category: 'GUILD ACCOUNTS',
    title: `👥 Guild Manager Accounts (${result.total_items})`,
    color: BOT_COLORS.BRAND,
    footerText: `Page ${result.current_page} of ${result.total_pages} • Weaklings Guild Manager`,
  });

  if (result.items.length === 0) {
    embed.setDescription('*No guild users found.*');
  } else {
    const lines = result.items.map(
      (u) => `• ${ROLE_BADGES[u.role] ?? u.role} — **${u.username}**`,
    );
    embed.setDescription(lines.join('\n'));
  }

  await interaction.editReply({ embeds: [embed] });
}
