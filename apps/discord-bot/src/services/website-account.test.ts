import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { ApiClient } from '../api/client.js';
import { ApiError } from '../api/client.js';
import {
  clearWebsiteRegistrationCache,
  buildWebsiteAccountRequiredReply,
  isWebsiteUserRegistered,
  isUnregisteredWebsiteUserError,
} from './website-account.js';

describe('website account gate', () => {
  beforeEach(() => clearWebsiteRegistrationCache());

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

  it('reuses a positive answer but always re-checks an unregistered user', async () => {
    let calls = 0;
    let registered = false;
    const api = {
      async get() {
        calls += 1;
        if (!registered) {
          throw new ApiError(401, 'Discord user 9 has no linked account in this system.');
        }
        return {};
      },
    } as unknown as ApiClient;

    assert.equal(await isWebsiteUserRegistered(api, '9'), false);
    assert.equal(await isWebsiteUserRegistered(api, '9'), false);
    assert.equal(calls, 2, 'a negative answer is never cached');

    registered = true;
    assert.equal(await isWebsiteUserRegistered(api, '9'), true);
    assert.equal(await isWebsiteUserRegistered(api, '9'), true);
    assert.equal(calls, 3, 'a positive answer is served from cache');
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
