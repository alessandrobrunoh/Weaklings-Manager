import { describe, expect, it } from 'vitest';

import { clientDisconnectCode } from './client-disconnect';

describe('clientDisconnectCode', () => {
  it('recognizes the codes a client abort produces', () => {
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    expect(clientDisconnectCode(reset)).toBe('ECONNRESET');
    expect(clientDisconnectCode({ code: 'ECONNABORTED' })).toBe('ECONNABORTED');
    expect(clientDisconnectCode({ code: 'EPIPE' })).toBe('EPIPE');
  });

  it('leaves genuine failures to crash the process', () => {
    expect(clientDisconnectCode(new TypeError('x is not a function'))).toBeNull();
    expect(clientDisconnectCode({ code: 'ECONNREFUSED' })).toBeNull();
    expect(clientDisconnectCode('ECONNRESET')).toBeNull();
    expect(clientDisconnectCode(null)).toBeNull();
    expect(clientDisconnectCode(undefined)).toBeNull();
  });
});
