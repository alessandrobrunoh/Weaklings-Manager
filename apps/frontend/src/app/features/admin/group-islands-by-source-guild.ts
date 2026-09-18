/** Islands belonging to one source guild, already ordered by name. */
export interface SourceGuildIslandGroup<T> {
  readonly sourceGuildTenantId: string | null;
  readonly sourceGuildName: string | null;
  readonly items: T[];
}

const UNKNOWN_SOURCE_KEY = '';

function sourceGuildKey(island: {
  source_guild_tenant_id?: string | null;
}): string {
  const id = island.source_guild_tenant_id?.trim();
  return id ? id : UNKNOWN_SOURCE_KEY;
}

function sourceGuildName(island: {
  source_guild_name?: string | null;
}): string | null {
  const name = island.source_guild_name?.trim();
  return name ? name : null;
}

/**
 * Groups catalog rows by source guild tenant id.
 *
 * Homonyms from different guilds stay visible as separate rows. Missing source
 * fields collapse into a trailing unknown group so the list still renders.
 */
export function groupIslandsBySourceGuild<
  T extends {
    id: number;
    name: string;
    source_guild_tenant_id?: string | null;
    source_guild_name?: string | null;
  },
>(islands: readonly T[]): SourceGuildIslandGroup<T>[] {
  const buckets = new Map<string, T[]>();
  for (const island of islands) {
    const key = sourceGuildKey(island);
    const existing = buckets.get(key);
    if (existing) {
      existing.push(island);
    } else {
      buckets.set(key, [island]);
    }
  }

  return [...buckets.entries()]
    .map(([key, items]) => {
      const named = items.find((item) => sourceGuildName(item) !== null);
      return {
        sourceGuildTenantId: key === UNKNOWN_SOURCE_KEY ? null : key,
        sourceGuildName: named ? sourceGuildName(named) : null,
        items: [...items].sort(
          (left, right) => left.name.localeCompare(right.name) || left.id - right.id,
        ),
      };
    })
    .sort((left, right) => {
      if (left.sourceGuildTenantId === null && right.sourceGuildTenantId !== null) {
        return 1;
      }
      if (left.sourceGuildTenantId !== null && right.sourceGuildTenantId === null) {
        return -1;
      }
      const leftLabel = left.sourceGuildName ?? left.sourceGuildTenantId ?? '';
      const rightLabel = right.sourceGuildName ?? right.sourceGuildTenantId ?? '';
      return leftLabel.localeCompare(rightLabel);
    });
}
