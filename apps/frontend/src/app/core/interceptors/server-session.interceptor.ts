import type { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';

import { SERVER_REQUEST_CONTEXT } from '../tokens/server-request.token';
import { API_BASE_URL } from '../tokens/api-base.token';

/**
 * Forwards the browser's session cookie to the backend during SSR.
 *
 * The session is an http-only cookie set by the backend, and the browser never
 * sends it to the frontend server's render on the browser's behalf. Without
 * this, every server-side probe of `api/auth/me` is anonymous and the server
 * renders the signed-out shell. The cookie is attached only to requests that
 * go to the configured backend, never to third-party URLs, and it is a no-op in
 * the browser, where `SERVER_REQUEST_CONTEXT` is not provided.
 */
export const serverSessionInterceptor: HttpInterceptorFn = (req, next) => {
  const context = inject(SERVER_REQUEST_CONTEXT);
  const baseUrl = inject(API_BASE_URL).replace(/\/$/, '');

  if (!context?.cookie || !isBackendUrl(req.url, baseUrl)) {
    return next(req);
  }
  return next(req.clone({ setHeaders: { Cookie: context.cookie } }));
};

function isBackendUrl(url: string, baseUrl: string): boolean {
  if (!/^https?:\/\//i.test(url)) {
    return true;
  }
  return baseUrl !== '' && url.startsWith(`${baseUrl}/`);
}
