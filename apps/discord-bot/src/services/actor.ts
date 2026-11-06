import type { ApiClient } from '../api/client.js';
import { discordRoleIdsFromMember } from '../api/discord-role-ids.js';

/**
 * The guild-scoped API client for one interaction, carrying the actor's Discord identity.
 *
 * The actor claim (member id, role ids, username) is attached only for an interaction that came
 * from a member of the guild. A DM, or an interaction without a guild member, gets the plain
 * guild client, so the backend never sees a presence claim it cannot verify. Every call site
 * builds its client through here rather than assembling the headers itself.
 */
export function actorApiFor(
  interaction: {
    inGuild(): boolean;
    user: { id: string; username: string };
    member: Parameters<typeof discordRoleIdsFromMember>[0];
  },
  guildApi: ApiClient,
): ApiClient {
  if (!interaction.inGuild()) {
    return guildApi;
  }
  return guildApi.withDiscordActor(
    interaction.user.id,
    discordRoleIdsFromMember(interaction.member),
    interaction.user.username,
  );
}
