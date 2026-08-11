import { Injectable, signal } from '@angular/core';

/**
 * Lightweight toast notification service.
 *
 * Backed by a signal list so the toast container (mounted in the shell) can
 * reactively render them. Auto-dismiss after a timeout keeps the UX snappy
 * without a heavyweight overlay system.
 */
export type ToastKind = 'success' | 'error' | 'info';

export interface Toast {
  readonly id: number;
  readonly kind: ToastKind;
  readonly message: string;
}

@Injectable({ providedIn: 'root' })
export class ToastService {
  private nextId = 1;
  private readonly _toasts = signal<Toast[]>([]);

  /** Reactive list of currently-visible toasts. */
  readonly toasts = this._toasts.asReadonly();

  success(message: string): void {
    this.push('success', message);
  }

  error(message: string): void {
    this.push('error', message, 6000);
  }

  info(message: string): void {
    this.push('info', message);
  }

  dismiss(id: number): void {
    this._toasts.update((list) => list.filter((toast) => toast.id !== id));
  }

  private push(kind: ToastKind, message: string, timeoutMs = 3500): void {
    const id = this.nextId++;
    this._toasts.update((list) => [...list, { id, kind, message }]);
    if (typeof window !== 'undefined') {
      window.setTimeout(() => this.dismiss(id), timeoutMs);
    }
  }
}
