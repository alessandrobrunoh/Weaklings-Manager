import { inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { ApiService } from './api.service';
import { API_BASE_URL } from '../tokens/api-base.token';
import type { DiscordUserProfile, PermissionKey } from '../models/api.models';

/**
 * Session-aware authentication service.
 *
 * Holds the current user profile in a signal; pages can reactively show/hide
 * UI based on `isAuthenticated`. The actual session cookie is set by the
 * backend's Discord OAuth callback, so this service only reads `/api/auth/me`.
 *
 * Side effects:
 *  - On `load()`, an HTTP call is made to `/api/auth/me`; failures set the
 *    profile to `null` (treated as "not logged in") rather than throwing, so
 *    the auth guard can route unauthenticated users to the login page.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly api = inject(ApiService);
  private readonly apiBaseUrl = inject(API_BASE_URL);

  private readonly _profile = signal<DiscordUserProfile | null>(null);
  private readonly _loading = signal(false);
  private loadPromise: Promise<DiscordUserProfile | null> | null = null;

  /** Current user profile, or `null` when not authenticated. */
  readonly profile = this._profile.asReadonly();

  /** True while the initial profile probe is in flight. */
  readonly loading = this._loading.asReadonly();

  /** Reactive flag derived from the presence of a profile. */
  readonly isAuthenticated = signal(false);

  /** Trigger the Discord OAuth login flow (full-page redirect). */
  login(): void {
    if (typeof window === 'undefined') {
      return;
    }
    window.location.href = this.buildBrowserUrl('api/auth/discord/login');
  }

  /** Clear the session cookie via the backend and reset local state. */
  async logout(): Promise<void> {
    try {
      await firstValueFrom(this.api.post<void>('api/auth/logout', null));
    } catch {
      // Even if the call fails, drop local state — the cookie will expire.
    }
    this.setProfile(null);
  }

  /**
   * Probe the current session.
   *
   * Designed to be called once on app bootstrap. A 401 is treated as
   * "no session" and resolved to `null` rather than rejecting.
   */
  async load(): Promise<DiscordUserProfile | null> {
    if (this.loadPromise) {
      return this.loadPromise;
    }

    this._loading.set(true);
    this.loadPromise = this.fetchProfile();

    try {
      return await this.loadPromise;
    } finally {
      this.loadPromise = null;
      this._loading.set(false);
    }
  }

  /** Update local session state without a backend round-trip. */
  setProfile(profile: DiscordUserProfile | null): void {
    this._profile.set(profile);
    this.isAuthenticated.set(profile !== null);
  }

  /** True when route-level visibility still needs legacy role gating. */
  hasRole(...roles: DiscordUserProfile['highest_role'][]): boolean {
    const profile = this._profile();
    if (!profile) {
      return false;
    }
    if (profile.is_superadmin) {
      return true;
    }

    return (
      roles.includes(profile.highest_role) || profile.roles.some((role) => roles.includes(role))
    );
  }

  /** True when the backend grants the requested capability to this session. */
  hasPermission(permission: PermissionKey): boolean {
    const profile = this._profile();
    if (!profile) {
      return false;
    }
    if (profile.is_superadmin) {
      return true;
    }

    return profile.permissions.includes(permission);
  }

  private async fetchProfile(): Promise<DiscordUserProfile | null> {
    try {
      const profile = await firstValueFrom(this.api.get<DiscordUserProfile>('api/auth/me'));
      this.setProfile(profile ?? null);
      return profile ?? null;
    } catch {
      this.setProfile(null);
      return null;
    }
  }

  private buildBrowserUrl(path: string): string {
    const base = this.apiBaseUrl.replace(/\/$/, '');
    const tail = path.startsWith('/') ? path : `/${path}`;
    return `${base}${tail}`;
  }
}
