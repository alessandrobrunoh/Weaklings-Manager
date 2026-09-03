import type { GuildMember } from 'discord.js';
import type { GuildSettingsView } from '../api/types.js';

/**
 * Assigns join roles when a human member joins Discord:
 * the configured base guild role, and the Discord role linked to the
 * gestionale default role, when those ids are present and distinct.
 *
 * Bots are skipped. Missing or already-held roles are no-ops. Discord API
 * failures are logged and do not prevent the remaining role from being applied.
 */
export async function assignJoinRole(
  member: GuildMember,
  settings: Pick<GuildSettingsView, 'discord_auto_role_id' | 'default_role_discord_id'>,
): Promise<void> {
  if (member.user.bot) {
    return;
  }

  const roleIds = uniqueRoleIds([
    settings.discord_auto_role_id,
    settings.default_role_discord_id,
  ]);

  for (const roleId of roleIds) {
    if (member.roles.cache.has(roleId)) {
      continue;
    }
    try {
      await member.roles.add(roleId, 'Join role');
    } catch (error) {
      console.warn(`[Bot] Failed to assign join role ${roleId}:`, error);
    }
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
