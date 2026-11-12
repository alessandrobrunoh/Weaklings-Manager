import { COMPACT_FEATURE_STYLES } from '../compact-feature.styles';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  AlbionAllianceChoice,
  AllianceContext,
  AllianceMember,
  AttachableGuild,
  DiscordRoleView,
  GuildSettingsView,
  UpdateGuildSettingsRequest,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Checkbox } from '../../shared/components/checkbox/checkbox';
import { ChoiceGroup } from '../../shared/components/choice-group/choice-group';
import { DataTable } from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import type { DataTableColumn } from '../../shared/components/data-table/data-table-column';
import { Dialog } from '../../shared/components/dialog/dialog';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { FilterBar } from '../../shared/components/filter-bar/filter-bar';
import { Loading } from '../../shared/components/loading/loading';
import { Menu, type MenuItem } from '../../shared/components/menu/menu';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { SearchableSelect } from '../../shared/components/searchable-select/searchable-select';
import { StatusChip } from '../../shared/components/status-chip/status-chip';
import { type SummaryItem, SummaryBand } from '../../shared/components/summary-band/summary-band';
import { roleSelectOptions } from '../../shared/discord/discord-options';

/** A destructive or consequential action waiting for confirmation in a dialog. */
type PendingAction =
  | { readonly kind: 'leave'; readonly name: string }
  | { readonly kind: 'reset' }
  | { readonly kind: 'reinvite'; readonly guildId: string; readonly name: string };

/**
 * Alliance settings. Sections: what this Discord's alliance is, who is in it (with pending
 * invites counted), and what is shared (the Discord roles and pings the alliance uses).
 * Linking, leaving and re-inviting happen in dialogs; the header carries one primary action.
 */
@Component({
  selector: 'app-admin-alliance',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [COMPACT_FEATURE_STYLES],
  imports: [
    Checkbox,
    ChoiceGroup,
    DataTable,
    DataTableCell,
    Dialog,
    EmptyState,
    ErrorState,
    FilterBar,
    Loading,
    Menu,
    PageHeader,
    PageStack,
    SearchableSelect,
    StatusChip,
    SummaryBand,
  ],
  template: `
    <app-page-header
      [title]="t('admin.alliance.title')"
      [subtitle]="t('admin.alliance.subtitle')"
      [menuItems]="menuItems()"
      (menuSelect)="onMenu($event)"
    >
      <div pageActions>
        @if (canAccept()) {
          <button type="button" class="btn btn--primary" (click)="acceptInvite()" [disabled]="saving()">
            {{ t('admin.alliance.accept') }}
          </button>
        } @else if (needsSetup()) {
          <button type="button" class="btn btn--primary" (click)="openSetup()" [disabled]="saving()">
            {{ t('admin.alliance.setup') }}
          </button>
        }
      </div>
    </app-page-header>

    <app-page-stack>
      @if (loading()) {
        <app-loading variant="detail" [label]="t('common.loading')" />
      } @else if (loadFailed()) {
        <app-error-state [retryLabel]="t('common.retry')" (retry)="load()" />
      } @else {
        <section class="card p-4" aria-labelledby="alliance-about-heading">
          <h2 id="alliance-about-heading" class="section-title">{{ t('admin.alliance.about') }}</h2>
          <p class="mt-1 text-sm">{{ statusCopy() }}</p>
          <dl class="mt-3 grid gap-3 text-sm sm:grid-cols-3">
            <div class="min-w-0">
              <dt class="hint">{{ t('admin.alliance.title') }}</dt>
              <dd class="truncate">{{ context()?.alliance_name || t('common.none') }}</dd>
            </div>
            @if (context()?.kind === 'guild' && context()?.membership_status) {
              <div>
                <dt class="hint">{{ t('admin.alliance.yourStatus') }}</dt>
                <dd class="mt-0.5">
                  <app-status-chip [value]="context()!.membership_status!" [label]="statusLabel(context()!.membership_status!)" />
                </dd>
              </div>
            }
            @if (isAlliance()) {
              <div>
                <dt class="hint">{{ t('admin.alliance.albionLink') }}</dt>
                <dd>{{ context()?.albion_alliance_id ? t('admin.alliance.linked') : t('admin.alliance.notLinked') }}</dd>
              </div>
            }
          </dl>
        </section>

        <form class="grid gap-4" data-testid="alliance-settings-form" (submit)="save($event)">
          @if (isAlliance() || members().length > 0) {
            <section class="card p-4" aria-labelledby="alliance-members-heading">
              <h2 id="alliance-members-heading" class="section-title">{{ t('admin.alliance.members') }}</h2>
              <p class="hint mt-1 max-w-2xl">
                {{ isAlliance() ? t('admin.alliance.memberRolesHint') : t('admin.alliance.membersHint') }}
              </p>

              @if (members().length > 0) {
                <app-summary-band class="mt-3 block" [items]="summaryItems()" [ariaLabel]="t('admin.alliance.members')" />

                <app-data-table
                  class="mt-3 block"
                  [columns]="memberColumns()"
                  [rows]="members()"
                  [trackBy]="trackMember"
                  [ariaLabel]="t('admin.alliance.members')"
                  [hideSearch]="true"
                  [syncUrl]="false"
                  mobileLayout="stack"
                >
                  <ng-template dataTableCell="name" let-row>
                    <span class="font-medium">{{ row.name }}</span>
                  </ng-template>
                  <ng-template dataTableCell="status" let-row>
                    <app-status-chip [value]="row.status" [label]="statusLabel(row.status)" />
                  </ng-template>
                  <ng-template dataTableCell="role" let-row>
                    <app-searchable-select
                      class="block min-w-48"
                      [options]="roleOptions(memberRoleDraft(row.guild_tenant_id))"
                      [value]="memberRoleDraft(row.guild_tenant_id)"
                      [emptyLabel]="t('admin.allianceRole.disabled')"
                      [searchPlaceholder]="t('common.search')"
                      [noMatchesLabel]="t('picker.noMatches')"
                      [emptyOptionsLabel]="t('picker.empty')"
                      [loading]="catalogLoading()"
                      [ariaLabel]="t('admin.alliance.memberRole') + ' ' + row.name"
                      (valueChange)="setMemberRole(row.guild_tenant_id, $event)"
                    />
                  </ng-template>
                  <ng-template dataTableCell="actions" let-row>
                    @if (row.status === 'left') {
                      <app-menu
                        appearance="ghost"
                        [items]="reinviteItems()"
                        [label]="t('admin.alliance.memberActions', { name: row.name })"
                        (itemSelect)="onMemberAction(row, $event)"
                      />
                    }
                  </ng-template>
                </app-data-table>
              } @else {
                <app-empty-state class="mt-3 block" compact [message]="t('admin.alliance.membersEmpty')" />
              }
            </section>
          }

          <section class="card p-4" aria-labelledby="alliance-shared-heading">
            <h2 id="alliance-shared-heading" class="section-title">{{ t('admin.alliance.sharedTitle') }}</h2>
            <p class="hint mt-1 max-w-2xl">{{ t('admin.alliance.sharedHint') }}</p>

            <div class="mt-4 grid max-w-md gap-1">
              @if (isAlliance()) {
                <span class="label">{{ t('admin.alliance.eventRole') }}</span>
                <app-searchable-select
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
                <span class="hint">{{ t('admin.alliance.eventRoleHint') }}</span>
              } @else {
                <span class="label">{{ t('admin.allianceRole.title') }}</span>
                <app-searchable-select
                  [options]="roleOptions(allianceRoleDraft())"
                  [value]="allianceRoleDraft()"
                  [emptyLabel]="t('admin.allianceRole.disabled')"
                  [searchPlaceholder]="t('common.search')"
                  [noMatchesLabel]="t('picker.noMatches')"
                  [emptyOptionsLabel]="t('picker.empty')"
                  [loading]="catalogLoading()"
                  [ariaLabel]="t('admin.allianceRole.title')"
                  (valueChange)="allianceRoleDraft.set($event)"
                />
                <span class="hint">{{ allianceRoleHint() }}</span>
                <span class="hint">{{ t('admin.allianceRole.roleHint') }}</span>
              }
            </div>

            <div class="mt-4 flex justify-end">
              <button type="submit" class="btn btn--primary" [disabled]="saving()">
                {{ t('admin.discord.save') }}
              </button>
            </div>
          </section>
        </form>
      }
    </app-page-stack>

    @if (setupOpen()) {
      <app-dialog size="md" [title]="t('admin.alliance.setup')" [subtitle]="t('admin.alliance.setupHint')" (closed)="closeSetup()">
        <div class="grid gap-4">
          <app-filter-bar
            [searchLabel]="t('register.albionAlliance')"
            [searchPlaceholder]="t('register.albionAllianceHint')"
            [query]="setupQuery()"
            (queryChange)="onSetupSearch($event)"
          />

          @if (setupOptions().length > 0) {
            <app-choice-group
              [options]="setupOptions()"
              [value]="setupAlliance()?.id ?? null"
              [ariaLabel]="t('admin.alliance.resultsLabel')"
              (valueChange)="pickSetupAlliance($event)"
            />
          } @else if (setupQuery().trim().length >= 2) {
            <p class="hint">{{ t('picker.noMatches') }}</p>
          }

          @if (setupAlliance()) {
            <form id="alliance-setup-form" class="grid gap-2" (submit)="saveSetup($event)">
              <fieldset class="grid gap-1">
                <legend class="label mb-1">{{ t('admin.alliance.guildsLabel') }}</legend>
                @for (guild of setupGuilds(); track guild.id) {
                  <app-checkbox
                    [inputId]="'alliance-guild-' + guild.id"
                    [label]="guild.name"
                    [checked]="setupMembers().includes(guild.id)"
                    (checkedChange)="setSetupMember(guild.id, $event)"
                  />
                } @empty {
                  <p class="hint">{{ t('picker.empty') }}</p>
                }
              </fieldset>
            </form>
          }
        </div>

        <div dialogFooter>
          <button type="button" class="btn btn--outline" (click)="closeSetup()">{{ t('common.cancel') }}</button>
          <button
            type="submit"
            class="btn btn--primary"
            form="alliance-setup-form"
            [disabled]="saving() || !setupAlliance() || setupMembers().length === 0"
          >
            {{ t('admin.alliance.setup') }}
          </button>
        </div>
      </app-dialog>
    }

    @if (pendingAction(); as action) {
      <app-dialog size="sm" [title]="t(actionTitleKey(action))" (closed)="cancelAction()">
        <p class="text-sm">{{ actionBody(action) }}</p>
        <div dialogFooter>
          <button type="button" class="btn btn--outline" (click)="cancelAction()">{{ t('common.cancel') }}</button>
          <button
            type="button"
            class="btn"
            [class.btn--primary]="action.kind === 'reinvite'"
            [class.btn--danger]="action.kind !== 'reinvite'"
            [disabled]="saving()"
            (click)="confirmAction()"
          >
            {{ t(actionTitleKey(action)) }}
          </button>
        </div>
      </app-dialog>
    }
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
  protected readonly pendingAction = signal<PendingAction | null>(null);
  protected readonly setupOpen = signal(false);
  protected readonly setupQuery = signal('');
  protected readonly setupHits = signal<AlbionAllianceChoice[]>([]);
  protected readonly setupAlliance = signal<AlbionAllianceChoice | null>(null);
  protected readonly setupGuilds = signal<AttachableGuild[]>([]);
  protected readonly setupMembers = signal<string[]>([]);

  protected readonly members = computed(() => this.context()?.members ?? []);
  protected readonly isAlliance = computed(() => this.context()?.kind === 'alliance');
  protected readonly needsSetup = computed(
    () => this.isAlliance() && !this.context()?.albion_alliance_id,
  );
  protected readonly canAccept = computed(
    () => this.context()?.kind === 'guild' && this.context()?.membership_status === 'pending',
  );
  protected readonly canLeave = computed(
    () =>
      this.context()?.kind === 'guild' &&
      this.context()?.membership_status === 'active' &&
      this.auth.hasPermission('alliance.leave'),
  );
  protected readonly allianceRoleHint = computed(() =>
    this.t(
      this.isAlliance() ? 'admin.allianceRole.hintAlliance' : 'admin.allianceRole.hintGuild',
    ),
  );

  protected readonly summaryItems = computed<SummaryItem[]>(() => {
    const members = this.members();
    const count = (status: AllianceMember['status']) =>
      members.filter((member) => member.status === status).length;
    const pending = count('pending');
    return [
      { label: this.t('admin.alliance.statActive'), value: count('active') },
      {
        label: this.t('admin.alliance.statPending'),
        value: pending,
        hint: this.t('admin.alliance.statPendingHint'),
        tone: pending > 0 ? 'warning' : 'default',
      },
      { label: this.t('admin.alliance.statLeft'), value: count('left') },
    ];
  });

  protected readonly memberColumns = computed<readonly DataTableColumn<AllianceMember>[]>(() => {
    const columns: DataTableColumn<AllianceMember>[] = [
      { key: 'name', label: 'common.name', sortable: true, accessor: (member) => member.name },
      { key: 'status', label: 'common.status', sortable: true, accessor: (member) => member.status },
    ];
    if (this.isAlliance()) {
      columns.push({ key: 'role', label: 'admin.alliance.memberRole' });
      columns.push({ key: 'actions', label: '' });
    }
    return columns;
  });

  protected readonly reinviteItems = computed<MenuItem[]>(() => [
    { id: 'reinvite', label: this.t('admin.alliance.reinvite') },
  ]);

  protected readonly menuItems = computed<MenuItem[]>(() => {
    const items: MenuItem[] = [];
    if (this.isAlliance()) {
      items.push({ id: 'reset', label: this.t('admin.alliance.reset'), danger: true });
    }
    if (this.canLeave()) {
      items.push({
        id: 'leave',
        label: this.t('admin.alliance.leave'),
        danger: true,
        separatorBefore: items.length > 0,
      });
    }
    return items;
  });

  protected readonly setupOptions = computed(() =>
    this.setupHits().map((hit) => ({ id: hit.id, label: hit.name })),
  );

  protected readonly trackMember = (member: AllianceMember) => member.guild_tenant_id;

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

  protected statusLabel(status: string): string {
    switch (status) {
      case 'active':
        return this.t('admin.alliance.statusActive');
      case 'pending':
        return this.t('admin.alliance.statusPending');
      case 'left':
        return this.t('admin.alliance.statusLeft');
      default:
        return status;
    }
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
    if (ctx.membership_status === 'left' && ctx.alliance_name) {
      return this.t('admin.alliance.leftNamed', { name: ctx.alliance_name });
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

  protected onMenu(id: string): void {
    if (id === 'reset') {
      this.pendingAction.set({ kind: 'reset' });
    } else if (id === 'leave') {
      this.pendingAction.set({ kind: 'leave', name: this.context()?.alliance_name ?? '' });
    }
  }

  protected onMemberAction(member: AllianceMember, id: string): void {
    if (id === 'reinvite') {
      this.pendingAction.set({
        kind: 'reinvite',
        guildId: member.guild_tenant_id,
        name: member.name,
      });
    }
  }

  protected cancelAction(): void {
    this.pendingAction.set(null);
  }

  protected async confirmAction(): Promise<void> {
    const action = this.pendingAction();
    if (!action) {
      return;
    }
    this.pendingAction.set(null);
    if (action.kind === 'leave') {
      await this.leaveAlliance();
    } else if (action.kind === 'reset') {
      await this.resetSetup();
    } else {
      await this.reinvite(action.guildId);
    }
  }

  protected actionTitleKey(action: PendingAction): TranslationKey {
    switch (action.kind) {
      case 'leave':
        return 'admin.alliance.leave';
      case 'reset':
        return 'admin.alliance.reset';
      case 'reinvite':
        return 'admin.alliance.reinvite';
    }
  }

  protected actionBody(action: PendingAction): string {
    switch (action.kind) {
      case 'leave':
        return this.t('admin.alliance.leaveConfirm', { name: action.name });
      case 'reset':
        return this.t('admin.alliance.resetHint');
      case 'reinvite':
        return this.t('admin.alliance.reinviteConfirm', { name: action.name });
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

  protected async reinvite(guildId: string): Promise<void> {
    const ctx = this.context();
    if (!ctx?.alliance_id) {
      return;
    }
    this.saving.set(true);
    try {
      const invited = await firstValueFrom(
        this.api.post<AllianceMember>(
          `api/alliances/${ctx.alliance_id}/members/${guildId}/invite`,
          {},
        ),
      );
      this.toasts.success(
        this.t(invited.status === 'active' ? 'admin.alliance.rejoined' : 'admin.alliance.reinvited'),
      );
      await this.load();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected openSetup(): void {
    this.setupQuery.set('');
    this.setupHits.set([]);
    this.setupAlliance.set(null);
    this.setupGuilds.set([]);
    this.setupMembers.set([]);
    this.setupOpen.set(true);
  }

  protected closeSetup(): void {
    this.setupOpen.set(false);
  }

  protected onSetupSearch(query: string): void {
    this.setupQuery.set(query);
    const q = query.trim();
    if (q.length < 2) {
      this.setupHits.set([]);
      return;
    }
    void firstValueFrom(this.api.get<AlbionAllianceChoice[]>('api/tenants/albion-alliances', {
      q,
      region: 'europe',
    })).then((hits) => this.setupHits.set(hits ?? [])).catch(() => this.setupHits.set([]));
  }

  protected async pickSetupAlliance(id: string | null): Promise<void> {
    const alliance = this.setupHits().find((hit) => hit.id === id);
    if (!alliance) {
      return;
    }
    this.setupAlliance.set(alliance);
    this.setupMembers.set([]);
    try {
      const guilds = await firstValueFrom(this.api.get<AttachableGuild[]>('api/tenants/attachable-guilds', {
        albion_alliance_id: alliance.id,
        region: 'europe',
      }));
      this.setupGuilds.set(guilds ?? []);
    } catch {
      this.setupGuilds.set([]);
    }
  }

  protected setSetupMember(id: string, checked: boolean): void {
    this.setupMembers.update((ids) =>
      checked ? (ids.includes(id) ? ids : [...ids, id]) : ids.filter((current) => current !== id),
    );
  }

  protected async resetSetup(): Promise<void> {
    const allianceId = this.context()?.alliance_id;
    if (!allianceId) return;
    this.saving.set(true);
    try {
      await firstValueFrom(this.api.post(`api/alliances/${allianceId}/reset-setup`, {}));
      await this.load();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async saveSetup(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const allianceId = this.context()?.alliance_id;
    const picked = this.setupAlliance();
    if (!allianceId || !picked) return;
    this.saving.set(true);
    try {
      await firstValueFrom(this.api.post(`api/alliances/${allianceId}/setup`, {
        albion_alliance_id: picked.id,
        albion_api_region: 'europe',
        member_guild_ids: this.setupMembers(),
      }));
      this.setupOpen.set(false);
      this.toasts.success(this.t('admin.alliance.linkedDone'));
      await this.load();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async leaveAlliance(): Promise<void> {
    const ctx = this.context();
    const guildId = this.auth.profile()?.tenant_id;
    if (!ctx?.alliance_id || !guildId) {
      return;
    }
    this.saving.set(true);
    try {
      await firstValueFrom(
        this.api.post(`api/alliances/${ctx.alliance_id}/members/${guildId}/leave`, {}),
      );
      this.toasts.success(this.t('admin.alliance.leftDone'));
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
