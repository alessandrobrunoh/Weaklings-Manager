import { COMPACT_FEATURE_STYLES } from '../compact-feature.styles';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  DiscordChannelKind,
  DiscordChannelView,
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
import { Tabs, type TabOption } from '../../shared/components/tabs/tabs';
import { channelSelectOptions, roleSelectOptions } from '../../shared/discord/discord-options';

interface ApplicationsDraft {
  discord_applications_channel_id: string;
  discord_tickets_archive_channel_id: string;
  discord_applications_manage_role_id: string;
  discord_applications_accepted_role_id: string;
  discord_applications_status_channel_id: string;
  discord_applications_open: string;
  discord_applications_panel_title: string;
  discord_applications_panel_message: string;
  discord_applications_welcome_title: string;
  discord_applications_welcome_message: string;
  discord_applications_status_open_message: string;
  discord_applications_status_closed_message: string;
  discord_applications_manage_title: string;
  discord_applications_manage_message: string;
  discord_applications_accept_title: string;
  discord_applications_accept_message: string;
  discord_applications_decline_title: string;
  discord_applications_decline_message: string;
  discord_applications_close_title: string;
  discord_applications_close_message: string;
  discord_applications_no_permission_title: string;
  discord_applications_no_permission_message: string;
  discord_applications_already_open_title: string;
  discord_applications_already_open_message: string;
  discord_applications_closed_title: string;
  discord_applications_closed_message: string;
  discord_applications_error_message: string;
  discord_applications_final_title: string;
  discord_applications_result_message: string;
  discord_applications_panel_message_id: string;
  discord_tickets_welcome_title: string;
  discord_tickets_welcome_message: string;
  discord_tickets_closed_title: string;
  discord_tickets_closed_message: string;
}

interface MessageField {
  readonly field: keyof ApplicationsDraft;
  readonly labelKey: TranslationKey;
  readonly kind: 'title' | 'message';
}

interface MessageGroup {
  readonly legendKey: TranslationKey;
  readonly fields: readonly MessageField[];
}

const EMPTY_DRAFT: ApplicationsDraft = {
  discord_applications_channel_id: '',
  discord_tickets_archive_channel_id: '',
  discord_applications_manage_role_id: '',
  discord_applications_accepted_role_id: '',
  discord_applications_status_channel_id: '',
  discord_applications_open: 'false',
  discord_applications_panel_title: 'Applications',
  discord_applications_panel_message: 'Clicca il pulsante per creare una application.',
  discord_applications_welcome_title: 'Benvenuto',
  discord_applications_welcome_message: 'Di cosa hai bisogno?',
  discord_applications_status_open_message: 'Le application sono aperte.',
  discord_applications_status_closed_message: 'Le application sono chiuse.',
  discord_applications_manage_title: 'Gestisci application',
  discord_applications_manage_message: 'Usa i pulsanti qui sotto per gestire questa application.',
  discord_applications_accept_title: 'Application accettata',
  discord_applications_accept_message: 'La tua application è stata accettata.',
  discord_applications_decline_title: 'Application rifiutata',
  discord_applications_decline_message: 'La tua application è stata rifiutata.',
  discord_applications_close_title: 'Application chiusa',
  discord_applications_close_message: 'Questa application è stata chiusa.',
  discord_applications_no_permission_title: 'Permessi insufficienti',
  discord_applications_no_permission_message: 'Non hai il permesso di gestire le application.',
  discord_applications_already_open_title: 'Application già aperta',
  discord_applications_already_open_message: 'Hai già un’application aperta.',
  discord_applications_closed_title: 'Application chiuse',
  discord_applications_closed_message: 'Le application sono attualmente chiuse.',
  discord_applications_error_message: 'Si è verificato un errore. Riprova più tardi.',
  discord_applications_final_title: 'Application conclusa',
  discord_applications_result_message: 'Grazie per aver inviato la tua application.',
  discord_applications_panel_message_id: '',
  discord_tickets_welcome_title: 'Ticket di supporto',
  discord_tickets_welcome_message: 'Descrivi qui il problema: un membro dello staff ti risponderà appena possibile.',
  discord_tickets_closed_title: 'Ticket chiuso',
  discord_tickets_closed_message: 'Questo ticket è stato chiuso.',
};

const MESSAGE_GROUPS: readonly MessageGroup[] = [
  {
    legendKey: 'admin.applications.welcomeGroup',
    fields: [
      {
        field: 'discord_applications_welcome_title',
        labelKey: 'admin.applications.welcomeTitle',
        kind: 'title',
      },
      {
        field: 'discord_applications_welcome_message',
        labelKey: 'admin.applications.welcomeMessage',
        kind: 'message',
      },
    ],
  },
  {
    legendKey: 'admin.applications.statusGroup',
    fields: [
      {
        field: 'discord_applications_status_open_message',
        labelKey: 'admin.applications.statusOpenMessage',
        kind: 'message',
      },
      {
        field: 'discord_applications_status_closed_message',
        labelKey: 'admin.applications.statusClosedMessage',
        kind: 'message',
      },
    ],
  },
  {
    legendKey: 'admin.applications.manageGroup',
    fields: [
      {
        field: 'discord_applications_manage_title',
        labelKey: 'admin.applications.manageTitle',
        kind: 'title',
      },
      {
        field: 'discord_applications_manage_message',
        labelKey: 'admin.applications.manageMessage',
        kind: 'message',
      },
    ],
  },
  {
    legendKey: 'admin.applications.acceptGroup',
    fields: [
      {
        field: 'discord_applications_accept_title',
        labelKey: 'admin.applications.acceptTitle',
        kind: 'title',
      },
      {
        field: 'discord_applications_accept_message',
        labelKey: 'admin.applications.acceptMessage',
        kind: 'message',
      },
    ],
  },
  {
    legendKey: 'admin.applications.declineGroup',
    fields: [
      {
        field: 'discord_applications_decline_title',
        labelKey: 'admin.applications.declineTitle',
        kind: 'title',
      },
      {
        field: 'discord_applications_decline_message',
        labelKey: 'admin.applications.declineMessage',
        kind: 'message',
      },
    ],
  },
  {
    legendKey: 'admin.applications.closeGroup',
    fields: [
      {
        field: 'discord_applications_close_title',
        labelKey: 'admin.applications.closeTitle',
        kind: 'title',
      },
      {
        field: 'discord_applications_close_message',
        labelKey: 'admin.applications.closeMessage',
        kind: 'message',
      },
    ],
  },
  {
    legendKey: 'admin.applications.noPermissionGroup',
    fields: [
      {
        field: 'discord_applications_no_permission_title',
        labelKey: 'admin.applications.noPermissionTitle',
        kind: 'title',
      },
      {
        field: 'discord_applications_no_permission_message',
        labelKey: 'admin.applications.noPermissionMessage',
        kind: 'message',
      },
    ],
  },
  {
    legendKey: 'admin.applications.alreadyOpenGroup',
    fields: [
      {
        field: 'discord_applications_already_open_title',
        labelKey: 'admin.applications.alreadyOpenTitle',
        kind: 'title',
      },
      {
        field: 'discord_applications_already_open_message',
        labelKey: 'admin.applications.alreadyOpenMessage',
        kind: 'message',
      },
    ],
  },
  {
    legendKey: 'admin.applications.closedGroup',
    fields: [
      {
        field: 'discord_applications_closed_title',
        labelKey: 'admin.applications.closedTitle',
        kind: 'title',
      },
      {
        field: 'discord_applications_closed_message',
        labelKey: 'admin.applications.closedMessage',
        kind: 'message',
      },
    ],
  },
  {
    legendKey: 'admin.applications.errorGroup',
    fields: [
      {
        field: 'discord_applications_error_message',
        labelKey: 'admin.applications.errorMessage',
        kind: 'message',
      },
    ],
  },
  {
    legendKey: 'admin.applications.finalGroup',
    fields: [
      {
        field: 'discord_applications_final_title',
        labelKey: 'admin.applications.finalTitle',
        kind: 'title',
      },
      {
        field: 'discord_applications_result_message',
        labelKey: 'admin.applications.finalMessage',
        kind: 'message',
      },
    ],
  },
  {
    legendKey: 'admin.applications.ticketGroup',
    fields: [
      {
        field: 'discord_tickets_welcome_title',
        labelKey: 'admin.applications.ticketWelcomeTitle',
        kind: 'title',
      },
      {
        field: 'discord_tickets_welcome_message',
        labelKey: 'admin.applications.ticketWelcomeMessage',
        kind: 'message',
      },
      {
        field: 'discord_tickets_closed_title',
        labelKey: 'admin.applications.ticketClosedTitle',
        kind: 'title',
      },
      {
        field: 'discord_tickets_closed_message',
        labelKey: 'admin.applications.ticketClosedMessage',
        kind: 'message',
      },
    ],
  },
];

/** Open/closed switch for the Discord applications panel. */
const STATUS_TABS = ['open', 'closed'] as const;
type StatusTab = (typeof STATUS_TABS)[number];

/**
 * Discord applications panel: open/closed state, channels, roles, and bot copy.
 */
@Component({
  selector: 'app-admin-applications',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Loading, PageHeader, PageStack, SearchableSelect, Tabs],
  styles: [COMPACT_FEATURE_STYLES, `
    .status-card {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
    }
    .message-group {
      margin: 0;
      padding: 1rem;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-cards);
      background: var(--color-surface-2);
    }
    .message-group legend {
      padding-inline: 0.375rem;
      color: var(--color-text);
      font-size: var(--ui-text-sm);
      font-weight: 600;
    }
  `],
  template: `
    <form (submit)="save($event)">
      <app-page-header
        [title]="t('admin.applications.title')"
        [subtitle]="t('admin.applications.hint')"
        [badge]="loaded() ? (isOpen() ? t('admin.applications.open') : t('admin.applications.closed')) : undefined"
      >
        @if (loaded()) {
          <button type="submit" class="btn btn--primary" [disabled]="saving()">
            {{ t('admin.applications.save') }}
          </button>
        }
      </app-page-header>

      <app-page-stack>
        @if (loading()) {
          <app-loading variant="detail" [label]="t('common.loading')" />
        } @else {
          <section class="card">
            <div class="status-card">
              <div class="min-w-0">
                <h2 class="section-title">{{ t('admin.applications.statusLabel') }}</h2>
                <p class="hint mt-1 max-w-2xl">
                  {{ isOpen() ? t('admin.applications.openHint') : t('admin.applications.closedHint') }}
                </p>
                <p class="hint mt-1 max-w-2xl">
                  {{ t('admin.applications.saveStatusHint') }}
                </p>
              </div>
              <app-tabs
                variant="segmented"
                [ariaLabel]="t('admin.applications.statusLabel')"
                [options]="statusTabs()"
                [active]="statusTab()"
                (activeChange)="onStatusChange($event)"
              />
            </div>
          </section>

          <section class="card">
            <h2 class="section-title">{{ t('admin.applications.channelsTitle') }}</h2>
            <p class="hint mb-4 mt-1 max-w-2xl">
              {{ t('admin.applications.channelsHint') }}
            </p>
            <div class="grid gap-4 sm:grid-cols-2">
              <label>
                <span class="label">{{ t('admin.applications.panelChannel') }}</span>
                <app-searchable-select
                  class="mt-1 block"
                  [options]="channelOptions(['text'], draft().discord_applications_channel_id)"
                  [value]="draft().discord_applications_channel_id"
                  [emptyLabel]="t('admin.applications.placeholder')"
                  [searchPlaceholder]="t('common.search')"
                  [noMatchesLabel]="t('picker.noMatches')"
                  [emptyOptionsLabel]="t('picker.empty')"
                  [loading]="catalogLoading()"
                  [ariaLabel]="t('admin.applications.panelChannel')"
                  (valueChange)="setDraft('discord_applications_channel_id', $event)"
                />
                <span class="hint mt-1 block">
                  {{ t('admin.applications.panelChannelHint') }}
                </span>
              </label>
              <label>
                <span class="label">{{ t('admin.applications.archiveCategory') }}</span>
                <app-searchable-select
                  class="mt-1 block"
                  [options]="channelOptions(['text'], draft().discord_tickets_archive_channel_id)"
                  [value]="draft().discord_tickets_archive_channel_id"
                  [emptyLabel]="t('admin.applications.placeholder')"
                  [searchPlaceholder]="t('common.search')"
                  [noMatchesLabel]="t('picker.noMatches')"
                  [emptyOptionsLabel]="t('picker.empty')"
                  [loading]="catalogLoading()"
                  [ariaLabel]="t('admin.applications.archiveCategory')"
                  (valueChange)="setDraft('discord_tickets_archive_channel_id', $event)"
                />
                <span class="hint mt-1 block">
                  {{ t('admin.applications.archiveHint') }}
                </span>
              </label>
              <label>
                <span class="label">{{ t('admin.applications.manageRole') }}</span>
                <app-searchable-select
                  class="mt-1 block"
                  [options]="roleOptions(draft().discord_applications_manage_role_id)"
                  [value]="draft().discord_applications_manage_role_id"
                  [emptyLabel]="t('admin.applications.placeholder')"
                  [searchPlaceholder]="t('common.search')"
                  [noMatchesLabel]="t('picker.noMatches')"
                  [emptyOptionsLabel]="t('picker.empty')"
                  [loading]="catalogLoading()"
                  [ariaLabel]="t('admin.applications.manageRole')"
                  (valueChange)="setDraft('discord_applications_manage_role_id', $event)"
                />
                <span class="hint mt-1 block">
                  {{ t('admin.applications.manageRoleHint') }}
                </span>
              </label>
              <label>
                <span class="label">{{ t('admin.applications.acceptedRole') }}</span>
                <app-searchable-select
                  class="mt-1 block"
                  [options]="roleOptions(draft().discord_applications_accepted_role_id)"
                  [value]="draft().discord_applications_accepted_role_id"
                  [emptyLabel]="t('admin.applications.placeholder')"
                  [searchPlaceholder]="t('common.search')"
                  [noMatchesLabel]="t('picker.noMatches')"
                  [emptyOptionsLabel]="t('picker.empty')"
                  [loading]="catalogLoading()"
                  [ariaLabel]="t('admin.applications.acceptedRole')"
                  (valueChange)="setDraft('discord_applications_accepted_role_id', $event)"
                />
                <span class="hint mt-1 block">
                  {{ t('admin.applications.acceptedRoleHint') }}
                </span>
              </label>
              <label>
                <span class="label">{{ t('admin.applications.statusChannel') }}</span>
                <app-searchable-select
                  class="mt-1 block"
                  [options]="channelOptions(['text'], draft().discord_applications_status_channel_id)"
                  [value]="draft().discord_applications_status_channel_id"
                  [emptyLabel]="t('admin.applications.placeholder')"
                  [searchPlaceholder]="t('common.search')"
                  [noMatchesLabel]="t('picker.noMatches')"
                  [emptyOptionsLabel]="t('picker.empty')"
                  [loading]="catalogLoading()"
                  [ariaLabel]="t('admin.applications.statusChannel')"
                  (valueChange)="setDraft('discord_applications_status_channel_id', $event)"
                />
                <span class="hint mt-1 block">
                  {{ t('admin.applications.statusChannelHint') }}
                </span>
              </label>
            </div>
          </section>

          <section class="card">
            <h2 class="section-title">{{ t('admin.applications.panelCardTitle') }}</h2>
            <p class="hint mb-4 mt-1 max-w-2xl">
              {{ t('admin.applications.panelCardHint') }}
            </p>
            <div class="grid gap-4">
              <label>
                <span class="label">{{ t('admin.applications.panelTitle') }}</span>
                <input
                  id="applications-panel-title"
                  name="applications-panel-title"
                  class="input"
                  type="text"
                  maxlength="256"
                  [value]="draft().discord_applications_panel_title"
                  aria-describedby="applications-panel-title-hint"
                  (input)="updateField('discord_applications_panel_title', $event)"
                />
                <span id="applications-panel-title-hint" class="hint mt-1 block">
                  {{ t('admin.applications.panelTitleHint') }}
                </span>
              </label>
              <label>
                <span class="label">{{ t('admin.applications.panelMessage') }}</span>
                <textarea
                  id="applications-panel-message"
                  name="applications-panel-message"
                  class="input min-h-28"
                  maxlength="4000"
                  [value]="draft().discord_applications_panel_message"
                  aria-describedby="applications-panel-message-hint"
                  (input)="updateField('discord_applications_panel_message', $event)"
                ></textarea>
                <span id="applications-panel-message-hint" class="hint mt-1 block">
                  {{ t('admin.applications.panelMessageHint') }}
                </span>
              </label>
            </div>
          </section>

          <section class="card">
            <h2 class="section-title">{{ t('admin.applications.messagesTitle') }}</h2>
            <p class="hint mb-4 mt-1 max-w-2xl">
              {{ t('admin.applications.messagesHint') }}
            </p>
            <div class="grid gap-4 lg:grid-cols-2">
              @for (group of messageGroups; track group.legendKey) {
                <fieldset class="message-group">
                  <legend>{{ t(group.legendKey) }}</legend>
                  <div class="grid gap-3">
                    @for (field of group.fields; track field.field) {
                      <label>
                        <span class="label">{{ t(field.labelKey) }}</span>
                        @if (field.kind === 'title') {
                          <input
                            class="input"
                            type="text"
                            maxlength="256"
                            [id]="fieldId(field.field)"
                            [name]="field.field"
                            [value]="draft()[field.field]"
                            [attr.aria-describedby]="fieldId(field.field) + '-hint'"
                            (input)="updateField(field.field, $event)"
                          />
                        } @else {
                          <textarea
                            class="input min-h-24"
                            maxlength="4000"
                            [id]="fieldId(field.field)"
                            [name]="field.field"
                            [value]="draft()[field.field]"
                            [attr.aria-describedby]="fieldId(field.field) + '-hint'"
                            (input)="updateField(field.field, $event)"
                          ></textarea>
                        }
                        <span class="hint mt-1 block" [id]="fieldId(field.field) + '-hint'">
                          {{ field.kind === 'title' ? t('admin.applications.titleHint') : t('admin.applications.textHint') }}
                        </span>
                      </label>
                    }
                  </div>
                </fieldset>
              }
            </div>
          </section>
        }
      </app-page-stack>
    </form>
  `,
})
export class AdminApplications {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly messageGroups = MESSAGE_GROUPS;
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly catalogLoading = signal(false);
  protected readonly draft = signal<ApplicationsDraft>({ ...EMPTY_DRAFT });
  protected readonly discordRoles = signal<DiscordRoleView[]>([]);
  protected readonly discordChannels = signal<DiscordChannelView[]>([]);

  protected readonly loaded = computed(() => !this.loading());
  protected readonly isOpen = computed(() => this.draft().discord_applications_open === 'true');
  protected readonly statusTab = computed<StatusTab>(() => (this.isOpen() ? 'open' : 'closed'));
  protected readonly statusTabs = computed<readonly TabOption[]>(() =>
    STATUS_TABS.map((id) => ({
      id,
      label: this.t(id === 'open' ? 'admin.applications.open' : 'admin.applications.closed'),
    })),
  );
  protected readonly canManage = computed(() => this.auth.hasPermission('admin.settings.manage'));

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    if (this.canManage()) {
      void this.load();
    } else {
      this.loading.set(false);
    }
  }

  protected fieldId(field: keyof ApplicationsDraft): string {
    return `applications-${field}`;
  }

  protected channelOptions(kinds: DiscordChannelKind[], selectedId: string) {
    return channelSelectOptions(this.discordChannels(), kinds, selectedId);
  }

  protected roleOptions(selectedId: string) {
    return roleSelectOptions(this.discordRoles(), selectedId);
  }

  protected setDraft(field: keyof ApplicationsDraft, value: string): void {
    this.draft.update((draft) => ({ ...draft, [field]: value }));
  }

  protected onStatusChange(id: string): void {
    this.setDraft('discord_applications_open', id === 'open' ? 'true' : 'false');
  }

  protected updateField(field: keyof ApplicationsDraft, event: Event): void {
    const value = (event.target as HTMLInputElement | HTMLTextAreaElement).value;
    this.setDraft(field, value);
  }

  protected async save(submit: SubmitEvent): Promise<void> {
    submit.preventDefault();
    this.saving.set(true);
    try {
      const draft = this.draft();
      const body: UpdateGuildSettingsRequest = {
        discord_applications_channel_id: draft.discord_applications_channel_id.trim(),
        discord_tickets_archive_channel_id: draft.discord_tickets_archive_channel_id.trim(),
        discord_applications_manage_role_id: draft.discord_applications_manage_role_id.trim(),
        discord_applications_accepted_role_id: draft.discord_applications_accepted_role_id.trim(),
        discord_applications_status_channel_id: draft.discord_applications_status_channel_id.trim(),
        discord_applications_open: draft.discord_applications_open === 'true',
        discord_applications_panel_title: draft.discord_applications_panel_title.trim(),
        discord_applications_panel_message: draft.discord_applications_panel_message.trim(),
        discord_applications_welcome_title: draft.discord_applications_welcome_title.trim(),
        discord_applications_welcome_message: draft.discord_applications_welcome_message.trim(),
        discord_applications_status_open_message: draft.discord_applications_status_open_message.trim(),
        discord_applications_status_closed_message: draft.discord_applications_status_closed_message.trim(),
        discord_applications_manage_title: draft.discord_applications_manage_title.trim(),
        discord_applications_manage_message: draft.discord_applications_manage_message.trim(),
        discord_applications_accept_title: draft.discord_applications_accept_title.trim(),
        discord_applications_accept_message: draft.discord_applications_accept_message.trim(),
        discord_applications_decline_title: draft.discord_applications_decline_title.trim(),
        discord_applications_decline_message: draft.discord_applications_decline_message.trim(),
        discord_applications_close_title: draft.discord_applications_close_title.trim(),
        discord_applications_close_message: draft.discord_applications_close_message.trim(),
        discord_applications_no_permission_title: draft.discord_applications_no_permission_title.trim(),
        discord_applications_no_permission_message: draft.discord_applications_no_permission_message.trim(),
        discord_applications_already_open_title: draft.discord_applications_already_open_title.trim(),
        discord_applications_already_open_message: draft.discord_applications_already_open_message.trim(),
        discord_applications_closed_title: draft.discord_applications_closed_title.trim(),
        discord_applications_closed_message: draft.discord_applications_closed_message.trim(),
        discord_applications_error_message: draft.discord_applications_error_message.trim(),
        discord_applications_final_title: draft.discord_applications_final_title.trim(),
        discord_applications_result_message: draft.discord_applications_result_message.trim(),
        discord_applications_panel_message_id: draft.discord_applications_panel_message_id.trim(),
        discord_tickets_welcome_title: draft.discord_tickets_welcome_title.trim(),
        discord_tickets_welcome_message: draft.discord_tickets_welcome_message.trim(),
        discord_tickets_closed_title: draft.discord_tickets_closed_title.trim(),
        discord_tickets_closed_message: draft.discord_tickets_closed_message.trim(),
      };
      const updated = await firstValueFrom(
        this.api.put<GuildSettingsView>('api/admin/settings', body),
      );
      this.draft.set(toDraft(updated));
      this.toasts.success(this.t('admin.applications.saved'));
    } catch {
      this.toasts.error(this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    await Promise.all([this.loadSettings(), this.loadCatalog()]);
    this.loading.set(false);
  }

  private async loadSettings(): Promise<void> {
    try {
      const settings = await firstValueFrom(this.api.get<GuildSettingsView>('api/admin/settings'));
      this.draft.set(toDraft(settings));
    } catch {
      this.toasts.error(this.t('common.error'));
    }
  }

  private async loadCatalog(): Promise<void> {
    this.catalogLoading.set(true);
    try {
      const [roles, channels] = await Promise.all([
        firstValueFrom(this.api.get<DiscordRoleView[]>('api/admin/discord/roles')).catch(() =>
          firstValueFrom(this.api.get<DiscordRoleView[]>('api/admin/autorole/roles')),
        ),
        firstValueFrom(this.api.get<DiscordChannelView[]>('api/admin/discord/channels')),
      ]);
      this.discordRoles.set(roles);
      this.discordChannels.set(channels);
    } catch {
      this.toasts.error(this.t('common.error'));
    } finally {
      this.catalogLoading.set(false);
    }
  }
}

function toDraft(settings: GuildSettingsView): ApplicationsDraft {
  return {
    discord_applications_channel_id: settings.discord_applications_channel_id ?? '',
    discord_tickets_archive_channel_id: settings.discord_tickets_archive_channel_id ?? '',
    discord_applications_manage_role_id: settings.discord_applications_manage_role_id ?? '',
    discord_applications_accepted_role_id: settings.discord_applications_accepted_role_id ?? '',
    discord_applications_status_channel_id: settings.discord_applications_status_channel_id ?? '',
    discord_applications_open: String(settings.discord_applications_open),
    discord_applications_panel_title: settings.discord_applications_panel_title ?? 'Applications',
    discord_applications_panel_message:
      settings.discord_applications_panel_message ?? 'Clicca il pulsante per creare una application.',
    discord_applications_welcome_title: settings.discord_applications_welcome_title ?? 'Benvenuto',
    discord_applications_welcome_message:
      settings.discord_applications_welcome_message ?? 'Di cosa hai bisogno?',
    discord_applications_status_open_message:
      settings.discord_applications_status_open_message ?? 'Le application sono aperte.',
    discord_applications_status_closed_message:
      settings.discord_applications_status_closed_message ?? 'Le application sono chiuse.',
    discord_applications_manage_title:
      settings.discord_applications_manage_title ?? 'Gestisci application',
    discord_applications_manage_message:
      settings.discord_applications_manage_message ??
      'Usa i pulsanti qui sotto per gestire questa application.',
    discord_applications_accept_title:
      settings.discord_applications_accept_title ?? 'Application accettata',
    discord_applications_accept_message:
      settings.discord_applications_accept_message ?? 'La tua application è stata accettata.',
    discord_applications_decline_title:
      settings.discord_applications_decline_title ?? 'Application rifiutata',
    discord_applications_decline_message:
      settings.discord_applications_decline_message ?? 'La tua application è stata rifiutata.',
    discord_applications_close_title:
      settings.discord_applications_close_title ?? 'Application chiusa',
    discord_applications_close_message:
      settings.discord_applications_close_message ?? 'Questa application è stata chiusa.',
    discord_applications_no_permission_title:
      settings.discord_applications_no_permission_title ?? 'Permessi insufficienti',
    discord_applications_no_permission_message:
      settings.discord_applications_no_permission_message ??
      'Non hai il permesso di gestire le application.',
    discord_applications_already_open_title:
      settings.discord_applications_already_open_title ?? 'Application già aperta',
    discord_applications_already_open_message:
      settings.discord_applications_already_open_message ?? 'Hai già un’application aperta.',
    discord_applications_closed_title:
      settings.discord_applications_closed_title ?? 'Application chiuse',
    discord_applications_closed_message:
      settings.discord_applications_closed_message ?? 'Le application sono attualmente chiuse.',
    discord_applications_error_message:
      settings.discord_applications_error_message ?? 'Si è verificato un errore. Riprova più tardi.',
    discord_applications_final_title:
      settings.discord_applications_final_title ?? 'Application conclusa',
    discord_applications_result_message:
      settings.discord_applications_result_message ?? 'Grazie per aver inviato la tua application.',
    discord_applications_panel_message_id: settings.discord_applications_panel_message_id ?? '',
    discord_tickets_welcome_title: settings.discord_tickets_welcome_title ?? 'Ticket di supporto',
    discord_tickets_welcome_message:
      settings.discord_tickets_welcome_message ??
      'Descrivi qui il problema: un membro dello staff ti risponderà appena possibile.',
    discord_tickets_closed_title: settings.discord_tickets_closed_title ?? 'Ticket chiuso',
    discord_tickets_closed_message: settings.discord_tickets_closed_message ?? 'Questo ticket è stato chiuso.',
  };
}
