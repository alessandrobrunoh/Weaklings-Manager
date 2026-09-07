import { ChannelType, type ModalSubmitInteraction, type TextChannel } from 'discord.js';
import type { ApiClient } from '../api/client.js';
import type { ApplicationView } from '../api/types.js';
import {
  APPLICATION_INGAME_FIELD,
  APPLICATION_MODAL_ID,
  buildApplicationAlreadyOpenEmbed,
  buildApplicationClosedEmbed,
  buildApplicationErrorEmbed,
  buildApplicationLinkEmbed,
  buildApplicationReopenedEmbed,
  buildApplicationWelcomeComponents,
  buildApplicationWelcomeEmbed,
} from '../embeds/application.embed.js';
import { createResponseEmbed } from '../embeds/theme.js';
import { getSettingsService } from '../services/settings.js';
import {
  fetchGuildChannel,
  findReusableTicket,
  linkIngameName,
  reopenTicket,
  ticketChannelName,
  ticketOverwrites,
} from '../services/application-ticket.js';

/**
 * Handles every modal submission.
 *
 * Modals arrive as their own interaction type, separate from the button that
 * opened them, so the work that used to sit behind `application:create` now
 * lives here — the button only shows the form.
 */
export async function handleModal(
  interaction: ModalSubmitInteraction,
  api: ApiClient,
): Promise<void> {
  try {
    if (interaction.customId === APPLICATION_MODAL_ID) {
      await submitApplication(interaction, api);
      return;
    }
    await interaction.reply({
      embeds: [
        createResponseEmbed('warning', 'Unknown Form', 'Unknown form submission.', 'BOT SYSTEM'),
      ],
      flags: ['Ephemeral'],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'An unexpected error occurred.';
    let errEmbed = createResponseEmbed('error', 'Form Failed', message, 'BOT SYSTEM');
    if (interaction.customId.startsWith('application:')) {
      try {
        errEmbed = buildApplicationErrorEmbed(
          await getSettingsService(api.guildId).applicationsSettings(),
        );
      } catch {
        // Keep the generic error if settings are unavailable while handling one.
      }
    }
    const reply = { embeds: [errEmbed], flags: ['Ephemeral'] as any };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply);
    } else {
      await interaction.reply(reply);
    }
  }
}

/**
 * Opens the applicant's ticket, or brings their archived one back.
 *
 * Reusing the old channel is the whole point of the reopen path: a member who
 * left and came back gets the same ticket, so the managers reading it still
 * have every previous message and decision in front of them.
 */
async function submitApplication(
  interaction: ModalSubmitInteraction,
  api: ApiClient,
): Promise<void> {
  await interaction.deferReply({ flags: ['Ephemeral'] });
  const guild = interaction.guild;
  if (!guild) throw new Error('Applications can only be opened inside a server.');

  const settings = await getSettingsService(api.guildId).applicationsSettings();
  if (!settings.discord_applications_open) {
    await interaction.editReply({ embeds: [buildApplicationClosedEmbed(settings)] });
    return;
  }
  const categoryId = settings.discord_applications_category_id;
  if (!categoryId) {
    throw new Error(
      'La categoria delle application non è configurata. Aprila da Impostazioni Discord e scegli una categoria.',
    );
  }
  const parent = await fetchGuildChannel(guild, categoryId);
  if (!parent || parent.type !== ChannelType.GuildCategory) {
    throw new Error(
      'La categoria delle application non è valida. Riapri Impostazioni Discord e seleziona una categoria, non un canale.',
    );
  }

  const active = await api.get<ApplicationView | null>(
    'api/applications/active',
    interaction.user.id,
  );
  if (active) {
    await interaction.editReply({
      embeds: [buildApplicationAlreadyOpenEmbed(settings, active.channel_id)],
    });
    return;
  }

  const ingameName = interaction.fields.getTextInputValue(APPLICATION_INGAME_FIELD).trim();
  const botId = interaction.client.user?.id;

  const reusable = await findReusableTicket(guild, api, interaction.user.id);
  let channel: TextChannel;
  let application: ApplicationView;
  let reopened = false;

  if (reusable) {
    application = await reopenTicket(
      guild,
      api,
      settings,
      interaction.user.id,
      reusable.channel,
      reusable.application.id,
      ingameName || null,
      parent.id,
      botId,
    );
    channel = reusable.channel;
    reopened = true;
    await channel.send({
      embeds: [buildApplicationReopenedEmbed(settings, application.reopen_count ?? 1)],
      components: buildApplicationWelcomeComponents(application.id),
      allowedMentions: { parse: [] },
    });
  } else {
    channel = (await guild.channels.create({
      name: ticketChannelName(interaction.user.username, interaction.user.id),
      type: ChannelType.GuildText,
      parent: parent.id,
      permissionOverwrites: ticketOverwrites(
        guild,
        interaction.user.id,
        settings.discord_applications_manage_role_id ?? null,
        botId,
      ),
      reason: `Application opened by ${interaction.user.tag}`,
    })) as TextChannel;
    try {
      application = await api.post<ApplicationView>(
        'api/applications',
        {
          channel_id: channel.id,
          username: interaction.user.username,
          ingame_name: ingameName || null,
        },
        interaction.user.id,
      );
    } catch (error) {
      await channel.delete('Application persistence failed').catch(() => undefined);
      throw error;
    }
    await channel.send({
      embeds: [buildApplicationWelcomeEmbed(settings)],
      components: buildApplicationWelcomeComponents(application.id),
      allowedMentions: { parse: [] },
    });
  }

  // Linking is attempted after the ticket exists, never before: an applicant
  // whose character cannot be found still gets their application, and the
  // outcome is reported in the ticket so a manager can finish it by hand.
  if (ingameName) {
    const outcome = await linkIngameName(api, interaction.user.id, ingameName);
    await channel
      .send({
        embeds: [buildApplicationLinkEmbed(outcome, ingameName)],
        allowedMentions: { parse: [] },
      })
      .catch(() => undefined);
  }

  await interaction.editReply({
    embeds: [
      createResponseEmbed(
        'success',
        reopened ? 'Application riaperta' : 'Application created',
        reopened
          ? `Ho riaperto la tua application in <#${channel.id}> con tutta la conversazione precedente.`
          : `La tua application è stata aperta in <#${channel.id}>.`,
        'APPLICATIONS',
      ),
    ],
  });
}
