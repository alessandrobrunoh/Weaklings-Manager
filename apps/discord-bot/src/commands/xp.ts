import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import type { ApiClient } from '../api/client.js';
import { expiryFromDays, resolveInternalUserId } from '../api/resolve-user.js';
import type { AdjustXpRequest, ProgressionMeView } from '../api/types.js';
import { BOT_COLORS, createBaseEmbed, createResponseEmbed } from '../embeds/theme.js';

export const data = new SlashCommandBuilder()
  .setName('xp')
  .setDescription('Adjust a member\'s season XP, level, or multiplier (Officer+)')
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Add (or subtract) season XP')
      .addUserOption((opt) =>
        opt.setName('user').setDescription('Target member').setRequired(true),
      )
      .addIntegerOption((opt) =>
        opt.setName('amount').setDescription('XP to add (negative subtracts)').setRequired(true),
      )
      .addStringOption((opt) =>
        opt.setName('reason').setDescription('Why this adjustment').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('set')
      .setDescription('Set season XP to an exact value')
      .addUserOption((opt) =>
        opt.setName('user').setDescription('Target member').setRequired(true),
      )
      .addIntegerOption((opt) =>
        opt
          .setName('amount')
          .setDescription('XP to set')
          .setRequired(true)
          .setMinValue(0),
      )
      .addStringOption((opt) =>
        opt.setName('reason').setDescription('Why this adjustment').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('level')
      .setDescription('Set season level (writes the minimum XP for that level)')
      .addUserOption((opt) =>
        opt.setName('user').setDescription('Target member').setRequired(true),
      )
      .addIntegerOption((opt) =>
        opt.setName('level').setDescription('Level to set').setRequired(true).setMinValue(1),
      )
      .addStringOption((opt) =>
        opt.setName('reason').setDescription('Why this adjustment').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('multiplier')
      .setDescription('Set the XP multiplier')
      .addUserOption((opt) =>
        opt.setName('user').setDescription('Target member').setRequired(true),
      )
      .addNumberOption((opt) =>
        opt
          .setName('value')
          .setDescription('Multiplier (0–5)')
          .setRequired(true)
          .setMinValue(0)
          .setMaxValue(5),
      )
      .addStringOption((opt) =>
        opt.setName('reason').setDescription('Why this adjustment').setRequired(true),
      )
      .addIntegerOption((opt) =>
        opt
          .setName('days')
          .setDescription('Expiry in days (omit for no expiry)')
          .setRequired(false)
          .setMinValue(1),
      ),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
): Promise<void> {
  await interaction.deferReply({ flags: ['Ephemeral'] });

  const sub = interaction.options.getSubcommand(true);
  const target = interaction.options.getUser('user', true);
  const reason = interaction.options.getString('reason', true);

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
      'SEASON RANK',
    );
    await interaction.editReply({ embeds: [errEmbed] });
    return;
  }

  const body: AdjustXpRequest = { reason };
  if (sub === 'add') {
    body.add_xp = interaction.options.getInteger('amount', true);
  } else if (sub === 'set') {
    body.set_xp = interaction.options.getInteger('amount', true);
  } else if (sub === 'level') {
    body.set_level = interaction.options.getInteger('level', true);
  } else if (sub === 'multiplier') {
    body.set_multiplier = interaction.options.getNumber('value', true);
    const expires = expiryFromDays(interaction.options.getInteger('days'));
    if (expires) body.multiplier_expires_at = expires;
  }

  const view = await api.post<ProgressionMeView>(
    `api/progression/users/${userId}/adjust`,
    body,
    interaction.user.id,
  );

  const embed = createBaseEmbed({
    category: 'SEASON PROGRESSION',
    title: '⚡ Season XP Adjusted',
    description: `*Progression adjustment recorded for <@${target.id}>*`,
    color: BOT_COLORS.SUCCESS,
  }).addFields(
    {
      name: '👤 Target Member',
      value: `<@${target.id}> (\`${target.username}\`)`,
      inline: true,
    },
    {
      name: '🌟 New Level & XP',
      value: `• **Level:** **${view.level}**\n• **Total XP:** **${view.xp.toLocaleString('en-US')}**`,
      inline: true,
    },
    {
      name: '📝 Stated Reason',
      value: reason,
      inline: false,
    },
  );
  await interaction.editReply({ embeds: [embed] });
}
