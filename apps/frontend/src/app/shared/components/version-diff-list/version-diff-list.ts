import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import type { VersionDiffEntry } from '../../../features/comps/version-diff';

/**
 * Renders what changed between two versions, as a plain before/after table.
 *
 * The `change` column spells the kind of change out in words rather than encoding it in colour, so
 * the table reads the same to a screen reader and in a high-contrast theme. Wide content scrolls in
 * its own container instead of pushing the page sideways.
 */
@Component({
  selector: 'app-version-diff-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (entries().length === 0) {
      <p class="text-sm" style="color: var(--color-text-secondary)">{{ emptyLabel() }}</p>
    } @else {
      <div style="overflow-x: auto">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">{{ subjectLabel() }}</th>
              <th scope="col">{{ beforeLabel() }}</th>
              <th scope="col">{{ afterLabel() }}</th>
              <th scope="col">{{ changeLabel() }}</th>
            </tr>
          </thead>
          <tbody>
            @for (entry of entries(); track entry.subject) {
              <tr>
                <th scope="row" class="font-medium">{{ entry.subject }}</th>
                <td>{{ entry.before ?? '—' }}</td>
                <td>{{ entry.after ?? '—' }}</td>
                <td>{{ changeText(entry.change) }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
  `,
})
export class VersionDiffList {
  readonly entries = input.required<readonly VersionDiffEntry[]>();
  /** Labels come from the parent so the component stays translation-agnostic. */
  readonly emptyLabel = input('No differences.');
  readonly subjectLabel = input('What');
  readonly beforeLabel = input('Before');
  readonly afterLabel = input('After');
  readonly changeLabel = input('Change');
  readonly addedLabel = input('Added');
  readonly removedLabel = input('Removed');
  readonly changedLabel = input('Changed');

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
}
