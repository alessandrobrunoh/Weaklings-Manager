import { HttpClient, HttpErrorResponse, HttpHeaders, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable, throwError } from 'rxjs';
import { catchError, map } from 'rxjs/operators';

import { API_BASE_URL } from '../tokens/api-base.token';
import type { ApiResponse, BlockingReference, ProblemDetails } from '../models/api.models';

/**
 * Generic typed HTTP client for the Albion Guild Manager backend.
 *
 * All backend JSON endpoints share the same `{ status, data }` envelope, so
 * this service unwraps it once and returns `T` directly to consumers. Endpoints
 * that bypass the envelope (OpenAlbion `categories` / `weapons/{id}/stats`)
 * should call `requestRaw` instead.
 *
 * Errors are normalized to an `ApiError` with a friendly `detail` extracted
 * from Problem Details, so feature pages can show one consistent message.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly problem?: ProblemDetails,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /**
   * The specific rows blocking a delete/update (e.g. events still using a
   * comp), when the backend returned them — `null` for every other error.
   * Callers that want a rich "here's what's in the way" dialog instead of a
   * plain toast should check this before falling back to `.message`.
   */
  blockingReferences(): BlockingReference[] | null {
    const params = this.problem?.invalid_params;
    if (!params || typeof params !== 'object' || !('blocking_references' in params)) {
      return null;
    }
    const refs = (params as { blocking_references: unknown }).blocking_references;
    return Array.isArray(refs) ? (refs as BlockingReference[]) : null;
  }
}

type QueryParams = Record<string, string | number | boolean | undefined | null>;

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(API_BASE_URL);

  /** GET unwrapping the standard envelope. */
  get<T>(path: string, params?: QueryParams): Observable<T> {
    return this.requestRaw<ApiResponse<T>>('GET', path, { params }).pipe(map((r) => r.data));
  }

  /** POST unwrapping the standard envelope. */
  post<T>(path: string, body: unknown | null = null): Observable<T> {
    return this.requestRaw<ApiResponse<T>>('POST', path, { body }).pipe(map((r) => r.data));
  }

  /** PATCH unwrapping the standard envelope. */
  patch<T>(path: string, body: unknown): Observable<T> {
    return this.requestRaw<ApiResponse<T>>('PATCH', path, { body }).pipe(map((r) => r.data));
  }

  /** PUT unwrapping the standard envelope. */
  put<T>(path: string, body: unknown): Observable<T> {
    return this.requestRaw<ApiResponse<T>>('PUT', path, { body }).pipe(map((r) => r.data));
  }

  /** DELETE unwrapping the standard envelope; returns `null` when body is empty. */
  delete<T>(path: string, body: unknown | null = null): Observable<T | void> {
    return this.requestRaw<ApiResponse<T> | void>('DELETE', path, { body }).pipe(
      map((r) => (r && (r as ApiResponse<T>).data) as T),
    );
  }

  /**
   * Raw HTTP call that bypasses envelope unwrapping. Use for endpoints that
   * return a bare array or object (e.g. OpenAlbion `categories`).
   */
  requestRaw<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    opts: { params?: QueryParams; body?: unknown | null; responseType?: 'json' } = {},
  ): Observable<T> {
    const url = this.buildUrl(path);
    const params = this.toHttpParams(opts.params);
    const headers = new HttpHeaders({ Accept: 'application/json' });
    const body = opts.body ?? undefined;

    return this.http
      .request<T>(method, url, {
        params,
        headers,
        body,
        withCredentials: true,
        responseType: opts.responseType ?? 'json',
      })
      .pipe(catchError((err: HttpErrorResponse) => throwError(() => this.normalize(err))));
  }

  private buildUrl(path: string): string {
    if (/^https?:\/\//i.test(path)) {
      return path;
    }
    const base = this.baseUrl.replace(/\/$/, '');
    const tail = path.startsWith('/') ? path : `/${path}`;
    return `${base}${tail}`;
  }

  private toHttpParams(params?: QueryParams): HttpParams {
    let httpParams = new HttpParams();
    if (!params) {
      return httpParams;
    }
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') {
        continue;
      }
      httpParams = httpParams.set(key, String(value));
    }
    return httpParams;
  }

  private normalize(err: HttpErrorResponse): ApiError {
    if (err.status === 0) {
      return new ApiError(0, 'Network error — is the backend reachable?');
    }
    const problem =
      err.error !== null && typeof err.error === 'object'
        ? (err.error as ProblemDetails)
        : undefined;
    return new ApiError(err.status, problemMessage(err, problem), problem);
  }
}

/**
 * Human-readable message for a failed response.
 *
 * Prefers the backend's Problem Details `detail`. Anything else (an HTML error
 * page from a proxy, an empty 502/503/504 body, Angular's "Http failure
 * response for ..." text) is replaced by a short status message instead of
 * leaking raw markup or a URL into a toast.
 */
function problemMessage(err: HttpErrorResponse, problem: ProblemDetails | undefined): string {
  if (typeof problem?.detail === 'string' && problem.detail.length > 0) {
    return problem.detail;
  }
  if (typeof err.error === 'string') {
    const text = err.error.trim();
    if (text.length > 0 && text.length <= 300 && !text.startsWith('<')) {
      return text;
    }
  }
  return err.status >= 500
    ? `The server had a problem (error ${err.status}). Try again in a moment.`
    : `The request failed (error ${err.status}).`;
}
