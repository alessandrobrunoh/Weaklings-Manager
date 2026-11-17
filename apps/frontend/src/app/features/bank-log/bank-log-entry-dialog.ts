import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  BankLogCandidate,
  BankLogCategory,
  BankLogEntry,
  BankLogLink,
  BankLogLinkKind,
  BankLogLinkTarget,
  BankLogStatus,
  PaginatedData,
  UserProfile,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Checkbox } from '../../shared/components/checkbox/checkbox';
import { Dialog } from '../../shared/components/dialog/dialog';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { Icon } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import {
  SearchableSelect,
  type SearchableSelectOption,
} from '../../shared/components/searchable-select/searchable-select';
import { Select, type SelectOption } from '../../shared/components/select/select';
import { StatusChip } from '../../shared/components/status-chip/status-chip';
import { Tabs, type TabOption } from '../../shared/components/tabs/tabs';
import {
  formatSignedSilver,
  formatSilver,
  formatSpan,
  formatUtc,
  minutesBetween,
  numeric,
} from './bank-log-format';
import { BankLogScore } from './bank-log-score';

type ChipTone = 'warning' | 'info' | 'success' | 'neutral';
type EntryTab = 'match' | 'explain' | 'transaction';
type ValueKind = 'bags' | 'loot_sale';

const CATEGORIES: readonly BankLogCategory[] = ['payout', 'bags', 'loot_sale', 'guild_expense', 'donation', 'other'];

const CATEGORY_KEYS: Record<BankLogCategory, TranslationKey> = {
  payout: 'bankLog.category.payout',
  bags: 'bankLog.category.bags',
  loot_sale: 'bankLog.category.loot_sale',
  guild_expense: 'bankLog.category.guild_expense',
  donation: 'bankLog.category.donation',
  other: 'bankLog.category.other',
};

const STATUS_KEYS: Record<BankLogStatus, TranslationKey> = {
  unmatched: 'bankLog.state.unmatched',
  suggested: 'bankLog.state.suggested',
  matched: 'bankLog.state.matched',
  explained: 'bankLog.state.explained',
};

const STATUS_TONES: Record<BankLogStatus, ChipTone> = {
  unmatched: 'warning',
  suggested: 'info',
  matched: 'success',
  explained: 'neutral',
};

const LINK_KIND_KEYS: Record<BankLogLinkKind, TranslationKey> = {
  payout: 'bankLog.category.payout',
  bags: 'bankLog.category.bags',
  loot_sale: 'bankLog.category.loot_sale',
  manual: 'bankLog.links.kind.manual',
};

/** Ready-made explanations an officer can start from. */
const EXPLAIN_PRESETS: readonly TranslationKey[] = [
  'bankLog.explain.preset.officerMove',
  'bankLog.explain.preset.personal',
  'bankLog.explain.preset.settledOutside',
  'bankLog.explain.preset.purchase',
];

const WINDOW_DAYS = [1, 7, 30] as const;

/**
 * One bank log row: what it is, what it is linked to, and the three ways to resolve it (link it
 * to Manager records, explain it, or create the missing transaction).
 *
 * Owns its own requests; tells the page through `changed` so the summary and the table reload.
 */
@Component({
  selector: 'app-bank-log-entry-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Checkbox, Dialog, EmptyState, Icon, Loading, SearchableSelect, Select, StatusChip, Tabs, BankLogScore],
  styles: `
    :host {
      display: contents;
    }
    .entry {
      display: grid;
      gap: 1rem;
      min-width: 0;
    }
    .entry__hero {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 0.75rem 1.5rem;
      padding: var(--card-padding);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-cards);
      background: var(--color-surface-2);
    }
    .entry__amount {
      display: block;
      font-size: var(--ui-text-xl);
      font-weight: 700;
      line-height: 1.75rem;
      font-variant-numeric: tabular-nums;
    }
    .entry__in {
      color: var(--color-success);
    }
    .entry__out {
      color: var(--color-error);
    }
    .entry__who {
      margin: 0.125rem 0 0;
      font-size: var(--ui-text-sm);
      color: var(--color-text-secondary);
    }
    .entry__who strong {
      color: var(--color-text);
      font-weight: 600;
    }
    .entry__meta {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-end;
      gap: 0.75rem 1.25rem;
      margin: 0;
    }
    .entry__meta dt {
      font-size: var(--ui-text-xs);
      font-weight: 600;
      color: var(--color-text-secondary);
    }
    .entry__meta dd {
      margin: 0.25rem 0 0;
      font-size: var(--ui-text-sm);
    }
    .entry__category {
      width: 11rem;
    }
    .entry__section {
      display: grid;
      gap: 0.625rem;
      min-width: 0;
    }
    .entry__section-head {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-end;
      justify-content: space-between;
      gap: 0.5rem 1rem;
    }
    .entry__section-head h3 {
      margin: 0;
    }
    .entry__list {
      display: grid;
      gap: 0.5rem;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .entry__match {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto auto;
      align-items: center;
      gap: 0.5rem 1rem;
      padding: 0.75rem;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-inputs);
      background: var(--color-surface);
    }
    .entry__match--best {
      border-color: color-mix(in srgb, var(--color-primary) 45%, var(--color-border));
    }
    .entry__match--linked {
      grid-template-columns: auto minmax(0, 1fr) auto auto;
      border-color: color-mix(in srgb, var(--color-success) 45%, var(--color-border));
    }
    .entry__match-title {
      margin: 0;
      font-size: var(--ui-text-sm);
      font-weight: 600;
      color: var(--color-text);
      overflow-wrap: anywhere;
    }
    .entry__match-sub {
      margin: 0.125rem 0 0;
      font-size: var(--ui-text-xs);
      color: var(--color-text-secondary);
      overflow-wrap: anywhere;
    }
    .entry__facts {
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem 0.375rem;
      margin: 0.375rem 0 0;
      padding: 0;
      list-style: none;
    }
    .entry__fact {
      padding: 0 0.375rem;
      border-radius: var(--radius-badges);
      background: var(--color-surface-2);
      font-size: var(--ui-text-xs);
      line-height: 1.25rem;
      color: var(--color-text-secondary);
    }
    .entry__fact--good {
      color: var(--color-success);
    }
    .entry__fact--off {
      color: var(--color-warning);
    }
    .entry__match-amount {
      font-size: var(--ui-text-sm);
      font-weight: 600;
      text-align: end;
      white-space: nowrap;
    }
    .entry__match-actions {
      display: flex;
      gap: 0.375rem;
      justify-content: flex-end;
    }
    .entry__tools {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem 0.75rem;
    }
    .entry__search {
      flex: 1 1 14rem;
      min-width: 0;
    }
    .entry__finder {
      max-height: 22rem;
      overflow: auto;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-inputs);
    }
    .entry__finder thead th {
      position: sticky;
      top: 0;
      z-index: 1;
    }
    .entry__finder tbody tr {
      cursor: pointer;
    }
    .entry__finder tbody tr.entry__row--selected {
      background: var(--color-primary-subtle);
    }
    .entry__finder tbody tr.entry__row--linked {
      cursor: not-allowed;
      opacity: 0.6;
    }
    .entry__finder td {
      vertical-align: top;
    }
    .entry__pick {
      width: 2.25rem;
    }
    .entry__nowrap {
      white-space: nowrap;
    }
    .entry__exact {
      color: var(--color-success);
      font-weight: 600;
    }
    .entry__selection {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem 1rem;
      padding: 0.625rem 0.75rem;
      border-radius: var(--radius-inputs);
      background: var(--color-surface-2);
      font-size: var(--ui-text-sm);
    }
    .entry__presets {
      display: flex;
      flex-wrap: wrap;
      gap: 0.375rem;
    }
    .entry__preview {
      margin: 0;
      padding: 0.75rem;
      border-left: 3px solid var(--color-primary);
      border-radius: var(--radius-inputs);
      background: var(--color-surface-2);
      font-size: var(--ui-text-sm);
    }
    .entry__form {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 12rem;
      gap: 0.75rem;
    }
    .entry__field {
      display: grid;
      align-content: start;
      gap: 0.25rem;
      min-width: 0;
    }
    .entry__warning {
      display: flex;
      align-items: center;
      gap: 0.375rem;
      margin: 0;
      font-size: var(--ui-text-xs);
      color: var(--color-warning);
    }
    @media (max-width: 640px) {
      .entry__hero {
        grid-template-columns: minmax(0, 1fr);
      }
      /* Phones: score on top, the record under it, then amount beside the buttons. */
      .entry__match {
        grid-template-columns: minmax(0, 1fr) auto;
      }
      .entry__match > app-bank-log-score {
        grid-column: 1 / -1;
        justify-self: start;
      }
      .entry__match > div:not(.entry__match-actions) {
        grid-column: 1 / -1;
      }
      .entry__match--linked {
        grid-template-columns: auto minmax(0, 1fr) auto;
      }
      .entry__match--linked > div:not(.entry__match-actions) {
        grid-column: 2 / -1;
      }
      .entry__match--linked > .entry__match-amount {
        grid-column: 2;
      }
      .entry__match-amount {
        text-align: start;
      }
      .entry__form {
        grid-template-columns: minmax(0, 1fr);
      }
      /* Phones: each candidate becomes a card — tick | score … amount / record / when. */
      .entry__finder thead {
        display: none;
      }
      .entry__finder table,
      .entry__finder tbody {
        display: block;
      }
      .entry__finder tbody tr {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        align-items: center;
        gap: 0.25rem 0.75rem;
        padding: 0.625rem 0.75rem;
        border-bottom: 1px solid var(--color-border);
      }
      .entry__finder tbody tr:last-child {
        border-bottom: 0;
      }
      .entry__finder tbody td {
        display: block;
        width: auto;
        padding: 0;
        border: 0;
      }
      .entry__finder tbody td.entry__pick {
        grid-column: 1;
        grid-row: 1 / span 3;
        align-self: start;
      }
      .entry__finder tbody td:nth-child(3),
      .entry__finder tbody td.entry__when {
        grid-column: 2 / -1;
      }
      .entry__finder tbody td:nth-child(5) {
        grid-column: 3;
        grid-row: 1;
      }
      .entry__finder tbody td.entry__when {
        font-size: var(--ui-text-xs);
        white-space: normal;
      }
      .entry__finder tbody td.entry__hide-sm {
        display: none;
      }
      .entry__hide-sm {
        display: none;
      }
    }
  `,
  template: `
    @if (entry(); as row) {
      <app-dialog [title]="title()" [subtitle]="subtitle()" size="xl" (closed)="closed.emit()">
        <div class="entry">
          <!-- What the game says -->
          <section class="entry__hero" [attr.aria-label]="t('bankLog.entry.gameRow')">
            <div>
              <span class="entry__amount" [class.entry__in]="!withdrawal()" [class.entry__out]="withdrawal()">
                {{ signed(row.amount) }}
              </span>
              <p class="entry__who">
                {{ withdrawal() ? t('bankLog.entry.withdrawnBy') : t('bankLog.entry.depositedBy') }}
                <strong>{{ row.player_name }}</strong> · {{ utc(row.occurred_at) }}
              </p>
              @if (row.reason.toLowerCase() !== 'withdrawal' && row.reason.toLowerCase() !== 'deposit') {
                <p class="entry__who">{{ row.reason }}</p>
              }
              @if (row.occurrence > 1) {
                <p class="entry__who">{{ t('bankLog.detail.occurrence', { count: row.occurrence }) }}</p>
              }
            </div>
            <dl class="entry__meta">
              <div>
                <dt>{{ t('common.status') }}</dt>
                <dd><app-status-chip [value]="row.status" [label]="statusLabel(row.status)" [toneOverride]="statusTone(row.status)" /></dd>
              </div>
              <div>
                <dt id="entry-category-label">{{ t('common.category') }}</dt>
                <dd>
                  @if (canManage()) {
                    <app-select
                      class="entry__category"
                      size="sm"
                      [options]="categoryOptions()"
                      [value]="row.category"
                      [ariaLabel]="t('common.category')"
                      [disabled]="saving()"
                      (valueChange)="setCategory($event)"
                    />
                  } @else {
                    {{ categoryLabel(row.category) }}
                  }
                </dd>
              </div>
            </dl>
          </section>

          <!-- Confirmed link -->
          @if (confirmedLinks().length > 0) {
            <section class="entry__section" aria-labelledby="entry-linked-heading">
              <h3 id="entry-linked-heading" class="section-title section-title--sm">{{ t('bankLog.entry.linkedTo') }}</h3>
              <ul class="entry__list">
                @for (link of confirmedLinks(); track link.id) {
                  <li class="entry__match entry__match--linked">
                    <app-icon name="check" size="1rem" class="entry__in" />
                    <div>
                      <p class="entry__match-title">{{ linkTitle(link) }}</p>
                      <p class="entry__match-sub">{{ linkSubtitle(link) }}</p>
                    </div>
                    <span class="entry__match-amount num">{{ amount(linkTargetsTotal(link)) }}</span>
                    @if (canManage()) {
                      <div class="entry__match-actions">
                        <button type="button" class="btn btn--ghost btn--sm" [disabled]="saving()" (click)="removeLink(link)">
                          {{ t('bankLog.links.remove') }}
                        </button>
                      </div>
                    }
                  </li>
                }
              </ul>
            </section>
          }

          @if (row.status === 'explained') {
            <section class="entry__section" aria-labelledby="entry-explained-heading">
              <h3 id="entry-explained-heading" class="section-title section-title--sm">{{ t('bankLog.state.explained') }}</h3>
              <p class="entry__preview">{{ row.note }}</p>
              @if (canManage()) {
                <div>
                  <button type="button" class="btn btn--outline btn--sm" [disabled]="saving()" (click)="undoExplanation()">
                    {{ t('bankLog.explain.undo') }}
                  </button>
                </div>
              }
            </section>
          } @else if (confirmedLinks().length === 0) {
            @if (canManage()) {
              <app-tabs [options]="tabs()" [active]="tab()" [ariaLabel]="t('bankLog.entry.resolve')" (activeChange)="setTab($event)" />

              @switch (tab()) {
                @case ('match') {
                  <!-- Suggestions -->
                  <section class="entry__section" aria-labelledby="entry-suggestions-heading">
                    <div class="entry__section-head">
                      <div>
                        <h3 id="entry-suggestions-heading" class="section-title section-title--sm">{{ t('bankLog.links.suggestions') }}</h3>
                        <p class="hint">{{ t('bankLog.entry.suggestionsHint') }}</p>
                      </div>
                      <button type="button" class="btn btn--ghost btn--sm" [disabled]="saving()" (click)="searchAgain()">
                        <app-icon name="refresh" size="0.875rem" />
                        {{ t('bankLog.entry.searchAgain') }}
                      </button>
                    </div>
                    @if (suggestedLinks().length === 0) {
                      <p class="hint">{{ t('bankLog.entry.noSuggestions') }}</p>
                    } @else {
                      <ol class="entry__list">
                        @for (link of suggestedLinks(); track link.id; let first = $first) {
                          <li class="entry__match" [class.entry__match--best]="first">
                            <app-bank-log-score [score]="link.score" />
                            <div>
                              <p class="entry__match-title">{{ linkTitle(link) }}</p>
                              <p class="entry__match-sub">{{ linkSubtitle(link) }}</p>
                              <ul class="entry__facts">
                                @for (fact of linkFacts(link); track fact.text) {
                                  <li class="entry__fact" [class.entry__fact--good]="fact.tone === 'good'" [class.entry__fact--off]="fact.tone === 'off'">{{ fact.text }}</li>
                                }
                              </ul>
                            </div>
                            <span class="entry__match-amount num">{{ amount(linkTargetsTotal(link)) }}</span>
                            <div class="entry__match-actions">
                              <button type="button" class="btn btn--ghost btn--sm" [disabled]="saving()" (click)="rejectLink(link)">
                                {{ t('bankLog.links.reject') }}
                              </button>
                              <button type="button" class="btn btn--sm" [class.btn--primary]="first" [class.btn--outline]="!first" [disabled]="saving()" (click)="confirmLink(link)">
                                {{ t('bankLog.links.confirm') }}
                              </button>
                            </div>
                          </li>
                        }
                      </ol>
                    }
                  </section>

                  <!-- Finder -->
                  <section class="entry__section" aria-labelledby="entry-finder-heading">
                    <div>
                      <h3 id="entry-finder-heading" class="section-title section-title--sm">{{ t('bankLog.entry.findTitle') }}</h3>
                      <p class="hint">{{ finderHint() }}</p>
                    </div>
                    <div class="entry__tools">
                      <label class="entry__search">
                        <span class="sr-only">{{ t('common.search') }}</span>
                        <input
                          class="input input--sm"
                          type="search"
                          name="candidate_search"
                          [placeholder]="withdrawal() ? t('bankLog.entry.searchPayouts') : t('bankLog.entry.searchSplits')"
                          [value]="search()"
                          (input)="onSearch($event)"
                        />
                      </label>
                      <app-tabs variant="segmented" [options]="windowOptions()" [active]="String(days())" [ariaLabel]="t('bankLog.entry.window')" (activeChange)="setDays($event)" />
                      @if (!withdrawal()) {
                        <app-tabs variant="segmented" [options]="valueOptions()" [active]="valueKind()" [ariaLabel]="t('bankLog.entry.compareBy')" (activeChange)="setValueKind($event)" />
                      }
                      <app-checkbox inputId="entry-show-linked" [label]="t('bankLog.entry.showLinked')" [checked]="includeLinked()" (checkedChange)="setIncludeLinked($event)" />
                    </div>

                    @if (candidatesLoading() && candidates().length === 0) {
                      <app-loading variant="lines" [rows]="4" />
                    } @else if (candidates().length === 0) {
                      <app-empty-state compact icon="search" [message]="t('bankLog.entry.noCandidates')" [hint]="t('bankLog.entry.noCandidatesHint')" />
                    } @else {
                      <div class="entry__finder scrollbar-thin" [attr.aria-busy]="candidatesLoading()">
                        <table class="table">
                          <thead>
                            <tr>
                              <th scope="col" class="entry__pick"><span class="sr-only">{{ t('bankLog.entry.pick') }}</span></th>
                              <th scope="col">{{ t('bankLog.entry.likelihood') }}</th>
                              <th scope="col">{{ withdrawal() ? t('bankLog.entry.payout') : t('bankLog.entry.split') }}</th>
                              <th scope="col" class="entry__hide-sm">{{ t('bankLog.entry.when') }}</th>
                              <th scope="col" class="num">{{ t('common.amount') }}</th>
                              <th scope="col" class="num entry__hide-sm">{{ t('bankLog.entry.difference') }}</th>
                            </tr>
                          </thead>
                          <tbody>
                            @for (candidate of candidates(); track candidate.key) {
                              <tr
                                [class.entry__row--selected]="isSelected(candidate)"
                                [class.entry__row--linked]="candidate.linked"
                                (click)="toggle(candidate)"
                              >
                                <td class="entry__pick">
                                  <input
                                    type="checkbox"
                                    class="checkbox"
                                    [checked]="isSelected(candidate)"
                                    [disabled]="candidate.linked || saving()"
                                    [attr.aria-label]="candidateTitle(candidate)"
                                    (click)="$event.stopPropagation()"
                                    (change)="toggle(candidate)"
                                  />
                                </td>
                                <td><app-bank-log-score [score]="candidate.score" [compact]="true" /></td>
                                <td>
                                  <div class="entry__match-title">{{ candidateTitle(candidate) }}</div>
                                  <div class="entry__match-sub">{{ candidateSubtitle(candidate) }}</div>
                                  @if (candidate.linked) {
                                    <div class="entry__match-sub">{{ t('bankLog.manual.alreadyLinked') }}</div>
                                  }
                                </td>
                                <td class="entry__nowrap entry__when">
                                  <div>{{ apartText(candidate.minutes_apart) }}</div>
                                  <div class="entry__match-sub">{{ utc(candidate.at) }}</div>
                                </td>
                                <td class="num entry__nowrap">{{ amount(candidate.amount) }}</td>
                                <td class="num entry__nowrap entry__hide-sm" [class.entry__exact]="isExact(candidate)">
                                  {{ isExact(candidate) ? t('bankLog.entry.exact') : signed(numeric(candidate.amount) - expectedAmount()) }}
                                </td>
                              </tr>
                            }
                          </tbody>
                        </table>
                      </div>
                      <div class="entry__selection" aria-live="polite">
                        @if (selectedCandidates().length === 0) {
                          <span class="hint">{{ t('bankLog.entry.pickHint') }}</span>
                        } @else {
                          <span class="num">
                            {{ t('bankLog.manual.selectedTotal', { selected: amount(selectedTotal()), expected: amount(expectedAmount()) }) }}
                          </span>
                          @if (Math.abs(selectedDifference()) < 1) {
                            <span class="entry__exact">{{ t('bankLog.entry.addsUp') }}</span>
                          } @else {
                            <span class="entry__warning">
                              <app-icon name="alert" size="0.875rem" />
                              {{ t('bankLog.manual.mismatch', { difference: signed(-selectedDifference()) }) }}
                            </span>
                          }
                        }
                      </div>
                    }
                  </section>
                }

                @case ('explain') {
                  <section class="entry__section" aria-labelledby="entry-explain-heading">
                    <div>
                      <h3 id="entry-explain-heading" class="section-title section-title--sm">{{ t('bankLog.explain.title') }}</h3>
                      <p class="hint">{{ t('bankLog.entry.explainHint') }}</p>
                    </div>
                    <div class="entry__presets" role="group" [attr.aria-label]="t('bankLog.entry.presets')">
                      @for (preset of presets; track preset) {
                        <button type="button" class="btn btn--outline btn--sm" (click)="usePreset(preset)">{{ t(preset) }}</button>
                      }
                    </div>
                    <label class="entry__field">
                      <span class="label">{{ t('bankLog.explain.note') }}</span>
                      <textarea
                        class="textarea"
                        name="note"
                        rows="4"
                        maxlength="2000"
                        [value]="explainNote()"
                        (input)="onExplainInput($event)"
                        aria-describedby="entry-explain-required"
                      ></textarea>
                    </label>
                    <p id="entry-explain-required" class="hint">{{ t('bankLog.explain.required') }}</p>
                  </section>
                }

                @case ('transaction') {
                  <section class="entry__section" aria-labelledby="entry-tx-heading">
                    <div>
                      <h3 id="entry-tx-heading" class="section-title section-title--sm">{{ t('bankLog.tx.title') }}</h3>
                      <p class="hint">{{ t('bankLog.entry.txHint') }}</p>
                    </div>
                    <p class="entry__preview">{{ txPreview() }}</p>
                    <div class="entry__form">
                      <div class="entry__field">
                        <span class="label" id="entry-tx-member-label">{{ withdrawal() ? t('bankLog.entry.receivedBy') : t('bankLog.entry.depositor') }}</span>
                        <app-searchable-select
                          [options]="memberOptions()"
                          [value]="memberValue()"
                          [remote]="true"
                          [emptyLabel]="t('bankLog.entry.pickMember')"
                          [searchPlaceholder]="t('bankLog.entry.searchMembers')"
                          [noMatchesLabel]="t('picker.noMatches')"
                          [emptyOptionsLabel]="t('bankLog.entry.typeToSearch')"
                          [ariaLabel]="withdrawal() ? t('bankLog.entry.receivedBy') : t('bankLog.entry.depositor')"
                          (valueChange)="onMemberSelect($event)"
                          (searchChange)="onMemberSearch($event)"
                        />
                        <span class="hint">{{ withdrawal() ? t('bankLog.entry.receivedByHint') : t('bankLog.entry.depositorHint') }}</span>
                      </div>
                      <label class="entry__field">
                        <span class="label">{{ t('common.amount') }}</span>
                        <input
                          class="input num"
                          name="tx_amount"
                          type="number"
                          inputmode="numeric"
                          min="1"
                          step="1"
                          [value]="txAmount()"
                          (input)="onTxAmountInput($event)"
                          aria-describedby="entry-tx-amount-hint"
                        />
                        <span id="entry-tx-amount-hint" class="hint">{{ t('bankLog.entry.amountHint') }}</span>
                      </label>
                    </div>
                    @if (txAmountDiffers()) {
                      <p class="entry__warning" role="status">
                        <app-icon name="alert" size="0.875rem" />
                        {{ t('bankLog.entry.amountDiffers', { difference: signed(numeric(txAmount()) - expectedAmount()) }) }}
                      </p>
                    }
                  </section>
                }
              }
            } @else {
              <p class="hint">{{ t('bankLog.links.none') }}</p>
            }
          }

          @if (row.created_transaction_id !== null) {
            <p class="hint" role="status">{{ t('bankLog.tx.created', { id: row.created_transaction_id }) }}</p>
          }
        </div>

        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="closed.emit()">{{ t('common.close') }}</button>
          @if (canResolve()) {
            @switch (tab()) {
              @case ('match') {
                <button type="button" class="btn btn--primary" [disabled]="saving() || selectedCandidates().length === 0" (click)="linkSelected()">
                  {{ selectedCandidates().length > 1 ? t('bankLog.entry.linkMany', { count: selectedCandidates().length }) : t('bankLog.entry.linkOne') }}
                </button>
              }
              @case ('explain') {
                <button type="button" class="btn btn--primary" [disabled]="saving() || !explainNote().trim()" (click)="saveExplanation()">
                  {{ t('bankLog.explain.mark') }}
                </button>
              }
              @case ('transaction') {
                <button type="button" class="btn btn--primary" [disabled]="saving() || !txMember() || !txAmountValid()" (click)="createTransaction()">
                  {{ t('bankLog.entry.createTx') }}
                </button>
              }
            }
          }
        </div>
      </app-dialog>
    }
  `,
})
export class BankLogEntryDialog {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  /** The row as the table had it; the dialog reloads it on open. */
  readonly initial = input.required<BankLogEntry>();
  readonly canManage = input(false);
  readonly canCreateTransaction = input(false);

  readonly closed = output<void>();
  /** Something was written: the page reloads its summary and table. */
  readonly changed = output<void>();

  protected readonly Math = Math;
  protected readonly String = String;
  protected readonly numeric = numeric;
  protected readonly presets = EXPLAIN_PRESETS;

  protected readonly entry = signal<BankLogEntry | null>(null);
  protected readonly saving = signal(false);
  protected readonly tab = signal<EntryTab>('match');

  protected readonly candidates = signal<BankLogCandidate[]>([]);
  protected readonly candidatesLoading = signal(false);
  protected readonly selectedKeys = signal<readonly string[]>([]);
  protected readonly search = signal('');
  protected readonly days = signal(7);
  protected readonly valueKind = signal<ValueKind>('bags');
  protected readonly includeLinked = signal(false);
  private candidateRequest = 0;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  protected readonly explainNote = signal('');
  protected readonly txMember = signal<SearchableSelectOption | null>(null);
  protected readonly txAmount = signal('');
  protected readonly memberSearchResults = signal<SearchableSelectOption[]>([]);
  private memberSearchRequest = 0;

  protected readonly t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  protected readonly withdrawal = computed(() => numeric(this.entry()?.amount) < 0);
  protected readonly expectedAmount = computed(() => Math.abs(numeric(this.entry()?.amount)));

  protected readonly title = computed(() => {
    const row = this.entry();
    if (!row) {
      return '';
    }
    return this.t('bankLog.entry.title', { category: this.categoryLabel(row.category), id: row.id });
  });
  protected readonly subtitle = computed(() => {
    const row = this.entry();
    return row ? `${row.player_name} · ${this.utc(row.occurred_at)}` : '';
  });

  protected readonly confirmedLinks = computed(() => this.entry()?.links.filter((link) => link.confirmed) ?? []);
  protected readonly suggestedLinks = computed(() =>
    [...(this.entry()?.links.filter((link) => !link.confirmed) ?? [])].sort(
      (a, b) => (b.score ?? 0) - (a.score ?? 0) || a.id - b.id,
    ),
  );

  /** Whether the footer offers the active tab's action. */
  protected readonly canResolve = computed(() => {
    const row = this.entry();
    return Boolean(this.canManage() && row && row.status !== 'explained' && this.confirmedLinks().length === 0);
  });

  protected readonly tabs = computed<TabOption[]>(() => [
    { id: 'match', label: this.t('bankLog.entry.tabMatch'), icon: 'link', count: this.suggestedLinks().length || null },
    { id: 'explain', label: this.t('bankLog.entry.tabExplain'), icon: 'edit' },
    ...(this.canCreateTransaction() && this.entry()?.created_transaction_id === null
      ? [{ id: 'transaction', label: this.t('bankLog.entry.tabTransaction'), icon: 'plus' } as TabOption]
      : []),
  ]);

  protected readonly windowOptions = computed<TabOption[]>(() =>
    WINDOW_DAYS.map((days) => ({ id: String(days), label: this.t('bankLog.entry.days', { count: days }) })),
  );
  protected readonly valueOptions = computed<TabOption[]>(() => [
    { id: 'bags', label: this.t('bankLog.category.bags') },
    { id: 'loot_sale', label: this.t('bankLog.category.loot_sale') },
  ]);

  protected readonly categoryOptions = computed<SelectOption[]>(() =>
    CATEGORIES.map((category) => ({ value: category, label: this.categoryLabel(category) })),
  );

  protected readonly finderHint = computed(() =>
    this.withdrawal()
      ? this.t('bankLog.entry.findPayoutsHint', { days: this.days() })
      : this.t('bankLog.entry.findSplitsHint', { days: this.days() }),
  );

  protected readonly selectedCandidates = computed(() => {
    const keys = this.selectedKeys();
    return this.candidates().filter((candidate) => keys.includes(candidate.key));
  });
  protected readonly selectedTotal = computed(() =>
    this.selectedCandidates().reduce((sum, candidate) => sum + numeric(candidate.amount), 0),
  );
  protected readonly selectedDifference = computed(() => this.expectedAmount() - this.selectedTotal());

  protected readonly memberOptions = computed<SearchableSelectOption[]>(() => {
    const chosen = this.txMember();
    const results = this.memberSearchResults();
    return chosen && !results.some((option) => option.id === chosen.id) ? [chosen, ...results] : results;
  });
  protected readonly memberValue = computed(() => this.txMember()?.id ?? '');
  protected readonly txAmountValid = computed(() => {
    const value = Number(this.txAmount());
    return Number.isFinite(value) && value > 0;
  });
  protected readonly txAmountDiffers = computed(
    () => this.txAmountValid() && Math.abs(Number(this.txAmount()) - this.expectedAmount()) >= 1,
  );
  protected readonly txPreview = computed(() => {
    const row = this.entry();
    if (!row) {
      return '';
    }
    const params = {
      amount: this.amount(this.txAmountValid() ? this.txAmount() : this.expectedAmount()),
      member: this.txMember()?.label ?? this.t('bankLog.entry.theMember'),
      date: this.utc(row.occurred_at),
    };
    return this.withdrawal()
      ? this.t('bankLog.entry.txPreviewWithdrawal', params)
      : this.t('bankLog.entry.txPreviewDeposit', params);
  });

  constructor() {
    // A different row resets the dialog; the same row only refreshes.
    effect(() => {
      const row = this.initial();
      untracked(() => this.open(row));
    });
    inject(DestroyRef).onDestroy(() => {
      if (this.searchTimer) {
        clearTimeout(this.searchTimer);
      }
    });
  }

  private open(row: BankLogEntry): void {
    this.entry.set(row);
    this.tab.set('match');
    this.selectedKeys.set([]);
    this.candidates.set([]);
    this.search.set('');
    this.includeLinked.set(false);
    this.valueKind.set(row.category === 'loot_sale' ? 'loot_sale' : 'bags');
    this.days.set(numeric(row.amount) >= 0 && row.category === 'loot_sale' ? 30 : 7);
    this.explainNote.set(row.note ?? '');
    this.txMember.set(null);
    this.memberSearchResults.set([]);
    this.txAmount.set(String(Math.abs(numeric(row.amount))));
    void this.reload();
  }

  // ------------------------------------------------------------------ loading

  private async reload(): Promise<void> {
    const id = this.entry()?.id;
    if (id === undefined) {
      return;
    }
    try {
      const row = await firstValueFrom(this.api.get<BankLogEntry>(`api/bank/log/entries/${id}`));
      if (this.entry()?.id === id) {
        this.entry.set(row);
      }
    } catch (error) {
      this.toasts.error(this.errorMessage(error));
      return;
    }
    if (this.canManage()) {
      await this.loadCandidates();
    }
  }

  private async loadCandidates(): Promise<void> {
    const row = this.entry();
    if (!row || !this.canManage()) {
      return;
    }
    const request = ++this.candidateRequest;
    this.candidatesLoading.set(true);
    const params: Record<string, string | number | boolean> = { days: this.days() };
    if (this.search().trim()) {
      params['search'] = this.search().trim();
    }
    if (!this.withdrawal()) {
      params['value'] = this.valueKind();
    }
    if (this.includeLinked()) {
      params['include_linked'] = true;
    }
    try {
      const list = await firstValueFrom(
        this.api.get<BankLogCandidate[]>(`api/bank/log/entries/${row.id}/candidates`, params),
      );
      if (request === this.candidateRequest) {
        this.candidates.set(list);
        // Keep only the picks that are still listed.
        this.selectedKeys.update((keys) => keys.filter((key) => list.some((candidate) => candidate.key === key)));
      }
    } catch (error) {
      if (request === this.candidateRequest) {
        this.toasts.error(this.errorMessage(error));
      }
    } finally {
      if (request === this.candidateRequest) {
        this.candidatesLoading.set(false);
      }
    }
  }

  // ------------------------------------------------------------------ finder controls

  protected setTab(id: string): void {
    this.tab.set(id as EntryTab);
    if (id === 'transaction' && !this.withdrawal() && !this.txMember()) {
      // A depositor often uses the same name in the Manager.
      void this.onMemberSearch(this.entry()?.player_name ?? '', true);
    }
  }

  protected onSearch(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
    }
    this.searchTimer = setTimeout(() => void this.loadCandidates(), 250);
  }

  protected setDays(id: string): void {
    this.days.set(Number(id));
    void this.loadCandidates();
  }

  protected setValueKind(id: string): void {
    this.valueKind.set(id as ValueKind);
    void this.loadCandidates();
  }

  protected setIncludeLinked(value: boolean): void {
    this.includeLinked.set(value);
    void this.loadCandidates();
  }

  protected toggle(candidate: BankLogCandidate): void {
    if (candidate.linked || this.saving()) {
      return;
    }
    this.selectedKeys.update((keys) =>
      keys.includes(candidate.key) ? keys.filter((key) => key !== candidate.key) : [...keys, candidate.key],
    );
  }

  protected isSelected(candidate: BankLogCandidate): boolean {
    return this.selectedKeys().includes(candidate.key);
  }

  protected isExact(candidate: BankLogCandidate): boolean {
    return Math.abs(numeric(candidate.amount) - this.expectedAmount()) < Math.max(1, candidate.transaction_ids.length);
  }

  // ------------------------------------------------------------------ writes

  private async write<T>(action: () => Promise<T>, message: (result: T) => string): Promise<boolean> {
    this.saving.set(true);
    try {
      const result = await action();
      this.toasts.success(message(result));
      this.changed.emit();
      await this.reload();
      return true;
    } catch (error) {
      this.toasts.error(this.errorMessage(error));
      return false;
    } finally {
      this.saving.set(false);
    }
  }

  protected setCategory(category: string): void {
    const row = this.entry();
    if (!row || category === row.category) {
      return;
    }
    void this.patch({ category }, 'bankLog.categorySaved');
  }

  protected saveExplanation(): void {
    const note = this.explainNote().trim();
    if (!note) {
      this.toasts.error(this.t('bankLog.explain.required'));
      return;
    }
    void this.patch({ note, explained: true }, 'bankLog.explain.saved');
  }

  protected undoExplanation(): void {
    void this.patch({ explained: false }, 'bankLog.explain.undone');
  }

  private async patch(body: Record<string, unknown>, message: TranslationKey): Promise<void> {
    const row = this.entry();
    if (!row) {
      return;
    }
    await this.write(
      () => firstValueFrom(this.api.patch<BankLogEntry>(`api/bank/log/entries/${row.id}`, body)),
      () => this.t(message),
    );
  }

  protected async confirmLink(link: BankLogLink): Promise<void> {
    await this.write(
      () => firstValueFrom(this.api.post<BankLogLink>(`api/bank/log/links/${link.id}/confirm`, {})),
      () => this.t('bankLog.links.confirmedToast'),
    );
  }

  protected async rejectLink(link: BankLogLink): Promise<void> {
    await this.write(
      () => firstValueFrom(this.api.delete(`api/bank/log/links/${link.id}`)),
      () => this.t('bankLog.links.rejectedToast'),
    );
  }

  protected async removeLink(link: BankLogLink): Promise<void> {
    await this.write(
      () => firstValueFrom(this.api.delete(`api/bank/log/links/${link.id}`)),
      () => this.t('bankLog.links.removedToast'),
    );
  }

  protected async searchAgain(): Promise<void> {
    const row = this.entry();
    if (!row) {
      return;
    }
    await this.write(
      () => firstValueFrom(this.api.post<BankLogEntry>(`api/bank/log/entries/${row.id}/suggestions/refresh`, {})),
      (entry) => {
        const count = entry.links.filter((link) => !link.confirmed).length;
        return count > 0
          ? this.t('bankLog.entry.searchAgainFound', { count })
          : this.t('bankLog.entry.searchAgainNone');
      },
    );
  }

  protected async linkSelected(): Promise<void> {
    const row = this.entry();
    const selected = this.selectedCandidates();
    if (!row || selected.length === 0) {
      this.toasts.error(this.t('bankLog.manual.pickOne'));
      return;
    }
    const body = {
      entry_ids: [row.id],
      transaction_ids: [...new Set(selected.flatMap((candidate) => candidate.transaction_ids))],
      split_ids: selected.flatMap((candidate) => (candidate.split_id === null ? [] : [candidate.split_id])),
      kind: this.linkKind(row),
    };
    const ok = await this.write(
      () => firstValueFrom(this.api.post<BankLogLink>('api/bank/log/links', body)),
      () => this.t('bankLog.manual.linkedToast'),
    );
    if (ok) {
      this.selectedKeys.set([]);
    }
  }

  protected async createTransaction(): Promise<void> {
    const row = this.entry();
    const member = this.txMember();
    if (!row) {
      return;
    }
    if (!member) {
      this.toasts.error(this.t('bankLog.tx.memberRequired'));
      return;
    }
    if (!this.txAmountValid()) {
      this.toasts.error(this.t('siphoned.amountInvalid'));
      return;
    }
    await this.write(
      () =>
        firstValueFrom(
          this.api.post<BankLogEntry>(`api/bank/log/entries/${row.id}/transaction`, {
            to_user_id: Number(member.id),
            amount: Number(this.txAmount()),
          }),
        ),
      (entry) => this.t('bankLog.tx.created', { id: entry.created_transaction_id ?? '' }),
    );
  }

  // ------------------------------------------------------------------ explain and member inputs

  protected usePreset(key: TranslationKey): void {
    const text = this.t(key);
    const current = this.explainNote().trim();
    this.explainNote.set(current ? `${current} ${text}` : text);
  }

  protected onExplainInput(event: Event): void {
    this.explainNote.set((event.target as HTMLTextAreaElement).value);
  }

  protected onTxAmountInput(event: Event): void {
    this.txAmount.set((event.target as HTMLInputElement).value);
  }

  protected onMemberSelect(id: string): void {
    this.txMember.set(this.memberOptions().find((option) => option.id === id) ?? null);
  }

  /** Searches app members (transactions take local user ids). `preselect` picks an exact name match. */
  protected async onMemberSearch(query: string, preselect = false): Promise<void> {
    const request = ++this.memberSearchRequest;
    const term = query.trim();
    if (!term) {
      this.memberSearchResults.set([]);
      return;
    }
    try {
      const page = await firstValueFrom(
        this.api.get<PaginatedData<UserProfile>>('api/users', { username: term, limit: 25 }),
      );
      if (request !== this.memberSearchRequest) {
        return;
      }
      const options = page.items.map((member) => ({ id: String(member.id), label: member.username }));
      this.memberSearchResults.set(options);
      if (preselect && !this.txMember()) {
        const exact = options.find((option) => option.label.toLowerCase() === term.toLowerCase());
        if (exact) {
          this.txMember.set(exact);
        }
      }
    } catch {
      if (request === this.memberSearchRequest && !preselect) {
        this.toasts.error(this.t('common.error'));
      }
    }
  }

  // ------------------------------------------------------------------ display

  protected linkTargetsTotal(link: BankLogLink): number {
    return link.targets.reduce((sum, target) => sum + numeric(target.amount), 0);
  }

  /** "Alice" for a payout, "Split #12 · ZvZ Lymhurst" for a split, plus the link kind. */
  protected linkTitle(link: BankLogLink): string {
    const members = [...new Set(link.targets.map((target) => target.member_username).filter(Boolean))];
    if (members.length > 0) {
      return this.t('bankLog.entry.payoutTo', { member: members.join(', ') });
    }
    const labels = link.targets.map((target) => target.label);
    return `${this.t(LINK_KIND_KEYS[link.kind])} · ${labels.join(', ')}`;
  }

  /** Record ids, source splits and the record time. */
  protected linkSubtitle(link: BankLogLink): string {
    const parts: string[] = [];
    if (link.targets.some((target) => target.member_username)) {
      parts.push(link.targets.map((target) => target.label).join(', '));
      const splits = [...new Set(link.targets.map((target) => target.source_split_id).filter((id) => id !== null))];
      if (splits.length > 0) {
        parts.push(splits.map((id) => `Split #${id}`).join(', '));
      }
    }
    const at = this.nearestTargetTime(link.targets);
    if (at) {
      parts.push(this.utc(at));
    }
    return parts.join(' · ');
  }

  /** Short reasons behind a suggestion: amount fit, time gap, and grouped rows. */
  protected linkFacts(link: BankLogLink): { text: string; tone: 'good' | 'off' | 'plain' }[] {
    const row = this.entry();
    if (!row) {
      return [];
    }
    const facts: { text: string; tone: 'good' | 'off' | 'plain' }[] = [];
    const difference = this.linkTargetsTotal(link) - Math.abs(numeric(link.entries_total));
    if (Math.abs(difference) < Math.max(1, link.targets.length)) {
      facts.push({ text: this.t('bankLog.entry.exactAmount'), tone: 'good' });
    } else if (link.kind === 'bags' && difference > 0) {
      facts.push({ text: this.t('bankLog.entry.partOf', { amount: this.amount(this.linkTargetsTotal(link)) }), tone: 'off' });
    } else {
      facts.push({ text: this.t('bankLog.entry.offBy', { difference: this.signed(difference) }), tone: 'off' });
    }
    const minutes = minutesBetween(row.occurred_at, this.nearestTargetTime(link.targets));
    if (minutes !== null) {
      facts.push({ text: this.apartText(minutes), tone: Math.abs(minutes) <= 60 ? 'good' : 'plain' });
    }
    if (link.entry_ids.length > 1) {
      facts.push({ text: this.t('bankLog.entry.withRows', { count: link.entry_ids.length - 1 }), tone: 'plain' });
    }
    if (link.targets.length > 1) {
      facts.push({ text: this.t('bankLog.entry.records', { count: link.targets.length }), tone: 'plain' });
    }
    return facts;
  }

  protected candidateTitle(candidate: BankLogCandidate): string {
    if (candidate.kind === 'payout') {
      return candidate.member_username ?? candidate.label;
    }
    return candidate.detail ? `${candidate.label} · ${candidate.detail}` : candidate.label;
  }

  protected candidateSubtitle(candidate: BankLogCandidate): string {
    if (candidate.kind === 'payout') {
      const ids = candidate.transaction_ids.map((id) => `#${id}`).join(', ');
      return [
        candidate.transaction_ids.length > 1 ? this.t('bankLog.entry.paidTogether', { ids }) : ids,
        candidate.detail ?? '',
      ]
        .filter(Boolean)
        .join(' · ');
    }
    const parts = [];
    if (candidate.member_username) {
      parts.push(this.t('bankLog.entry.createdBy', { member: candidate.member_username }));
    }
    if (this.valueKind() === 'bags' && candidate.split_expected_sale) {
      parts.push(this.t('bankLog.entry.lootValue', { amount: this.amount(candidate.split_expected_sale) }));
    } else if (candidate.split_bags_value && numeric(candidate.split_bags_value) > 0) {
      parts.push(this.t('bankLog.entry.bagsValue', { amount: this.amount(candidate.split_bags_value) }));
    }
    return parts.join(' · ');
  }

  protected apartText(minutes: number | null): string {
    if (minutes === null) {
      return '—';
    }
    if (Math.abs(minutes) < 1) {
      return this.t('bankLog.entry.sameMinute');
    }
    const span = formatSpan(this.translate.locale(), minutes);
    return minutes > 0 ? this.t('bankLog.entry.after', { span }) : this.t('bankLog.entry.before', { span });
  }

  private nearestTargetTime(targets: BankLogLinkTarget[]): string | null {
    const row = this.entry();
    if (!row) {
      return null;
    }
    let best: string | null = null;
    let bestGap = Number.POSITIVE_INFINITY;
    for (const target of targets) {
      const minutes = minutesBetween(row.occurred_at, target.at);
      if (minutes !== null && Math.abs(minutes) < bestGap) {
        bestGap = Math.abs(minutes);
        best = target.at;
      }
    }
    return best;
  }

  private linkKind(row: BankLogEntry): BankLogLinkKind {
    if (numeric(row.amount) < 0) {
      return 'payout';
    }
    if (this.valueKind() === 'loot_sale') {
      return 'loot_sale';
    }
    return row.category === 'bags' || row.category === 'loot_sale' ? 'bags' : 'manual';
  }

  protected categoryLabel(category: BankLogCategory): string {
    return this.t(CATEGORY_KEYS[category]);
  }

  protected statusLabel(status: BankLogStatus): string {
    return this.t(STATUS_KEYS[status]);
  }

  protected statusTone(status: BankLogStatus): ChipTone {
    return STATUS_TONES[status];
  }

  protected amount(value: string | number | null | undefined): string {
    return formatSilver(this.translate.locale(), value);
  }

  protected signed(value: string | number | null | undefined): string {
    return formatSignedSilver(this.translate.locale(), value);
  }

  protected utc(iso: string | null | undefined): string {
    return formatUtc(this.translate.locale(), iso);
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : this.t('common.error');
  }
}
