import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { registrationLink } from './tenant-gate.js';

describe('registrationLink', () => {
  it('prefers the backend register_url', () => {
    assert.equal(
      registrationLink(
        {
          id: '1',
          registered: false,
          register_url: 'http://localhost:5173/register-tenant?guild=1',
        },
        'http://example.com',
        '1',
      ),
      'http://localhost:5173/register-tenant?guild=1',
    );
  });

  it('falls back to FRONTEND_URL', () => {
    assert.equal(
      registrationLink({ id: '99', registered: false }, 'http://localhost:5173/', '99'),
      'http://localhost:5173/register-tenant?guild=99',
    );
  });
});
