/**
 * Read the actor's member-role snowflakes from either discord.js cache-backed
 * members or the raw member shape included in an interaction payload.
 */
export function discordRoleIdsFromMember(
  member:
    | {
        roles: string[] | { cache: { keys(): IterableIterator<string> } };
      }
    | null
    | undefined,
): string[] {
  if (!member) return [];
  return Array.isArray(member.roles)
    ? [...member.roles]
    : [...member.roles.cache.keys()];
}
