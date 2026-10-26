import type {
  ChatInputCommandInteraction,
  MessageContextMenuCommandInteraction,
} from 'discord.js';
import type { ApiClient } from '../api/client.js';
import { discordRoleIdsFromMember } from '../api/discord-role-ids.js';
import type { BotCommand, BotMessageCommand } from '../commands/index.js';
import { createResponseEmbed } from '../embeds/theme.js';
import { fetchTenantStatus, requireRegisteredTenant } from './tenant-gate.js';
import {
  buildWebsiteAccountRequiredReply,
  isWebsiteUserRegistered,
} from './website-account.js';

/**
 * Slash commands that belong on an alliance Discord hub.
 *
 * Everything else is guild-only (warns, VOD, applications, roster, XP, …).
 * Event list/join/leave are allowed even if they no-op until alliance event
 * ping lands — they must not be rejected as unknown on the hub.
 */
export const ALLIANCE_ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
  'register',
  'balance',
  'balance-request',
  'events',
  'event-join',
  'event-leave',
  'me',
  'player',
]);

export const ALLIANCE_GUILD_ONLY_MESSAGE = 'This command is only available on a guild Discord.';

/** Guild tenants (and unknown kind) keep the full command set. */
export function isCommandAllowedOnTenant(
  commandName: string,
  kind: string | null | undefined,
): boolean {
  if (kind?.toLowerCase() !== 'alliance') {
    return true;
  }
  return ALLIANCE_ALLOWED_COMMANDS.has(commandName);
}

/**
 * Tenant registration + alliance allowlist, then the command body.
 *
 * Callers keep their own try/catch so execute errors still use the shared
 * command-failed embed.
 */
export async function executeSlashCommand(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
  command: BotCommand,
): Promise<void> {
  const guildApi = await requireRegisteredTenant(interaction, api);
  if (!guildApi) {
    return;
  }

  const guildId = interaction.guildId;
  if (!guildId) {
    return;
  }

  const status = await fetchTenantStatus(api, guildId);
  if (!isCommandAllowedOnTenant(interaction.commandName, status.kind)) {
    const embed = createResponseEmbed(
      'warning',
      'Guild Discord only',
      ALLIANCE_GUILD_ONLY_MESSAGE,
      'COMMAND',
    );
    await interaction.reply({ embeds: [embed], flags: ['Ephemeral'] });
    return;
  }

  const actorApi = guildApi.withDiscordActor(
    interaction.user.id,
    discordRoleIdsFromMember(interaction.member),
  );
  if (!(await isWebsiteUserRegistered(actorApi, interaction.user.id))) {
    await interaction.reply({
      ...buildWebsiteAccountRequiredReply(),
      flags: ['Ephemeral'],
    });
    return;
  }

  await command.execute(interaction, actorApi);
}

/** Tenant and account gate for message context-menu commands. */
export async function executeMessageContextCommand(
  interaction: MessageContextMenuCommandInteraction,
  api: ApiClient,
  command: BotMessageCommand,
): Promise<void> {
  const guildApi = await requireRegisteredTenant(interaction, api);
  if (!guildApi) return;
  const guildId = interaction.guildId;
  if (!guildId) return;

  const status = await fetchTenantStatus(api, guildId);
  if (!isCommandAllowedOnTenant('flash', status.kind)) {
    await interaction.reply({
      embeds: [
        createResponseEmbed(
          'warning',
          'Guild Discord only',
          ALLIANCE_GUILD_ONLY_MESSAGE,
          'COMMAND',
        ),
      ],
      flags: ['Ephemeral'],
    });
    return;
  }

  const actorApi = guildApi.withDiscordActor(
    interaction.user.id,
    discordRoleIdsFromMember(interaction.member),
  );
  if (!(await isWebsiteUserRegistered(actorApi, interaction.user.id))) {
    await interaction.reply({
      ...buildWebsiteAccountRequiredReply(),
      flags: ['Ephemeral'],
    });
    return;
  }
  await command.execute(interaction, actorApi);
}
