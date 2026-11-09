import type { APIEmbed } from 'discord.js';
import { createResponseEmbed } from './theme.js';

/**
 * Reply to `/link` and `/register` when the backend only filed a request.
 *
 * Albion offers no way to prove who owns a character, so for members the link takes effect
 * once an officer approves it; until then nothing (nickname, guild role) changes.
 */
export function buildPendingLinkEmbed(characterName: string): APIEmbed {
  return createResponseEmbed(
    'info',
    'Link request sent',
    `Your request to link **${characterName}** was sent. An officer has to approve it before your nickname and roles are updated.`,
    'ACCOUNT LINKING',
  ).toJSON();
}
