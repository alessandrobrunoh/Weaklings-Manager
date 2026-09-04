import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import type { ApiClient } from '../api/client.js';
import { expiryFromDays, resolveInternalUserId } from '../api/resolve-user.js';
import type { IssueWarnRequest, WarnSeverity, WarnView } from '../api/types.js';
import { BOT_COLORS, createBaseEmbed, createResponseEmbed } from '../embeds/theme.js';

export const data = new SlashCommandBuilder()
  .setName('warn')
  .setDescription('Issue a disciplinary warn (Officer+)')
  .addUserOption((opt) =>
    opt.setName('user').setDescription('Member to warn').setRequired(true),
  )
  .addStringOption((opt) =>
    opt.setName('reason').setDescription('Why this warn is being issued').setRequired(true),
  )
  .addStringOption((opt) =>
    opt
      .setName('severity')
      .setDescription('Severity')
      .setRequired(false)
      .addChoices(
        { name: 'Note', value: 'note' },
        { name: 'Warn', value: 'warn' },
        { name: 'Strike', value: 'strike' },
      ),
  )
  .addNumberOption((opt) =>
    opt
      .setName('multiplier')
      .setDescription('Optional XP multiplier to attach (0–5)')
      .setRequired(false)
      .setMinValue(0)
      .setMaxValue(5),
  )
  .addIntegerOption((opt) =>
    opt
      .setName('days')
      .setDescription('Multiplier duration in days')
      .setRequired(false)
      .setMinValue(1),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
): Promise<void> {
  await interaction.deferReply({ flags: ['Ephemeral'] });

  const target = interaction.options.getUser('user', true);
  const reason = interaction.options.getString('reason', true);
  const severity = (interaction.options.getString('severity') as WarnSeverity | null) ?? undefined;
  const multiplier = interaction.options.getNumber('multiplier');
  const days = interaction.options.getInteger('days');

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

  const body: IssueWarnRequest = { user_id: userId, reason };
  if (severity) body.severity = severity;
  if (multiplier !== null) body.multiplier = multiplier;
  const expires = expiryFromDays(days);
  if (expires) body.multiplier_expires_at = expires;

  const issued = await api.post<WarnView>('api/warns', body, interaction.user.id);
  const issuedSeverity = issued.severity ?? severity ?? 'warn';
  const issuedReason = issued.reason ?? reason;

  // The warn is already persisted at this point. A DM failure must not make the
  // moderator think the warn itself failed (the recipient may have DMs disabled).
  try {
    const notification = createBaseEmbed({
      category: 'MODERATION NOTICE',
      title: '⚠️ Disciplinary Warning Received',
      description: '*You have received a formal disciplinary warning in **Weaklings**.*',
      color: BOT_COLORS.WARNING,
      footerText: `Warn #${issued.id ?? '—'} • Weaklings Moderation`,
    }).addFields(
      {
        name: '📋 Warning Details',
        value: [
          `• ⚠️ **Severity:** **${issuedSeverity.toUpperCase()}**`,
          `• 📝 **Reason:** ${issuedReason}`,
          issued.id != null ? `• 🆔 **Warn ID:** \`#${issued.id}\`` : '',
        ].filter(Boolean).join('\n'),
        inline: false,
      },
      {
        name: 'ℹ️ Next Steps',
        value: 'Repeated warnings escalate automatically to guild penalties or removal. If you believe this was in error, open an Officer ticket.',
        inline: false,
      },
    );
    await target.send({ embeds: [notification] });
  } catch (err) {
    console.warn(`[WarnCommand] Could not DM ${target.tag} about warn:`, err);
  }

  const embed = createBaseEmbed({
    category: 'DISCIPLINARY ACTION',
    title: '⚠️ Warn Issued Successfully',
    description: `*Disciplinary action recorded against <@${target.id}>*`,
    color: BOT_COLORS.WARNING,
    footerText: `Warn #${issued.id ?? '—'} • Weaklings Moderation`,
  }).addFields(
    {
      name: '👤 Target Member',
      value: `<@${target.id}> (\`${target.username}\`)`,
      inline: true,
    },
    {
      name: '⚠️ Severity',
      value: `**${issuedSeverity.toUpperCase()}**`,
      inline: true,
    },
    {
      name: '📝 Stated Reason',
      value: issuedReason,
      inline: false,
    },
  );

  await interaction.editReply({ embeds: [embed] });
}
