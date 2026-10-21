import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ApiClient } from '../api/client.js';
import { ApiError } from '../api/client.js';
import {
  buildWebsiteAccountRequiredReply,
  isWebsiteUserRegistered,
  isUnregisteredWebsiteUserError,
} from './website-account.js';

describe('website account gate', () => {
  it('recognizes only the backend error for a Discord account without a website user', () => {
    assert.equal(
      isUnregisteredWebsiteUserError(
        new ApiError(401, 'Discord user 123 has no linked account in this system.'),
      ),
      true,
    );
    assert.equal(isUnregisteredWebsiteUserError(new ApiError(401, 'Invalid bot secret')), false);
    assert.equal(
      isUnregisteredWebsiteUserError(new ApiError(403, 'has no linked account in this system')),
      false,
    );
  });

  it('checks the local website profile for the given Discord user', async () => {
    const paths: string[] = [];
    const api = {
      async get(path: string, discordId?: string) {
        paths.push(`${path}:${discordId}`);
        return { linked: false };
      },
    } as unknown as ApiClient;

    assert.equal(await isWebsiteUserRegistered(api, 'discord-user'), true);
    assert.deepEqual(paths, ['api/users/me:discord-user']);
  });

  it('returns false for an unregistered Discord account and rethrows other failures', async () => {
    const api = {
      async get() {
        throw new ApiError(401, 'Discord user 123 has no linked account in this system.');
      },
    } as unknown as ApiClient;
    assert.equal(await isWebsiteUserRegistered(api, '123'), false);

    const unavailable = new ApiError(401, 'Invalid bot secret');
    const unavailableApi = {
      async get() {
        throw unavailable;
      },
    } as unknown as ApiClient;
    await assert.rejects(isWebsiteUserRegistered(unavailableApi, '123'), unavailable);
  });

  it('provides a login button and a clear next step', () => {
    const reply = buildWebsiteAccountRequiredReply();
    const button = reply.components[0].toJSON().components[0] as unknown as {
      label?: string;
      url?: string;
    };

    assert.match(reply.embeds[0].data.description ?? '', /not registered with Weaklings Manager/);
    assert.equal(button.label, 'Link your account');
    assert.equal(button.url, 'http://localhost:5173/login');
  });
});
