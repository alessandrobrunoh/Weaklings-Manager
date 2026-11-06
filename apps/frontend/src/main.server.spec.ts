import type { IncomingMessage, ServerResponse } from 'node:http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Angular build sets `ngServerMode` for the server bundle; under Vitest
// nothing does, so client-only hydration code (event replay) would run here.
vi.hoisted(() => {
  (globalThis as { ngServerMode?: boolean }).ngServerMode = true;
});

import render, { type AnalogServerContext } from './main.server';

/**
 * Server render through Analog's entry point, against a stubbed backend.
 *
 * The backend answers `api/auth/me` with a profile only when the request
 * carries the session cookie, the same way the Rust `UserContext` extractor
 * does. Anything else is treated as a 404 so child components fail quietly.
 */

const BACKEND = 'http://backend.test';
const SESSION_COOKIE = 'session=abc';
const profile = {
  id: 'u1',
  username: 'ada',
  user_id: 1,
  avatar: null,
  email: null,
  roles: [],
  highest_role: null,
  is_superadmin: false,
  is_platform_admin: false,
  permissions: [],
  tenant_id: 'g1',
  tenant_name: 'Guild',
  tenant_kind: 'guild',
} as never;

const DOCUMENT = '<!doctype html><html><head></head><body><app-root></app-root></body></html>';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeContext(cookie?: string): AnalogServerContext & {
  res: { statusCode: number; setHeader: ReturnType<typeof vi.fn> };
} {
  const res = { statusCode: 200, setHeader: vi.fn() };
  const req = { headers: cookie ? { cookie } : {} } as unknown as IncomingMessage;
  return { req, res: res as unknown as ServerResponse } as AnalogServerContext & {
    res: { statusCode: number; setHeader: ReturnType<typeof vi.fn> };
  };
}

describe('server render', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let previousBackend: string | undefined;

  beforeEach(() => {
    previousBackend = process.env['BACKEND_INTERNAL_URL'];
    process.env['BACKEND_INTERNAL_URL'] = `${BACKEND}/`;
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      if (url === `${BACKEND}/api/auth/me`) {
        return headers.get('cookie') === SESSION_COOKIE
          ? json(200, { status: 'ok', data: profile })
          : json(401, { status: 'error', detail: 'No active session' });
      }
      return json(404, { status: 'error', detail: 'not stubbed' });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (previousBackend === undefined) {
      delete process.env['BACKEND_INTERNAL_URL'];
    } else {
      process.env['BACKEND_INTERNAL_URL'] = previousBackend;
    }
  });

  it('forwards the session cookie and renders the authenticated shell', async () => {
    const context = fakeContext(SESSION_COOKIE);

    const html = await render('/dashboard', DOCUMENT, context);

    expect(html).toContain('<app-shell');
    expect(html).not.toContain('/login');
    const probe = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/api/auth/me'));
    expect(probe).toBeDefined();
    expect(new Headers((probe?.[1] as RequestInit).headers).get('cookie')).toBe(SESSION_COOKIE);
    // The probe result travels to the browser, which then skips its own probe.
    expect(html).toContain('auth.session');
    expect(html).toContain('"username":"ada"');
    expect(context.res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(context.res.statusCode).toBe(200);
  });

  it('answers a guarded route without a session with one redirect to login', async () => {
    const context = fakeContext();

    const html = await render('/dashboard', DOCUMENT, context);

    expect(html).toBe('');
    expect(context.res.statusCode).toBe(302);
    expect(context.res.setHeader).toHaveBeenCalledWith(
      'Location',
      expect.stringMatching(/^\/login\?next=/),
    );
    expect(context.res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    const probes = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/api/auth/me'));
    expect(probes).toHaveLength(1);
  });

  it('renders the login page directly when the public route is requested without a session', async () => {
    const context = fakeContext();

    const html = await render('/login', DOCUMENT, context);

    expect(html).toContain('<app-root');
    expect(context.res.statusCode).toBe(200);
  });
});
