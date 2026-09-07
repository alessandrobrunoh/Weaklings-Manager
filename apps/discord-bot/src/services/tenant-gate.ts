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

/** Cached `api/tenants/:id/status` lookups, keyed by Discord guild id. */
const statusCache = new Map<string, { status: TenantStatus; fetchedAt: number }>();

/** How long a registration answer is reused before the backend is asked again. */
export const TENANT_STATUS_TTL_MS = 60_000;

/**
 * Reads a guild's tenant registration, reusing a recent answer.
 *
 * Every message the bot sees and every poll tick would otherwise re-ask the
 * backend whether a guild is a tenant. The answer only changes when someone
 * completes (or loses) onboarding, so a short TTL is plenty and keeps the
 * hot paths off the network.
 */
export async function fetchTenantStatus(
  api: ApiClient,
  guildId: string,
): Promise<TenantStatus> {
  const cached = statusCache.get(guildId);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < TENANT_STATUS_TTL_MS) {
    return cached.status;
  }
  const status = await api.get<TenantStatus>(`api/tenants/${guildId}/status`);
  statusCache.set(guildId, { status, fetchedAt: now });
  return status;
}

/** Drops the cached answer for one guild, so the next check hits the backend. */
export function forgetTenantStatus(guildId: string): void {
  statusCache.delete(guildId);
}

/**
 * Whether this Discord guild is a registered tenant.
 *
 * Never throws: a backend hiccup answers "not registered" so callers skip this
 * tick instead of crashing a poll cycle or a message handler.
 */
export async function isRegisteredTenant(api: ApiClient, guildId: string): Promise<boolean> {
  try {
    return (await fetchTenantStatus(api, guildId)).registered;
  } catch (error) {
    console.warn(`[Tenant] Could not read registration for guild ${guildId}:`, error);
    return false;
  }
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

  const status = await fetchTenantStatus(api, guildId);
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
