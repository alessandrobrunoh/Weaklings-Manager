import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  PaginatedData,
  SiphonedBatchSummary,
  SiphonedEntryMutationRequest,
  SiphonedEntryView,
  SiphonedIngestRequest,
  SiphonedIngestResponse,
  SiphonedPlayerBalance,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';

const PAGE_SIZE = 10;

type SiphonedIngestRow = SiphonedIngestRequest['rows'][number];
type EntryDraft = Record<'occurred_at' | 'player_name' | 'reason' | 'amount', string>;

/**
 * Empty manual ledger form state.
 *
 * Keeping this as a factory prevents accidental shared object mutation when signals are reset.
 *
 * @example
 * const draft = emptyEntryDraft();
 */
function emptyEntryDraft(): EntryDraft {
  return {
    occurred_at: '',
    player_name: '',
    reason: '',
    amount: '',
  };
}

/**
 * Siphoned Energy operations page.
 *
 * Officers can paste Albion export rows and import them as immutable batches;
 * every authenticated member with view permission can inspect debts and the
 * raw ledger. The parser accepts comma, semicolon, or tab-separated exports so
 * it works with copied spreadsheet data without a separate preprocessing step.
 *
 * # Example
 * ```text
 * 2026-08-10 20:37:41;Galvdon;Withdrawal;-10
 * ```
 */
@Component({
  selector: 'app-siphoned',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PageHeader, EmptyState, Loading],
  template: `
    <app-page-header [title]="t('siphoned.title')" [subtitle]="t('siphoned.subtitle')">
      @if (canIngest()) {
        <button type="button" class="btn btn--primary" (click)="toggleIngestForm()">
          {{ showIngestForm() ? t('common.close') : t('siphoned.ingest') }}
        </button>
      }
    </app-page-header>

    <section class="card mb-6 p-5">
      <p class="text-sm font-semibold" style="color: var(--color-text-secondary)">
        Weekly manual update
      </p>
      <p class="mt-2 text-3xl font-bold" style="color: var(--color-text)">
        Last updated: {{ lastUpdatedLabel() }}
      </p>
      <p class="mt-2 text-sm" style="color: var(--color-text-secondary)">
        Update this ledger manually at least once per week by importing the latest Albion export.
      </p>
    </section>

    @if (showIngestForm()) {
      <form class="card mb-6 grid gap-4 p-5" (submit)="onIngestSubmit($event)">
        <label>
          <span class="label">Albion export rows</span>
          <textarea
            class="textarea font-mono text-xs"
            rows="8"
            [value]="rawExport()"
            (input)="onRawExportChange($event)"
            placeholder='"Date"&#9;"Player"&#9;"Reason"&#9;"Amount"&#10;"2026-08-10 20:37:41"&#9;"Galvdon"&#9;"Withdrawal"&#9;"-10"'
          ></textarea>
        </label>
        <p class="text-xs" style="color: var(--color-text-secondary)">
          Expected columns: Date, Player, Reason, Amount. You can paste the quoted tab-separated
          Albion export directly.
        </p>
        <div class="flex justify-end gap-2">
          <button type="button" class="btn btn--ghost" (click)="toggleIngestForm()">
            {{ t('common.cancel') }}
          </button>
          <button type="submit" class="btn btn--primary" [disabled]="saving()">
            {{ t('siphoned.ingest') }}
          </button>
        </div>
      </form>
    }

    <div
      class="mb-4 inline-flex gap-1 p-1"
      style="background-color: var(--color-surface-1); border-radius: var(--radius-md)"
    >
      <button
        type="button"
        class="btn btn--ghost"
        [class.btn--tonal]="tab() === 'balances'"
        (click)="switchTab('balances')"
      >
        {{ t('siphoned.balances') }}
      </button>
      <button
        type="button"
        class="btn btn--ghost"
        [class.btn--tonal]="tab() === 'entries'"
        (click)="switchTab('entries')"
      >
        {{ t('siphoned.entries') }}
      </button>
      <button
        type="button"
        class="btn btn--ghost"
        [class.btn--tonal]="tab() === 'batches'"
        (click)="switchTab('batches')"
      >
        {{ t('siphoned.batches') }}
      </button>
    </div>

    @if (loading()) {
      <app-loading [label]="t('common.loading')" />
    } @else if (tab() === 'balances') {
      @if (balances().length === 0) {
        <app-empty-state [message]="t('common.empty')" icon="activity" />
      } @else {
        <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          @for (balance of balances(); track balance.player_name) {
            <article class="card p-5">
              <div class="mb-3 flex items-start justify-between gap-3">
                <h3 class="font-semibold" style="color: var(--color-text)">
                  {{ balance.player_name }}
                </h3>
                <span
                  class="chip"
                  [class.chip--error]="toNumber(balance.net) < 0"
                  [class.chip--success]="toNumber(balance.net) > 0"
                >
                  {{ balanceStatusLabel(balance.net) }}
                  {{ formatAmount(absoluteAmount(balance.net)) }}
                </span>
              </div>
              <dl class="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt style="color: var(--color-text-secondary)">Deposited</dt>
                  <dd>{{ formatAmount(balance.total_deposited) }}</dd>
                </div>
                <div>
                  <dt style="color: var(--color-text-secondary)">Withdrawn</dt>
                  <dd>{{ formatAmount(balance.total_withdrawn) }}</dd>
                </div>
                <div>
                  <dt style="color: var(--color-text-secondary)">Entries</dt>
                  <dd>{{ balance.entry_count }}</dd>
                </div>
                <div>
                  <dt style="color: var(--color-text-secondary)">Last seen</dt>
                  <dd>{{ formatDate(balance.last_seen) }}</dd>
                </div>
              </dl>
            </article>
          }
        </div>
      }
    } @else if (tab() === 'entries') {
      @if (canIngest()) {
        <form class="card mb-4 grid gap-3 p-5" (submit)="onEntrySubmit($event)">
          <div class="grid gap-3 md:grid-cols-4">
            <label>
              <span class="label">Date</span>
              <input
                class="input"
                type="datetime-local"
                step="1"
                [value]="entryDraft().occurred_at"
                (input)="updateEntryDraft('occurred_at', $event)"
              />
            </label>
            <label>
              <span class="label">Player</span>
              <input
                class="input"
                type="text"
                [value]="entryDraft().player_name"
                (input)="updateEntryDraft('player_name', $event)"
                placeholder="Galvdon"
              />
            </label>
            <label>
              <span class="label">Reason</span>
              <input
                class="input"
                type="text"
                [value]="entryDraft().reason"
                (input)="updateEntryDraft('reason', $event)"
                placeholder="Deposit or Withdrawal"
              />
            </label>
            <label>
              <span class="label">Amount</span>
              <input
                class="input"
                type="number"
                step="1"
                [value]="entryDraft().amount"
                (input)="updateEntryDraft('amount', $event)"
                placeholder="-10"
              />
            </label>
          </div>
          <div class="flex justify-end gap-2">
            @if (editingEntryId() !== null) {
              <button type="button" class="btn btn--ghost" (click)="resetEntryDraft()">
                {{ t('common.cancel') }}
              </button>
            }
            <button type="submit" class="btn btn--primary" [disabled]="saving()">
              {{ editingEntryId() === null ? 'Add entry' : 'Save entry' }}
            </button>
          </div>
        </form>
      }

      @if (entries().length === 0) {
        <app-empty-state [message]="t('common.empty')" icon="activity" />
      } @else {
        <div class="overflow-x-auto card">
          <table class="table">
            <thead>
              <tr>
                <th>{{ t('common.date') }}</th>
                <th>{{ t('common.name') }}</th>
                <th>{{ t('common.status') }}</th>
                <th>{{ t('common.amount') }}</th>
                @if (canIngest()) {
                  <th>Actions</th>
                }
              </tr>
            </thead>
            <tbody>
              @for (entry of entries(); track entry.id) {
                <tr>
                  <td>{{ formatDate(entry.occurred_at) }}</td>
                  <td>{{ entry.player_name }}</td>
                  <td>
                    <span class="chip">{{ entry.reason }}</span>
                  </td>
                  <td>{{ formatAmount(entry.amount) }}</td>
                  @if (canIngest()) {
                    <td>
                      <div class="flex gap-2">
                        <button type="button" class="btn btn--ghost" (click)="editEntry(entry)">
                          Edit
                        </button>
                        <button
                          type="button"
                          class="btn btn--danger"
                          (click)="deleteEntry(entry.id)"
                        >
                          {{ t('common.delete') }}
                        </button>
                      </div>
                    </td>
                  }
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    } @else {
      @if (batches().length === 0) {
        <app-empty-state [message]="t('common.empty')" icon="activity" />
      } @else {
        <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          @for (batch of batches(); track batch.batch_id) {
            <article class="card p-5">
              <p class="font-mono text-xs" style="color: var(--color-text-secondary)">
                {{ batch.batch_id }}
              </p>
              <p class="mt-2 text-sm">
                {{ batch.row_count }} rows · {{ formatDate(batch.ingested_at) }}
              </p>
              @if (canIngest()) {
                <button
                  type="button"
                  class="btn btn--danger mt-4"
                  (click)="deleteBatch(batch.batch_id)"
                >
                  {{ t('common.delete') }}
                </button>
              }
            </article>
          }
        </div>
      }
    }
  `,
})
export class Siphoned {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly tab = signal<'balances' | 'entries' | 'batches'>('balances');
  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly showIngestForm = signal(false);
  protected readonly rawExport = signal('');
  protected readonly balances = signal<SiphonedPlayerBalance[]>([]);
  protected readonly entries = signal<SiphonedEntryView[]>([]);
  protected readonly batches = signal<SiphonedBatchSummary[]>([]);
  protected readonly lastUpdatedAt = signal<string | null>(null);
  protected readonly editingEntryId = signal<number | null>(null);
  protected readonly entryDraft = signal<EntryDraft>(emptyEntryDraft());

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.refreshLastUpdated();
    void this.load();
  }

  protected canIngest(): boolean {
    return this.auth.hasPermission('siphoned.ingest');
  }

  protected toggleIngestForm(): void {
    this.showIngestForm.update((isVisible) => !isVisible);
  }

  protected onRawExportChange(event: Event): void {
    this.rawExport.set((event.target as HTMLTextAreaElement).value);
  }

  protected switchTab(tab: 'balances' | 'entries' | 'batches'): void {
    if (this.tab() === tab) {
      return;
    }
    this.tab.set(tab);
    void this.load();
  }

  protected onIngestSubmit(event: SubmitEvent): void {
    event.preventDefault();
    void this.ingest();
  }

  protected onEntrySubmit(event: SubmitEvent): void {
    event.preventDefault();
    void this.saveEntry();
  }

  protected updateEntryDraft(field: keyof EntryDraft, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.entryDraft.update((draft) => ({ ...draft, [field]: value }));
  }

  protected editEntry(entry: SiphonedEntryView): void {
    this.editingEntryId.set(entry.id);
    this.entryDraft.set({
      occurred_at: this.toDateTimeLocal(entry.occurred_at),
      player_name: entry.player_name,
      reason: entry.reason,
      amount: String(entry.amount),
    });
  }

  protected resetEntryDraft(): void {
    this.editingEntryId.set(null);
    this.entryDraft.set(emptyEntryDraft());
  }

  private async ingest(): Promise<void> {
    const request = this.buildIngestRequest();
    if (!request) {
      return;
    }

    this.saving.set(true);
    try {
      const response = await firstValueFrom(
        this.api.post<SiphonedIngestResponse>('api/siphoned/ingest', request),
      );
      this.rawExport.set('');
      this.showIngestForm.set(false);
      this.toasts.success(`${response.ingested_count} rows imported`);
      await this.refreshLastUpdated();
      await this.load();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  private async saveEntry(): Promise<void> {
    const request = this.buildEntryMutationRequest();
    if (!request) {
      return;
    }

    this.saving.set(true);
    try {
      const editingId = this.editingEntryId();
      if (editingId === null) {
        await firstValueFrom(this.api.post<SiphonedEntryView>('api/siphoned/entries', request));
        this.toasts.success('Entry added');
      } else {
        await firstValueFrom(
          this.api.put<SiphonedEntryView>(`api/siphoned/entries/${editingId}`, request),
        );
        this.toasts.success('Entry updated');
      }
      this.resetEntryDraft();
      await this.loadEntriesAndBalancesAfterMutation();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async deleteEntry(entryId: number): Promise<void> {
    try {
      await firstValueFrom(this.api.delete(`api/siphoned/entries/${entryId}`));
      this.toasts.success(this.t('common.delete'));
      await this.loadEntriesAndBalancesAfterMutation();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  protected async deleteBatch(batchId: string): Promise<void> {
    try {
      await firstValueFrom(this.api.delete(`api/siphoned/batches/${encodeURIComponent(batchId)}`));
      await this.refreshLastUpdated();
      await this.load();
      this.toasts.success(this.t('common.delete'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  protected formatAmount(value: number | string): string {
    return this.toNumber(value).toLocaleString();
  }

  protected formatDate(iso: string): string {
    return new Date(iso).toLocaleString();
  }

  protected lastUpdatedLabel(): string {
    const lastUpdatedAt = this.lastUpdatedAt();
    if (!lastUpdatedAt) {
      return 'Never';
    }
    return this.formatDate(lastUpdatedAt);
  }

  protected toNumber(value: number | string): number {
    return typeof value === 'number' ? value : Number(value);
  }

  /**
   * Keeps balance chips readable by showing magnitude separately from debt/credit direction.
   *
   * @example
   * absoluteAmount('-28')
   */
  protected absoluteAmount(value: number | string): number {
    return Math.abs(this.toNumber(value));
  }

  /**
   * Labels the accounting direction so positive balances are clearly visible next to debts.
   *
   * @example
   * balanceStatusLabel(28)
   */
  protected balanceStatusLabel(value: number | string): 'Credit' | 'Debt' | 'Even' {
    const amount = this.toNumber(value);
    if (amount > 0) {
      return 'Credit';
    }
    if (amount < 0) {
      return 'Debt';
    }
    return 'Even';
  }

  /**
   * Converts the single-entry form into the backend mutation payload.
   *
   * Manual corrections share the same validation constraints as imported rows: complete timestamp,
   * non-empty player/reason, and non-zero numeric amount.
   *
   * @example
   * const request = component['buildEntryMutationRequest']();
   */
  private buildEntryMutationRequest(): SiphonedEntryMutationRequest | null {
    const draft = this.entryDraft();
    const amount = Number(draft.amount);
    if (!draft.occurred_at || !draft.player_name.trim() || !draft.reason.trim()) {
      this.toasts.error(this.t('validation.required'));
      return null;
    }
    if (!Number.isFinite(amount) || amount === 0) {
      this.toasts.error('Amount must be a non-zero number');
      return null;
    }

    return {
      occurred_at: this.normalizeDate(draft.occurred_at, 1),
      player_name: draft.player_name.trim(),
      reason: draft.reason.trim(),
      amount,
    };
  }

  /**
   * Converts an ISO timestamp into the value expected by `datetime-local` inputs.
   *
   * The ledger treats copied Albion timestamps as UTC, so the rendered editor keeps UTC fields
   * instead of shifting them into the browser timezone.
   *
   * @example
   * toDateTimeLocal('2026-08-10T20:37:41Z')
   */
  private toDateTimeLocal(iso: string): string {
    const date = new Date(iso);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    const hour = String(date.getUTCHours()).padStart(2, '0');
    const minute = String(date.getUTCMinutes()).padStart(2, '0');
    const second = String(date.getUTCSeconds()).padStart(2, '0');
    return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  }

  /**
   * Converts the pasted Albion ledger into the backend ingest payload.
   *
   * The export copied from spreadsheets is commonly quoted TSV and includes a header row. Invalid
   * non-empty data rows fail the whole import so operators do not accidentally write partial or
   * timestamp-shifted ledger entries.
   *
   * @example
   * component.rawExport.set('"Date"\t"Player"\t"Reason"\t"Amount"\n"2026-08-10 20:37:41"\t"Galvdon"\t"Withdrawal"\t"-10"');
   * const request = component['buildIngestRequest']();
   */
  private buildIngestRequest(): SiphonedIngestRequest | null {
    try {
      const rows = this.rawExport()
        .split(/\r?\n/)
        .map((line, index) => this.parseExportLine(line, index + 1))
        .filter((row): row is SiphonedIngestRow => row !== null);

      if (rows.length === 0) {
        this.toasts.error(this.t('validation.required'));
        return null;
      }

      return { rows };
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
      return null;
    }
  }

  /**
   * Parses one pasted export row while preserving quoted separators inside fields.
   *
   * Empty lines and the canonical header row are ignored. Every other malformed line reports its
   * line number so the officer can fix the source paste before writing an immutable batch.
   *
   * @example
   * parseExportLine('"2026-08-10 20:37:41"\t"Galvdon"\t"Withdrawal"\t"-10"', 2)
   */
  private parseExportLine(line: string, lineNumber: number): SiphonedIngestRow | null {
    const trimmed = line.trim();
    if (!trimmed) {
      return null;
    }

    const [dateValue, playerName, reason, amountValue] = this.parseDelimitedLine(trimmed).map(
      (field) => this.stripOuterQuotes(field.trim()),
    );
    if (this.isHeaderRow(dateValue, playerName, reason, amountValue)) {
      return null;
    }
    if (!dateValue || !playerName || !reason || !amountValue) {
      throw new Error(
        `Invalid export row at line ${lineNumber}: expected Date, Player, Reason, Amount.`,
      );
    }

    const amount = Number(amountValue.replace(/\s/g, ''));
    if (!Number.isFinite(amount)) {
      throw new Error(`Invalid amount at line ${lineNumber}: ${amountValue}`);
    }

    return {
      occurred_at: this.normalizeDate(dateValue, lineNumber),
      player_name: playerName,
      reason,
      amount,
    };
  }

  /**
   * Splits CSV/TSV-style text without breaking quoted fields.
   *
   * Albion exports copied from sheets are tab-separated, but older users may paste semicolon or
   * comma files. The separator is detected from the first unquoted delimiter in the row.
   *
   * @example
   * parseDelimitedLine('"Date"\t"Player"\t"Reason"\t"Amount"')
   */
  private parseDelimitedLine(line: string): string[] {
    const separator = this.detectSeparator(line);
    const fields: string[] = [];
    let currentField = '';
    let isInsideQuotes = false;

    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      const nextCharacter = line[index + 1];
      if (character === '"' && nextCharacter === '"' && isInsideQuotes) {
        currentField += '"';
        index += 1;
        continue;
      }
      if (character === '"') {
        isInsideQuotes = !isInsideQuotes;
        currentField += character;
        continue;
      }
      if (character === separator && !isInsideQuotes) {
        fields.push(currentField);
        currentField = '';
        continue;
      }
      currentField += character;
    }

    fields.push(currentField);
    return fields;
  }

  /**
   * Chooses the delimiter from the pasted row using only unquoted characters.
   *
   * Tabs are preferred because the official copied table uses TSV; comma and semicolon remain for
   * manually exported files.
   *
   * @example
   * detectSeparator('"Date"\t"Player"')
   */
  private detectSeparator(line: string): '\t' | ';' | ',' {
    const counts: Record<'\t' | ';' | ',', number> = { '\t': 0, ';': 0, ',': 0 };
    let isInsideQuotes = false;

    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      if (character === '"') {
        isInsideQuotes = !isInsideQuotes;
        continue;
      }
      if (!isInsideQuotes && (character === '\t' || character === ';' || character === ',')) {
        counts[character] += 1;
      }
    }

    if (counts['\t'] > 0) {
      return '\t';
    }
    if (counts[';'] > 0) {
      return ';';
    }
    return ',';
  }

  /**
   * Removes one surrounding quote pair while preserving quotes inside the value.
   *
   * Spreadsheet copies quote every cell; stripping here keeps the rest of the parser independent
   * from the source format.
   *
   * @example
   * stripOuterQuotes('"Withdrawal"')
   */
  private stripOuterQuotes(value: string): string {
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      return value.slice(1, -1).replace(/""/g, '"');
    }
    return value;
  }

  /**
   * Detects the optional exported header row.
   *
   * The comparison is case-insensitive so translated spreadsheet tools or casing changes do not
   * accidentally import the header as a ledger row.
   *
   * @example
   * isHeaderRow('Date', 'Player', 'Reason', 'Amount')
   */
  private isHeaderRow(
    dateValue: string | undefined,
    playerName: string | undefined,
    reason: string | undefined,
    amountValue: string | undefined,
  ): boolean {
    return (
      dateValue?.toLowerCase() === 'date' &&
      playerName?.toLowerCase() === 'player' &&
      reason?.toLowerCase() === 'reason' &&
      amountValue?.toLowerCase() === 'amount'
    );
  }

  /**
   * Normalizes Albion's timezone-less timestamp into a UTC ISO string accepted by the backend.
   *
   * The copied export does not include an offset, so constructing `Date` from the string directly
   * would apply the browser's local timezone and shift the stored hour. Parsing the components with
   * `Date.UTC` preserves the visible Albion timestamp as UTC. Invalid dates throw instead of
   * falling back to `now`, because this ledger is immutable and a hidden replacement would corrupt
   * debt calculations.
   *
   * @example
   * normalizeDate('2026-08-10 20:37:41', 2)
   */
  private normalizeDate(value: string, lineNumber: number): string {
    const normalizedValue = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? `${value}:00` : value;
    const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(normalizedValue);
    if (!match) {
      throw new Error(`Invalid date at line ${lineNumber}: ${value}`);
    }

    const [, year, month, day, hour, minute, second] = match;
    const yearNumber = Number(year);
    const monthNumber = Number(month);
    const dayNumber = Number(day);
    const hourNumber = Number(hour);
    const minuteNumber = Number(minute);
    const secondNumber = Number(second);
    const date = new Date(
      Date.UTC(yearNumber, monthNumber - 1, dayNumber, hourNumber, minuteNumber, secondNumber),
    );
    const isSameUtcTimestamp =
      date.getUTCFullYear() === yearNumber &&
      date.getUTCMonth() === monthNumber - 1 &&
      date.getUTCDate() === dayNumber &&
      date.getUTCHours() === hourNumber &&
      date.getUTCMinutes() === minuteNumber &&
      date.getUTCSeconds() === secondNumber;
    if (Number.isNaN(date.getTime()) || !isSameUtcTimestamp) {
      throw new Error(`Invalid date at line ${lineNumber}: ${value}`);
    }
    return date.toISOString();
  }

  /**
   * Refreshes the weekly update banner from the latest import batch.
   *
   * Batch timestamps represent when officers pasted a full Albion export, which is the important
   * weekly operational checkpoint. Manual single-entry corrections do not move this reminder.
   *
   * @example
   * await refreshLastUpdated();
   */
  private async refreshLastUpdated(): Promise<void> {
    try {
      const batches = await firstValueFrom(
        this.api.get<SiphonedBatchSummary[]>('api/siphoned/batches'),
      );
      this.batches.set(batches);
      this.lastUpdatedAt.set(batches[0]?.ingested_at ?? null);
    } catch {
      this.lastUpdatedAt.set(null);
    }
  }

  /**
   * Keeps the visible ledger and accounting totals in sync after single-row corrections.
   *
   * @example
   * await loadEntriesAndBalancesAfterMutation();
   */
  private async loadEntriesAndBalancesAfterMutation(): Promise<void> {
    await this.load();
    const balances = await firstValueFrom(
      this.api.get<SiphonedPlayerBalance[]>('api/siphoned/balances'),
    );
    this.balances.set(balances);
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      if (this.tab() === 'balances') {
        const balances = await firstValueFrom(
          this.api.get<SiphonedPlayerBalance[]>('api/siphoned/balances'),
        );
        this.balances.set(balances);
        return;
      }

      if (this.tab() === 'entries') {
        const page = await firstValueFrom(
          this.api.get<PaginatedData<SiphonedEntryView>>('api/siphoned/entries', {
            page: 1,
            limit: PAGE_SIZE,
          }),
        );
        this.entries.set(page.items);
        return;
      }

      const batches = await firstValueFrom(
        this.api.get<SiphonedBatchSummary[]>('api/siphoned/batches'),
      );
      this.batches.set(batches);
      this.lastUpdatedAt.set(batches[0]?.ingested_at ?? null);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }
}
