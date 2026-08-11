import { ButtonInteraction, Colors, EmbedBuilder } from 'discord.js';
import type { ApiClient } from '../api/client.js';
import type { BuildRole, EventDetailView, PaginatedData, EventView, BattleSummary, CompDetail } from '../api/types.js';
import { buildEventEmbed, buildEventSummaryEmbed, buildEventActionRows } from '../embeds/event.embed.js';
import { buildBattleListEmbed } from '../embeds/battle.embed.js';

const GUILD_NAME = process.env['GUILD_NAME'] ?? '';

const BUILD_ROLE_LABELS: Record<BuildRole, string> = {
  healer: '🛡️ Healer',
  tank: '🪓 Tank',
  dps: '⚔️ DPS',
  support: '✨ Support',
  battle_mount: '🐴 Battle Mount',
  brawler: '🥊 Brawler',
};

/**
 * Handles all button interactions.
 *
 * Custom ID format:
 *   event:join:{eventId}:{role}    — join event with build role
 *   event:leave:{eventId}          — leave event
 *   event:start:{eventId}          — start event (Officer+)
 *   event:stop:{eventId}           — stop event (Officer+)
 *   events:prev:{page}             — navigate events list
 *   events:next:{page}             — navigate events list
 *   battles:prev:{page}            — navigate battles list
 *   battles:next:{page}            — navigate battles list
 */
export async function handleButton(
  interaction: ButtonInteraction,
  api: ApiClient,
): Promise<void> {
  const parts = interaction.customId.split(':');
  const [ns, action, ...rest] = parts;

  try {
    if (ns === 'event') {
      await handleEventButton(interaction, api, action, rest);
    } else if (ns === 'events') {
      await handleEventsNav(interaction, api, action, rest);
    } else if (ns === 'battles') {
      await handleBattlesNav(interaction, api, action, rest);
    } else {
      await interaction.reply({ content: '❓ Unknown button action.', ephemeral: true });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'An unexpected error occurred.';
    const reply = { content: `❌ ${message}`, ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply);
    } else {
      await interaction.reply(reply);
    }
  }
}

async function handleEventButton(
  interaction: ButtonInteraction,
  api: ApiClient,
  action: string,
  rest: string[],
): Promise<void> {
  if (action === 'join') {
    const [eventIdStr, role] = rest;
    const eventId = Number(eventIdStr);
    const buildRole = role as BuildRole;

    await interaction.deferReply({ ephemeral: true });

    // Fetch the event to get the active comp
    const event = await api.get<EventDetailView>(`api/events/${eventId}`, interaction.user.id);

    if (!event.active_comp_id) {
      await interaction.editReply({ content: '❌ This event has no active comp set.' });
      return;
    }

    // Fetch the comp details to see what builds are available
    let comp;
    try {
      comp = await api.get<CompDetail>(`api/comps/${event.active_comp_id}`, interaction.user.id);
    } catch (err) {
      await interaction.editReply({ content: '❌ Failed to fetch comp details.' });
      return;
    }

    // Filter builds by the selected role
    const availableBuilds = comp.builds.filter((b: any) => b.build.role === buildRole);

    if (availableBuilds.length === 0) {
      await interaction.editReply({
        content: `❌ The active comp (**${comp.name}**) does not require any **${BUILD_ROLE_LABELS[buildRole] ?? buildRole}** builds.`,
      });
      return;
    }

    const { ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } = await import('discord.js');

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`event:join_build:${eventId}`)
      .setPlaceholder('Select your specific build')
      .addOptions(
        availableBuilds.map((b: any) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(b.build.name)
            .setDescription(`Requested: ${b.quantity}`)
            .setValue(String(b.build_id)),
        ),
      );

    const row = new ActionRowBuilder<InstanceType<typeof StringSelectMenuBuilder>>().addComponents(selectMenu);

    await interaction.editReply({
      content: `🎯 Select your specific **${BUILD_ROLE_LABELS[buildRole] ?? buildRole}** build for event **#${eventId}**:`,
      components: [row],
    });
    return;
  }

  if (action === 'leave') {
    const [eventIdStr] = rest;
    const eventId = Number(eventIdStr);

    await interaction.deferReply({ ephemeral: true });
    await api.delete(`api/events/${eventId}/participate`, interaction.user.id);
    await interaction.editReply({ content: `✅ You have left event **#${eventId}**.` });
    return;
  }

  if (action === 'start') {
    const [eventIdStr] = rest;
    const eventId = Number(eventIdStr);

    await interaction.deferReply({ ephemeral: true });
    const event = await api.post<EventDetailView>(
      `api/events/${eventId}/start`,
      {},
      interaction.user.id,
    );
    const embed = buildEventEmbed(event);
    await interaction.editReply({ content: `✅ Event **#${eventId}** is now LIVE!`, embeds: [embed] });
    return;
  }

  if (action === 'stop') {
    const [eventIdStr] = rest;
    const eventId = Number(eventIdStr);

    await interaction.deferReply({ ephemeral: true });
    const event = await api.post<EventDetailView>(
      `api/events/${eventId}/stop`,
      {},
      interaction.user.id,
    );
    const embed = buildEventEmbed(event);
    await interaction.editReply({ content: `✅ Event **#${eventId}** stopped.`, embeds: [embed] });
    return;
  }

  await interaction.reply({ content: '❓ Unknown event action.', ephemeral: true });
}

async function handleEventsNav(
  interaction: ButtonInteraction,
  api: ApiClient,
  action: string,
  rest: string[],
): Promise<void> {
  const currentPage = Number(rest[0]) ?? 1;
  const newPage = action === 'next' ? currentPage + 1 : Math.max(1, currentPage - 1);

  await interaction.deferUpdate();

  const result = await api.get<PaginatedData<EventView>>(
    'api/events',
    interaction.user.id,
    { page: newPage, limit: 10 },
  );

  const embed = buildEventSummaryEmbed(result.items, result.current_page, result.total_pages);

  // Rebuild nav row with updated state
  const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import('discord.js');
  const navRow = new ActionRowBuilder<InstanceType<typeof ButtonBuilder>>().addComponents(
    new ButtonBuilder()
      .setCustomId(`events:prev:${newPage}`)
      .setLabel('◀ Prev')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(newPage <= 1),
    new ButtonBuilder()
      .setCustomId(`events:next:${newPage}`)
      .setLabel('Next ▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(newPage >= result.total_pages),
  );

  await interaction.editReply({ embeds: [embed], components: [navRow] });
}

async function handleBattlesNav(
  interaction: ButtonInteraction,
  api: ApiClient,
  action: string,
  rest: string[],
): Promise<void> {
  const currentPage = Number(rest[0]) ?? 1;
  const newPage = action === 'next' ? currentPage + 1 : Math.max(1, currentPage - 1);

  await interaction.deferUpdate();

  const result = await api.get<PaginatedData<BattleSummary>>(
    'api/battles',
    interaction.user.id,
    { page: newPage, limit: 10 },
  );

  const embed = buildBattleListEmbed(result.items, GUILD_NAME, result.current_page, result.total_pages);

  const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import('discord.js');
  const navRow = new ActionRowBuilder<InstanceType<typeof ButtonBuilder>>().addComponents(
    new ButtonBuilder()
      .setCustomId(`battles:prev:${newPage}`)
      .setLabel('◀ Prev')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(newPage <= 1),
    new ButtonBuilder()
      .setCustomId(`battles:next:${newPage}`)
      .setLabel('Next ▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(newPage >= result.total_pages),
  );

  await interaction.editReply({ embeds: [embed], components: [navRow] });
}
