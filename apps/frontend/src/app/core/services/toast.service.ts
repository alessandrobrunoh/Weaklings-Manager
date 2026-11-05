import { Injectable, signal } from '@angular/core';

/**
 * Lightweight toast notification service.
 *
 * Backed by a signal list so the toast container (mounted in the shell) can
 * reactively render them. Success and info toasts auto-dismiss after a
 * timeout; error toasts stay until the user dismisses them, because a long
 * backend explanation (a 409 detail, a blocking-reference message) must stay
 * readable (WCAG 2.2.1 Timing Adjustable).
 */
export type ToastKind = 'success' | 'error' | 'info';

export interface Toast {
  readonly id: number;
  readonly kind: ToastKind;
  readonly message: string;
}

/** Cap so persistent errors cannot pile up and cover the page. */
const MAX_TOASTS = 5;

@Injectable({ providedIn: 'root' })
export class ToastService {
  private nextId = 1;
  private readonly _toasts = signal<Toast[]>([]);

  /** Reactive list of currently-visible toasts. */
  readonly toasts = this._toasts.asReadonly();

  success(message: string): void {
    this.push('success', message);
  }

  /** Persistent: stays until dismissed. An identical message already on screen is not repeated. */
  error(message: string): void {
    this.push('error', message, null);
  }

  info(message: string): void {
    this.push('info', message);
  }

  dismiss(id: number): void {
    this._toasts.update((list) => list.filter((toast) => toast.id !== id));
  }

  private push(kind: ToastKind, message: string, timeoutMs: number | null = 3500): void {
    if (this._toasts().some((toast) => toast.kind === kind && toast.message === message)) {
      return;
    }
    const id = this.nextId++;
    this._toasts.update((list) => [...list, { id, kind, message }].slice(-MAX_TOASTS));
    if (timeoutMs !== null && typeof window !== 'undefined') {
      window.setTimeout(() => this.dismiss(id), timeoutMs);
    }
  }
}
