import type { GuildMember } from 'discord.js';
import type { GuildSettingsView } from '../api/types.js';

/**
 * Assigns the configured base guild role when a human member joins Discord.
 *
 * Bots are skipped. Missing or already-held roles are no-ops so the handler
 * can run on every GuildMemberAdd without duplicating work.
 */
export async function assignJoinRole(
  member: GuildMember,
  settings: Pick<GuildSettingsView, 'discord_auto_role_id'>,
): Promise<void> {
  if (member.user.bot) {
    return;
  }
  const roleId = settings.discord_auto_role_id;
  if (!roleId) {
    return;
  }
  if (member.roles.cache.has(roleId)) {
    return;
  }
  await member.roles.add(roleId, 'Base guild role');
}
