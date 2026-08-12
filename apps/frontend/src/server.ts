import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express, { type NextFunction, type Request, type Response } from 'express';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const browserDistFolder = join(import.meta.dirname, '../browser');
type StreamingRequestInit = RequestInit & { duplex?: 'half' };

const backendProxyTarget = process.env['API_REWRITE_URL'];

const app = express();
const angularApp = new AngularNodeAppEngine();

/**
 * Server-side API gateway for SSR requests.
 *
 * Relative `/api` calls made during Angular rendering must reach the backend
 * service, not this frontend server. Without this handoff, SSR recursively
 * renders itself until the Node heap is exhausted.
 *
 * Side effects: performs network I/O and streams backend responses to the
 * original client. Safe to call concurrently because it stores no request state.
 *
 * @example
 * ```ts
 * app.use('/api', proxyBackendRequest);
 * ```
 */
async function proxyBackendRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!backendProxyTarget) {
    res.status(502).json({ error: 'API_REWRITE_URL is not configured.' });
    return;
  }

  try {
    const upstreamUrl = new URL(req.originalUrl, backendProxyTarget);
    const upstreamResponse = await fetch(upstreamUrl, createProxyRequest(req));
    writeProxyResponse(upstreamResponse, res);
  } catch (error) {
    next(error);
  }
}

/**
 * Fetch-compatible request options for forwarding Express requests.
 *
 * Node fetch requires `duplex: 'half'` when a streamed request body is present,
 * while GET and HEAD must not include a body. The original host header is also
 * removed so the backend receives the target service host.
 *
 * @example
 * ```ts
 * const init = createProxyRequest(req);
 * await fetch('http://backend:3000/api/auth/me', init);
 * ```
 */
function createProxyRequest(req: Request): StreamingRequestInit {
  const headers = new Headers(req.headers as Record<string, string>);
  headers.delete('host');

  if (req.method === 'GET' || req.method === 'HEAD') {
    return { headers, method: req.method };
  }

  return {
    body: req as unknown as BodyInit,
    duplex: 'half',
    headers,
    method: req.method,
  };
}

/**
 * Streams backend responses without buffering large payloads in memory.
 *
 * Headers are copied before the body starts so cookies, redirects, and content
 * types remain backend-owned. If the backend returns no body, the response ends
 * immediately.
 *
 * @example
 * ```ts
 * const response = await fetch('http://backend:3000/api/auth/me');
 * writeProxyResponse(response, res);
 * ```
 */
function writeProxyResponse(upstreamResponse: globalThis.Response, res: Response): void {
  res.status(upstreamResponse.status);

  upstreamResponse.headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();

    if (lowerKey === 'content-encoding' || lowerKey === 'content-length') {
      return;
    }

    res.setHeader(key, value);
  });

  if (!upstreamResponse.body) {
    res.end();
    return;
  }

  const upstreamBody =
    upstreamResponse.body as unknown as Parameters<typeof Readable.fromWeb>[0];

  Readable.fromWeb(upstreamBody).pipe(res);
}

/**
 * Example Express Rest API endpoints can be defined here.
 * Uncomment and define endpoints as necessary.
 *
 * Example:
 * ```ts
 * app.get('/api/{*splat}', (req, res) => {
 *   // Handle API request
 * });
 * ```
 */

app.use('/api', proxyBackendRequest);
app.use('/scalar', proxyBackendRequest);

/**
 * Serve static files from /browser
 */
app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false,
  }),
);

/**
 * Handle all other requests by rendering the Angular application.
 */
app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) => (response ? writeResponseToNodeResponse(response, res) : next()))
    .catch(next);
});

/**
 * Start the server if this module is the main entry point, or it is ran via PM2.
 * The server listens on the port defined by the `PORT` environment variable, or defaults to 4000.
 */
if (isMainModule(import.meta.url) || process.env['pm_id']) {
  const port = process.env['PORT'] || 4000;
  app.listen(port, (error) => {
    if (error) {
      throw error;
    }

    console.log(`Node Express server listening on http://localhost:${port}`);
  });
}

/**
 * Request handler used by the Angular CLI (for dev-server and during build) or Firebase Cloud Functions.
 */
export const reqHandler = createNodeRequestHandler(app);
