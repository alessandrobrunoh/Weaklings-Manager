import type { GuildMember } from 'discord.js';
import type { GuildSettingsView } from '../api/types.js';

/**
 * Assigns the default join role when a human member joins Discord.
 *
 * Bots are skipped. Missing or already-held roles are no-ops.
 */
export async function assignJoinRole(
  member: GuildMember,
  settings: Pick<GuildSettingsView, 'discord_auto_role_id'>,
): Promise<void> {
  if (member.user.bot) {
    return;
  }

  const roleId = settings.discord_auto_role_id;
  if (!roleId || member.roles.cache.has(roleId)) {
    return;
  }

  try {
    await member.roles.add(roleId, 'Join role');
  } catch (error) {
    console.warn(`[Bot] Failed to assign join role ${roleId}:`, error);
  }
}

function uniqueRoleIds(ids: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    unique.push(id);
  }
  return unique;
}
