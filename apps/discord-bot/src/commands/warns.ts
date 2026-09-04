import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import type { ApiClient } from '../api/client.js';
import { asListItems, resolveInternalUserId } from '../api/resolve-user.js';
import type { PaginatedData, WarnEscalationView, WarnView } from '../api/types.js';
import { BOT_COLORS, buildAsciiBar, createBaseEmbed, createResponseEmbed } from '../embeds/theme.js';

export const data = new SlashCommandBuilder()
  .setName('warns')
  .setDescription('View warns or open escalations (Officer+)')
  .addUserOption((opt) =>
    opt.setName('user').setDescription('Member whose warn history to show').setRequired(false),
  );

function severityBadge(s: string): string {
  switch (s.toLowerCase()) {
    case 'high': return '🔴 HIGH';
    case 'medium': return '🟡 MEDIUM';
    case 'low': return '⚪ LOW';
    default: return `⚠️ ${s.toUpperCase()}`;
  }
}

function formatWarn(w: WarnView): string {
  const statusBadge = w.revoked_at ? '*(revoked)*' : '`ACTIVE`';
  const reason = w.reason?.trim() || '*No reason specified*';
  return `• \`#${w.id}\` ${severityBadge(w.severity)} ${statusBadge} — ${reason}`;
}

function formatEscalation(e: WarnEscalationView): string {
  const state = e.acknowledged_at ? '✅ Handled' : '⚠️ Open Action';
  const who = e.username ? `**${e.username}**` : `user \`${e.user_id}\``;
  return `• \`#${e.id}\` ${who} — **${e.warn_count_at_time}** warns (limit: ${e.threshold_at_time}) · ${state}`;
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
      const errEmbed = createResponseEmbed('error', 'Warns Unavailable', message, 'DISCIPLINARY');
      await interaction.editReply({ embeds: [errEmbed] });
      return;
    }

    const embed = createBaseEmbed({
      category: 'DISCIPLINARY REGISTER',
      title: '⚠️ Officer Disciplinary Overview',
      description: '*Active escalation alerts and recent warning audit trail*',
      color: escalations.length > 0 ? BOT_COLORS.DANGER : BOT_COLORS.WARNING,
    });

    const escalationLines =
      escalations.length > 0 ? escalations.map(formatEscalation).join('\n') : '*No open escalations.*';
    const warnLines = warns.length > 0 ? warns.map(formatWarn).join('\n') : '*No recent warnings recorded.*';

    embed.addFields(
      { name: `🚨 Open Escalations (${escalations.length})`, value: escalationLines.slice(0, 1024), inline: false },
      { name: '📋 Recent Warnings', value: warnLines.slice(0, 1024), inline: false },
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
      'DISCIPLINARY',
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
  const activeWarns = warns.filter((w) => !w.revoked_at);

  const embed = createBaseEmbed({
    category: 'DISCIPLINARY RECORD',
    title: `⚠️ Disciplinary Record — ${target.displayName}`,
    description: `*Member account status · **${activeWarns.length}** active warnings on file*`,
    color: activeWarns.length >= 3 ? BOT_COLORS.DANGER : BOT_COLORS.WARNING,
  });

  const maxThreshold = 4;
  const bar = buildAsciiBar(activeWarns.length, maxThreshold, 14);
  const pct = Math.min(100, Math.round((activeWarns.length / maxThreshold) * 100));

  embed.addFields({
    name: '🚨 ESCALATION RISK GAUGE',
    value: `\`\`\`\nWarn Level  ${bar}  ${activeWarns.length} / ${maxThreshold} Active Warns (${pct}%)\nAction: Automatic Officer Escalation & Kick at ${maxThreshold} Warns\n\`\`\``,
    inline: false,
  });

  if (warns.length === 0) {
    embed.addFields({
      name: '📋 Infraction History',
      value: '*Clean record! No warnings or infractions recorded.*',
      inline: false,
    });
  } else {
    embed.addFields({
      name: `📋 Recorded Infractions (${warns.length})`,
      value: warns.map(formatWarn).join('\n').slice(0, 1024),
      inline: false,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}
