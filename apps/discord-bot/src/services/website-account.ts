import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { ApiError, type ApiClient } from '../api/client.js';
import { config } from '../config.js';
import { createResponseEmbed } from '../embeds/theme.js';

const UNREGISTERED_DISCORD_ACCOUNT_DETAIL = 'has no linked account in this system';

/** True only for the backend response used when a Discord user has not logged in to the website. */
export function isUnregisteredWebsiteUserError(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    error.status === 401 &&
    error.message.includes(UNREGISTERED_DISCORD_ACCOUNT_DETAIL)
  );
}

/** How long a positive "has a website account" answer is reused. */
const REGISTERED_CACHE_TTL_MS = 5 * 60_000;
const registeredUntil = new Map<string, number>();

/** Drops every cached answer; used by tests. */
export function clearWebsiteRegistrationCache(): void {
  registeredUntil.clear();
}

/**
 * Checks that the Discord user has a local website profile.
 *
 * Only a positive answer is cached: this check sits in front of every command,
 * and a slow backend round trip here is what pushes a command past Discord's 3
 * second acknowledgement window. A user who is not registered yet is always
 * re-checked, so signing in on the website takes effect immediately.
 */
export async function isWebsiteUserRegistered(
  api: ApiClient,
  discordId: string,
): Promise<boolean> {
  const cacheKey = `${api.guildId ?? ''}:${discordId}`;
  if ((registeredUntil.get(cacheKey) ?? 0) > Date.now()) return true;
  try {
    await api.get('api/users/me', discordId);
    registeredUntil.set(cacheKey, Date.now() + REGISTERED_CACHE_TTL_MS);
    return true;
  } catch (error) {
    if (isUnregisteredWebsiteUserError(error)) {
      return false;
    }
    throw error;
  }
}

/** Reply shown when a Discord user needs to sign in to the website first. */
export function buildWebsiteAccountRequiredReply() {
  const loginUrl = `${config.FRONTEND_URL.replace(/\/$/, '')}/login`;
  const linkButton = new ButtonBuilder()
    .setLabel('Link your account')
    .setStyle(ButtonStyle.Link)
    .setURL(loginUrl);

  return {
    embeds: [
      createResponseEmbed(
        'warning',
        'Website Account Required',
        'Your Discord account is not registered with Weaklings Manager yet. Sign in to the website with Discord using the button below, then try the command or event signup again.',
        'ACCOUNT',
      ),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(linkButton),
    ],
  };
}
