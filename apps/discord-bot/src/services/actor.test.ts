import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ApiClient } from '../api/client.js';
import { actorApiFor } from './actor.js';

function recordingGuildApi(): { api: ApiClient; actorCalls: unknown[][] } {
  const actorCalls: unknown[][] = [];
  const api = {
    withDiscordActor(...args: unknown[]) {
      actorCalls.push(args);
      return api;
    },
  } as unknown as ApiClient;
  return { api, actorCalls };
}

function interaction(inGuild: boolean) {
  return {
    inGuild: () => inGuild,
    user: { id: '111', username: 'officer' },
    member: { roles: ['9', '8'] },
  };
}

describe('actorApiFor', () => {
  it('attaches the member id, role ids and username for a guild interaction', () => {
    const guild = recordingGuildApi();
    actorApiFor(interaction(true), guild.api);
    assert.deepEqual(guild.actorCalls, [['111', ['9', '8'], 'officer']]);
  });

  it('returns the plain guild client, with no actor claim, outside a guild', () => {
    const guild = recordingGuildApi();
    const returned = actorApiFor(interaction(false), guild.api);
    assert.equal(returned, guild.api);
    assert.deepEqual(guild.actorCalls, []);
  });
});
