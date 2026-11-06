import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';

import { API_BASE_URL } from '../tokens/api-base.token';
import { AuthService } from '../services/auth.service';
import { ToastService } from '../services/toast.service';
import { TranslateService } from '../services/translate.service';

/**
 * Handles a backend 401 that arrives while the user is signed in.
 *
 * Without it an expired session (or a revoked one) only produced a failing
 * toast per click on a shell that still looked alive. On such a 401 the local
 * profile is cleared and the user is sent to `/login`, keeping the current
 * URL as `next`.
 *
 * Deliberately narrow:
 *  - only requests to the backend API are considered (third-party calls such
 *    as OpenAlbion can answer 401 for unrelated reasons);
 *  - `api/auth/*` is left to `AuthService`, which already interprets 401/403
 *    from the session probe, logout and the tenant pickers;
 *  - nothing happens when no profile is loaded, so a signed-out user and the
 *    burst of parallel 401s after the first one cannot cause a redirect loop;
 *  - the 401 must carry the backend's session-missing detail ("No active
 *    session" / "Invalid session cookie format"). Other 401s (a feature
 *    refusing a request for its own reasons) leave the session alone;
 *  - 403 is passed through untouched: it usually means "not allowed to do
 *    this", not "no session", so it must not sign the user out.
 *
 * The original error is always re-thrown so `ApiService` still normalizes it
 * for the calling page.
 */
export const sessionExpiryInterceptor: HttpInterceptorFn = (req, next) => {
  const baseUrl = inject(API_BASE_URL);
  const auth = inject(AuthService);
  const router = inject(Router);
  const toasts = inject(ToastService);
  const translate = inject(TranslateService);

  return next(req).pipe(
    catchError((err: unknown) => {
      if (
        err instanceof HttpErrorResponse &&
        err.status === 401 &&
        isBackendCall(req.url, baseUrl) &&
        !isAuthEndpoint(req.url) &&
        isSessionMissing(err) &&
        auth.profile() !== null
      ) {
        auth.setProfile(null);
        toasts.error(translate.t('auth.session_expired'));
        const current = router.url;
        const onLogin = current === '/login' || current.startsWith('/login?');
        void router.navigate(['/login'], {
          queryParams: current && !onLogin ? { next: current } : {},
        });
      }
      return throwError(() => err);
    }),
  );
};

function isBackendCall(url: string, baseUrl: string): boolean {
  if (!/^https?:\/\//i.test(url)) {
    return true;
  }
  return baseUrl !== '' && url.startsWith(baseUrl.replace(/\/$/, '') + '/');
}

function isAuthEndpoint(url: string): boolean {
  return /\/api\/auth\//.test(url.split('?')[0]);
}

/**
 * True when the Problem Details body says the request carried no usable
 * session cookie (see the `UserContext` extractor in the backend).
 */
function isSessionMissing(err: HttpErrorResponse): boolean {
  const body: unknown = err.error;
  const detail =
    typeof body === 'object' && body !== null ? (body as { detail?: unknown }).detail : undefined;
  return (
    typeof detail === 'string' &&
    (detail.startsWith('No active session') || detail.startsWith('Invalid session cookie'))
  );
}
