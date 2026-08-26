import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import type { ApiClient } from '../api/client.js';
import { expiryFromDays, resolveInternalUserId } from '../api/resolve-user.js';
import type { IssueWarnRequest, WarnSeverity, WarnView } from '../api/types.js';
import { createResponseEmbed } from '../embeds/theme.js';

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

  const lines = [
    `• **Member:** <@${target.id}>`,
    `• **Severity:** **${issued.severity ?? severity ?? 'warn'}**`,
    `• **Reason:** ${issued.reason ?? reason}`,
  ];
  if (issued.id != null) lines.push(`• **ID:** \`${issued.id}\``);

  const embed = createResponseEmbed('success', 'Warn Issued', lines.join('\n'), 'WARNS');
  await interaction.editReply({ embeds: [embed] });
}
