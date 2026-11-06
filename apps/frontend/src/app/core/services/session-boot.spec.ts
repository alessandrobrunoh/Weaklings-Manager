import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthService } from './auth.service';
import { bootSessionProbe } from './session-boot';

function authWith(load: () => Promise<unknown>): Pick<AuthService, 'load'> {
  return { load } as Pick<AuthService, 'load'>;
}

describe('bootSessionProbe', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops waiting on a hung backend in the browser after the bound', async () => {
    const auth = authWith(() => new Promise(() => undefined));
    const booted = vi.fn();

    void bootSessionProbe(auth, false, 3000).then(booted);

    await vi.advanceTimersByTimeAsync(2999);
    expect(booted).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(booted).toHaveBeenCalledOnce();
  });

  it('keeps waiting on the server, where the render needs the answer', async () => {
    const auth = authWith(() => new Promise(() => undefined));
    const booted = vi.fn();

    void bootSessionProbe(auth, true, 3000).then(booted);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(booted).not.toHaveBeenCalled();
  });

  it('resolves as soon as the probe answers and leaves no timer behind', async () => {
    const load = vi.fn().mockResolvedValue({ id: 'u1' });

    await bootSessionProbe(authWith(load), false, 3000);

    expect(load).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
