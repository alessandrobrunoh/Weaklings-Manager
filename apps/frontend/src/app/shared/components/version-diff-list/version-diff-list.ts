import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type {
  VersionDiffEntry,
  VersionDiffToken,
} from '../../../features/comps/version-diff';

/** A run of entries that share a section heading (`Main`, `Swap`); `name` is empty for flat lists. */
interface DiffGroup {
  readonly name: string;
  readonly entries: readonly VersionDiffEntry[];
}

/**
 * Renders what changed between two versions, older to newer.
 *
 * Entries that carry a `group` (a build's `Main` and `Swap`) are listed under a heading per group,
 * in the order given. Each entry names its subject (a slot, a build), says in words whether it was
 * added, removed or changed, and lists only the tokens that differ: the item, a spell by its key, a
 * version, a player count. Every token reads `before → after`, and the older and newer sides carry
 * the caller's labels (for example `v1` and `v2`) so the direction is never implicit.
 *
 * Colour never carries the meaning: the kind of change is a text label with a symbol, and on a
 * narrow container the two sides stack with their labels written out. Entries without tokens
 * (plain `before` / `after` text) render as a single token.
 *
 * @example
 * ```html
 * <app-version-diff-list
 *   [entries]="diff()"
 *   [beforeLabel]="'v1'"
 *   [afterLabel]="'v2'"
 *   [emptyLabel]="t('comps.noDifferences')"
 * />
 * ```
 */
@Component({
  selector: 'app-version-diff-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: block;
      container-type: inline-size;
      min-width: 0;
      color: var(--color-text);
    }
    .empty {
      margin: 0;
      font-size: 0.875rem;
      color: var(--color-text-secondary);
    }
    .legend {
      display: none;
      grid-template-columns: 5.5rem minmax(0, 1fr) 1.5rem minmax(0, 1fr);
      column-gap: 0.75rem;
      padding: 0 0.75rem 0.375rem;
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--color-text-secondary);
    }
    @container (min-width: 36rem) {
      .legend {
        display: grid;
      }
    }
    .group {
      margin: 0 0 1rem;
    }
    .group__name {
      margin: 0 0 0.375rem;
      font-size: 0.8125rem;
      font-weight: 600;
      color: var(--color-text-heading);
    }
    .entries {
      margin: 0;
      padding: 0;
      list-style: none;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      background: var(--color-surface);
    }
    .entry {
      padding: 0.5rem 0.75rem;
    }
    .entry + .entry {
      border-top: 1px solid var(--color-border);
    }
    .entry__head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.25rem 0.625rem;
    }
    .entry__subject {
      font-size: 0.875rem;
      font-weight: 600;
      overflow-wrap: anywhere;
    }
    .entry__change {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      padding: 0 0.375rem;
      border: 1px solid var(--color-border-strong);
      border-radius: var(--radius-sm);
      font-size: 0.75rem;
      line-height: 1.125rem;
      color: var(--color-text-secondary);
    }
    .entry__symbol {
      font-family: var(--font-mono);
      font-weight: 700;
    }
    .tokens {
      margin: 0.25rem 0 0;
      padding: 0;
      list-style: none;
    }
    .token {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 0.125rem;
      padding: 0.25rem 0;
      font-size: 0.875rem;
      line-height: 1.25rem;
    }
    .token__label {
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--color-text-secondary);
    }
    .token__label:empty {
      display: none;
    }
    .side {
      position: relative;
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 0 0.375rem;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .side__tag {
      font-size: 0.75rem;
      color: var(--color-text-secondary);
    }
    .side__none {
      color: var(--color-text-secondary);
      font-style: italic;
    }
    .token__arrow {
      display: none;
      color: var(--color-text-secondary);
      text-align: center;
    }
    @container (min-width: 36rem) {
      .token {
        grid-template-columns: 5.5rem minmax(0, 1fr) 1.5rem minmax(0, 1fr);
        column-gap: 0.75rem;
        align-items: baseline;
      }
      .token__arrow {
        display: block;
      }
      .side__tag {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip-path: inset(50%);
        white-space: nowrap;
      }
    }
  `,
  template: `
    @if (entries().length === 0) {
      <p class="empty">{{ emptyLabel() }}</p>
    } @else {
      <div class="legend" aria-hidden="true">
        <span>{{ subjectLabel() }}</span>
        <span>{{ beforeLabel() }}</span>
        <span></span>
        <span>{{ afterLabel() }}</span>
      </div>
      @for (group of groups(); track group.name) {
        <section class="group">
          @if (group.name) {
            <h4 class="group__name">{{ group.name }}</h4>
          }
          <ul class="entries">
            @for (entry of group.entries; track entry.subject) {
              <li class="entry">
                <div class="entry__head">
                  <span class="entry__subject">{{ entry.subject }}</span>
                  <span class="entry__change">
                    <span class="entry__symbol" aria-hidden="true">{{ changeSymbol(entry.change) }}</span>
                    <span class="sr-only">{{ changeLabel() }}: </span>
                    {{ changeText(entry.change) }}
                  </span>
                </div>
                <ul class="tokens">
                  @for (token of tokensOf(entry); track $index) {
                    <li class="token">
                      <span class="token__label">{{ token.label }}</span>
                      <span class="side">
                        <span class="side__tag">{{ beforeLabel() }}:</span>
                        @if (token.before !== null) {
                          <span>{{ token.before }}</span>
                        } @else {
                          <span class="side__none">{{ noneLabel() }}</span>
                        }
                      </span>
                      <span class="token__arrow" aria-hidden="true">→</span>
                      <span class="side">
                        <span class="side__tag">{{ afterLabel() }}:</span>
                        @if (token.after !== null) {
                          <span>{{ token.after }}</span>
                        } @else {
                          <span class="side__none">{{ noneLabel() }}</span>
                        }
                      </span>
                    </li>
                  }
                </ul>
              </li>
            }
          </ul>
        </section>
      }
    }
  `,
})
export class VersionDiffList {
  readonly entries = input.required<readonly VersionDiffEntry[]>();
  /** Labels come from the parent so the component stays translation-agnostic. */
  readonly emptyLabel = input('No differences.');
  /** Heading of the first column (what changed). Shown on wide containers. */
  readonly subjectLabel = input('What');
  /** The older side, for example `v1`. Always pass it so the direction is explicit. */
  readonly beforeLabel = input('Before');
  /** The newer side, for example `v2`. */
  readonly afterLabel = input('After');
  /** Spoken before an entry's change word ("Change: Added"). */
  readonly changeLabel = input('Change');
  readonly addedLabel = input('Added');
  readonly removedLabel = input('Removed');
  readonly changedLabel = input('Changed');
  /** Shown for a side that has nothing (a slot that was empty, a build that was not fielded). */
  readonly noneLabel = input('None');

  protected readonly groups = computed<DiffGroup[]>(() => {
    const groups: { name: string; entries: VersionDiffEntry[] }[] = [];
    for (const entry of this.entries()) {
      const name = entry.group ?? '';
      const last = groups[groups.length - 1];
      if (last && last.name === name) {
        last.entries.push(entry);
      } else {
        groups.push({ name, entries: [entry] });
      }
    }
    return groups;
  });

  /** An entry's tokens, or one token made from its plain before / after text. */
  protected tokensOf(entry: VersionDiffEntry): readonly VersionDiffToken[] {
    return (
      entry.tokens ?? [{ kind: 'item', label: '', before: entry.before, after: entry.after }]
    );
  }

  protected changeText(change: VersionDiffEntry['change']): string {
    switch (change) {
      case 'added':
        return this.addedLabel();
      case 'removed':
        return this.removedLabel();
      case 'changed':
        return this.changedLabel();
    }
  }

  protected changeSymbol(change: VersionDiffEntry['change']): string {
    switch (change) {
      case 'added':
        return '+';
      case 'removed':
        return '−';
      case 'changed':
        return '~';
    }
  }
}
