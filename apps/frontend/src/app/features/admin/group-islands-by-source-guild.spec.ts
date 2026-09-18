import { describe, expect, it } from 'vitest';

import { groupIslandsBySourceGuild } from './group-islands-by-source-guild';

function island(
  id: number,
  name: string,
  source?: { tenantId?: string | null; name?: string | null },
): {
  id: number;
  name: string;
  source_guild_tenant_id?: string | null;
  source_guild_name?: string | null;
} {
  return {
    id,
    name,
    source_guild_tenant_id: source?.tenantId,
    source_guild_name: source?.name,
  };
}

describe('groupIslandsBySourceGuild', () => {
  it('groups by source guild and keeps homonyms from different guilds', () => {
    const grouped = groupIslandsBySourceGuild([
      island(2, 'Bank Island', { tenantId: 'g-beta', name: 'Beta' }),
      island(1, 'Bank Island', { tenantId: 'g-alpha', name: 'Alpha' }),
      island(3, 'Vault', { tenantId: 'g-alpha', name: 'Alpha' }),
    ]);

    expect(grouped.map((group) => group.sourceGuildName)).toEqual(['Alpha', 'Beta']);
    expect(grouped[0]?.sourceGuildTenantId).toBe('g-alpha');
    expect(grouped[0]?.items.map((item) => item.name)).toEqual(['Bank Island', 'Vault']);
    expect(grouped[1]?.items.map((item) => item.id)).toEqual([2]);
  });

  it('does not collapse same-named islands from different guilds', () => {
    const grouped = groupIslandsBySourceGuild([
      island(1, 'Bank Island', { tenantId: 'g-alpha', name: 'Alpha' }),
      island(2, 'Bank Island', { tenantId: 'g-beta', name: 'Beta' }),
    ]);

    expect(grouped.flatMap((group) => group.items)).toHaveLength(2);
  });

  it('puts missing source fields in a trailing unknown group', () => {
    const grouped = groupIslandsBySourceGuild([
      island(2, 'Orphan'),
      island(1, 'Named', { tenantId: 'g-alpha', name: 'Alpha' }),
      island(3, 'Blank', { tenantId: '  ', name: '  ' }),
    ]);

    expect(grouped).toHaveLength(2);
    expect(grouped[0]?.sourceGuildName).toBe('Alpha');
    expect(grouped[1]?.sourceGuildTenantId).toBeNull();
    expect(grouped[1]?.sourceGuildName).toBeNull();
    expect(grouped[1]?.items.map((item) => item.id)).toEqual([3, 2]);
  });

  it('returns no sections for an empty list', () => {
    expect(groupIslandsBySourceGuild([])).toEqual([]);
  });
});
