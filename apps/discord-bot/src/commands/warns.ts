import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import type { ApiClient } from '../api/client.js';
import { asListItems, resolveInternalUserId } from '../api/resolve-user.js';
import type { PaginatedData, WarnEscalationView, WarnView } from '../api/types.js';
import { BOT_COLORS, createBaseEmbed, createResponseEmbed } from '../embeds/theme.js';

export const data = new SlashCommandBuilder()
  .setName('warns')
  .setDescription('View warns or open escalations (Officer+)')
  .addUserOption((opt) =>
    opt.setName('user').setDescription('Member whose warn history to show').setRequired(false),
  );

function formatWarn(w: WarnView): string {
  const revoked = w.revoked_at ? 'revoked' : 'active';
  const reason = w.reason?.trim() || '*no reason*';
  return `• \`#${w.id}\` **${w.severity}** (${revoked}) — ${reason}`;
}

function formatEscalation(e: WarnEscalationView): string {
  const state = e.acknowledged_at ? 'handled' : 'open';
  const who = e.username ? `**${e.username}**` : `user \`${e.user_id}\``;
  return `• \`#${e.id}\` ${who} — **${e.warn_count_at_time}** warns (threshold ${e.threshold_at_time}) · ${state}`;
}

export async function execute(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
): Promise<void> {
  await interaction.deferReply({ flags: ['Ephemeral'] });

  const target = interaction.options.getUser('user');

  if (!target) {
    const [escalationsResult, warnsResult] = await Promise.allSettled([
      api.get<PaginatedData<WarnEscalationView> | WarnEscalationView[]>(
        'api/warns/escalations',
        interaction.user.id,
      ),
      api.get<PaginatedData<WarnView> | WarnView[]>(
        'api/warns',
        interaction.user.id,
        { page: 1, limit: 10 },
      ),
    ]);

    const escalations =
      escalationsResult.status === 'fulfilled' ? asListItems(escalationsResult.value) : [];
    const warns = warnsResult.status === 'fulfilled' ? asListItems(warnsResult.value) : [];

    if (escalationsResult.status === 'rejected' && warnsResult.status === 'rejected') {
      const err = escalationsResult.reason;
      const message = err instanceof Error ? err.message : 'Failed to load warns.';
      const errEmbed = createResponseEmbed('error', 'Warns Unavailable', message, 'WARNS');
      await interaction.editReply({ embeds: [errEmbed] });
      return;
    }

    const embed = createBaseEmbed({
      category: 'WARNS',
      title: '⚠️ Warn Register',
      color: BOT_COLORS.WARNING,
    });

    const escalationLines =
      escalations.length > 0 ? escalations.map(formatEscalation).join('\n') : '*None open.*';
    const warnLines = warns.length > 0 ? warns.map(formatWarn).join('\n') : '*None recorded.*';

    embed.addFields(
      { name: 'Open Escalations', value: escalationLines.slice(0, 1024) },
      { name: 'Recent Warns', value: warnLines.slice(0, 1024) },
    );

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  const userId = await resolveInternalUserId(
    api,
    interaction.user.id,
    target.id,
    target.username,
  );
  if (userId === null) {
    const errEmbed = createResponseEmbed(
      'error',
      'Account Not Found',
      `**${target.displayName}** has no linked guild account.`,
      'WARNS',
    );
    await interaction.editReply({ embeds: [errEmbed] });
    return;
  }

  const result = await api.get<PaginatedData<WarnView> | WarnView[]>(
    'api/warns',
    interaction.user.id,
    { user_id: userId, page: 1, limit: 20 },
  );
  const warns = asListItems(result);

  const embed = createBaseEmbed({
    category: 'WARNS',
    title: `⚠️ Warns — ${target.displayName}`,
    color: BOT_COLORS.WARNING,
  });

  if (warns.length === 0) {
    embed.setDescription('*No warns on record.*');
  } else {
    embed.setDescription(warns.map(formatWarn).join('\n').slice(0, 4096));
  }

  await interaction.editReply({ embeds: [embed] });
}
