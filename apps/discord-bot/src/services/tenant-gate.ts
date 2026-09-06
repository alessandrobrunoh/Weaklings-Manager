import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { ApiClient } from '../api/client.js';
import { config } from '../config.js';
import { createResponseEmbed } from '../embeds/theme.js';

/** Link shown to officers when the guild has no tenant row yet. */
export function registrationLink(
  status: TenantStatus,
  frontendUrl: string,
  guildId: string,
): string {
  return (
    status.register_url ??
    `${frontendUrl.replace(/\/$/, '')}/register-tenant?guild=${guildId}`
  );
}

export interface TenantStatus {
  id: string;
  registered: boolean;
  status?: string | null;
  name?: string | null;
  register_url?: string | null;
}

/**
 * If this Discord guild is not a registered tenant, reply with the onboarding
 * link and return null. Otherwise return an API client stamped with X-Guild-Id.
 */
export async function requireRegisteredTenant(
  interaction: ChatInputCommandInteraction,
  api: ApiClient,
): Promise<ApiClient | null> {
  const guildId = interaction.guildId;
  if (!guildId) {
    const embed = createResponseEmbed(
      'warning',
      'Server only',
      'This command only works inside a Discord server.',
      'TENANT',
    );
    await interaction.reply({ embeds: [embed], flags: ['Ephemeral'] });
    return null;
  }

  const status = await api.get<TenantStatus>(`api/tenants/${guildId}/status`);
  if (status.registered) {
    return api.withGuild(guildId);
  }

  const url = registrationLink(status, config.FRONTEND_URL, guildId);
  const embed = createResponseEmbed(
    'warning',
    'Register this server first',
    'This Discord server is not registered yet. Open the link below to set up the guild (Albion region, in-game guild, …). The first person who completes registration becomes the Super Admin.',
    'TENANT',
  );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel('Register this server').setStyle(ButtonStyle.Link).setURL(url),
  );
  await interaction.reply({ embeds: [embed], components: [row], flags: ['Ephemeral'] });
  return null;
}
