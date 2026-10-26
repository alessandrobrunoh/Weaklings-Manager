import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  type ModalSubmitInteraction,
} from 'discord.js';
import { ApiError, type ApiClient } from '../api/client.js';
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
import { flashCopy } from '../services/flash-copy.js';
import { parseFlashWhen } from '../services/flash-time.js';
import { FLASH_UNDO_WINDOW_MS, getPoller } from '../services/poller.js';
import type { EventView } from '../api/types.js';
import {
  FLASH_MODAL_ID,
  FLASH_NOTES_FIELD,
  FLASH_WHAT_FIELD,
  FLASH_WHEN_FIELD,
} from '../commands/flash.js';
import {
  fetchGuildChannel,
  createPrivateTicketThread,
  applicationThreadName,
  findReusableTicket,
  linkIngameName,
  reopenTicket,
  staffRolePing,
  type TicketChannel,
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
    if (interaction.customId === FLASH_MODAL_ID) {
      await submitFlashMass(interaction, api);
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
    if (interaction.customId === FLASH_MODAL_ID) {
      errEmbed = createResponseEmbed(
        'error',
        flashCopy(interaction.locale, 'modalFailed'),
        message,
        'FLASH MASS',
      );
    }
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
 * Creates a flash mass from the `/flash` modal and asks the poller to announce
 * immediately — the poller stays the only announcer, so the checkpoint
 * semantics (and its `failedAnnounces` retry map) apply to flash pings too.
 */
async function submitFlashMass(
  interaction: ModalSubmitInteraction,
  api: ApiClient,
): Promise<void> {
  await interaction.deferReply({ flags: ['Ephemeral'] });

  const what = interaction.fields.getTextInputValue(FLASH_WHAT_FIELD).trim();
  const whenRaw = interaction.fields.getTextInputValue(FLASH_WHEN_FIELD).trim();
  const notes = interaction.fields.getTextInputValue(FLASH_NOTES_FIELD).trim();

  const settingsService = getSettingsService(api.guildId);
  const [routes, guildSettings] = await Promise.all([
    settingsService.eventChannelRoutes(),
    settingsService.get(),
  ]);
  const timezone = guildSettings.discord_event_timezone ?? 'Europe/Rome';
  const parsed = parseFlashWhen(whenRaw, new Date(), timezone);
  if ('error' in parsed) {
    throw new Error(flashCopy(interaction.locale, 'invalidTime', { when: whenRaw }));
  }

  if (!routes.flashMass) {
    throw new Error(flashCopy(interaction.locale, 'missingChannel'));
  }
  const eventRoleId = guildSettings.discord_event_role_id;
  if (!eventRoleId) {
    throw new Error(flashCopy(interaction.locale, 'missingRole'));
  }

  const massAt = parsed.massAt;
  const startAt = new Date(massAt.getTime() + 30 * 60 * 1000);
  let event: EventView;
  try {
    event = await api.post<EventView>(
      'api/events',
      {
        title: what,
        ...(notes ? { description: notes } : {}),
        event_kind: 'flash' as const,
        discord_role_ids: [eventRoleId],
        mass_time_utc: massAt.toISOString(),
        start_time_utc: startAt.toISOString(),
      },
      interaction.user.id,
    );
  } catch (error) {
    console.warn(`[FlashCommand] Could not create event for guild ${api.guildId}:`, error);
    throw new Error(
      error instanceof ApiError && error.status === 403
        ? flashCopy(interaction.locale, 'noPermission')
        : flashCopy(interaction.locale, 'createFailed'),
    );
  }

  // Best-effort: the scheduled tick still announces within POLL_INTERVAL_MS if
  // the immediate poll fails; the retry map covers a partial failure.
  try {
    await getPoller(api.guildId)?.pollNow();
  } catch (err) {
    console.warn('[FlashCommand] Immediate poll after creation failed:', err);
  }

  const massTs = Math.floor(massAt.getTime() / 1000);
  const undoUntilTs = Math.floor(
    (Date.parse(event.created_at) + FLASH_UNDO_WINDOW_MS) / 1000,
  );
  await interaction.editReply({
    embeds: [
      createResponseEmbed(
        'success',
        flashCopy(interaction.locale, 'createdTitle'),
        flashCopy(interaction.locale, 'createdBody', {
          id: event.id,
          what,
          massTs,
          interpretation: parsed.interpretation,
          channelId: routes.flashMass,
          undoUntilTs,
        }),
        'FLASH MASS',
      ),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`event:undo-flash:${event.id}`)
          .setLabel(flashCopy(interaction.locale, 'undoButton'))
          .setStyle(ButtonStyle.Danger),
      ),
    ],
  });
}
/**
 * Opens the applicant's ticket, or brings an archived one back.
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
  const parentChannelId = settings.discord_applications_channel_id;
  if (!parentChannelId) {
    throw new Error(
      'Il canale delle application non è configurato. Apri Impostazioni Discord e scegli il canale del pannello.',
    );
  }
  const parent = await fetchGuildChannel(guild, parentChannelId);
  if (!parent || parent.type !== ChannelType.GuildText) {
    throw new Error(
      'Il canale delle application non è valido. Seleziona un canale testuale, non una categoria o un thread.',
    );
  }
  // A deleted/renamed management role can remain in settings after the guild
  // was reconfigured. Only invite its members when the role still exists.
  const configuredManageRoleId = settings.discord_applications_manage_role_id;
  const manageRole = configuredManageRoleId
    ? await guild.roles.fetch(configuredManageRoleId).catch(() => null)
    : null;

  const active = await api.get<ApplicationView | null>(
    'api/applications/active',
    interaction.user.id,
  );
  if (active) {
    const existingChannel = await fetchGuildChannel(guild, active.channel_id);
    if (existingChannel) {
      await interaction.editReply({
        embeds: [buildApplicationAlreadyOpenEmbed(settings, active.channel_id)],
      });
      return;
    }
    // The thread/channel was manually deleted. Mark the stale application
    // closed so the member can submit a replacement immediately.
    await api.post(`api/applications/${active.id}/close`, {}, interaction.user.id).catch(() => undefined);
  }

  const ingameName = interaction.fields.getTextInputValue(APPLICATION_INGAME_FIELD).trim();
  const botId = interaction.client.user?.id;

  const reusable = await findReusableTicket(guild, api, interaction.user.id);
  let channel: TicketChannel;
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
      settings.discord_applications_category_id ?? parent.id,
      botId,
    );
    channel = reusable.channel;
    reopened = true;
    await channel.send({
      ...staffRolePing(configuredManageRoleId),
      embeds: [buildApplicationReopenedEmbed(settings, application.reopen_count ?? 1)],
      components: buildApplicationWelcomeComponents(application.id),
    });
  } else {
    channel = await createPrivateTicketThread(
      parent,
      applicationThreadName(interaction.user.username, interaction.user.id),
      guild,
      interaction.user.id,
      manageRole?.id ?? null,
      `Application opened by ${interaction.user.tag}`,
    );
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
      ...staffRolePing(configuredManageRoleId),
      embeds: [buildApplicationWelcomeEmbed(settings)],
      components: buildApplicationWelcomeComponents(application.id),
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
