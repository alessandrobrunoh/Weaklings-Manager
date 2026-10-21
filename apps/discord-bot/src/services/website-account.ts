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

/**
 * Checks that the Discord user has a local website profile.
 */
export async function isWebsiteUserRegistered(
  api: ApiClient,
  discordId: string,
): Promise<boolean> {
  try {
    await api.get('api/users/me', discordId);
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
