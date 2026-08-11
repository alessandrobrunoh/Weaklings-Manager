import { ChatInputCommandInteraction, EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import type { ApiClient } from '../api/client.js';
import type { PaginatedData, UserProfile } from '../api/types.js';

export const data = new SlashCommandBuilder()
  .setName('users')
  .setDescription('Browse guild members')
  .addStringOption((opt) =>
    opt.setName('search').setDescription('Filter by username').setRequired(false),
  )
  .addIntegerOption((opt) =>
    opt.setName('page').setDescription('Page number').setMinValue(1).setRequired(false),
  );

const ROLE_COLOR: Record<string, string> = {
  SuperAdmin: '`👑 SuperAdmin`',
  Admin:      '`🔴 Admin`',
  Officer:    '`🟡 Officer`',
  User:       '`User`',
};

export async function execute(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const search = interaction.options.getString('search') ?? undefined;
  const page   = interaction.options.getInteger('page') ?? 1;

  const params: Record<string, string | number> = { page, limit: 20 };
  if (search) params['username'] = search;

  const result = await api.get<PaginatedData<UserProfile>>(
    'api/users',
    interaction.user.id,
    params,
  );

  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setAuthor({ name: 'Guild Members' })
    .setTitle(`${result.total_items} members`)
    .setFooter({ text: `Page ${result.current_page} of ${result.total_pages}` })
    .setTimestamp();

  if (result.items.length === 0) {
    embed.setDescription('*No members found.*');
  } else {
    const lines = result.items.map(
      (u) => `${ROLE_COLOR[u.role] ?? u.role} **${u.username}**`,
    );
    embed.setDescription(lines.join('\n'));
  }

  await interaction.editReply({ embeds: [embed] });
}
