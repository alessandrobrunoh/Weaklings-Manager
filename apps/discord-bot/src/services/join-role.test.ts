import assert from 'node:assert/strict';
import test from 'node:test';
import type { GuildMember } from 'discord.js';
import { assignJoinRole } from './join-role.js';

function member(opts: { bot?: boolean; hasRole?: boolean } = {}): GuildMember & { added: string[] } {
  const added: string[] = [];
  return {
    added,
    user: { bot: opts.bot ?? false },
    roles: {
      cache: { has: () => opts.hasRole ?? false },
      add: async (id: string) => {
        added.push(id);
      },
    },
  } as unknown as GuildMember & { added: string[] };
}

test('assignJoinRole skips bots', async () => {
  const target = member({ bot: true });
  await assignJoinRole(target, { discord_auto_role_id: '111' });
  assert.deepEqual(target.added, []);
});

test('assignJoinRole skips when no role is configured', async () => {
  const target = member();
  await assignJoinRole(target, { discord_auto_role_id: null });
  assert.deepEqual(target.added, []);
});

test('assignJoinRole assigns the configured role', async () => {
  const target = member();
  await assignJoinRole(target, { discord_auto_role_id: '222' });
  assert.deepEqual(target.added, ['222']);
});

test('assignJoinRole is a no-op when the member already has the role', async () => {
  const target = member({ hasRole: true });
  await assignJoinRole(target, { discord_auto_role_id: '222' });
  assert.deepEqual(target.added, []);
});
