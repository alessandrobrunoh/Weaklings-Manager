import { COMPACT_FEATURE_STYLES } from '../compact-feature.styles';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  DiscordChannelView,
  DiscordRoleView,
  GuildRankView,
  ProgressionSeasonView,
  ProgressionSettingsView,
  UpdateProgressionSettingsRequest,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { DataTable } from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import type { DataTableColumn } from '../../shared/components/data-table/data-table-column';
import { Dialog } from '../../shared/components/dialog/dialog';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { SearchableSelect } from '../../shared/components/searchable-select/searchable-select';
import { StatusChip } from '../../shared/components/status-chip/status-chip';
import { channelSelectOptions } from '../../shared/discord/discord-options';

interface ProgressionDraft {
  xp_base: number;
  xp_exponent: number;
  max_level: number;
  xp_message: number;
  xp_event_create: number;
  xp_event_join: number;
  xp_event_complete: number;
  xp_vod: number;
  message_cooldown_secs: number;
  message_min_chars: number;
  warn_threshold: number;
  vod_forum_channel_id: string;
}

type ProgressionLevel = ProgressionSettingsView['level_preview'][number];

interface RankRow {
  readonly rank: GuildRankView;
  readonly index: number;
}

/** Rank being edited in the dialog. `index` is null while adding a new rank. */
interface RankDialog {
  index: number | null;
  name: string;
  min_xp: number;
  discord_role_id: string;
}

/** Season being edited in the dialog. `id` is null while opening a new season. */
interface SeasonDialog {
  id: number | null;
  name: string;
  starts_at: string;
  ends_at: string;
  activate: boolean;
}

const EMPTY_PROGRESSION_DRAFT: ProgressionDraft = {
  xp_base: 100,
  xp_exponent: 1.5,
  max_level: 50,
  xp_message: 1,
  xp_event_create: 25,
  xp_event_join: 10,
  xp_event_complete: 15,
  xp_vod: 40,
  message_cooldown_secs: 60,
  message_min_chars: 2,
  warn_threshold: 3,
  vod_forum_channel_id: '',
};

const MAX_GUILD_RANKS = 20;

/**
 * XP curve, activity rates, guild ranks, and season calendar.
 */
@Component({
  selector: 'app-admin-progression',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [COMPACT_FEATURE_STYLES],
  imports: [
    DataTable,
    DataTableCell,
    Dialog,
    ErrorState,
    Loading,
    PageHeader,
    PageStack,
    SearchableSelect,
    StatusChip,
  ],
  template: `
    <app-page-header
      [title]="t('admin.progression.title')"
      [subtitle]="t('admin.progression.hint')"
    />

    @if (progressionLoading()) {
      <app-loading variant="detail" />
    } @else if (progressionSettings(); as settings) {
      <app-page-stack>
        <section class="card p-5">
          <form class="grid gap-6" (submit)="saveProgressionSettings($event)">
            <p class="text-xs" style="color: var(--color-text-secondary)">
              {{ t('validation.requiredLegend') }}
            </p>

            <div class="grid gap-4">
              <div>
                <h3 class="section-title section-title--sm">{{ t('admin.progression.curve') }}</h3>
                <p class="hint">{{ t('admin.progression.curveHint') }}</p>
              </div>
              <div class="grid gap-4 sm:grid-cols-3">
                <div class="grid content-start gap-1.5">
                  <label class="grid gap-1.5">
                    <span class="label">
                      {{ t('admin.progression.xpBase') }}
                      <span style="color: var(--color-error)" aria-hidden="true">*</span>
                    </span>
                    <input class="input mono" type="number" min="1" required
                      aria-describedby="progression-help-xp-base"
                      [value]="progressionDraft().xp_base"
                      (input)="updateProgressionNumber('xp_base', $event)" />
                  </label>
                  <p id="progression-help-xp-base" class="hint">{{ t('admin.progression.helpXpBase') }}</p>
                </div>
                <div class="grid content-start gap-1.5">
                  <label class="grid gap-1.5">
                    <span class="label">
                      {{ t('admin.progression.xpExponent') }}
                      <span style="color: var(--color-error)" aria-hidden="true">*</span>
                    </span>
                    <input class="input mono" type="number" min="1" step="0.1" required
                      aria-describedby="progression-help-xp-exponent"
                      [value]="progressionDraft().xp_exponent"
                      (input)="updateProgressionNumber('xp_exponent', $event)" />
                  </label>
                  <p id="progression-help-xp-exponent" class="hint">{{ t('admin.progression.helpXpExponent') }}</p>
                </div>
                <div class="grid content-start gap-1.5">
                  <label class="grid gap-1.5">
                    <span class="label">
                      {{ t('admin.progression.maxLevel') }}
                      <span style="color: var(--color-error)" aria-hidden="true">*</span>
                    </span>
                    <input class="input mono" type="number" min="1" required
                      aria-describedby="progression-help-max-level"
                      [value]="progressionDraft().max_level"
                      (input)="updateProgressionNumber('max_level', $event)" />
                  </label>
                  <p id="progression-help-max-level" class="hint">{{ t('admin.progression.helpMaxLevel') }}</p>
                </div>
              </div>
            </div>

            <div class="grid gap-4">
              <div>
                <h3 class="section-title section-title--sm">{{ t('admin.progression.rates') }}</h3>
                <p class="hint">{{ t('admin.progression.ratesHint') }}</p>
              </div>
              <div class="grid gap-4 sm:grid-cols-3">
                <div class="grid content-start gap-1.5">
                  <label class="grid gap-1.5">
                    <span class="label">
                      {{ t('admin.progression.xpMessage') }}
                      <span style="color: var(--color-error)" aria-hidden="true">*</span>
                    </span>
                    <input class="input mono" type="number" min="0" required
                      aria-describedby="progression-help-xp-message"
                      [value]="progressionDraft().xp_message"
                      (input)="updateProgressionNumber('xp_message', $event)" />
                  </label>
                  <p id="progression-help-xp-message" class="hint">{{ t('admin.progression.helpXpMessage') }}</p>
                </div>
                <div class="grid content-start gap-1.5">
                  <label class="grid gap-1.5">
                    <span class="label">
                      {{ t('admin.progression.xpEventCreate') }}
                      <span style="color: var(--color-error)" aria-hidden="true">*</span>
                    </span>
                    <input class="input mono" type="number" min="0" required
                      aria-describedby="progression-help-xp-event-create"
                      [value]="progressionDraft().xp_event_create"
                      (input)="updateProgressionNumber('xp_event_create', $event)" />
                  </label>
                  <p id="progression-help-xp-event-create" class="hint">{{ t('admin.progression.helpXpEventCreate') }}</p>
                </div>
                <div class="grid content-start gap-1.5">
                  <label class="grid gap-1.5">
                    <span class="label">
                      {{ t('admin.progression.xpEventJoin') }}
                      <span style="color: var(--color-error)" aria-hidden="true">*</span>
                    </span>
                    <input class="input mono" type="number" min="0" required
                      aria-describedby="progression-help-xp-event-join"
                      [value]="progressionDraft().xp_event_join"
                      (input)="updateProgressionNumber('xp_event_join', $event)" />
                  </label>
                  <p id="progression-help-xp-event-join" class="hint">{{ t('admin.progression.helpXpEventJoin') }}</p>
                </div>
                <div class="grid content-start gap-1.5">
                  <label class="grid gap-1.5">
                    <span class="label">
                      {{ t('admin.progression.xpEventComplete') }}
                      <span style="color: var(--color-error)" aria-hidden="true">*</span>
                    </span>
                    <input class="input mono" type="number" min="0" required
                      aria-describedby="progression-help-xp-event-complete"
                      [value]="progressionDraft().xp_event_complete"
                      (input)="updateProgressionNumber('xp_event_complete', $event)" />
                  </label>
                  <p id="progression-help-xp-event-complete" class="hint">{{ t('admin.progression.helpXpEventComplete') }}</p>
                </div>
                <div class="grid content-start gap-1.5">
                  <label class="grid gap-1.5">
                    <span class="label">
                      {{ t('admin.progression.xpVod') }}
                      <span style="color: var(--color-error)" aria-hidden="true">*</span>
                    </span>
                    <input class="input mono" type="number" min="0" required
                      aria-describedby="progression-help-xp-vod"
                      [value]="progressionDraft().xp_vod"
                      (input)="updateProgressionNumber('xp_vod', $event)" />
                  </label>
                  <p id="progression-help-xp-vod" class="hint">{{ t('admin.progression.helpXpVod') }}</p>
                </div>
              </div>
            </div>

            <div class="grid gap-4">
              <div>
                <h3 class="section-title section-title--sm">{{ t('admin.progression.messageLimits') }}</h3>
                <p class="hint">{{ t('admin.progression.messageLimitsHint') }}</p>
              </div>
              <div class="grid gap-4 sm:grid-cols-3">
                <div class="grid content-start gap-1.5">
                  <label class="grid gap-1.5">
                    <span class="label">
                      {{ t('admin.progression.cooldown') }}
                      <span style="color: var(--color-error)" aria-hidden="true">*</span>
                    </span>
                    <input class="input mono" type="number" min="0" required
                      aria-describedby="progression-help-cooldown"
                      [value]="progressionDraft().message_cooldown_secs"
                      (input)="updateProgressionNumber('message_cooldown_secs', $event)" />
                  </label>
                  <p id="progression-help-cooldown" class="hint">{{ t('admin.progression.helpCooldown') }}</p>
                </div>
                <div class="grid content-start gap-1.5">
                  <label class="grid gap-1.5">
                    <span class="label">
                      {{ t('admin.progression.minChars') }}
                      <span style="color: var(--color-error)" aria-hidden="true">*</span>
                    </span>
                    <input class="input mono" type="number" min="0" required
                      aria-describedby="progression-help-min-chars"
                      [value]="progressionDraft().message_min_chars"
                      (input)="updateProgressionNumber('message_min_chars', $event)" />
                  </label>
                  <p id="progression-help-min-chars" class="hint">{{ t('admin.progression.helpMinChars') }}</p>
                </div>
              </div>
            </div>

            <div class="grid gap-4">
              <div>
                <h3 class="section-title section-title--sm">{{ t('admin.progression.moderation') }}</h3>
                <p class="hint">{{ t('admin.progression.moderationHint') }}</p>
              </div>
              <div class="grid gap-4 sm:grid-cols-3">
                <div class="grid content-start gap-1.5">
                  <label class="grid gap-1.5">
                    <span class="label">
                      {{ t('admin.progression.warnThreshold') }}
                      <span style="color: var(--color-error)" aria-hidden="true">*</span>
                    </span>
                    <input class="input mono" type="number" min="1" required
                      aria-describedby="progression-help-warn-threshold"
                      [value]="progressionDraft().warn_threshold"
                      (input)="updateProgressionNumber('warn_threshold', $event)" />
                  </label>
                  <p id="progression-help-warn-threshold" class="hint">{{ t('admin.progression.helpWarnThreshold') }}</p>
                </div>
                <div class="grid content-start gap-1.5 sm:col-span-2">
                  <label class="grid gap-1.5">
                    <span class="label">{{ t('admin.progression.vodForum') }}</span>
                    <app-searchable-select
                      class="block"
                      [options]="forumChannelOptions()"
                      [value]="progressionDraft().vod_forum_channel_id"
                      [emptyLabel]="t('admin.discord.placeholder')"
                      [searchPlaceholder]="t('common.search')"
                      [noMatchesLabel]="t('picker.noMatches')"
                      [emptyOptionsLabel]="t('picker.empty')"
                      [ariaLabel]="t('admin.progression.vodForum')"
                      (valueChange)="setVodForumChannel($event)"
                    />
                  </label>
                  <p class="hint">{{ t('admin.progression.helpVodForum') }}</p>
                </div>
              </div>
            </div>

            <div>
              <button type="submit" class="btn btn--primary" [disabled]="progressionSaving()">
                {{ t('admin.progression.save') }}
              </button>
            </div>
          </form>
        </section>

        @if (settings.level_preview.length > 0) {
          <section class="card p-5">
            <div class="mb-3">
              <h3 class="section-title section-title--sm">{{ t('admin.progression.preview') }}</h3>
              <p class="hint">{{ t('admin.progression.levelsHint') }}</p>
            </div>
            <app-data-table
              [columns]="levelColumns"
              [rows]="settings.level_preview"
              [trackBy]="trackLevel"
              [ariaLabel]="t('admin.progression.preview')"
              [hideSearch]="true"
              [hidePageSize]="true"
              [pageSize]="20"
              [syncUrl]="false"
              mobileLayout="stack"
              emptyIcon="sparkles"
            >
              <ng-template dataTableCell="xp" let-row>
                <span class="num">{{ row.xp }}</span>
              </ng-template>
            </app-data-table>
          </section>
        }

        <section class="card p-5">
          <form class="grid gap-4" (submit)="saveGuildRanks($event)">
            <div>
              <h3 class="section-title section-title--sm">{{ t('admin.progression.ranksTitle') }}</h3>
              <p class="hint">{{ t('admin.progression.ranksHint') }}</p>
            </div>
            <app-data-table
              [columns]="rankColumns"
              [rows]="rankRows()"
              [trackBy]="trackRank"
              [ariaLabel]="t('admin.progression.ranksTitle')"
              [hideSearch]="true"
              [hidePageSize]="true"
              [pageSize]="20"
              [syncUrl]="false"
              mobileLayout="stack"
              emptyIcon="sparkles"
            >
              <ng-template dataTableCell="role" let-row>
                {{ roleLabel(row.rank.discord_role_id) }}
              </ng-template>
              <ng-template dataTableCell="actions" let-row>
                <div class="flex justify-end">
                  <button type="button" class="btn btn--outline btn--sm"
                    [attr.aria-label]="t('admin.progression.editNamed', { name: row.rank.name })"
                    (click)="openRankDialog(row.index)">
                    {{ t('common.edit') }}
                  </button>
                </div>
              </ng-template>
            </app-data-table>
            <div class="flex flex-wrap items-center gap-3">
              <button type="button" class="btn btn--outline"
                [disabled]="guildRanks().length >= maxGuildRanks"
                (click)="openRankDialog(null)">
                {{ t('admin.progression.rankAdd') }}
              </button>
              <button type="submit" class="btn btn--primary" [disabled]="rankSaving()">
                {{ t('admin.progression.rankSave') }}
              </button>
            </div>
          </form>
        </section>

        <section class="card p-5">
          <div class="mb-3 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 class="section-title section-title--sm">{{ t('admin.progression.seasons') }}</h3>
              <p class="hint">{{ t('admin.progression.seasonsHint') }}</p>
            </div>
            <button type="button" class="btn btn--primary" (click)="openSeasonDialog(null)">
              {{ t('admin.progression.createSeason') }}
            </button>
          </div>
          <app-data-table
            [columns]="seasonColumns"
            [rows]="progressionSeasons()"
            [trackBy]="trackSeason"
            [ariaLabel]="t('admin.progression.seasons')"
            [hideSearch]="true"
            [hidePageSize]="true"
            [pageSize]="20"
            [syncUrl]="false"
            mobileLayout="stack"
            emptyIcon="sparkles"
          >
            <ng-template dataTableCell="starts_at" let-row>
              {{ formatDateTime(row.starts_at) }}
            </ng-template>
            <ng-template dataTableCell="ends_at" let-row>
              {{ formatDateTime(row.ends_at) }}
            </ng-template>
            <ng-template dataTableCell="status" let-row>
              @if (row.is_active) {
                <app-status-chip value="active" [toneOverride]="'success'" [label]="t('admin.progression.active')" />
              } @else {
                <app-status-chip value="inactive" [label]="t('admin.progression.inactive')" />
              }
            </ng-template>
            <ng-template dataTableCell="actions" let-row>
              <div class="flex flex-wrap justify-end gap-2">
                @if (!row.is_active) {
                  <button type="button" class="btn btn--outline btn--sm"
                    (click)="activateSeason(row.id)">
                    {{ t('admin.progression.activate') }}
                  </button>
                }
                <button type="button" class="btn btn--outline btn--sm"
                  [attr.aria-label]="t('admin.progression.editNamed', { name: row.name })"
                  (click)="openSeasonDialog(row)">
                  {{ t('common.edit') }}
                </button>
              </div>
            </ng-template>
          </app-data-table>
        </section>
      </app-page-stack>

      @if (rankDialog(); as dialog) {
        <app-dialog
          [title]="t(dialog.index === null ? 'admin.progression.rankAdd' : 'admin.progression.rankEditTitle')"
          (closed)="closeRankDialog()"
        >
          <form id="rank-dialog-form" class="grid gap-4" (submit)="saveRankDialog($event)">
            <p class="text-xs" style="color: var(--color-text-secondary)">
              {{ t('validation.requiredLegend') }}
            </p>
            <label class="grid gap-1.5">
              <span class="label">
                {{ t('admin.progression.rankName') }}
                <span style="color: var(--color-error)" aria-hidden="true">*</span>
              </span>
              <input class="input" type="text" maxlength="40" required [value]="dialog.name"
                (input)="updateRankDialog('name', $event)" />
            </label>
            <div class="grid content-start gap-1.5">
              <label class="grid gap-1.5">
                <span class="label">
                  {{ t('admin.progression.rankMinXp') }}
                  <span style="color: var(--color-error)" aria-hidden="true">*</span>
                </span>
                <input class="input mono" type="number" min="0" required
                  [readonly]="dialog.index === 0"
                  [attr.aria-describedby]="dialog.index === 0 ? 'rank-dialog-floor-hint' : null"
                  [value]="dialog.min_xp"
                  (input)="updateRankDialog('min_xp', $event)" />
              </label>
              @if (dialog.index === 0) {
                <p id="rank-dialog-floor-hint" class="hint">{{ t('admin.progression.rankFloorHint') }}</p>
              }
            </div>
            <label class="grid gap-1.5">
              <span class="label">{{ t('admin.progression.rankDiscordRole') }}</span>
              <select class="input" [value]="dialog.discord_role_id" (change)="updateRankDialogRole($event)">
                <option value="">{{ t('admin.progression.rankUnmapped') }}</option>
                @for (role of discordRoles(); track role.id) {
                  <option [value]="role.id">{{ role.name }} ({{ role.id }})</option>
                }
                @if (dialog.discord_role_id && !hasDiscordRole(dialog.discord_role_id)) {
                  <option [value]="dialog.discord_role_id">
                    {{ dialog.discord_role_id }} ({{ t('admin.progression.rankUnavailable') }})
                  </option>
                }
              </select>
            </label>
          </form>
          <div dialogFooter class="flex w-full flex-wrap items-center justify-between gap-2">
            @if (dialog.index !== null && dialog.index > 0) {
              <button type="button" class="btn btn--outline" (click)="removeRankFromDialog()">
                {{ t('admin.progression.rankRemove', { name: dialog.name }) }}
              </button>
            } @else {
              <span></span>
            }
            <div class="flex gap-2">
              <button type="button" class="btn btn--ghost" (click)="closeRankDialog()">
                {{ t('common.cancel') }}
              </button>
              <button type="submit" form="rank-dialog-form" class="btn btn--primary">
                {{ t('common.save') }}
              </button>
            </div>
          </div>
        </app-dialog>
      }

      @if (seasonDialog(); as dialog) {
        <app-dialog
          [title]="t(dialog.id === null ? 'admin.progression.createSeason' : 'admin.progression.seasonEditTitle')"
          (closed)="closeSeasonDialog()"
        >
          <form id="season-dialog-form" class="grid gap-4" (submit)="saveSeasonDialog($event)">
            <p class="text-xs" style="color: var(--color-text-secondary)">
              {{ t('validation.requiredLegend') }}
            </p>
            <label class="grid gap-1.5">
              <span class="label">
                {{ t('admin.progression.seasonName') }}
                <span style="color: var(--color-error)" aria-hidden="true">*</span>
              </span>
              <input class="input" type="text" [value]="dialog.name" required
                (input)="updateSeasonDialog('name', $event)" />
            </label>
            <label class="grid gap-1.5">
              <span class="label">
                {{ t('admin.progression.startsAt') }}
                <span style="color: var(--color-error)" aria-hidden="true">*</span>
              </span>
              <input class="input mono" type="datetime-local" required [value]="dialog.starts_at"
                (input)="updateSeasonDialog('starts_at', $event)" />
            </label>
            <label class="grid gap-1.5">
              <span class="label">
                {{ t('admin.progression.endsAt') }}
                <span style="color: var(--color-error)" aria-hidden="true">*</span>
              </span>
              <input class="input mono" type="datetime-local" required [value]="dialog.ends_at"
                (input)="updateSeasonDialog('ends_at', $event)" />
            </label>
            @if (dialog.id === null) {
              <label class="flex items-center gap-2">
                <input class="checkbox" type="checkbox" [checked]="dialog.activate"
                  (change)="toggleSeasonDialogActivate($event)" />
                <span>{{ t('admin.progression.activateOnCreate') }}</span>
              </label>
            }
          </form>
          <div dialogFooter class="flex w-full flex-wrap justify-end gap-2">
            <button type="button" class="btn btn--ghost" (click)="closeSeasonDialog()">
              {{ t('common.cancel') }}
            </button>
            <button type="submit" form="season-dialog-form" class="btn btn--primary">
              {{ t(dialog.id === null ? 'admin.progression.createSeason' : 'common.save') }}
            </button>
          </div>
        </app-dialog>
      }
    } @else {
      <app-error-state
        [message]="t('common.error')"
        [retryLabel]="t('common.retry')"
        (retry)="loadProgression()"
      />
    }
  `,
})
export class AdminProgression {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly maxGuildRanks = MAX_GUILD_RANKS;
  protected readonly progressionLoading = signal(true);
  protected readonly progressionSaving = signal(false);
  protected readonly progressionSettings = signal<ProgressionSettingsView | null>(null);
  protected readonly progressionDraft = signal<ProgressionDraft>({ ...EMPTY_PROGRESSION_DRAFT });
  protected readonly progressionSeasons = signal<ProgressionSeasonView[]>([]);
  protected readonly discordChannels = signal<DiscordChannelView[]>([]);
  protected readonly discordRoles = signal<DiscordRoleView[]>([]);
  protected readonly guildRanks = signal<GuildRankView[]>([]);
  protected readonly rankSaving = signal(false);
  protected readonly rankDialog = signal<RankDialog | null>(null);
  protected readonly seasonDialog = signal<SeasonDialog | null>(null);
  protected readonly rankRows = computed<RankRow[]>(() =>
    this.guildRanks().map((rank, index) => ({ rank, index })),
  );

  protected readonly levelColumns: readonly DataTableColumn<ProgressionLevel>[] = [
    { key: 'level', label: 'admin.progression.level' },
    { key: 'xp', label: 'admin.progression.xpNeeded', align: 'right' },
  ];

  protected readonly rankColumns: readonly DataTableColumn<RankRow>[] = [
    { key: 'name', label: 'admin.progression.rankName', accessor: (row) => row.rank.name },
    { key: 'min_xp', label: 'admin.progression.rankMinXp', align: 'right', accessor: (row) => row.rank.min_xp },
    { key: 'role', label: 'admin.progression.rankDiscordRole' },
    { key: 'actions', label: 'common.actions', align: 'right' },
  ];

  protected readonly seasonColumns: readonly DataTableColumn<ProgressionSeasonView>[] = [
    { key: 'name', label: 'admin.progression.seasonName' },
    { key: 'starts_at', label: 'admin.progression.startsAt' },
    { key: 'ends_at', label: 'admin.progression.endsAt' },
    { key: 'status', label: 'common.status' },
    { key: 'actions', label: 'common.actions', align: 'right' },
  ];

  protected readonly trackLevel = (row: ProgressionLevel) => row.level;
  protected readonly trackRank = (row: RankRow) => row.index;
  protected readonly trackSeason = (row: ProgressionSeasonView) => row.id;

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  constructor() {
    void this.loadProgression();
  }

  protected async loadProgression(): Promise<void> {
    this.progressionLoading.set(true);
    try {
      const [settings, seasons] = await Promise.all([
        firstValueFrom(this.api.get<ProgressionSettingsView>('api/progression/settings')),
        firstValueFrom(this.api.get<ProgressionSeasonView[]>('api/progression/seasons')),
      ]);
      this.progressionSettings.set(settings);
      this.progressionDraft.set(toProgressionDraft(settings));
      this.guildRanks.set(settings.guild_ranks);
      this.progressionSeasons.set(seasons);
      void this.loadDiscordChannels();
      void this.loadDiscordRoles();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.progressionLoading.set(false);
    }
  }

  protected updateProgressionNumber(field: keyof ProgressionDraft, event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.progressionDraft.update((draft) => ({ ...draft, [field]: value }));
  }

  protected forumChannelOptions() {
    return channelSelectOptions(
      this.discordChannels(),
      ['forum'],
      this.progressionDraft().vod_forum_channel_id,
    );
  }

  protected setVodForumChannel(channelId: string): void {
    this.progressionDraft.update((draft) => ({ ...draft, vod_forum_channel_id: channelId }));
  }

  private async loadDiscordChannels(): Promise<void> {
    try {
      const channels = await firstValueFrom(
        this.api.get<DiscordChannelView[]>('api/admin/discord/channels'),
      );
      this.discordChannels.set(channels);
    } catch {
      // The VOD picker stays empty until Discord listing is available.
    }
  }

  private async loadDiscordRoles(): Promise<void> {
    try {
      this.discordRoles.set(await firstValueFrom(
        this.api.get<DiscordRoleView[]>('api/admin/discord/roles'),
      ));
    } catch {
      // Existing mappings remain visible as unavailable options.
    }
  }

  protected hasDiscordRole(roleId: string): boolean {
    return this.discordRoles().some((role) => role.id === roleId);
  }

  protected roleLabel(roleId: string | null): string {
    if (!roleId) {
      return this.t('admin.progression.rankUnmapped');
    }
    const role = this.discordRoles().find((row) => row.id === roleId);
    return role
      ? role.name
      : `${roleId} (${this.t('admin.progression.rankUnavailable')})`;
  }

  protected openRankDialog(index: number | null): void {
    if (index === null) {
      const ranks = this.guildRanks();
      if (ranks.length >= MAX_GUILD_RANKS) {
        return;
      }
      this.rankDialog.set({
        index: null,
        name: this.t('admin.progression.rankNewName'),
        min_xp: (ranks.at(-1)?.min_xp ?? -1) + 1,
        discord_role_id: '',
      });
      return;
    }
    const rank = this.guildRanks()[index];
    if (!rank) {
      return;
    }
    this.rankDialog.set({
      index,
      name: rank.name,
      min_xp: rank.min_xp,
      discord_role_id: rank.discord_role_id ?? '',
    });
  }

  protected closeRankDialog(): void {
    this.rankDialog.set(null);
  }

  protected updateRankDialog(field: 'name' | 'min_xp', event: Event): void {
    const input = event.target as HTMLInputElement;
    const value = field === 'name' ? input.value : Number(input.value);
    this.rankDialog.update((dialog) => (dialog ? { ...dialog, [field]: value } : dialog));
  }

  protected updateRankDialogRole(event: Event): void {
    const roleId = (event.target as HTMLSelectElement).value;
    this.rankDialog.update((dialog) => (dialog ? { ...dialog, discord_role_id: roleId } : dialog));
  }

  protected saveRankDialog(submit: SubmitEvent): void {
    submit.preventDefault();
    const dialog = this.rankDialog();
    if (!dialog) {
      return;
    }
    const rank: GuildRankView = {
      name: dialog.name.trim(),
      min_xp: dialog.min_xp,
      discord_role_id: dialog.discord_role_id || null,
    };
    this.guildRanks.update((ranks) => dialog.index === null
      ? [...ranks, rank]
      : ranks.map((row, i) => (i === dialog.index ? rank : row)));
    this.rankDialog.set(null);
  }

  protected removeRankFromDialog(): void {
    const index = this.rankDialog()?.index ?? null;
    if (index === null || index === 0) {
      return;
    }
    this.guildRanks.update((ranks) => ranks.filter((_, i) => i !== index));
    this.rankDialog.set(null);
  }

  protected async saveGuildRanks(submit: SubmitEvent): Promise<void> {
    submit.preventDefault();
    this.rankSaving.set(true);
    try {
      const updated = await firstValueFrom(this.api.put<ProgressionSettingsView>(
        'api/progression/settings',
        { guild_ranks: this.guildRanks() },
      ));
      this.guildRanks.set(updated.guild_ranks);
      this.progressionSettings.set(updated);
      this.toasts.success(this.t('admin.progression.saved'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.rankSaving.set(false);
    }
  }

  protected async saveProgressionSettings(submit: SubmitEvent): Promise<void> {
    submit.preventDefault();
    this.progressionSaving.set(true);
    try {
      const draft = this.progressionDraft();
      const body: UpdateProgressionSettingsRequest = {
        xp_base: draft.xp_base,
        xp_exponent: draft.xp_exponent,
        max_level: draft.max_level,
        xp_message: draft.xp_message,
        xp_event_create: draft.xp_event_create,
        xp_event_join: draft.xp_event_join,
        xp_event_complete: draft.xp_event_complete,
        xp_vod: draft.xp_vod,
        message_cooldown_secs: draft.message_cooldown_secs,
        message_min_chars: draft.message_min_chars,
        warn_threshold: draft.warn_threshold,
        vod_forum_channel_id: draft.vod_forum_channel_id.trim(),
      };
      const updated = await firstValueFrom(
        this.api.put<ProgressionSettingsView>('api/progression/settings', body),
      );
      this.progressionSettings.set(updated);
      this.progressionDraft.set(toProgressionDraft(updated));
      this.toasts.success(this.t('admin.progression.saved'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.progressionSaving.set(false);
    }
  }

  protected formatDateTime(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
      ? iso
      : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }

  protected openSeasonDialog(season: ProgressionSeasonView | null): void {
    this.seasonDialog.set(season
      ? {
          id: season.id,
          name: season.name,
          starts_at: toLocalInput(season.starts_at),
          ends_at: toLocalInput(season.ends_at),
          activate: false,
        }
      : { id: null, name: '', starts_at: '', ends_at: '', activate: true });
  }

  protected closeSeasonDialog(): void {
    this.seasonDialog.set(null);
  }

  protected updateSeasonDialog(field: 'name' | 'starts_at' | 'ends_at', event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.seasonDialog.update((dialog) => (dialog ? { ...dialog, [field]: value } : dialog));
  }

  protected toggleSeasonDialogActivate(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.seasonDialog.update((dialog) => (dialog ? { ...dialog, activate: checked } : dialog));
  }

  protected async saveSeasonDialog(submit: SubmitEvent): Promise<void> {
    submit.preventDefault();
    const dialog = this.seasonDialog();
    if (!dialog) {
      return;
    }
    try {
      const body = {
        name: dialog.name.trim(),
        starts_at: fromLocalInput(dialog.starts_at),
        ends_at: fromLocalInput(dialog.ends_at),
      };
      if (dialog.id === null) {
        await firstValueFrom(
          this.api.post<ProgressionSeasonView>('api/progression/seasons', {
            ...body,
            activate: dialog.activate,
          }),
        );
        this.seasonDialog.set(null);
        await this.loadProgression();
        this.toasts.success(this.t('admin.progression.seasonCreated'));
        return;
      }
      const updated = await firstValueFrom(
        this.api.put<ProgressionSeasonView>(`api/progression/seasons/${dialog.id}`, body),
      );
      this.progressionSeasons.update((rows) =>
        rows.map((row) => (row.id === dialog.id ? updated : row)),
      );
      this.seasonDialog.set(null);
      this.toasts.success(this.t('admin.progression.seasonSaved'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  protected async activateSeason(id: number): Promise<void> {
    try {
      await firstValueFrom(
        this.api.put<ProgressionSeasonView>(`api/progression/seasons/${id}/activate`, {}),
      );
      await this.loadProgression();
      this.toasts.success(this.t('admin.progression.seasonActivated'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }
}

function toProgressionDraft(settings: ProgressionSettingsView): ProgressionDraft {
  return {
    xp_base: settings.xp_base,
    xp_exponent: Number(settings.xp_exponent),
    max_level: settings.max_level,
    xp_message: settings.xp_message,
    xp_event_create: settings.xp_event_create,
    xp_event_join: settings.xp_event_join,
    xp_event_complete: settings.xp_event_complete,
    xp_vod: settings.xp_vod,
    message_cooldown_secs: settings.message_cooldown_secs,
    message_min_chars: settings.message_min_chars,
    warn_threshold: settings.warn_threshold,
    vod_forum_channel_id: settings.vod_forum_channel_id ?? '',
  };
}

function toLocalInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInput(value: string): string {
  return new Date(value).toISOString();
}
