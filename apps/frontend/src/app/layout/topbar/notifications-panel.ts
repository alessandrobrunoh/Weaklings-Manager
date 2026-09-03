import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';

import type { NotificationView } from '../../core/models/api.models';
import { AuthService } from '../../core/services/auth.service';
import { NotificationService } from '../../core/services/notification.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Dialog } from '../../shared/components/dialog/dialog';
import { Icon } from '../../shared/components/icon/icon';
import { TooltipDirective } from '../../shared/directives/tooltip.directive';

const TITLE_MAX = 120;
const BODY_MAX = 2000;

/**
 * Topbar inbox: bell, unread badge, dropdown list, optional broadcast compose.
 *
 * Light-dismiss uses document pointerdown on the host rather than the Popover
 * API so the panel stays testable in jsdom and does not need a polyfill.
 */
@Component({
  selector: 'app-notifications-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, Dialog, Icon, TooltipDirective],
  host: {
    class: 'relative',
    '(document:pointerdown)': 'onDocumentPointer($event)',
    '(document:keydown.escape)': 'onEscape()',
  },
  styles: `
    :host {
      display: inline-flex;
    }
    .inbox-panel {
      position: absolute;
      top: calc(100% + 8px);
      right: 0;
      z-index: 40;
      width: min(22rem, calc(100vw - 1.5rem));
      max-height: min(24rem, calc(100vh - 5rem));
      overflow: hidden;
      display: flex;
      flex-direction: column;
      border-radius: var(--radius-cards);
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      box-shadow: var(--shadow-xl);
    }
    .inbox-list {
      overflow-y: auto;
      flex: 1;
    }
  `,
  template: `
    <button
      type="button"
      class="btn btn--ghost shrink-0 relative text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
      style="min-width: 36px; height: 36px; padding: 0.35rem;"
      (click)="togglePanel()"
      [appTooltip]="t('notifications.open')"
      tooltipPosition="bottom"
      [attr.aria-label]="t('notifications.open')"
      [attr.aria-expanded]="panelOpen()"
      [attr.aria-controls]="panelOpen() ? panelId : null"
    >
      <app-icon name="bell" size="1.125rem" />
      @if (unreadCount() > 0) {
        <span
          class="absolute flex items-center justify-center rounded-full text-[9px] font-bold text-[var(--color-on-primary)] bg-[var(--color-primary)]"
          style="
            top: 2px;
            right: 2px;
            min-width: 14px;
            height: 14px;
            padding: 0 3px;
          "
          aria-hidden="true"
        >
          {{ unreadLabel() }}
        </span>
      }
    </button>

    @if (panelOpen()) {
      <div
        [id]="panelId"
        class="inbox-panel"
        role="dialog"
        [attr.aria-labelledby]="titleId"
      >
        <header
          class="flex items-center justify-between gap-2 px-3.5 py-2.5"
          style="border-bottom: 1px solid var(--color-border)"
        >
          <h2 [id]="titleId" class="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
            {{ t('notifications.title') }}
          </h2>
          @if (unreadCount() > 0) {
            <button
              type="button"
              class="btn btn--ghost text-xs"
              style="min-width: auto; height: 26px; padding: 0 0.5rem"
              (click)="onMarkAllRead()"
            >
              {{ t('notifications.markAllRead') }}
            </button>
          }
        </header>

        <div class="inbox-list">
          @if (notifications.loading()) {
            <p class="px-3 py-6 text-sm text-center" style="color: var(--color-text-secondary)">
              {{ t('common.loading') }}
            </p>
          } @else if (notifications.error()) {
            <p class="px-3 py-6 text-sm text-center" style="color: var(--color-text-secondary)">
              {{ t('notifications.loadError') }}
            </p>
          } @else if (notifications.items().length === 0) {
            <div class="px-3 py-6 text-center">
              <p class="text-sm font-medium" style="color: var(--color-text)">
                {{ t('notifications.empty') }}
              </p>
              <p class="mt-1 text-xs" style="color: var(--color-text-secondary)">
                {{ t('notifications.emptyHint') }}
              </p>
            </div>
          } @else {
            <ul class="m-0 list-none p-0">
              @for (row of notifications.items(); track row.id) {
                <li style="border-bottom: 1px solid var(--color-border)">
                  <button
                    type="button"
                    class="w-full text-left px-3.5 py-2.5 transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:bg-[var(--color-surface-hover)] block"
                    style="background: none; border: none; cursor: pointer"
                    (click)="onOpenRow(row)"
                  >
                    <div class="flex items-start justify-between gap-2">
                      <span
                        class="block text-xs truncate"
                        [style.font-weight]="row.read_at ? '400' : '600'"
                        [style.color]="row.read_at ? 'var(--color-text-secondary)' : 'var(--color-text)'"
                      >
                        {{ row.title }}
                      </span>
                      @if (!row.read_at) {
                        <span class="h-1.5 w-1.5 rounded-full bg-[var(--color-info)] shrink-0 mt-1" aria-hidden="true"></span>
                      }
                    </div>
                    <span
                      class="mt-0.5 block text-xs line-clamp-2"
                      style="color: var(--color-text-secondary)"
                    >
                      {{ row.body }}
                    </span>
                    <span
                      class="mt-1 block text-[10px] mono"
                      style="color: var(--color-text-tertiary)"
                    >
                      {{ row.created_at | date: 'MMM d, HH:mm' }}
                    </span>
                  </button>
                </li>
              }
            </ul>
          }
        </div>

        @if (canBroadcast()) {
          <footer
            class="px-3 py-2"
            style="border-top: 1px solid var(--color-border)"
          >
            <button
              type="button"
              class="btn btn--ghost w-full text-xs"
              style="height: 32px"
              (click)="openCompose()"
            >
              {{ t('notifications.broadcast') }}
            </button>
          </footer>
        }
      </div>
    }

    @if (composeOpen()) {
      <app-dialog
        [title]="t('notifications.broadcast')"
        size="sm"
        (closed)="composeOpen.set(false)"
      >
        <form class="grid gap-3" (submit)="onBroadcastSubmit($event)">
          <p class="text-xs" style="color: var(--color-text-secondary)">
            {{ t('notifications.broadcastHint') }}
          </p>
          <label class="block">
            <span class="label font-medium">{{ t('notifications.broadcastTitle') }}</span>
            <input
              class="input"
              type="text"
              required
              maxlength="120"
              [value]="composeTitle()"
              (input)="onTitleInput($event)"
            />
          </label>
          <label class="block">
            <span class="label font-medium">{{ t('notifications.broadcastBody') }}</span>
            <textarea
              class="input"
              rows="4"
              required
              maxlength="2000"
              [value]="composeBody()"
              (input)="onBodyInput($event)"
            ></textarea>
          </label>
          <div dialogFooter>
            <button type="button" class="btn btn--ghost" (click)="composeOpen.set(false)">
              {{ t('common.cancel') }}
            </button>
            <button
              type="submit"
              class="btn btn--primary"
              [disabled]="composeBusy() || !composeValid()"
            >
              {{ t('notifications.broadcastSend') }}
            </button>
          </div>
        </form>
      </app-dialog>
    }
  `,
})
export class NotificationsPanel {
  protected readonly notifications = inject(NotificationService);
  private readonly auth = inject(AuthService);
  private readonly translate = inject(TranslateService);
  private readonly toasts = inject(ToastService);
  private readonly router = inject(Router);
  private readonly host = inject(ElementRef<HTMLElement>);

  protected readonly panelOpen = signal(false);
  protected readonly composeOpen = signal(false);
  protected readonly composeTitle = signal('');
  protected readonly composeBody = signal('');
  protected readonly composeBusy = signal(false);

  protected readonly panelId = 'topbar-notifications-panel';
  protected readonly titleId = 'topbar-notifications-title';

  protected readonly unreadCount = this.notifications.unreadCount;
  protected readonly canBroadcast = computed(() =>
    this.auth.hasPermission('notifications.broadcast'),
  );
  protected readonly composeValid = computed(() => {
    const title = this.composeTitle().trim();
    const body = this.composeBody().trim();
    return (
      title.length > 0 &&
      title.length <= TITLE_MAX &&
      body.length > 0 &&
      body.length <= BODY_MAX
    );
  });

  protected t = (key: TranslationKey) => this.translate.t(key);

  protected onTitleInput(event: Event): void {
    this.composeTitle.set((event.target as HTMLInputElement).value);
  }

  protected onBodyInput(event: Event): void {
    this.composeBody.set((event.target as HTMLTextAreaElement).value);
  }

  protected unreadLabel(): string {
    const count = this.unreadCount();
    return count > 99 ? '99+' : String(count);
  }

  protected async togglePanel(): Promise<void> {
    const next = !this.panelOpen();
    this.panelOpen.set(next);
    if (next) {
      await this.notifications.loadInbox();
    }
  }

  protected closePanel(): void {
    this.panelOpen.set(false);
  }

  protected openCompose(): void {
    this.closePanel();
    this.composeTitle.set('');
    this.composeBody.set('');
    this.composeOpen.set(true);
  }

  protected async onMarkAllRead(): Promise<void> {
    await this.notifications.markAllRead();
  }

  protected async onOpenRow(row: NotificationView): Promise<void> {
    if (!row.read_at) {
      await this.notifications.markRead(row.id);
    }
    this.closePanel();
    if (row.link_path) {
      await this.router.navigateByUrl(row.link_path);
    }
  }

  protected async onBroadcastSubmit(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.composeValid() || this.composeBusy()) {
      return;
    }
    this.composeBusy.set(true);
    try {
      await this.notifications.broadcast({
        title: this.composeTitle().trim(),
        body: this.composeBody().trim(),
      });
      this.toasts.success(this.t('notifications.broadcastSent'));
      this.composeOpen.set(false);
    } catch {
      this.toasts.error(this.t('common.error'));
    } finally {
      this.composeBusy.set(false);
    }
  }

  protected onDocumentPointer(event: Event): void {
    if (!this.panelOpen()) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Node)) {
      return;
    }
    if (!this.host.nativeElement.contains(target)) {
      this.closePanel();
    }
  }

  protected onEscape(): void {
    if (this.composeOpen()) {
      return;
    }
    this.closePanel();
  }
}
