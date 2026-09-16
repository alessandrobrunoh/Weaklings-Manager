import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { ChatInputCommandInteraction } from 'discord.js';
import type { ApiClient } from '../api/client.js';
import type { BotCommand } from '../commands/index.js';
import {
  ALLIANCE_ALLOWED_COMMANDS,
  ALLIANCE_GUILD_ONLY_MESSAGE,
  executeSlashCommand,
  isCommandAllowedOnTenant,
} from './command-gate.js';
import { forgetTenantStatus, type TenantStatus } from './tenant-gate.js';

const ALLIANCE_COMMANDS = [
  'register',
  'balance',
  'balance-request',
  'events',
  'event-join',
  'event-leave',
  'me',
  'player',
] as const;

const GUILD_ONLY_COMMANDS = [
  'warn',
  'unwarn',
  'warns',
  'vod',
  'applications-panel',
  'battles',
  'users',
  'link',
  'roster',
  'rank',
  'leaderboard',
  'xp',
  'event-create',
  'event-start',
  'event-stop',
  'event-roster',
] as const;

let guildSeq = 0;

function nextGuildId(): string {
  guildSeq += 1;
  return `alliance-gate-${guildSeq}`;
}

afterEach(() => {
  for (let i = 1; i <= guildSeq; i += 1) {
    forgetTenantStatus(`alliance-gate-${i}`);
  }
});

function stubApi(status: TenantStatus): ApiClient {
  const scoped = { guildId: status.id } as ApiClient;
  return {
    async get() {
      return status;
    },
    withGuild() {
      return scoped;
    },
  } as unknown as ApiClient;
}

function stubInteraction(opts: {
  commandName: string;
  guildId?: string | null;
}): ChatInputCommandInteraction & { replies: unknown[] } {
  const replies: unknown[] = [];
  return {
    commandName: opts.commandName,
    guildId: opts.guildId === undefined ? nextGuildId() : opts.guildId,
    replied: false,
    deferred: false,
    replies,
    async reply(payload: unknown) {
      replies.push(payload);
    },
  } as unknown as ChatInputCommandInteraction & { replies: unknown[] };
}

function stubCommand(): BotCommand & { calls: ApiClient[] } {
  const calls: ApiClient[] = [];
  return {
    data: { name: 'stub' } as BotCommand['data'],
    calls,
    async execute(_interaction, api) {
      calls.push(api);
    },
  };
}

function allianceStatus(id: string): TenantStatus {
  return { id, registered: true, status: 'active', name: 'Alliance Hub', kind: 'alliance' };
}

function guildStatus(id: string): TenantStatus {
  return { id, registered: true, status: 'active', name: 'A Guild', kind: 'guild' };
}

describe('isCommandAllowedOnTenant', () => {
  it('allows the alliance hub commands and rejects guild-only ones', () => {
    assert.deepEqual([...ALLIANCE_ALLOWED_COMMANDS].sort(), [...ALLIANCE_COMMANDS].sort());
    for (const name of ALLIANCE_COMMANDS) {
      assert.equal(isCommandAllowedOnTenant(name, 'alliance'), true, name);
    }
    for (const name of GUILD_ONLY_COMMANDS) {
      assert.equal(isCommandAllowedOnTenant(name, 'alliance'), false, name);
    }
  });

  it('allows every command on a guild tenant, including when kind is missing', () => {
    for (const name of [...ALLIANCE_COMMANDS, ...GUILD_ONLY_COMMANDS]) {
      assert.equal(isCommandAllowedOnTenant(name, 'guild'), true, name);
      assert.equal(isCommandAllowedOnTenant(name, undefined), true, name);
    }
  });
});

describe('executeSlashCommand', () => {
  it('rejects /warn on an alliance Discord with a clear ephemeral', async () => {
    const interaction = stubInteraction({ commandName: 'warn' });
    const command = stubCommand();
    const api = stubApi(allianceStatus(interaction.guildId!));

    await executeSlashCommand(interaction, api, command);

    assert.equal(command.calls.length, 0);
    assert.equal(interaction.replies.length, 1);
    const payload = interaction.replies[0] as {
      embeds: Array<{ data: { description?: string } }>;
      flags: string[];
    };
    assert.equal(payload.embeds[0].data.description, ALLIANCE_GUILD_ONLY_MESSAGE);
    assert.equal(ALLIANCE_GUILD_ONLY_MESSAGE, 'This command is only available on a guild Discord.');
    assert.deepEqual(payload.flags, ['Ephemeral']);
  });

  it('still runs /register and /balance on an alliance Discord', async () => {
    for (const name of ['register', 'balance'] as const) {
      const interaction = stubInteraction({ commandName: name });
      const command = stubCommand();
      const status = allianceStatus(interaction.guildId!);
      const api = stubApi(status);

      await executeSlashCommand(interaction, api, command);

      assert.equal(command.calls.length, 1, name);
      assert.equal(command.calls[0].guildId, status.id, name);
      assert.equal(interaction.replies.length, 0, name);
    }
  });

  it('still runs /warn on a guild Discord', async () => {
    const interaction = stubInteraction({ commandName: 'warn' });
    const command = stubCommand();
    const api = stubApi(guildStatus(interaction.guildId!));

    await executeSlashCommand(interaction, api, command);

    assert.equal(command.calls.length, 1);
    assert.equal(interaction.replies.length, 0);
  });
});
