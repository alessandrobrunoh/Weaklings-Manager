import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { firstValueFrom, type Observable } from 'rxjs';

import type {
  CompSummary,
  CreateEventPartyRequest,
  DeleteEventPartyRequest,
  EventParty,
  EventPartyChange,
  EventRosterRole,
  EventRosterView,
  PaginatedData,
  ReorderEventPartiesRequest,
  UpdateEventPartyRequest,
} from '../../../core/models/api.models';
import { ApiService } from '../../../core/services/api.service';
import { ToastService } from '../../../core/services/toast.service';
import { TranslateService } from '../../../core/services/translate.service';
import type { TranslationKey } from '../../../i18n/en';
import { Dialog } from '../../../shared/components/dialog/dialog';
import { Icon } from '../../../shared/components/icon/icon';
import { Select, type SelectOption } from '../../../shared/components/select/select';
import {
  movedPartyOrder,
  roleColorVar,
  roleLabelKey,
  sortedRoleCounts,
} from './roster-lobby';

/** What the user has typed into one party card but not saved yet. */
interface PartyDraft {
  readonly name: string;
  readonly compId: string;
}

/**
 * Manager-only editor for an event's parties: one card per party with its label, comp, seat
 * summary and extra roles, plus a card to add another party.
 *
 * Every change goes through the party endpoints with the roster version the page last saw, then
 * asks the page to reload; the page owns the roster, this component owns only the drafts.
 */
@Component({
  selector: 'app-event-party-structure',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Dialog, Icon, Select],
  styles: `
    :host {
      display: block;
    }
    .structure {
      display: grid;
      gap: 1rem;
      grid-template-columns: repeat(auto-fill, minmax(min(100%, 22rem), 1fr));
      align-items: start;
    }
    .structure-card {
      display: grid;
      gap: 0.75rem;
      padding: 1rem;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-lg);
      background: var(--color-surface);
    }
    .structure-card--add {
      border-style: dashed;
    }
    .structure-card__head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
    }
    .structure-card__title {
      margin: 0;
      font-size: 0.8125rem;
      font-weight: 700;
      color: var(--color-text);
    }
    .structure-card__tools {
      display: flex;
      gap: 0.25rem;
    }
    .structure-field {
      display: grid;
      gap: 0.25rem;
    }
    .structure-roles {
      display: flex;
      flex-wrap: wrap;
      gap: 0.375rem;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .structure-role {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      padding: 0.125rem 0.5rem;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-pills);
      font-size: 0.75rem;
      color: var(--color-text);
    }
    .structure-role__dot {
      width: 0.5rem;
      height: 0.5rem;
      border-radius: 50%;
      background: var(--role-accent, var(--color-border-strong));
    }
    .structure-extra {
      display: grid;
      gap: 0.375rem;
    }
    .structure-extra__row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
      padding: 0.375rem 0.625rem;
      border-radius: var(--radius-md);
      background: var(--color-surface-2);
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--color-text);
    }
    .structure-card__actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
    }
    .structure-card__actions .structure-card__remove {
      margin-left: auto;
    }
  `,
  template: `
    <section class="structure" [attr.aria-label]="t('events.parties.modeStructure')">
      @for (party of parties(); track party.id) {
        <article class="structure-card" [attr.aria-labelledby]="'structure-party-' + party.id">
          <header class="structure-card__head">
            <h3 class="structure-card__title" [id]="'structure-party-' + party.id">
              {{ defaultName(party.position) }}
              <span class="text-[var(--color-text-secondary)] font-normal">
                · {{ t('events.lobby.seatsCount', { filled: party.filled_count, total: party.seat_count }) }}
              </span>
            </h3>
            <div class="structure-card__tools">
              <button
                type="button"
                class="icon-btn"
                [disabled]="busy() || $first"
                [attr.aria-label]="t('events.parties.moveUp') + ': ' + defaultName(party.position)"
                (click)="move(party, -1)"
              >
                <app-icon name="chevron-up" size="0.875rem" />
              </button>
              <button
                type="button"
                class="icon-btn"
                [disabled]="busy() || $last"
                [attr.aria-label]="t('events.parties.moveDown') + ': ' + defaultName(party.position)"
                (click)="move(party, 1)"
              >
                <app-icon name="chevron-down" size="0.875rem" />
              </button>
            </div>
          </header>

          <div class="structure-field">
            <label class="label" [for]="'structure-name-' + party.id">{{ t('events.parties.name') }}</label>
            <input
              class="input input--sm"
              type="text"
              maxlength="40"
              [id]="'structure-name-' + party.id"
              [value]="draftName(party)"
              [placeholder]="t('events.parties.namePlaceholder')"
              (input)="setDraftName(party, $event)"
            />
          </div>

          <div class="structure-field">
            <span class="label" [id]="'structure-comp-label-' + party.id">{{ t('events.parties.comp') }}</span>
            <app-select
              size="sm"
              [options]="compOptionsFor(party)"
              [value]="draftCompId(party)"
              [placeholder]="t('events.parties.compPlaceholder')"
              [ariaLabelledBy]="'structure-comp-label-' + party.id"
              (valueChange)="setDraftComp(party, $event)"
            />
          </div>

          @if (roleSummary(party).length > 0) {
            <ul class="structure-roles">
              @for (entry of roleSummary(party); track entry.role) {
                <li class="structure-role" [style.--role-accent]="roleColor(entry.role)">
                  <span class="structure-role__dot" aria-hidden="true"></span>
                  {{ roleName(entry.role) }}
                  <span class="font-mono">{{ entry.count }}</span>
                </li>
              }
            </ul>
          } @else {
            <p class="text-xs text-[var(--color-text-secondary)]">{{ t('events.parties.noRoles') }}</p>
          }

          <div class="structure-extra">
            <span class="label">{{ t('events.parties.extraRoles') }}</span>
            @for (role of extraRolesOf(party); track role.id) {
              <div class="structure-extra__row">
                <span>{{ role.name }}</span>
                <button
                  type="button"
                  class="btn btn--danger btn--sm text-xs py-0.5 px-2"
                  [disabled]="busy()"
                  (click)="removeRole.emit(role)"
                >
                  {{ t('events.detail.remove_role') }}
                </button>
              </div>
            } @empty {
              <p class="text-xs text-[var(--color-text-secondary)]">{{ t('events.parties.noExtraRoles') }}</p>
            }
            <button
              type="button"
              class="btn btn--outline btn--sm"
              [disabled]="busy()"
              (click)="addRole.emit(party.id)"
            >
              <app-icon name="plus" size="0.75rem" />
              {{ t('events.parties.addRole') }}
            </button>
          </div>

          <div class="structure-card__actions">
            <button
              type="button"
              class="btn btn--primary btn--sm"
              [disabled]="busy() || !isDirty(party) || !draftCompId(party)"
              (click)="save(party)"
            >
              {{ t('events.parties.save') }}
            </button>
            <button
              type="button"
              class="btn btn--danger btn--sm structure-card__remove"
              [disabled]="busy() || parties().length <= 1"
              [attr.title]="parties().length <= 1 ? t('events.parties.removeLast') : null"
              (click)="pendingRemoval.set(party)"
            >
              {{ t('events.parties.remove') }}
            </button>
          </div>
        </article>
      }

      <article class="structure-card structure-card--add" aria-labelledby="structure-add-title">
        <h3 id="structure-add-title" class="structure-card__title">+ {{ t('events.parties.add') }}</h3>
        <div class="structure-field">
          <label class="label" for="structure-new-name">{{ t('events.parties.name') }}</label>
          <input
            id="structure-new-name"
            class="input input--sm"
            type="text"
            maxlength="40"
            [value]="newName()"
            [placeholder]="t('events.parties.namePlaceholder')"
            (input)="newName.set(inputValue($event))"
          />
        </div>
        <div class="structure-field">
          <span class="label" id="structure-new-comp-label">{{ t('events.parties.comp') }}</span>
          <app-select
            size="sm"
            [options]="compOptions()"
            [value]="newCompId()"
            [placeholder]="t('events.parties.compPlaceholder')"
            ariaLabelledBy="structure-new-comp-label"
            (valueChange)="newCompId.set($event)"
          />
        </div>
        <div class="structure-card__actions">
          <button
            type="button"
            class="btn btn--primary btn--sm"
            [disabled]="busy() || !newCompId()"
            (click)="addParty()"
          >
            <app-icon name="plus" size="0.75rem" />
            {{ t('events.parties.add') }}
          </button>
        </div>
      </article>
    </section>

    @if (pendingRemoval(); as target) {
      <app-dialog [title]="t('events.parties.removeTitle')" size="sm" (closed)="pendingRemoval.set(null)">
        <p class="text-sm text-[var(--color-text-secondary)]">{{ t('events.parties.removeBody') }}</p>
        <div dialogFooter class="flex justify-end gap-2">
          <button type="button" class="btn btn--outline btn--sm" (click)="pendingRemoval.set(null)">
            {{ t('common.cancel') }}
          </button>
          <button type="button" class="btn btn--danger btn--sm" [disabled]="busy()" (click)="confirmRemoval(target)">
            {{ t('events.parties.remove') }}
          </button>
        </div>
      </app-dialog>
    }
  `,
})
export class EventPartyStructure {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  /** Event the parties belong to. */
  readonly eventId = input.required<number>();
  /** Latest roster snapshot: its `parties` are listed and its version guards every write. */
  readonly roster = input.required<EventRosterView>();
  /** The event's extra roster roles (any party); each card shows its own. */
  readonly extraRoles = input<readonly EventRosterRole[]>([]);

  /** Asks the page to reload the event after a party change succeeded. */
  readonly changed = output<void>();
  /** Asks the page to open the extra-role dialog preselected on this party. */
  readonly addRole = output<number>();
  /** Asks the page to remove an extra role. */
  readonly removeRole = output<EventRosterRole>();

  protected readonly parties = computed<readonly EventParty[]>(() => this.roster().parties ?? []);
  protected readonly comps = signal<readonly CompSummary[]>([]);
  protected readonly busy = signal(false);
  protected readonly pendingRemoval = signal<EventParty | null>(null);
  protected readonly newName = signal('');
  protected readonly newCompId = signal('');
  private readonly drafts = signal<Readonly<Record<number, PartyDraft>>>({});

  protected readonly compOptions = computed<readonly SelectOption[]>(() =>
    this.comps().map((comp) => ({
      value: String(comp.id),
      label: comp.name,
    })),
  );

  constructor() {
    void this.loadComps();
  }

  protected t(key: TranslationKey, params?: Record<string, string | number>): string {
    return this.translate.t(key, params);
  }

  protected defaultName(position: number): string {
    return this.t('events.lobby.party', { number: position });
  }

  protected roleName(role: string): string {
    const key = roleLabelKey(role);
    return key ? this.t(key) : role;
  }

  protected roleColor(role: string): string {
    return roleColorVar(role);
  }

  protected roleSummary(party: EventParty): { role: string; count: number }[] {
    return sortedRoleCounts(party.role_counts);
  }

  protected extraRolesOf(party: EventParty): readonly EventRosterRole[] {
    return this.extraRoles().filter((role) => !role.is_fill && role.party_id === party.id);
  }

  /** Comps to offer on a card: the list, plus the party's current comp if the list lacks it. */
  protected compOptionsFor(party: EventParty): readonly SelectOption[] {
    const options = this.compOptions();
    if (options.some((option) => option.value === String(party.comp_id))) return options;
    return [{ value: String(party.comp_id), label: party.comp_name }, ...options];
  }

  protected draftName(party: EventParty): string {
    return this.drafts()[party.id]?.name ?? party.name ?? '';
  }

  protected draftCompId(party: EventParty): string {
    return this.drafts()[party.id]?.compId ?? String(party.comp_id);
  }

  protected isDirty(party: EventParty): boolean {
    return (
      this.draftName(party).trim() !== (party.name ?? '') ||
      this.draftCompId(party) !== String(party.comp_id)
    );
  }

  protected setDraftName(party: EventParty, event: Event): void {
    this.patchDraft(party, { name: this.inputValue(event) });
  }

  protected setDraftComp(party: EventParty, compId: string): void {
    this.patchDraft(party, { compId });
  }

  protected inputValue(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  private patchDraft(party: EventParty, patch: Partial<PartyDraft>): void {
    const current: PartyDraft = {
      name: this.draftName(party),
      compId: this.draftCompId(party),
    };
    this.drafts.update((drafts) => ({ ...drafts, [party.id]: { ...current, ...patch } }));
  }

  protected async addParty(): Promise<void> {
    const compId = Number(this.newCompId());
    if (!Number.isInteger(compId) || compId <= 0) return;
    const body: CreateEventPartyRequest = {
      comp_id: compId,
      expected_roster_version: this.roster().roster_version,
    };
    const name = this.newName().trim();
    if (name) body.name = name;
    const done = await this.run<EventRosterView>(() =>
      this.api.post<EventRosterView>(`api/events/${this.eventId()}/parties`, body),
    );
    if (done) {
      this.newName.set('');
      this.newCompId.set('');
      this.toasts.success(this.t('events.parties.added'));
    }
  }

  protected async save(party: EventParty): Promise<void> {
    const compId = Number(this.draftCompId(party));
    if (!Number.isInteger(compId) || compId <= 0) return;
    const body: UpdateEventPartyRequest = {
      comp_id: compId,
      // An empty name clears the label.
      name: this.draftName(party).trim(),
      expected_roster_version: this.roster().roster_version,
    };
    const result = await this.run<EventPartyChange>(() =>
      this.api.patch<EventPartyChange>(`api/events/${this.eventId()}/parties/${party.id}`, body),
    );
    if (result) {
      this.clearDraft(party.id);
      this.toasts.success(this.t('events.parties.saved'));
      this.announceUnseated(result.value?.unseated_count);
    }
  }

  protected async confirmRemoval(party: EventParty): Promise<void> {
    const body: DeleteEventPartyRequest = {
      expected_roster_version: this.roster().roster_version,
    };
    const result = await this.run<EventPartyChange>(() =>
      this.api.delete<EventPartyChange>(`api/events/${this.eventId()}/parties/${party.id}`, body),
    );
    this.pendingRemoval.set(null);
    if (result) {
      this.clearDraft(party.id);
      this.toasts.success(this.t('events.parties.removed'));
      this.announceUnseated(result.value?.unseated_count);
    }
  }

  protected async move(party: EventParty, direction: -1 | 1): Promise<void> {
    const order = movedPartyOrder(
      this.parties().map((entry) => entry.id),
      party.id,
      direction,
    );
    if (!order) return;
    const body: ReorderEventPartiesRequest = {
      party_ids: order,
      expected_roster_version: this.roster().roster_version,
    };
    const done = await this.run<EventRosterView>(() =>
      this.api.post<EventRosterView>(`api/events/${this.eventId()}/parties/order`, body),
    );
    if (done) this.toasts.success(this.t('events.parties.reordered'));
  }

  private announceUnseated(count: number | undefined): void {
    if (!count || count <= 0) return;
    this.toasts.success(
      count === 1
        ? this.t('events.parties.unseatedOne')
        : this.t('events.parties.unseatedMany', { count }),
    );
  }

  private clearDraft(partyId: number): void {
    this.drafts.update((drafts) => {
      const next = { ...drafts };
      delete next[partyId];
      return next;
    });
  }

  /**
   * Runs one party command and asks the page to reload. Resolves to the response wrapped in an
   * object (the value is `undefined` for a body-less success), or `null` after showing the error.
   */
  private async run<T>(command: () => Observable<T | void>): Promise<{ value: T | undefined } | null> {
    if (this.busy()) return null;
    this.busy.set(true);
    try {
      const value = (await firstValueFrom(command())) as T | undefined;
      this.changed.emit();
      return { value };
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('events.parties.loadFailed'));
      // A stale version or a concurrent edit: show what the server has now.
      this.changed.emit();
      return null;
    } finally {
      this.busy.set(false);
    }
  }

  private async loadComps(): Promise<void> {
    try {
      const response = await firstValueFrom(
        this.api.get<PaginatedData<CompSummary>>('api/comps', {
          page: 1,
          limit: 500,
          sort: 'name',
          order: 'asc',
        }),
      );
      this.comps.set(response.items);
    } catch {
      this.toasts.error(this.t('events.parties.compsFailed'));
    }
  }
}
