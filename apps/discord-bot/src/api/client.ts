import type { ApiResponse } from './types.js';

/**
 * HTTP client for the Albion Guild Manager backend.
 *
 * Authentication strategy: the bot passes two custom headers on every request:
 *   X-Bot-Secret  — shared secret that the backend validates
 *   X-Discord-Id  — the Discord user ID of the person who ran the command
 *
 * The backend middleware resolves the Discord ID to a local user and treats the
 * request as if that user were logged in (full permission check applies).
 *
 * When discordId is omitted the request runs without user context (bot-level).
 */
export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly botSecret: string,
  ) {}

  async get<T>(
    path: string,
    discordId?: string,
    params?: Record<string, string | number>,
  ): Promise<T> {
    const url = this.buildUrl(path, params);
    return this.request<T>('GET', url, undefined, discordId);
  }

  async post<T>(path: string, body: unknown, discordId?: string): Promise<T> {
    const url = this.buildUrl(path);
    return this.request<T>('POST', url, body, discordId);
  }

  async patch<T>(path: string, body: unknown, discordId?: string): Promise<T> {
    const url = this.buildUrl(path);
    return this.request<T>('PATCH', url, body, discordId);
  }

  async put<T>(path: string, body: unknown, discordId?: string): Promise<T> {
    const url = this.buildUrl(path);
    return this.request<T>('PUT', url, body, discordId);
  }

  async delete<T>(path: string, discordId?: string): Promise<T | null> {
    const url = this.buildUrl(path);
    return this.request<T | null>('DELETE', url, undefined, discordId);
  }

  /** Fetches a user profile from the backend using their Discord ID. */
  async getDiscordProfile(discordId: string): Promise<ApiResponse<unknown> | null> {
    try {
      const url = this.buildUrl('api/auth/me');
      const res = await fetch(url, {
        headers: this.headers(discordId),
      });
      if (!res.ok) return null;
      return (await res.json()) as ApiResponse<unknown>;
    } catch {
      return null;
    }
  }

  private async request<T>(
    method: string,
    url: string,
    body?: unknown,
    discordId?: string,
  ): Promise<T> {
    const headers = this.headers(discordId);

    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      (headers as Record<string, string>)['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const res = await fetch(url, init);

    if (!res.ok) {
      let detail: string = res.statusText;
      try {
        const err = (await res.json()) as { detail?: string; message?: string };
        detail = err.detail ?? err.message ?? detail;
      } catch {
        // ignore JSON parse errors
      }
      throw new ApiError(res.status, detail);
    }

    // 204 No Content
    if (res.status === 204) return null as T;

    const json = (await res.json()) as ApiResponse<T>;
    return json.data;
  }

  private headers(discordId?: string): HeadersInit {
    const h: Record<string, string> = {
      Accept: 'application/json',
      'X-Bot-Secret': this.botSecret,
    };
    if (discordId) {
      h['X-Discord-Id'] = discordId;
    }
    return h;
  }

  private buildUrl(path: string, params?: Record<string, string | number>): string {
    const base = this.baseUrl.replace(/\/$/, '');
    const tail = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${base}${tail}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
