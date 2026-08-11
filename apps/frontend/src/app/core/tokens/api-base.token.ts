import { InjectionToken } from '@angular/core';

/**
 * Base URL of the backend API. In dev this is proxied by the Angular dev server
 * (see `proxy.conf.json`). Override at runtime via `window.__API_BASE__`.
 */
export const API_BASE_URL = new InjectionToken<string>('API_BASE_URL', {
  providedIn: 'root',
  factory: () => {
    if (typeof window === 'undefined') {
      return '';
    }
    const w = window as unknown as Record<string, unknown>;
    const value = w['__API_BASE__'];
    return typeof value === 'string' ? value : '';
  },
});
