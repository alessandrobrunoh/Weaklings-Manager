import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { PLATFORM_ID, inject } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';

import { API_BASE_URL } from '../tokens/api-base.token';
import { AuthService } from '../services/auth.service';

/**
 * Sends a member an officer blocked to the "access blocked" screen.
 *
 * The backend answers every authenticated request of a blocked member with
 * `403` and the problem code `account_blocked`, also on a live session. This
 * interceptor turns that into a dedicated screen instead of a generic error toast per click:
 * the local profile is dropped (`AuthService.markBlocked`) and the router goes to `/blocked`.
 *
 * Deliberately narrow:
 *  - only backend API calls are considered;
 *  - the `GET api/auth/me` session probe is left to `AuthService` and the route guards, which
 *    reach `/blocked` on their own (navigating from here during boot would race them);
 *  - the browser only: a server render never navigates from an interceptor.
 *
 * The original error is always re-thrown so `ApiService` still normalizes it for the caller.
 */
export const accessBlockedInterceptor: HttpInterceptorFn = (req, next) => {
  const baseUrl = inject(API_BASE_URL);
  const auth = inject(AuthService);
  const router = inject(Router);
  const isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  return next(req).pipe(
    catchError((err: unknown) => {
      if (
        isBrowser &&
        err instanceof HttpErrorResponse &&
        err.status === 403 &&
        isBackendCall(req.url, baseUrl) &&
        !isSessionProbe(req.url) &&
        isAccountBlocked(err)
      ) {
        auth.markBlocked();
        if (router.url !== '/blocked') {
          void router.navigate(['/blocked']);
        }
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

function isSessionProbe(url: string): boolean {
  return /\/api\/auth\/me$/.test(url.split('?')[0]);
}

function isAccountBlocked(err: HttpErrorResponse): boolean {
  const body: unknown = err.error;
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { code?: unknown }).code === 'account_blocked'
  );
}
