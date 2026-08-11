import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  AlbionGuildMember,
  CreateSplitRequest,
  EventView,
  MatchedParticipant,
  OcrResult,
  PaginatedData,
  SplitDetail,
  SplitStatus,
  SplitSummary,
  UpdateSplitRequest,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { Icon } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';

const PAGE_SIZE = 10;

interface SplitParticipantDraft {
  readonly raw_name: string;
  readonly user_id: number;
  readonly username: string;
  readonly weight: number;
}

/**
 * Loot split workspace with OCR-assisted participant matching.
 *
 * Members upload a screenshot or paste Albion names; the frontend sends images
 * to the Mistral-backed OCR endpoint and then asks the split matcher to resolve
 * Albion names against linked Discord users. The final roster is edited as
 * percentage weights, avoiding internal `user_id` leakage in the UI.
 *
 * # Example
 * ```text
 * Upload party screenshot -> review matched cards -> create split
 * ```
 */
@Component({
  selector: 'app-splits',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PageHeader, EmptyState, Icon, Loading],
  template: `
    <app-page-header [title]="t('splits.title')" [subtitle]="t('splits.subtitle')">
      <button type="button" class="btn btn--primary" (click)="toggleCreateForm()">
        {{ showCreateForm() ? t('common.close') : t('splits.new') }}
      </button>
    </app-page-header>

    @if (showCreateForm()) {
      <form class="card mb-6 grid gap-5 p-5" (submit)="onCreateSubmit($event)">
        <div class="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
          <section class="grid gap-4">
            <label>
              <span class="label">{{ t('common.name') }}</span>
              <input
                class="input"
                type="text"
                [value]="draftTitle()"
                (input)="onTitleChange($event)"
              />
            </label>

            <label>
              <span class="label">Event (optional)</span>
              <select class="select" [value]="draftEventId()" (change)="onDraftEventChange($event)">
                <option value="">No event</option>
                @for (event of eventOptions(); track event.id) {
                  <option [value]="event.id">
                    {{ event.title }} · {{ formatDate(event.event_date_utc) }}
                  </option>
                }
              </select>
            </label>

            <div class="grid gap-3 sm:grid-cols-3">
              <label>
                <span class="label">{{ t('splits.estimated') }}</span>
                <input
                  class="input"
                  type="number"
                  min="0"
                  [value]="draftEstimated()"
                  (input)="onEstimatedChange($event)"
                />
              </label>
              <label>
                <span class="label">Repair</span>
                <input
                  class="input"
                  type="number"
                  min="0"
                  [value]="draftRepair()"
                  (input)="onRepairChange($event)"
                />
              </label>
              <label>
                <span class="label">Bags</span>
                <input
                  class="input"
                  type="number"
                  min="0"
                  [value]="draftBags()"
                  (input)="onBagsChange($event)"
                />
              </label>
            </div>

            <label>
              <span class="label">{{ t('splits.match_ocr') }}</span>
              <input
                class="input"
                type="file"
                accept="image/*"
                (change)="onScreenshotChange($event)"
              />
            </label>

            <label>
              <span class="label">Albion names (one per line)</span>
              <textarea
                class="textarea"
                rows="5"
                [value]="rawNames()"
                (input)="onRawNamesChange($event)"
              ></textarea>
            </label>

            <div class="flex flex-wrap gap-2">
              <button
                type="button"
                class="btn btn--tonal"
                [disabled]="matching()"
                (click)="matchParticipants()"
              >
                {{ matching() ? t('common.loading') : t('splits.match_ocr') }}
              </button>
              <button type="button" class="btn btn--ghost" (click)="clearParticipants()">
                {{ t('common.delete') }} roster
              </button>
            </div>
          </section>

          <section class="surface p-4">
            <div class="mb-3 flex items-center justify-between gap-3">
              <h3 class="font-semibold" style="color: var(--color-text)">
                {{ t('splits.participants') }}
              </h3>
              <div class="flex items-center gap-2">
                <span
                  class="chip"
                  [class.chip--success]="totalWeight() === 100"
                  [class.chip--warning]="totalWeight() !== 100"
                >
                  {{ totalWeight() }}%
                </span>
                <button
                  type="button"
                  class="btn btn--primary"
                  style="min-width: 2.25rem; padding: 0.45rem 0.7rem"
                  (click)="openParticipantDialog()"
                  aria-label="Add participant"
                >
                  +
                </button>
              </div>
            </div>

            @if (participants().length === 0) {
              <app-empty-state [message]="t('common.empty')" icon="users" />
            } @else {
              <div class="grid gap-2">
                @for (participant of participants(); track participant.user_id) {
                  <article class="card grid gap-3 p-3 sm:grid-cols-[1fr_auto] sm:items-center">
                    <div>
                      <p class="font-medium" style="color: var(--color-text)">
                        {{ participant.raw_name }}
                      </p>
                      <p class="text-xs" style="color: var(--color-text-secondary)">
                        {{ participant.username }}
                      </p>
                    </div>
                    <div class="flex items-center justify-end gap-2">
                      <label class="flex items-center gap-2">
                        <input
                          class="input"
                          style="width: 6rem"
                          type="number"
                          min="1"
                          max="100"
                          [value]="participant.weight"
                          (input)="onWeightChange(participant.user_id, $event)"
                        />
                        <span class="text-sm" style="color: var(--color-text-secondary)">%</span>
                      </label>
                      <button
                        type="button"
                        class="btn btn--ghost"
                        style="min-width: 2rem; padding: 0.35rem"
                        (click)="removeParticipant(participant.user_id)"
                        aria-label="Remove participant"
                      >
                        <app-icon name="close" size="0.875rem" />
                      </button>
                    </div>
                  </article>
                }
              </div>
            }
          </section>
        </div>

        <div class="flex justify-end gap-2">
          <button type="button" class="btn btn--ghost" (click)="toggleCreateForm()">
            {{ t('common.cancel') }}
          </button>
          <button
            type="submit"
            class="btn btn--primary"
            [disabled]="saving() || participants().length === 0"
          >
            {{ t('common.create') }}
          </button>
        </div>
      </form>

      @if (isParticipantDialogOpen()) {
        <div class="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm">
          <section class="card w-full max-w-xl p-5" role="dialog" aria-modal="true">
            <header class="mb-4 flex items-start justify-between gap-3">
              <div>
                <h3 class="text-lg font-semibold" style="color: var(--color-text)">
                  Add participant
                </h3>
                <p class="text-sm" style="color: var(--color-text-secondary)">
                  Search the Albion roster and select a linked player.
                </p>
              </div>
              <button type="button" class="btn btn--ghost" (click)="closeParticipantDialog()">
                <app-icon name="close" size="1rem" />
              </button>
            </header>

            <form class="mb-4 flex gap-2" (submit)="onParticipantSearchSubmit($event)">
              <input
                class="input"
                type="text"
                [value]="participantSearch()"
                (input)="onParticipantSearchChange($event)"
                placeholder="Albion player name"
              />
              <button type="submit" class="btn btn--primary" [disabled]="searchingRoster()">
                Search
              </button>
            </form>

            @if (searchingRoster()) {
              <app-loading [label]="t('common.loading')" />
            } @else if (participantRoster().length === 0) {
              <app-empty-state [message]="t('common.empty')" icon="search" />
            } @else {
              <div class="grid max-h-80 gap-2 overflow-y-auto pr-1 scrollbar-thin">
                @for (member of participantRoster(); track member.id) {
                  <button
                    type="button"
                    class="surface flex items-center justify-between gap-3 p-3 text-left"
                    (click)="addRosterMember(member)"
                  >
                    <span class="font-medium" style="color: var(--color-text)">{{
                      member.name
                    }}</span>
                    <span class="chip">Add</span>
                  </button>
                }
              </div>
            }
          </section>
        </div>
      }
    }

    <div class="mb-4 flex items-center gap-3">
      <label class="label" style="margin-bottom: 0">{{ t('common.status') }}</label>
      <select
        class="select"
        style="width: auto"
        [value]="statusFilter()"
        (change)="onStatusChange($event)"
      >
        <option value="">{{ t('common.all') }}</option>
        <option value="pending">Pending</option>
        <option value="completed">Completed</option>
        <option value="not_completed">Not completed</option>
        <option value="lost">Lost</option>
      </select>
    </div>

    @if (loading()) {
      <app-loading [label]="t('common.loading')" />
    } @else if (splits().length === 0) {
      <app-empty-state [message]="t('common.empty')" icon="swords" />
    } @else {
      <div class="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        @for (split of splits(); track split.id) {
          <article class="card p-5 cursor-pointer" (click)="openSplit(split.id)">
            <header class="mb-3 flex items-start justify-between gap-2">
              <h3 class="text-base font-semibold" style="color: var(--color-text)">
                {{ split.note || 'Split #' + split.id }}
              </h3>
              <span class="chip" [class]="statusChip(split.status)">{{ split.status }}</span>
            </header>
            <p class="mb-3 text-xs" style="color: var(--color-text-secondary)">
              By {{ split.created_by_username }} · {{ formatDate(split.created_at) }}
              @if (split.event_title) {
                · Event: {{ split.event_title }}
              }
            </p>
            <dl class="space-y-1 text-sm">
              <div class="flex justify-between">
                <dt style="color: var(--color-text-secondary)">{{ t('splits.participants') }}</dt>
                <dd>{{ split.participant_count }}</dd>
              </div>
              <div class="flex justify-between">
                <dt style="color: var(--color-text-secondary)">{{ t('splits.estimated') }}</dt>
                <dd style="font-variant-numeric: tabular-nums">
                  {{ formatAmount(split.estimated_market_value) }}
                </dd>
              </div>
              <div class="flex justify-between font-semibold">
                <dt>{{ t('splits.net_value') }}</dt>
                <dd style="font-variant-numeric: tabular-nums">
                  {{ formatAmount(split.net_value) }}
                </dd>
              </div>
            </dl>

            @if (canAct() && split.status === 'pending') {
              <footer class="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  class="btn btn--primary"
                  (click)="$event.stopPropagation(); close(split.id, 'complete')"
                >
                  Complete
                </button>
                <button
                  type="button"
                  class="btn btn--tonal"
                  (click)="$event.stopPropagation(); close(split.id, 'not-completed')"
                >
                  Not completed
                </button>
                <button
                  type="button"
                  class="btn btn--danger"
                  (click)="$event.stopPropagation(); close(split.id, 'lost')"
                >
                  Lost
                </button>
              </footer>
            }
          </article>
        }
      </div>

      <div class="mt-4 flex items-center justify-between">
        <p class="text-xs" style="color: var(--color-text-secondary)">
          {{ t('common.page') }} {{ page() }} {{ t('common.of') }} {{ totalPages() }}
        </p>
        <div class="flex gap-2">
          <button type="button" class="btn btn--outline" [disabled]="page() <= 1" (click)="prev()">
            {{ t('common.prev') }}
          </button>
          <button
            type="button"
            class="btn btn--outline"
            [disabled]="page() >= totalPages()"
            (click)="next()"
          >
            {{ t('common.next') }}
          </button>
        </div>
      </div>
    }

    @if (selectedSplit(); as detail) {
      <div class="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm">
        <section class="card w-full max-w-3xl p-5" role="dialog" aria-modal="true">
          <header class="mb-4 flex items-start justify-between gap-3">
            <div>
              <h2 class="text-xl font-semibold" style="color: var(--color-text)">
                {{ detail.note || 'Split #' + detail.id }}
              </h2>
              <p class="text-sm" style="color: var(--color-text-secondary)">
                {{ detail.status }} · By {{ detail.created_by_username }} ·
                {{ formatDate(detail.created_at) }}
                @if (detail.event_title) {
                  · Event: {{ detail.event_title }}
                }
              </p>
            </div>
            <button type="button" class="btn btn--ghost" (click)="closeSplitDetail()">
              <app-icon name="close" size="1rem" />
            </button>
          </header>

          @if (detail.status === 'pending' && canAct()) {
            <form
              class="mb-4 grid gap-3 sm:grid-cols-4"
              (submit)="onDetailUpdateSubmit($event, detail.id)"
            >
              <label class="surface p-3">
                <span class="label">Note</span>
                <input class="input" [value]="editNote()" (input)="onEditNoteChange($event)" />
              </label>
              <label class="surface p-3">
                <span class="label">Estimated</span>
                <input
                  class="input"
                  type="number"
                  min="0"
                  [value]="editEstimated()"
                  (input)="onEditEstimatedChange($event)"
                />
              </label>
              <label class="surface p-3">
                <span class="label">Repair</span>
                <input
                  class="input"
                  type="number"
                  min="0"
                  [value]="editRepair()"
                  (input)="onEditRepairChange($event)"
                />
              </label>
              <label class="surface p-3">
                <span class="label">Bags</span>
                <input
                  class="input"
                  type="number"
                  min="0"
                  [value]="editBags()"
                  (input)="onEditBagsChange($event)"
                />
              </label>
              <div class="sm:col-span-4 flex justify-end">
                <button type="submit" class="btn btn--tonal">Save split values</button>
              </div>
            </form>
          } @else {
            <div class="mb-4 grid gap-3 sm:grid-cols-4">
              <div class="surface p-3">
                <p class="text-xs" style="color: var(--color-text-secondary)">Estimated</p>
                <p class="font-semibold">{{ formatAmount(detail.estimated_market_value) }}</p>
              </div>
              <div class="surface p-3">
                <p class="text-xs" style="color: var(--color-text-secondary)">Repair</p>
                <p class="font-semibold">{{ formatAmount(detail.repair_value) }}</p>
              </div>
              <div class="surface p-3">
                <p class="text-xs" style="color: var(--color-text-secondary)">Bags</p>
                <p class="font-semibold">{{ formatAmount(detail.bags_value) }}</p>
              </div>
              <div class="surface p-3">
                <p class="text-xs" style="color: var(--color-text-secondary)">Net</p>
                <p class="font-semibold">{{ formatAmount(detail.net_value) }}</p>
              </div>
            </div>
          }

          <div class="overflow-x-auto">
            <table class="table">
              <thead>
                <tr>
                  <th>Player</th>
                  <th>Weight</th>
                  <th>Share</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                @for (participant of detail.participants; track participant.user_id) {
                  <tr>
                    <td>{{ participant.username }}</td>
                    <td>
                      @if (detail.status === 'pending' && canAct()) {
                        <input
                          class="input"
                          style="width: 6rem"
                          type="number"
                          min="1"
                          [value]="participant.weight"
                          (change)="updateDetailParticipant(detail.id, participant.user_id, $event)"
                        />
                      } @else {
                        {{ participant.weight }}%
                      }
                    </td>
                    <td>{{ formatAmount(participant.share_amount) }}</td>
                    <td>
                      @if (detail.status === 'pending' && canAct()) {
                        <button
                          type="button"
                          class="btn btn--ghost"
                          (click)="removeDetailParticipant(detail.id, participant.user_id)"
                        >
                          <app-icon name="close" size="0.875rem" />
                        </button>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>

          @if (detail.status === 'pending' && canAct()) {
            <footer class="mt-5 flex flex-wrap justify-end gap-2">
              <button type="button" class="btn btn--tonal" (click)="openParticipantDialog()">
                Add participant
              </button>
              <button type="button" class="btn btn--primary" (click)="close(detail.id, 'complete')">
                Complete and pay
              </button>
              <button
                type="button"
                class="btn btn--outline"
                (click)="close(detail.id, 'not-completed')"
              >
                Not completed
              </button>
              <button type="button" class="btn btn--danger" (click)="close(detail.id, 'lost')">
                Lost
              </button>
            </footer>
          }
        </section>
      </div>
    }
  `,
})
export class Splits {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly splits = signal<SplitSummary[]>([]);
  protected readonly loading = signal(false);
  protected readonly page = signal(1);
  protected readonly totalPages = signal(1);
  protected readonly statusFilter = signal<SplitStatus | ''>('');
  protected readonly saving = signal(false);
  protected readonly matching = signal(false);
  protected readonly showCreateForm = signal(false);
  protected readonly draftTitle = signal('');
  protected readonly draftEventId = signal('');
  protected readonly eventOptions = signal<EventView[]>([]);
  protected readonly draftEstimated = signal(0);
  protected readonly draftRepair = signal(0);
  protected readonly draftBags = signal(0);
  protected readonly rawNames = signal('');
  protected readonly participants = signal<SplitParticipantDraft[]>([]);
  protected readonly selectedSplit = signal<SplitDetail | null>(null);
  protected readonly editNote = signal('');
  protected readonly editEstimated = signal(0);
  protected readonly editRepair = signal(0);
  protected readonly editBags = signal(0);
  protected readonly isParticipantDialogOpen = signal(false);
  protected readonly participantSearch = signal('');
  protected readonly participantRoster = signal<AlbionGuildMember[]>([]);
  protected readonly searchingRoster = signal(false);

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.load();
    void this.loadEventOptions();
  }

  protected canAct(): boolean {
    return this.auth.hasPermission('splits.manage');
  }

  protected totalWeight(): number {
    return this.participants().reduce((sum, participant) => sum + participant.weight, 0);
  }

  protected onStatusChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as SplitStatus | '';
    this.statusFilter.set(value);
    this.page.set(1);
    void this.load();
  }

  protected toggleCreateForm(): void {
    this.showCreateForm.update((isVisible) => !isVisible);
  }

  protected onTitleChange(event: Event): void {
    this.draftTitle.set((event.target as HTMLInputElement).value);
  }

  protected onEstimatedChange(event: Event): void {
    this.draftEstimated.set(Number((event.target as HTMLInputElement).value));
  }

  protected onRepairChange(event: Event): void {
    this.draftRepair.set(Number((event.target as HTMLInputElement).value));
  }

  protected onBagsChange(event: Event): void {
    this.draftBags.set(Number((event.target as HTMLInputElement).value));
  }

  protected onDraftEventChange(event: Event): void {
    this.draftEventId.set((event.target as HTMLSelectElement).value);
  }

  protected onEditNoteChange(event: Event): void {
    this.editNote.set((event.target as HTMLInputElement).value);
  }

  protected onEditEstimatedChange(event: Event): void {
    this.editEstimated.set(Number((event.target as HTMLInputElement).value));
  }

  protected onEditRepairChange(event: Event): void {
    this.editRepair.set(Number((event.target as HTMLInputElement).value));
  }

  protected onEditBagsChange(event: Event): void {
    this.editBags.set(Number((event.target as HTMLInputElement).value));
  }

  protected onRawNamesChange(event: Event): void {
    this.rawNames.set((event.target as HTMLTextAreaElement).value);
  }

  protected onWeightChange(userId: number, event: Event): void {
    const weight = Math.max(1, Number((event.target as HTMLInputElement).value));
    this.participants.update((participants) =>
      participants.map((participant) =>
        participant.user_id === userId ? { ...participant, weight } : participant,
      ),
    );
  }

  protected openParticipantDialog(): void {
    this.isParticipantDialogOpen.set(true);
  }

  protected closeParticipantDialog(): void {
    this.isParticipantDialogOpen.set(false);
    this.participantSearch.set('');
    this.participantRoster.set([]);
  }

  protected onParticipantSearchChange(event: Event): void {
    this.participantSearch.set((event.target as HTMLInputElement).value);
  }

  protected onParticipantSearchSubmit(event: SubmitEvent): void {
    event.preventDefault();
    void this.searchParticipantRoster();
  }

  protected removeParticipant(userId: number): void {
    const nextParticipants = this.participants().filter(
      (participant) => participant.user_id !== userId,
    );
    this.participants.set(this.redistributeWeights(nextParticipants));
  }

  protected async addRosterMember(member: AlbionGuildMember): Promise<void> {
    try {
      const matched = await firstValueFrom(
        this.api.post<MatchedParticipant[]>('api/splits/match-participants', {
          names: [member.name],
        }),
      );
      const draft = this.toDraftParticipants(matched).at(0);
      if (!draft) {
        this.toasts.error('This Albion character is not linked to an app user.');
        return;
      }
      const selected = this.selectedSplit();
      if (selected) {
        await this.upsertDetailParticipant(selected.id, draft.user_id, 1);
        this.closeParticipantDialog();
        return;
      }

      if (this.participants().some((participant) => participant.user_id === draft.user_id)) {
        this.toasts.info(`${draft.raw_name} is already in the roster.`);
        this.closeParticipantDialog();
        return;
      }
      this.participants.set(this.redistributeWeights([...this.participants(), draft]));
      this.closeParticipantDialog();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  protected async onScreenshotChange(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement).files?.item(0);
    if (!file) {
      return;
    }

    const formData = new FormData();
    formData.append('image', file);

    this.matching.set(true);
    try {
      const result = await firstValueFrom(this.api.post<OcrResult>('api/utils/ocr', formData));
      this.rawNames.set(result.lines.join('\n'));
      await this.matchParticipants();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.matching.set(false);
    }
  }

  protected async matchParticipants(): Promise<void> {
    const names = this.rawNames()
      .split(/\r?\n|,/)
      .map((name) => name.trim())
      .filter(Boolean);
    if (names.length === 0) {
      this.toasts.error(this.t('validation.required'));
      return;
    }

    this.matching.set(true);
    try {
      const matched = await firstValueFrom(
        this.api.post<MatchedParticipant[]>('api/splits/match-participants', { names }),
      );
      this.participants.set(this.redistributeWeights(this.toDraftParticipants(matched)));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.matching.set(false);
    }
  }

  protected clearParticipants(): void {
    this.rawNames.set('');
    this.participants.set([]);
  }

  private async searchParticipantRoster(): Promise<void> {
    const query = this.participantSearch().trim();
    if (!query) {
      this.toasts.error(this.t('validation.required'));
      return;
    }

    this.searchingRoster.set(true);
    try {
      const rosterPage = await firstValueFrom(
        this.api.get<PaginatedData<AlbionGuildMember>>('api/albion/guild/roster', {
          q: query,
          limit: 25,
        }),
      );
      this.participantRoster.set(rosterPage.items);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.searchingRoster.set(false);
    }
  }

  protected onCreateSubmit(event: SubmitEvent): void {
    event.preventDefault();
    void this.createSplit();
  }

  protected async openSplit(splitId: number): Promise<void> {
    try {
      const detail = await firstValueFrom(this.api.get<SplitDetail>(`api/splits/${splitId}`));
      this.setSelectedSplit(detail);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  protected closeSplitDetail(): void {
    this.selectedSplit.set(null);
  }

  protected onDetailUpdateSubmit(event: SubmitEvent, splitId: number): void {
    event.preventDefault();
    void this.updateSplitValues(splitId);
  }

  protected async updateSplitValues(splitId: number): Promise<void> {
    const request: UpdateSplitRequest = {
      note: this.editNote(),
      estimated_market_value: this.editEstimated(),
      repair_value: this.editRepair(),
      bags_value: this.editBags(),
    };

    try {
      const detail = await firstValueFrom(
        this.api.patch<SplitDetail>(`api/splits/${splitId}`, request),
      );
      this.setSelectedSplit(detail);
      await this.load();
      this.toasts.success(this.t('common.save'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  protected async updateDetailParticipant(
    splitId: number,
    userId: number,
    event: Event,
  ): Promise<void> {
    const weight = Math.max(1, Number((event.target as HTMLInputElement).value));
    await this.upsertDetailParticipant(splitId, userId, weight);
  }

  protected async removeDetailParticipant(splitId: number, userId: number): Promise<void> {
    try {
      const detail = await firstValueFrom(
        this.api.delete<SplitDetail>(`api/splits/${splitId}/participants/${userId}`),
      );
      this.setSelectedSplit(detail as SplitDetail);
      await this.load();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  private async createSplit(): Promise<void> {
    const request = this.buildCreateRequest();
    if (!request) {
      return;
    }

    this.saving.set(true);
    try {
      await firstValueFrom(this.api.post<SplitDetail>('api/splits', request));
      this.resetCreateForm();
      await this.load();
      this.toasts.success(this.t('common.create'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async close(id: number, action: 'complete' | 'not-completed' | 'lost'): Promise<void> {
    try {
      const detail = await firstValueFrom(
        this.api.post<SplitDetail>(`api/splits/${id}/${action}`, {}),
      );
      this.setSelectedSplit(detail);
      this.toasts.success(action);
      await this.load();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  protected async next(): Promise<void> {
    if (this.page() >= this.totalPages()) {
      return;
    }
    this.page.update((p) => p + 1);
    await this.load();
  }

  protected async prev(): Promise<void> {
    if (this.page() <= 1) {
      return;
    }
    this.page.update((p) => p - 1);
    await this.load();
  }

  protected formatAmount(value: number | string | null | undefined): string {
    if (value === null || value === undefined) {
      return '—';
    }
    return Number(value).toLocaleString();
  }

  protected formatDate(iso: string): string {
    return new Date(iso).toLocaleString();
  }

  protected statusChip(status: SplitStatus): string {
    if (status === 'completed') {
      return 'chip chip--success';
    }
    if (status === 'pending') {
      return 'chip chip--warning';
    }
    if (status === 'lost') {
      return 'chip chip--error';
    }
    return 'chip';
  }

  private setSelectedSplit(detail: SplitDetail): void {
    this.selectedSplit.set(detail);
    this.editNote.set(detail.note ?? '');
    this.editEstimated.set(Number(detail.estimated_market_value));
    this.editRepair.set(Number(detail.repair_value));
    this.editBags.set(Number(detail.bags_value));
  }

  private toDraftParticipants(matched: MatchedParticipant[]): SplitParticipantDraft[] {
    return matched.map((participant) => ({
      raw_name: participant.matched_name,
      user_id: participant.user_id,
      username: participant.username,
      weight: 1,
    }));
  }

  private redistributeWeights(participants: SplitParticipantDraft[]): SplitParticipantDraft[] {
    if (participants.length === 0) {
      return [];
    }

    const baseWeight = Math.floor(100 / participants.length);
    return participants.map((participant, index) => ({
      ...participant,
      weight: index === participants.length - 1 ? 100 - baseWeight * index : baseWeight,
    }));
  }

  private buildCreateRequest(): CreateSplitRequest | null {
    const title = this.draftTitle().trim();
    const participants = this.participants().map((participant) => ({
      user_id: participant.user_id,
      weight: participant.weight,
    }));

    if (!title || participants.length === 0) {
      this.toasts.error(this.t('validation.required'));
      return null;
    }

    const request: CreateSplitRequest = {
      note: title,
      estimated_market_value: this.draftEstimated(),
      repair_value: this.draftRepair(),
      bags_value: this.draftBags(),
      participants,
    };
    const eventId = Number(this.draftEventId());
    if (eventId > 0) {
      request.event_id = eventId;
    }
    return request;
  }

  private async upsertDetailParticipant(
    splitId: number,
    userId: number,
    weight: number,
  ): Promise<void> {
    try {
      const detail = await firstValueFrom(
        this.api.post<SplitDetail>(`api/splits/${splitId}/participants`, {
          user_id: userId,
          weight,
        }),
      );
      this.setSelectedSplit(detail);
      await this.load();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  private resetCreateForm(): void {
    this.draftTitle.set('');
    this.draftEventId.set('');
    this.draftEstimated.set(0);
    this.draftRepair.set(0);
    this.draftBags.set(0);
    this.rawNames.set('');
    this.participants.set([]);
    this.showCreateForm.set(false);
  }

  private async loadEventOptions(): Promise<void> {
    try {
      const events = await firstValueFrom(
        this.api.get<PaginatedData<EventView>>('api/events', { page: 1, limit: 100 }),
      );
      this.eventOptions.set(events.items);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      const filter = this.statusFilter();
      const params: Record<string, string | number> = { page: this.page(), limit: PAGE_SIZE };
      if (filter) {
        params['status'] = filter;
      }
      const data = await firstValueFrom(
        this.api.get<PaginatedData<SplitSummary>>('api/splits', params),
      );
      this.splits.set(data.items);
      this.totalPages.set(data.total_pages);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }
}
