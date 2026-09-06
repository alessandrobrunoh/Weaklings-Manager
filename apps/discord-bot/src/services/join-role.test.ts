import assert from 'node:assert/strict';
import test from 'node:test';
import type { GuildMember } from 'discord.js';
import { assignJoinRole } from './join-role.js';

function member(
  opts: { bot?: boolean; roles?: string[]; failOn?: string[] } = {},
): GuildMember & { added: string[] } {
  const added: string[] = [];
  const held = new Set(opts.roles ?? []);
  const failOn = new Set(opts.failOn ?? []);
  return {
    added,
    user: { bot: opts.bot ?? false },
    roles: {
      cache: { has: (id: string) => held.has(id) },
      add: async (id: string) => {
        if (failOn.has(id)) {
          throw new Error(`cannot assign ${id}`);
        }
        added.push(id);
        held.add(id);
      },
    },
  } as unknown as GuildMember & { added: string[] };
}

test('assignJoinRole skips bots', async () => {
  const target = member({ bot: true });
  await assignJoinRole(target, {
    discord_auto_role_id: '111',
  });
  assert.deepEqual(target.added, []);
});

test('assignJoinRole skips when no role is configured', async () => {
  const target = member();
  await assignJoinRole(target, {
    discord_auto_role_id: null,
  });
  assert.deepEqual(target.added, []);
});

test('assignJoinRole assigns the configured auto role', async () => {
  const target = member();
  await assignJoinRole(target, {
    discord_auto_role_id: '222',
  });
  assert.deepEqual(target.added, ['222']);
});

test('assignJoinRole is a no-op when the member already has the role', async () => {
  const target = member({ roles: ['222'] });
  await assignJoinRole(target, {
    discord_auto_role_id: '222',
  });
  assert.deepEqual(target.added, []);
});

test('assignJoinRole logs a warning when Discord rejects a role', async () => {
  const target = member({ failOn: ['111'] });
  const warnings: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    await assignJoinRole(target, {
      discord_auto_role_id: '111',
    });
  } finally {
    console.warn = original;
  }
  assert.deepEqual(target.added, []);
  assert.equal(warnings.length, 1);
});
