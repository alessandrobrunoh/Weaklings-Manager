import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AllianceContext, DiscordRoleView, GuildSettingsView } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import { AdminAlliance } from './admin-alliance';

const roles: DiscordRoleView[] = [{ id: 'role-ally', name: 'Alliance', position: 1, managed: false }];

const settings = {
  discord_alliance_role_id: 'role-ally',
  discord_event_role_id: null,
} as GuildSettingsView;

const context: AllianceContext = {
  kind: 'guild',
  alliance_id: 'ally-1',
  alliance_name: 'North',
  membership_status: 'active',
  members: [{ guild_tenant_id: 'g1', name: 'Alpha', status: 'active' }],
};

describe('AdminAlliance', () => {
  let fixture: ComponentFixture<AdminAlliance>;
  let api: {
    get: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
    patch: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    api = {
      get: vi.fn((path: string) => {
        if (path === 'api/alliances/me') {
          return of(context);
        }
        if (path === 'api/admin/settings') {
          return of(settings);
        }
        if (path.includes('roles')) {
          return of(roles);
        }
        return of(null);
      }),
      put: vi.fn().mockReturnValue(of(settings)),
      post: vi.fn().mockReturnValue(of({})),
      patch: vi.fn().mockReturnValue(of({})),
    };

    await TestBed.configureTestingModule({
      imports: [AdminAlliance],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiService, useValue: api },
        {
          provide: AuthService,
          useValue: { profile: () => ({ tenant_id: 'g1', tenant_kind: 'guild' }) },
        },
        { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
        { provide: TranslateService, useValue: { t: (key: string) => key } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(AdminAlliance);
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture?.destroy();
  });

  it('shows alliance membership and the role picker', () => {
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('admin.alliance.title');
    expect(text).toContain('Alpha');
    expect(text).toContain('admin.allianceRole.title');
    expect(api.get).toHaveBeenCalledWith('api/alliances/me');
  });

  it('saves the alliance Discord role', async () => {
    const form = fixture.nativeElement.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await fixture.whenStable();
    expect(api.put).toHaveBeenCalledWith(
      'api/admin/settings',
      expect.objectContaining({ discord_alliance_role_id: 'role-ally' }),
    );
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('on an alliance hub saves a Discord role per member guild', async () => {
    const allianceContext: AllianceContext = {
      kind: 'alliance',
      alliance_id: 'ally-1',
      alliance_name: 'Big WeakPie',
      membership_status: null,
      members: [
        {
          guild_tenant_id: 'g1',
          name: 'Weaklings',
          status: 'active',
          discord_role_id: 'role-ally',
        },
      ],
    };
    api.get.mockImplementation((path: string) => {
      if (path === 'api/alliances/me') {
        return of(allianceContext);
      }
      if (path === 'api/admin/settings') {
        return of(settings);
      }
      if (path.includes('roles')) {
        return of(roles);
      }
      return of(null);
    });
    fixture.destroy();
    fixture = TestBed.createComponent(AdminAlliance);
    await fixture.whenStable();
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Weaklings');
    expect(text).toContain('admin.alliance.memberRolesHint');
    expect(text).not.toContain('admin.allianceRole.title');

    const form = fixture.nativeElement.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await fixture.whenStable();
    expect(api.put).toHaveBeenCalledWith(
      'api/admin/settings',
      expect.objectContaining({ discord_event_role_id: '' }),
    );
    expect(api.patch).toHaveBeenCalledWith('api/alliances/ally-1/members/g1', {
      discord_role_id: 'role-ally',
    });
  });
});
