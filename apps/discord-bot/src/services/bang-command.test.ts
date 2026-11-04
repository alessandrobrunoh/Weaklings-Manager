import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { Message } from 'discord.js';
import { ApiError, type ApiClient } from '../api/client.js';
import { commands } from '../commands/index.js';
import { forgetTenantStatus, type TenantStatus } from './tenant-gate.js';
import {
  ALLIANCE_GUILD_ONLY_MESSAGE,
} from './command-gate.js';
import {
  BangCommandInteractionAdapter,
  handleBangCommand,
  parseBangCommand,
  tokenizeArgs,
} from './bang-command.js';

let guildSeq = 0;
function nextGuildId(): string {
  guildSeq += 1;
  return `bang-test-${guildSeq}`;
}

afterEach(() => {
  for (let i = 1; i <= guildSeq; i += 1) {
    forgetTenantStatus(`bang-test-${i}`);
  }
});

function guildStatus(id: string): TenantStatus {
  return { id, registered: true, status: 'active', name: 'A Guild', kind: 'guild' };
}

function allianceStatus(id: string): TenantStatus {
  return { id, registered: true, status: 'active', name: 'Alliance Hub', kind: 'alliance' };
}

/** API stub shaped like the one in command-gate.test.ts. */
function stubApi(status: TenantStatus, accountError?: ApiError): ApiClient {
  const scoped = {
    guildId: status.id,
    async get(path: string) {
      if (path === 'api/users/me' && accountError) {
        throw accountError;
      }
      if (path === 'api/bank/balance') {
        return {
          pending_total: 0,
          pending_count: 0,
          requested_total: 0,
          requested_count: 0,
        };
      }
      return { linked: false };
    },
    withDiscordActor() {
      return scoped;
    },
  } as unknown as ApiClient;
  return {
    async get() {
      return status;
    },
    withGuild() {
      return scoped;
    },
  } as unknown as ApiClient;
}

interface SentMessage {
  id: string;
  edits: unknown[];
  edit(payload: unknown): Promise<SentMessage>;
}

function makeSentMessage(id: string): SentMessage {
  const sent: SentMessage = {
    id,
    edits: [],
    async edit(payload: unknown) {
      sent.edits.push(payload);
      return sent;
    },
  };
  return sent;
}

function stubMessage(content: string, guildId: string): Message & { sent: SentMessage[] } {
  const sent: SentMessage[] = [];
  return {
    content,
    author: { id: 'member-id', bot: false, username: 'tester', displayName: 'Tester' },
    guildId,
    channelId: 'channel-id',
    inGuild: () => true,
    mentions: { users: new Map() },
    member: { roles: { cache: new Map() } },
    guild: { preferredLocale: 'en-US', id: guildId },
    channel: { sendTyping: () => Promise.resolve() },
    client: {},
    sent,
    async reply(payload: unknown) {
      const s = makeSentMessage(`sent-${sent.length + 1}`);
      sent.push(s);
      (s as unknown as { payload: unknown }).payload = payload;
      return s;
    },
  } as unknown as Message & { sent: SentMessage[] };
}

describe('parseBangCommand', () => {
  it('parses name and whitespace-separated args', () => {
    assert.deepEqual(parseBangCommand('!event-join 42'), { name: 'event-join', args: ['42'] });
    assert.deepEqual(parseBangCommand('!events 2'), { name: 'events', args: ['2'] });
    assert.deepEqual(parseBangCommand('!BALANCE'), { name: 'balance', args: [] });
    assert.deepEqual(parseBangCommand('!balance   '), { name: 'balance', args: [] });
  });

  it('supports quoted multi-word args', () => {
    assert.deepEqual(parseBangCommand('!warn @u "too slow" high'), {
      name: 'warn',
      args: ['@u', 'too slow', 'high'],
    });
    assert.deepEqual(tokenizeArgs(`'a b' c "d'e"`), ['a b', 'c', "d'e"]);
  });

  it('ignores non-bang content, bare prefix, and glued punctuation', () => {
    assert.equal(parseBangCommand('/balance'), null);
    assert.equal(parseBangCommand('hi !balance'), null);
    assert.equal(parseBangCommand('!'), null);
    assert.equal(parseBangCommand('!!'), null);
    assert.equal(parseBangCommand('!balance!'), null);
  });
});

describe('handleBangCommand', () => {
  it('ignores bot authors, unknown names, and non-bang content without replying', async () => {
    const api = stubApi(guildStatus(nextGuildId()));
    const botMsg = stubMessage('!balance', nextGuildId());
    (botMsg.author as { bot: boolean }).bot = true;

    await handleBangCommand(botMsg, api, commands);
    await handleBangCommand(stubMessage('!definitely-not-a-command', nextGuildId()), api, commands);
    await handleBangCommand(stubMessage('just chatting', nextGuildId()), api, commands);

    assert.equal(botMsg.sent.length, 0);
  });

  it('end-to-end: !balance runs the real handler through every gate', async () => {
    const guildId = nextGuildId();
    const message = stubMessage('!balance', guildId);
    const api = stubApi(guildStatus(guildId));

    await handleBangCommand(message, api, commands);

    // deferReply sent nothing; the single visible message is balance's editReply.
    assert.equal(message.sent.length, 1);
    const payload = (message.sent[0] as unknown as { payload: Record<string, unknown> }).payload;
    assert.ok(!('flags' in payload), 'ephemeral flag must not leak into a message reply');
    const embeds = payload.embeds as Array<{ data: { title?: string } }>;
    assert.match(embeds[0].data.title ?? '', /Vault Balance — Tester/);
    const allowed = payload.allowedMentions as { users: string[] };
    assert.deepEqual(allowed.users, ['member-id']);
  });

  it('applies the alliance tenant gate to !warn', async () => {
    const guildId = nextGuildId();
    const message = stubMessage('!warn <@1> "reason" low', guildId);
    const api = stubApi(allianceStatus(guildId));

    await handleBangCommand(message, api, commands);

    assert.equal(message.sent.length, 1);
    const payload = (message.sent[0] as unknown as { payload: { embeds: Array<{ data: { description?: string } }> } }).payload;
    assert.equal(payload.embeds[0].data.description, ALLIANCE_GUILD_ONLY_MESSAGE);
  });

  it('prompts unregistered website users instead of running the command', async () => {
    const guildId = nextGuildId();
    const message = stubMessage('!balance', guildId);
    const api = stubApi(
      guildStatus(guildId),
      new ApiError(401, 'Discord user member-id has no linked account in this system.'),
    );

    await handleBangCommand(message, api, commands);

    assert.equal(message.sent.length, 1);
    const payload = (message.sent[0] as unknown as { payload: { embeds: Array<{ data: { title?: string } }> } }).payload;
    assert.match(payload.embeds[0].data.title ?? '', /Website Account Required/);
  });
});

describe('BangCommandInteractionAdapter', () => {
  it('fills options positionally, including subcommands and typed coercion', () => {
    const message = stubMessage('!ignored', 'g');
    const warn = commands.get('warn')!;
    const adapter = new BangCommandInteractionAdapter(
      message,
      warn,
      'warn',
      ['<@42>', 'too slow', 'low', '1.5', '7'],
    );
    assert.equal(adapter.options.getUser('user')?.id, '42');
    assert.equal(adapter.options.getString('reason'), 'too slow');
    assert.equal(adapter.options.getString('severity'), 'low');
    assert.equal(adapter.options.getNumber('multiplier'), 1.5);
    assert.equal(adapter.options.getInteger('days'), 7);

    const xp = commands.get('xp')!;
    const xpAdapter = new BangCommandInteractionAdapter(
      message,
      xp,
      'xp',
      ['add', '<@42>', '500', 'did great'],
    );
    assert.equal(xpAdapter.options.getSubcommand(), 'add');
    assert.equal(xpAdapter.options.getUser('user')?.id, '42');
    assert.equal(xpAdapter.options.getInteger('amount'), 500);
    assert.equal(xpAdapter.options.getString('reason'), 'did great');
  });

  it('ignores extra args beyond the declared options', () => {
    const message = stubMessage('!ignored', 'g');
    const events = commands.get('events')!;
    const adapter = new BangCommandInteractionAdapter(message, events, 'events', ['2', 'junk']);
    assert.equal(adapter.options.getInteger('page'), 2);
    assert.equal(adapter.options.getString('nope'), null);
  });
});
