import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AutoRoleSettingsView,
  DiscordChannelView,
  DiscordRoleView,
  GuildSettingsView,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import { AdminDiscord } from './admin-discord';

const roles: DiscordRoleView[] = [
  { id: 'role-member', name: 'Member', position: 1, managed: false },
  { id: 'role-event', name: 'Event ping', position: 2, managed: false },
];

const channels: DiscordChannelView[] = [
  {
    id: 'ch-events',
    name: 'events',
    kind: 'text',
    type_id: 0,
    parent_id: null,
    position: 0,
    available_tags: [],
  },
];

const settings: GuildSettingsView = {
  discord_events_channel_id: 'ch-events',
  discord_battles_channel_id: null,
  discord_battles_cta_channel_id: null,
  discord_audit_log_channel_id: null,
  discord_transaction_spam_channel_id: null,
  discord_event_role_id: 'role-event',
  discord_auto_role_id: 'role-member',
  discord_splits_forum_channel_id: null,
  discord_split_pending_tag_id: null,
  discord_split_completed_tag_id: null,
  discord_split_not_completed_tag_id: null,
  discord_split_lost_tag_id: null,
  discord_event_voice_category_id: null,
  discord_applications_channel_id: null,
  discord_applications_category_id: null,
  discord_applications_archive_category_id: null,
  discord_applications_manage_role_id: null,
  discord_applications_status_channel_id: null,
  discord_applications_open: false,
  discord_applications_panel_title: 'Applications',
  discord_applications_panel_message: '',
  discord_applications_welcome_title: '',
  discord_applications_welcome_message: '',
  discord_applications_status_open_message: '',
  discord_applications_status_closed_message: '',
  discord_applications_panel_message_id: null,
  default_split_fee: 20,
};

const autorole: AutoRoleSettingsView = {
  discord_auto_role_id: 'role-member',
};

describe('AdminDiscord', () => {
  let fixture: ComponentFixture<AdminDiscord>;
  let api: {
    get: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
  };
  let toasts: {
    success: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    api = {
      get: vi.fn((path: string) => {
        if (path === 'api/admin/settings') {
          return of(settings);
        }
        if (path === 'api/admin/autorole') {
          return of(autorole);
        }
        if (path === 'api/admin/discord/roles' || path === 'api/admin/autorole/roles') {
          return of(roles);
        }
        if (path === 'api/admin/discord/channels') {
          return of(channels);
        }
        return of(null);
      }),
      put: vi.fn((path: string, body: unknown) => {
        if (path === 'api/admin/settings') {
          return of({ ...settings, ...(body as object) });
        }
        if (path === 'api/admin/autorole') {
          return of(body);
        }
        return of(null);
      }),
    };

    toasts = {
      success: vi.fn(),
      error: vi.fn(),
    };

    await TestBed.configureTestingModule({
      imports: [AdminDiscord],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiService, useValue: api },
        { provide: ToastService, useValue: toasts },
        {
          provide: AuthService,
          useValue: {
            hasPermission: () => true,
          },
        },
        {
          provide: TranslateService,
          useValue: {
            t: (key: string) => key,
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(AdminDiscord);
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
  });

  it('shows saved Discord names and hides application fields', () => {
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Member');
    expect(text).toContain('Event ping');
    expect(text).toContain('#events');
    expect(text).not.toContain('admin.discord.applicationPanelChannel');
    expect(text).not.toContain('admin.discord.applicationsOpen');
  });

  it('saves guild settings and autorole together from the page Save', async () => {
    const form = fixture.nativeElement.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await fixture.whenStable();

    expect(api.put).toHaveBeenCalledWith(
      'api/admin/settings',
      expect.objectContaining({
        discord_events_channel_id: 'ch-events',
        discord_event_role_id: 'role-event',
        default_split_fee: 20,
      }),
    );
    const settingsBody = api.put.mock.calls.find((call) => call[0] === 'api/admin/settings')?.[1] as
      | Record<string, unknown>
      | undefined;
    expect(settingsBody).toBeTruthy();
    expect(Object.keys(settingsBody ?? {}).some((key) => key.includes('applications'))).toBe(false);
    expect(settingsBody).toHaveProperty('discord_auto_role_id', 'role-member');

    expect(api.put).toHaveBeenCalledWith('api/admin/autorole', {
      discord_auto_role_id: 'role-member',
    });
    expect(toasts.success).toHaveBeenCalledWith('admin.discord.saved');
  });
});
