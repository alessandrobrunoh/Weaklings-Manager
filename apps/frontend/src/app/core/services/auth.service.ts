import {
  inject,
  Injectable,
  makeStateKey,
  PLATFORM_ID,
  signal,
  TransferState,
} from '@angular/core';
import { isPlatformBrowser, isPlatformServer } from '@angular/common';
import { firstValueFrom } from 'rxjs';

import { ApiError, ApiService } from './api.service';
import { API_BASE_URL } from '../tokens/api-base.token';
import type {
  BotInvite,
  DiscordUserProfile,
  RegisterableGuild,
  TenantChoice,
} from '../models/api.models';

/**
 * Session probe result carried from the server render to the browser.
 *
 * `sessionUnreachable` is the probe's failure flag, so a backend blip during
 * SSR shows the same state after hydration instead of flipping it.
 */
export interface TransferredSession {
  readonly profile: DiscordUserProfile | null;
  readonly sessionUnreachable: boolean;
}

/** `TransferState` key under which the server stores its session probe. */
export const SESSION_STATE_KEY = makeStateKey<TransferredSession>('auth.session');

/**
 * Session-aware authentication service.
 *
 * Holds the current user profile in a signal; pages can reactively show/hide
 * UI based on `isAuthenticated`. The actual session cookie is set by the
 * backend's Discord OAuth callback, so this service only reads `/api/auth/me`.
 *
 * Side effects:
 *  - On `load()`, an HTTP call is made to `/api/auth/me`. A 401 or 403 means
 *    there is no session. Other failures leave the last known profile in place
 *    and set `sessionUnreachable`, so a blip is not treated as a logout.
 *  - The probe runs on the server too (with the browser's cookie forwarded by
 *    `serverSessionInterceptor`). Its result is stored in `TransferState`, and
 *    the browser reuses it at hydration instead of probing again, so the
 *    hydrated shell is the one the server rendered.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly api = inject(ApiService);
  private readonly apiBaseUrl = inject(API_BASE_URL);
  private readonly transferState = inject(TransferState);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly isBrowser = isPlatformBrowser(this.platformId);
  private serverProbe: Promise<TransferredSession> | null = null;

  private readonly _profile = signal<DiscordUserProfile | null>(null);
  private readonly _loading = signal(false);
  private loadPromise: Promise<DiscordUserProfile | null> | null = null;

  /** Current user profile, or `null` when not authenticated. */
  readonly profile = this._profile.asReadonly();

  /** True while the initial profile probe is in flight. */
  readonly loading = this._loading.asReadonly();

  /**
   * True when the last `/auth/me` probe failed for a reason other than
   * "not signed in" (network or server). The cookie may still be valid.
   */
  readonly sessionUnreachable = signal(false);

  /** Reactive flag derived from the presence of a profile. */
  readonly isAuthenticated = signal(false);

  /** Tenants the user may enter after Discord returned several guild matches. */
  async pendingTenants(): Promise<TenantChoice[]> {
    return firstValueFrom(this.api.get<TenantChoice[]>('api/auth/pending-tenants'));
  }

  /** Finish OAuth by pinning the session to `tenantId`. */
  async selectTenant(tenantId: string): Promise<DiscordUserProfile> {
    const profile = await firstValueFrom(
      this.api.post<DiscordUserProfile>('api/auth/select-tenant', { tenant_id: tenantId }),
    );
    this.setProfile(profile);
    return profile;
  }

  /** Tenants this session may switch into. */
  async myTenants(): Promise<TenantChoice[]> {
    return firstValueFrom(this.api.get<TenantChoice[]>('api/auth/tenants'));
  }

  /** Discord servers the user can still register as tenants. */
  async registerableGuilds(): Promise<RegisterableGuild[]> {
    return firstValueFrom(this.api.get<RegisterableGuild[]>('api/auth/registerable-guilds'));
  }

  /** OAuth URL that adds the manager bot to a Discord server. */
  async botInvite(): Promise<BotInvite> {
    return firstValueFrom(this.api.get<BotInvite>('api/auth/bot-invite'));
  }

  /** Re-scope the session to another tenant the user already belongs to. */
  async switchTenant(tenantId: string): Promise<DiscordUserProfile> {
    const profile = await firstValueFrom(
      this.api.post<DiscordUserProfile>('api/auth/switch-tenant', { tenant_id: tenantId }),
    );
    this.setProfile(profile);
    return profile;
  }

  /** Trigger the Discord OAuth login flow (full-page redirect). */
  login(next?: string): void {
    if (typeof window === 'undefined') {
      return;
    }
    const suffix = next ? `?next=${encodeURIComponent(next)}` : '';
    window.location.href = this.buildBrowserUrl(`api/auth/discord/login${suffix}`);
  }

  /**
   * Clear the session cookie via the backend, then reset local state.
   *
   * A failed call leaves the profile in place: the http-only cookie is still
   * valid, so pretending the user signed out would only desync the UI.
   * A 401 or 403 means the cookie is already gone.
   */
  async logout(): Promise<void> {
    try {
      await firstValueFrom(this.api.post<void>('api/auth/logout', null));
    } catch (err) {
      if (!isSignedOut(err)) {
        throw err;
      }
    }
    this.sessionUnreachable.set(false);
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

  /** True when the backend grants the requested capability to this session. */
  hasPermission(permission: string): boolean {
    const profile = this._profile();
    if (!profile) {
      return false;
    }
    if (profile.is_superadmin) {
      return true;
    }

    return profile.permissions.includes(permission);
  }

  /** True when the session holds a control-plane platform role. */
  isPlatformAdmin(): boolean {
    return this._profile()?.is_platform_admin === true;
  }

  private async fetchProfile(): Promise<DiscordUserProfile | null> {
    const session = isPlatformServer(this.platformId)
      ? await this.probeOnceForRender()
      : (this.takeTransferredSession() ?? (await this.probeSession()));

    this.sessionUnreachable.set(session.sessionUnreachable);
    this.setProfile(session.profile);
    return session.profile;
  }

  /**
   * One probe per server render: the initializer, the guards and the redirect
   * guards all ask for the session, and they all get the same answer. The
   * result is stored in `TransferState` for the browser to pick up.
   */
  private probeOnceForRender(): Promise<TransferredSession> {
    this.serverProbe ??= this.probeSession().then((session) => {
      this.transferState.set(SESSION_STATE_KEY, session);
      return session;
    });
    return this.serverProbe;
  }

  /**
   * The session the server probed, on the browser's first load only.
   *
   * Consumed on read so a later `load()` (after logout or a tenant switch)
   * goes back to the network.
   */
  private takeTransferredSession(): TransferredSession | null {
    if (!this.isBrowser || !this.transferState.hasKey(SESSION_STATE_KEY)) {
      return null;
    }
    const session = this.transferState.get(SESSION_STATE_KEY, {
      profile: null,
      sessionUnreachable: false,
    });
    this.transferState.remove(SESSION_STATE_KEY);
    return session;
  }

  private async probeSession(): Promise<TransferredSession> {
    try {
      const profile = await firstValueFrom(this.api.get<DiscordUserProfile>('api/auth/me'));
      return { profile: profile ?? null, sessionUnreachable: false };
    } catch (err) {
      if (isSignedOut(err)) {
        return { profile: null, sessionUnreachable: false };
      }
      // Keep the last known profile: a network or server failure is not a logout.
      return { profile: this._profile(), sessionUnreachable: true };
    }
  }

  private buildBrowserUrl(path: string): string {
    const base = this.apiBaseUrl.replace(/\/$/, '');
    const tail = path.startsWith('/') ? path : `/${path}`;
    return `${base}${tail}`;
  }
}

/** 401/403 are a missing session. Status 0 and 5xx are not. */
function isSignedOut(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.status === 403);
}
