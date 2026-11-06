import { describe, expect, it } from 'vitest';

import { isSameOriginPath } from './same-origin-path';

describe('isSameOriginPath', () => {
  it.each(['/', '/dashboard', '/events/12?tab=battles', '/%2F%2Fevil.example'])(
    'accepts the same-origin path %s',
    (value) => {
      expect(isSameOriginPath(value)).toBe(true);
    },
  );

  it.each([
    '//evil.example',
    '///evil.example',
    '/\\evil.example',
    '\\\\evil.example',
    'https://evil.example',
    'evil.example',
    'javascript:alert(1)',
    '/dashboard\r\nSet-Cookie: x=1',
    '/dashboard\\x',
    '',
    null,
    undefined,
  ])('rejects %j', (value) => {
    expect(isSameOriginPath(value)).toBe(false);
  });
});
