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
    } else if (ns === 'bank') {
      await handleBankButton(interaction, api, action, rest);
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
      .setCustomId(`event:join_build:${eventId}:${interaction.message.id}`)
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
    
    try {
      const updatedEvent = await api.get<EventDetailView>(`api/events/${eventId}`, interaction.user.id);
      const embed = buildEventEmbed(updatedEvent);
      await interaction.message.edit({ embeds: [embed] });
    } catch (e) {
      console.error('Failed to update event embed on leave', e);
    }

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
    await interaction.message.edit({ embeds: [embed] });
    await interaction.editReply({ content: `✅ Event **#${eventId}** is now LIVE!` });
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
    await interaction.message.edit({ embeds: [embed] });
    await interaction.editReply({ content: `✅ Event **#${eventId}** stopped.` });
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

async function handleBankButton(
  interaction: ButtonInteraction,
  api: ApiClient,
  action: string,
  rest: string[],
): Promise<void> {
  if (action === 'request_all') {
    await interaction.deferReply({ ephemeral: true });
    
    // Disable the button on the original message if we have it
    try {
      const components = interaction.message.components;
      if (components && components.length > 0) {
        // I won't re-import all of discord.js classes just to disable the button,
        // it's easier to just strip components from the original message if they requested it
        await interaction.message.edit({ components: [] });
      }
    } catch (e) {}
    
    const txs = await api.post<any[]>(
      'api/bank/transactions/withdraw',
      { all: true },
      interaction.user.id,
    );

    const total  = txs.reduce((sum, tx) => sum + tx.amount, 0);
    const totalFmt = total.toLocaleString('en-US');

    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setAuthor({ name: 'Bank — Withdrawal Request' })
      .setDescription(
        `Withdrawal of **${totalFmt} silver** across **${txs.length}** transaction${txs.length !== 1 ? 's' : ''} submitted.\nAn officer will process it shortly.`,
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (action === 'accept') {
    const [txIdStr] = rest;
    const txId = Number(txIdStr);

    await interaction.deferReply({ ephemeral: true });
    
    try {
      await api.post<any>(
        'api/bank/transactions/withdraw/accept',
        { transaction_ids: [txId] },
        interaction.user.id,
      );
      
      // Update original message to remove buttons
      try {
        await interaction.message.edit({ components: [] });
      } catch (e) {}

      await interaction.editReply({ content: `✅ Withdrawal request **#${txId}** has been accepted and marked as paid.` });
    } catch (err: any) {
      await interaction.editReply({ content: `❌ Failed to accept: ${err.message || 'Unknown error'}` });
    }
    return;
  }

  if (action === 'reject') {
    const [txIdStr] = rest;
    const txId = Number(txIdStr);

    await interaction.deferReply({ ephemeral: true });
    
    try {
      await api.post<any>(
        'api/bank/transactions/withdraw/reject',
        { transaction_ids: [txId] },
        interaction.user.id,
      );
      
      // Update original message to remove buttons
      try {
        await interaction.message.edit({ components: [] });
      } catch (e) {}

      await interaction.editReply({ content: `❌ Withdrawal request **#${txId}** has been rejected.` });
    } catch (err: any) {
      await interaction.editReply({ content: `❌ Failed to reject: ${err.message || 'Unknown error'}` });
    }
    return;
  }

  await interaction.reply({ content: '❓ Unknown bank action.', ephemeral: true });
}
