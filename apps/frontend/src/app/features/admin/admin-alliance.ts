import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  AllianceContext,
  DiscordRoleView,
  GuildSettingsView,
  UpdateGuildSettingsRequest,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { SearchableSelect } from '../../shared/components/searchable-select/searchable-select';
import { roleSelectOptions } from '../../shared/discord/discord-options';

/** Dedicated alliance settings: membership plus the Discord roles applied on register. */
@Component({
  selector: 'app-admin-alliance',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Loading, PageHeader, PageStack, SearchableSelect],
  template: `
    <app-page-header [title]="t('admin.alliance.title')" [subtitle]="t('admin.alliance.subtitle')" />

    <app-page-stack>
      @if (loading()) {
        <app-loading [label]="t('common.loading')" />
      } @else if (loadFailed()) {
        <p class="text-sm" style="color: var(--color-danger)">{{ t('common.error') }}</p>
        <button type="button" class="btn btn--outline btn--sm" (click)="load()">
          {{ t('common.retry') }}
        </button>
      } @else {
        <section class="card p-5 grid gap-2">
          <h2 class="eyebrow">{{ t('admin.alliance.status') }}</h2>
          <p class="text-sm">{{ statusCopy() }}</p>
          @if (canAccept()) {
            <div>
              <button type="button" class="btn btn--primary btn--sm" (click)="acceptInvite()" [disabled]="saving()">
                {{ t('admin.alliance.accept') }}
              </button>
            </div>
          }
        </section>

        <form class="grid gap-4" (submit)="save($event)">
        @if (context()?.members?.length) {
          <section class="card p-5">
            <h2 class="eyebrow mb-3">{{ t('admin.alliance.members') }}</h2>
            @if (isAlliance()) {
              <p class="mb-4 max-w-2xl text-xs" style="color: var(--color-text-secondary)">
                {{ t('admin.alliance.memberRolesHint') }}
              </p>
            }
            <table class="w-full text-sm">
              <caption class="sr-only">{{ t('admin.alliance.members') }}</caption>
              <thead>
                <tr class="text-left text-xs" style="color: var(--color-text-secondary)">
                  <th scope="col" class="py-1 font-medium">{{ t('common.name') }}</th>
                  <th scope="col" class="py-1 font-medium">{{ t('common.status') }}</th>
                  @if (isAlliance()) {
                    <th scope="col" class="py-1 font-medium">{{ t('admin.alliance.memberRole') }}</th>
                  }
                </tr>
              </thead>
              <tbody>
                @for (member of context()!.members; track member.guild_tenant_id) {
                  <tr>
                    <td class="py-2">{{ member.name }}</td>
                    <td class="py-2">
                      <span class="chip text-xs">{{ member.status }}</span>
                    </td>
                    @if (isAlliance()) {
                      <td class="py-2 min-w-56">
                        <app-searchable-select
                          class="block"
                          [options]="roleOptions(memberRoleDraft(member.guild_tenant_id))"
                          [value]="memberRoleDraft(member.guild_tenant_id)"
                          [emptyLabel]="t('admin.allianceRole.disabled')"
                          [searchPlaceholder]="t('common.search')"
                          [noMatchesLabel]="t('picker.noMatches')"
                          [emptyOptionsLabel]="t('picker.empty')"
                          [loading]="catalogLoading()"
                          [ariaLabel]="t('admin.alliance.memberRole') + ' ' + member.name"
                          (valueChange)="setMemberRole(member.guild_tenant_id, $event)"
                        />
                      </td>
                    }
                  </tr>
                }
              </tbody>
            </table>
          </section>
        }

          @if (!isAlliance()) {
            <section class="card p-5">
              <fieldset>
                <legend class="eyebrow mb-1">{{ t('admin.allianceRole.title') }}</legend>
                <p class="mb-4 max-w-2xl text-xs" style="color: var(--color-text-secondary)">
                  {{ allianceRoleHint() }}
                </p>
                <label>
                  <span class="label">{{ t('admin.allianceRole.role') }}</span>
                  <app-searchable-select
                    class="mt-1 block"
                    [options]="roleOptions(allianceRoleDraft())"
                    [value]="allianceRoleDraft()"
                    [emptyLabel]="t('admin.allianceRole.disabled')"
                    [searchPlaceholder]="t('common.search')"
                    [noMatchesLabel]="t('picker.noMatches')"
                    [emptyOptionsLabel]="t('picker.empty')"
                    [loading]="catalogLoading()"
                    [ariaLabel]="t('admin.allianceRole.role')"
                    (valueChange)="allianceRoleDraft.set($event)"
                  />
                  <span class="mt-1 block text-xs" style="color: var(--color-text-secondary)">
                    {{ t('admin.allianceRole.roleHint') }}
                  </span>
                </label>
              </fieldset>
            </section>
          }

          @if (isAlliance()) {
            <section class="card p-5">
              <fieldset>
                <legend class="eyebrow mb-1">{{ t('admin.alliance.eventRole') }}</legend>
                <p class="mb-4 max-w-2xl text-xs" style="color: var(--color-text-secondary)">
                  {{ t('admin.alliance.eventRoleHint') }}
                </p>
                <label>
                  <span class="label">{{ t('admin.alliance.eventRole') }}</span>
                  <app-searchable-select
                    class="mt-1 block"
                    [options]="roleOptions(eventRoleDraft())"
                    [value]="eventRoleDraft()"
                    [emptyLabel]="t('admin.allianceRole.disabled')"
                    [searchPlaceholder]="t('common.search')"
                    [noMatchesLabel]="t('picker.noMatches')"
                    [emptyOptionsLabel]="t('picker.empty')"
                    [loading]="catalogLoading()"
                    [ariaLabel]="t('admin.alliance.eventRole')"
                    (valueChange)="eventRoleDraft.set($event)"
                  />
                </label>
              </fieldset>
            </section>
          }

          <div>
            <button type="submit" class="btn btn--primary" [disabled]="saving()">
              {{ t('admin.discord.save') }}
            </button>
          </div>
        </form>
      }
    </app-page-stack>
  `,
})
export class AdminAlliance {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly saving = signal(false);
  protected readonly catalogLoading = signal(false);
  protected readonly context = signal<AllianceContext | null>(null);
  protected readonly roles = signal<DiscordRoleView[]>([]);
  protected readonly allianceRoleDraft = signal('');
  protected readonly eventRoleDraft = signal('');
  protected readonly memberRoleDrafts = signal<Record<string, string>>({});

  protected readonly isAlliance = computed(() => this.context()?.kind === 'alliance');
  protected readonly canAccept = computed(
    () => this.context()?.kind === 'guild' && this.context()?.membership_status === 'pending',
  );
  protected readonly allianceRoleHint = computed(() =>
    this.t(
      this.isAlliance() ? 'admin.allianceRole.hintAlliance' : 'admin.allianceRole.hintGuild',
    ),
  );

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  constructor() {
    void this.load();
  }

  protected roleOptions(selectedId: string) {
    return roleSelectOptions(this.roles(), selectedId);
  }

  protected memberRoleDraft(guildTenantId: string): string {
    return this.memberRoleDrafts()[guildTenantId] ?? '';
  }

  protected setMemberRole(guildTenantId: string, roleId: string): void {
    this.memberRoleDrafts.update((drafts) => ({ ...drafts, [guildTenantId]: roleId }));
  }

  protected statusCopy(): string {
    const ctx = this.context();
    if (!ctx) {
      return this.t('admin.alliance.none');
    }
    if (ctx.kind === 'alliance') {
      return this.t('admin.alliance.youAreAlliance');
    }
    if (ctx.membership_status === 'pending') {
      return this.t('admin.alliance.pending');
    }
    if (ctx.membership_status === 'active' && ctx.alliance_name) {
      return this.t('admin.alliance.activeNamed', { name: ctx.alliance_name });
    }
    return this.t('admin.alliance.none');
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const [context, settings, roles] = await Promise.all([
        firstValueFrom(this.api.get<AllianceContext>('api/alliances/me')),
        firstValueFrom(this.api.get<GuildSettingsView>('api/admin/settings')),
        firstValueFrom(this.api.get<DiscordRoleView[]>('api/admin/discord/roles')).catch(() =>
          firstValueFrom(this.api.get<DiscordRoleView[]>('api/admin/autorole/roles')),
        ),
      ]);
      this.context.set(context);
      this.allianceRoleDraft.set(settings.discord_alliance_role_id ?? '');
      this.eventRoleDraft.set(settings.discord_event_role_id ?? '');
      this.memberRoleDrafts.set(
        Object.fromEntries(
          context.members.map((member) => [member.guild_tenant_id, member.discord_role_id ?? '']),
        ),
      );
      this.roles.set(roles);
    } catch {
      this.loadFailed.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  protected async acceptInvite(): Promise<void> {
    const ctx = this.context();
    const guildId = this.auth.profile()?.tenant_id;
    if (!ctx?.alliance_id || !guildId) {
      return;
    }
    this.saving.set(true);
    try {
      await firstValueFrom(
        this.api.post(`api/alliances/${ctx.alliance_id}/members/${guildId}/accept`, {}),
      );
      this.toasts.success(this.t('admin.alliance.accepted'));
      await this.load();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    this.saving.set(true);
    try {
      const ctx = this.context();
      const body: UpdateGuildSettingsRequest = {};
      if (this.isAlliance()) {
        body.discord_event_role_id = this.eventRoleDraft();
      } else {
        body.discord_alliance_role_id = this.allianceRoleDraft();
      }
      const updated = await firstValueFrom(
        this.api.put<GuildSettingsView>('api/admin/settings', body),
      );
      this.allianceRoleDraft.set(updated.discord_alliance_role_id ?? '');
      this.eventRoleDraft.set(updated.discord_event_role_id ?? '');
      if (this.isAlliance() && ctx?.alliance_id) {
        const drafts = this.memberRoleDrafts();
        await Promise.all(
          ctx.members.map((member) =>
            firstValueFrom(
              this.api.patch(`api/alliances/${ctx.alliance_id}/members/${member.guild_tenant_id}`, {
                discord_role_id: drafts[member.guild_tenant_id] ?? '',
              }),
            ),
          ),
        );
      }
      this.toasts.success(this.t('admin.discord.saved'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }
}
