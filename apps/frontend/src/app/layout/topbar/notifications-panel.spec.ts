import { provideZonelessChangeDetection, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import type { NotificationView } from '../../core/models/api.models';
import { AuthService } from '../../core/services/auth.service';
import { NotificationService } from '../../core/services/notification.service';
import { ToastService } from '../../core/services/toast.service';
import { NotificationsPanel } from './notifications-panel';

function sample(): NotificationView {
  return {
    id: 7,
    kind: 'broadcast',
    title: 'CTA tonight',
    body: 'Be online.',
    link_path: null,
    source_type: 'broadcast',
    source_id: 1,
    read_at: null,
    created_at: '2026-08-30T12:00:00Z',
  };
}

describe('NotificationsPanel', () => {
  let fixture: ComponentFixture<NotificationsPanel>;
  let loadInbox: ReturnType<typeof vi.fn>;
  let hasPermission: ReturnType<typeof vi.fn>;
  const items = signal<NotificationView[]>([]);
  const unreadCount = signal(0);

  beforeEach(async () => {
    loadInbox = vi.fn().mockResolvedValue(undefined);
    hasPermission = vi.fn().mockReturnValue(false);
    items.set([]);
    unreadCount.set(0);

    await TestBed.configureTestingModule({
      imports: [NotificationsPanel],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        ToastService,
        {
          provide: NotificationService,
          useValue: {
            items: items.asReadonly(),
            unreadCount: unreadCount.asReadonly(),
            loading: signal(false).asReadonly(),
            error: signal<string | null>(null).asReadonly(),
            loadInbox,
            markRead: vi.fn(),
            markAllRead: vi.fn(),
            broadcast: vi.fn(),
            refreshUnread: vi.fn(),
          },
        },
        {
          provide: AuthService,
          useValue: { hasPermission },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(NotificationsPanel);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('opens the inbox and loads rows on bell click', async () => {
    items.set([sample()]);
    unreadCount.set(1);
    const button = fixture.nativeElement.querySelector(
      'button[aria-label]',
    ) as HTMLButtonElement;
    button.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(loadInbox).toHaveBeenCalled();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(fixture.nativeElement.textContent).toContain('CTA tonight');
    expect(fixture.nativeElement.textContent).not.toContain('Guild announcement');
  });

  it('shows the compose action when the session can broadcast', async () => {
    hasPermission.mockReturnValue(true);
    fixture = TestBed.createComponent(NotificationsPanel);
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector(
      'button[aria-label]',
    ) as HTMLButtonElement;
    button.click();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.nativeElement.textContent).toContain('Guild announcement');
  });
});
