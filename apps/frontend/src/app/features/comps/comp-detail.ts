import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom } from 'rxjs';

import type {
  BuildDetail,
  BuildRole,
  CompBuildEntry,
  CompCategoryView,
  CompDetail,
  CompPerformanceView,
  CompPriceView,
  CompSummary,
  CreateCompRequest,
  OpponentPerformanceView,
  PaginatedData,
  UpdateCompRequest,
} from '../../core/models/api.models';
import { ApiError, ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Dialog } from '../../shared/components/dialog/dialog';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import {
  EntityHeader,
  type EntityMenuItem,
} from '../../shared/components/entity-header/entity-header';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Icon } from '../../shared/components/icon/icon';
import { LoadoutView } from '../../shared/components/loadout-view/loadout-view';
import { OwnershipScopeToggle } from '../../shared/components/ownership-scope-toggle/ownership-scope-toggle';
import {
  BUILD_ROLES,
  RoleTag,
  roleGlyph,
  roleLabelKey,
} from '../../shared/components/role-tag/role-tag';
import { VersionDiffList } from '../../shared/components/version-diff-list/version-diff-list';
import { VersionSwitcher } from '../../shared/components/version-switcher/version-switcher';
import { ViewToggle, type ViewToggleOption } from '../../shared/components/view-toggle/view-toggle';
import { WeaponIcon } from '../../shared/components/weapon-icon/weapon-icon';
import {
  ownershipListParams,
  ownershipOptionLabel,
  type OwnershipScope,
} from '../../shared/data/ownership-scope';
import { CompAddBuildDialog, type CompBuildAddition } from './comp-add-build-dialog';
import { canChangeAuthored } from './comp-access';
import {
  COMP_PARTY_SIZE,
  groupPartySeats,
  partyRoleMix,
  simulateCompParties,
  type CompPartyView,
} from './comp-parties';
import { diffCompVersions, type VersionDiffEntry } from './version-diff';

type DetailTab = 'roster' | 'parties' | 'analytics';

interface AllianceShareStatus {
  shared: boolean;
  share?: {
    published_id: number;
    shared_at: string;
  };
}

/** Longest composition name the lists lay out without truncating awkwardly. */
const MAX_NAME_LENGTH = 80;

/** How long a quantity stepper waits for more clicks before it saves. */
const QUANTITY_SAVE_DELAY_MS = 450;

/**
 * Composition detail page.
 *
 * Leads with a summary header (key numbers, one primary action, an overflow menu) and then three
 * views of the same roster: a compact build list whose rows expand to the full loadout, the
 * parties the roster splits into, and the analysis (role balance, weapons, battle performance,
 * market price). Editing is one mode switched on by the header's Edit action: quantity steppers on
 * the roster, remove buttons, and a single "Add build" dialog.
 *
 * Build loadouts are fetched lazily, the first time a build is expanded or inspected, and cached
 * for the lifetime of the page.
 *
 * @example
 * ```ts
 * routes.push({ path: 'comps/:compId', loadComponent: () => import('./comp-detail').then(m => m.CompDetailPage) });
 * ```
 */
@Component({
  selector: 'app-comp-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    CompAddBuildDialog,
    Dialog,
    EmptyState,
    EntityHeader,
    ErrorState,
    Icon,
    LoadoutView,
    OwnershipScopeToggle,
    RoleTag,
    VersionDiffList,
    VersionSwitcher,
    ViewToggle,
    WeaponIcon,
  ],
  styles: `
    :host {
      display: block;
      color: var(--color-text);
    }
    .cd-stack {
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }
    .cd-muted {
      color: var(--color-text-secondary);
    }
    .cd-mono {
      font-family: var(--font-mono);
    }
    .cd-tag {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      min-height: 1.375rem;
      padding: 0 0.5rem;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      background: var(--color-surface-2);
      color: var(--color-text-secondary);
      font-size: 0.75rem;
      font-weight: 500;
      white-space: nowrap;
    }
    .cd-tag--state {
      border-color: color-mix(in oklab, var(--color-warning) 40%, transparent);
      background: var(--color-warning-container);
      color: var(--color-warning);
    }
    .cd-badges {
      display: inline-flex;
      flex-wrap: wrap;
      gap: 0.375rem;
    }
    .cd-badges:empty {
      display: none;
    }
    .cd-meta {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.25rem 1rem;
    }
    .cd-meta a {
      color: var(--color-text-secondary);
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    .cd-meta a:hover {
      color: var(--color-text);
    }

    /* ---- summary band -------------------------------------------------- */
    .cd-stats {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0.875rem 1.5rem;
      margin: 0;
    }
    @media (min-width: 40rem) {
      .cd-stats {
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }
    }
    .cd-stat dt {
      font-size: 0.75rem;
      line-height: 1rem;
      color: var(--color-text-secondary);
    }
    .cd-stat dd {
      margin: 0;
    }
    .cd-stat__value {
      font-family: var(--font-mono);
      font-size: 1.25rem;
      font-weight: 500;
      line-height: 1.75rem;
      color: var(--color-text-heading);
    }
    .cd-stat__hint {
      font-size: 0.75rem;
      line-height: 1rem;
      color: var(--color-text-secondary);
    }
    .cd-roles {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem 1rem;
      margin: 0.875rem 0 0;
      padding: 0;
      list-style: none;
    }
    .cd-roles li {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
    }
    .cd-roles__n {
      font-family: var(--font-mono);
      font-size: 0.8125rem;
      font-weight: 600;
    }

    /* ---- shared bits --------------------------------------------------- */
    .cd-toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem 1rem;
      min-height: 2rem;
    }
    .cd-toolbar__note {
      font-size: 0.8125rem;
      color: var(--color-text-secondary);
    }
    .cd-panel {
      min-width: 0;
      padding: 1rem;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      background: var(--color-surface);
    }
    .cd-panel__title {
      margin: 0 0 0.75rem;
      font-size: 0.9375rem;
      font-weight: 600;
      color: var(--color-text-heading);
    }
    .cd-panel__note {
      margin: 0;
      font-size: 0.875rem;
      color: var(--color-text-secondary);
    }
    .cd-link-btn {
      padding: 0;
      border: 0;
      background: none;
      color: var(--color-text-secondary);
      font: inherit;
      font-size: 0.8125rem;
      text-decoration: underline;
      text-underline-offset: 2px;
      cursor: pointer;
    }
    .cd-link-btn:hover {
      color: var(--color-text);
    }
    .cd-link-btn:focus-visible,
    .cd-toggle:focus-visible,
    .cd-line:focus-visible,
    .cd-step:focus-visible,
    .cd-icon-btn:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }

    /* ---- roster table -------------------------------------------------- */
    .cd-roster {
      container-type: inline-size;
      container-name: roster;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      background: var(--color-surface);
    }
    .cd-table {
      width: 100%;
      border-collapse: collapse;
    }
    .cd-table th {
      padding: 0.5rem 0.75rem;
      border-bottom: 1px solid var(--color-border);
      font-size: 0.75rem;
      font-weight: 500;
      text-align: start;
      color: var(--color-text-secondary);
    }
    .cd-table td {
      padding: 0.375rem 0.75rem;
      border-top: 1px solid var(--color-border);
      vertical-align: middle;
    }
    .cd-table tbody tr:first-child td {
      border-top: 0;
    }
    .cd-num {
      text-align: end;
      white-space: nowrap;
    }
    .cd-table th.cd-num {
      text-align: end;
    }
    .cd-tr--open > td {
      background: var(--color-surface-2);
    }
    .cd-tr--detail > td {
      padding: 0.25rem 0.75rem 1rem 4.375rem;
      background: var(--color-surface-2);
      border-top: 0;
    }
    .cd-toggle {
      display: flex;
      align-items: center;
      gap: 0.625rem;
      width: 100%;
      min-height: 2.75rem;
      padding: 0;
      border: 0;
      border-radius: var(--radius-sm);
      background: none;
      color: inherit;
      font: inherit;
      text-align: start;
      cursor: pointer;
    }
    .cd-chevron {
      display: inline-flex;
      flex: 0 0 auto;
      color: var(--color-text-secondary);
    }
    .cd-build {
      min-width: 0;
    }
    .cd-build__name {
      display: block;
      font-size: 0.875rem;
      font-weight: 500;
      line-height: 1.25rem;
      overflow-wrap: anywhere;
    }
    .cd-build__version {
      margin-inline-start: 0.375rem;
      font-family: var(--font-mono);
      font-size: 0.75rem;
      font-weight: 400;
      color: var(--color-text-secondary);
    }
    .cd-build__sub {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.125rem 0.5rem;
      font-size: 0.75rem;
      line-height: 1.125rem;
      color: var(--color-text-secondary);
    }
    .cd-role-inline {
      display: none;
    }
    .cd-qty {
      font-family: var(--font-mono);
      font-size: 0.875rem;
      font-weight: 600;
    }
    .cd-actions {
      display: inline-flex;
      align-items: center;
      justify-content: flex-end;
      gap: 0.25rem;
    }
    .cd-icon-btn {
      display: inline-grid;
      place-items: center;
      width: 2rem;
      height: 2rem;
      border: 0;
      border-radius: var(--radius-sm);
      background: none;
      color: var(--color-text-secondary);
      cursor: pointer;
    }
    .cd-icon-btn:hover:not(:disabled) {
      background: var(--color-surface-hover);
      color: var(--color-text);
    }
    .cd-icon-btn--danger:hover:not(:disabled) {
      color: var(--color-error);
    }
    .cd-icon-btn:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .cd-stepper {
      display: inline-flex;
      align-items: center;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      background: var(--color-surface);
    }
    .cd-step {
      width: 2rem;
      height: 2rem;
      border: 0;
      border-radius: var(--radius-sm);
      background: none;
      color: var(--color-text);
      font-size: 1.125rem;
      line-height: 1;
      cursor: pointer;
    }
    .cd-step:hover:not(:disabled) {
      background: var(--color-surface-hover);
    }
    .cd-step:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .cd-step__value {
      min-width: 2rem;
      text-align: center;
      font-family: var(--font-mono);
      font-size: 0.875rem;
      font-weight: 600;
    }
    @container roster (max-width: 38rem) {
      .cd-col--role {
        display: none;
      }
      .cd-role-inline {
        display: inline-flex;
      }
      .cd-tr--detail > td {
        padding-inline-start: 0.75rem;
      }
    }

    /* ---- parties ------------------------------------------------------- */
    .cd-parties {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(100%, 22rem), 1fr));
      gap: 1rem;
      align-items: start;
    }
    .cd-party__head {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      justify-content: space-between;
      gap: 0.25rem 0.75rem;
    }
    .cd-party__title {
      margin: 0;
      font-size: 0.9375rem;
      font-weight: 600;
      color: var(--color-text-heading);
    }
    .cd-party__count {
      font-size: 0.8125rem;
      color: var(--color-text-secondary);
    }
    .cd-party__mix {
      margin: 0.25rem 0 0.5rem;
      font-size: 0.8125rem;
      color: var(--color-text-secondary);
    }
    .cd-lines {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .cd-lines li + li {
      border-top: 1px solid var(--color-border);
    }
    .cd-line {
      display: flex;
      align-items: center;
      gap: 0.625rem;
      width: 100%;
      min-height: 2.75rem;
      padding: 0.25rem 0.25rem;
      border: 0;
      border-radius: var(--radius-sm);
      background: none;
      color: inherit;
      font: inherit;
      text-align: start;
      cursor: pointer;
    }
    .cd-line:hover {
      background: var(--color-surface-hover);
    }
    .cd-line__name {
      flex: 1 1 auto;
      min-width: 0;
      font-size: 0.875rem;
      font-weight: 500;
      overflow-wrap: anywhere;
    }
    .cd-line__qty {
      flex: 0 0 auto;
      min-width: 2rem;
      text-align: end;
      font-family: var(--font-mono);
      font-size: 0.875rem;
      font-weight: 600;
    }

    /* ---- analytics ----------------------------------------------------- */
    .cd-analytics {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(100%, 24rem), 1fr));
      gap: 1rem;
      align-items: start;
    }
    .cd-balance {
      display: grid;
      grid-template-columns: auto minmax(3rem, 1fr) auto;
      align-items: center;
      gap: 0.5rem 0.75rem;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .cd-balance li {
      display: contents;
    }
    .cd-bar {
      height: 0.5rem;
      border-radius: var(--radius-sm);
      background: var(--color-surface-2);
      overflow: hidden;
    }
    .cd-bar > span {
      display: block;
      height: 100%;
      background: var(--color-text-muted);
    }
    .cd-balance__value {
      font-family: var(--font-mono);
      font-size: 0.8125rem;
      text-align: end;
      white-space: nowrap;
    }
    .cd-kv {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr));
      gap: 0.75rem 1rem;
      margin: 0 0 1rem;
    }
    .cd-weapons {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .cd-weapons li {
      display: flex;
      align-items: center;
      gap: 0.625rem;
      min-height: 2.5rem;
    }
    .cd-weapons li + li {
      border-top: 1px solid var(--color-border);
    }
    .cd-data {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.8125rem;
    }
    .cd-data th,
    .cd-data td {
      padding: 0.375rem 0.5rem;
      border-top: 1px solid var(--color-border);
      text-align: start;
    }
    .cd-data thead th {
      border-top: 0;
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--color-text-secondary);
    }
    .cd-data .cd-num {
      text-align: end;
    }
    .cd-outcome {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
    }
    .cd-outcome--ahead {
      color: var(--color-success);
    }
    .cd-outcome--behind {
      color: var(--color-error);
    }
    .cd-table-scroll {
      overflow-x: auto;
    }

    /* ---- skeleton ------------------------------------------------------ */
    .cd-skel__bar,
    .cd-skel__cell,
    .cd-skel__row {
      border-radius: var(--radius-sm);
      background: var(--color-surface-2);
    }
    .cd-skel__bar--title {
      width: min(18rem, 70%);
      height: 1.75rem;
    }
    .cd-skel__bar--meta {
      width: min(26rem, 90%);
      height: 1rem;
      margin-block-start: 0.625rem;
    }
    .cd-skel__stats {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0.75rem;
      margin-block: 1.25rem;
    }
    @media (min-width: 40rem) {
      .cd-skel__stats {
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }
    }
    .cd-skel__cell {
      height: 3.25rem;
    }
    .cd-skel__row {
      height: 2.75rem;
      margin-block-start: 0.5rem;
    }
    @media (prefers-reduced-motion: no-preference) {
      .cd-skel__bar,
      .cd-skel__cell,
      .cd-skel__row {
        animation: cd-pulse 1.4s ease-in-out infinite;
      }
    }
    @keyframes cd-pulse {
      50% {
        opacity: 0.5;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .cd-chevron {
        transition: none;
      }
    }
  `,
  template: `
    @if (loading()) {
      <div role="status" aria-busy="true">
        <span class="sr-only">{{ t('common.loading') }}</span>
        <div aria-hidden="true">
          <div class="cd-skel__bar cd-skel__bar--title"></div>
          <div class="cd-skel__bar cd-skel__bar--meta"></div>
          <div class="cd-skel__stats">
            <div class="cd-skel__cell"></div>
            <div class="cd-skel__cell"></div>
            <div class="cd-skel__cell"></div>
            <div class="cd-skel__cell"></div>
          </div>
          <div class="cd-skel__row"></div>
          <div class="cd-skel__row"></div>
          <div class="cd-skel__row"></div>
          <div class="cd-skel__row"></div>
          <div class="cd-skel__row"></div>
        </div>
      </div>
    } @else if (comp(); as current) {
      <app-entity-header
        [title]="current.name"
        [description]="current.description"
        [menuItems]="menuItems()"
        [menuLabel]="t('entityHeader.moreActions')"
        (menuSelect)="onMenu($event)"
      >
        <span entityBadges class="cd-badges">
          @if (current.archived_at) {
            <span class="cd-tag cd-tag--state">{{ t('comps.archived') }}</span>
          }
          @if (isGuildTenant() && shareStatus()?.shared) {
            <span class="cd-tag">{{ t('comps.sharedWithAlliance') }}</span>
          }
        </span>

        <div entityMeta class="cd-meta">
          @if ((current.versions ?? []).length > 1) {
            <app-version-switcher
              [versions]="current.versions ?? []"
              [currentId]="current.id"
              [busy]="saving()"
              [label]="t('comps.version')"
              [compact]="true"
              (select)="openVersion($event)"
            />
          } @else {
            <span class="cd-mono">v{{ current.version }}</span>
          }
          <span>{{ current.category_name || t('comps.noCategory') }}</span>
          <span>{{ t('compDetail.byAuthor', { name: current.created_by_username }) }}</span>
          <span>{{ t('compDetail.createdOn', { date: formatDate(current.created_at) }) }}</span>
          @if (parentComp(); as parent) {
            <a [routerLink]="['/comps', parent.id]">{{ t('compDetail.variantOf', { name: parent.name }) }}</a>
          }
        </div>

        @if (canManage()) {
          <button
            entityPrimary
            type="button"
            class="btn btn--primary"
            [disabled]="saving()"
            (click)="toggleEdit()"
          >
            <app-icon [name]="editing() ? 'check' : 'edit'" size="1rem" />
            {{ editing() ? t('compDetail.action.done') : t('compDetail.action.edit') }}
          </button>
        }

        <div entitySummary>
          <dl class="cd-stats">
            <div class="cd-stat">
              <dt>{{ t('compDetail.stat.players') }}</dt>
              <dd class="cd-stat__value">{{ current.total_quantity }}</dd>
            </div>
            <div class="cd-stat">
              <dt>{{ t('compDetail.stat.parties') }}</dt>
              <dd class="cd-stat__value">{{ parties().length }}</dd>
              @if (lastPartyShort(); as last) {
                <dd class="cd-stat__hint">{{ t('compDetail.stat.lastParty', { count: last, size: partySize }) }}</dd>
              }
            </div>
            <div class="cd-stat">
              <dt>{{ t('compDetail.stat.builds') }}</dt>
              <dd class="cd-stat__value">{{ current.builds.length }}</dd>
              <dd class="cd-stat__hint">{{ t('compDetail.stat.weapons', { count: weapons().length }) }}</dd>
            </div>
            <div class="cd-stat">
              <dt>{{ t('comps.winrate') }}</dt>
              <dd class="cd-stat__value">{{ winRateText() }}</dd>
              <dd class="cd-stat__hint">{{ winRateHint() }}</dd>
            </div>
          </dl>
          @if (roleDistribution().length > 0) {
            <ul class="cd-roles" [attr.aria-label]="t('compDetail.roleBreakdown')">
              @for (dist of roleDistribution(); track dist.role) {
                <li>
                  <app-role-tag [role]="dist.role" />
                  <span class="cd-roles__n">{{ dist.quantity }}</span>
                </li>
              }
            </ul>
          }
        </div>
      </app-entity-header>

      <div class="cd-stack">
        <app-view-toggle [options]="tabOptions()" [active]="tab()" (activeChange)="onTabChange($event)" />

        <!-- ================= ROSTER ================= -->
        @if (tab() === 'roster') {
          <section class="cd-stack" [attr.aria-label]="t('compDetail.tab.roster')">
            @if (current.builds.length === 0) {
              <app-empty-state
                icon="package"
                [message]="t('comps.noBuilds')"
                [hint]="canManage() ? t('compDetail.empty.hint') : undefined"
              >
                @if (canManage()) {
                  <button type="button" class="btn btn--primary btn--sm" (click)="openAdd()">
                    <app-icon name="plus" size="0.875rem" />
                    {{ t('comps.addBuild') }}
                  </button>
                }
              </app-empty-state>
            } @else {
              <div class="cd-toolbar">
                @if (editing()) {
                  <span class="cd-toolbar__note" role="status">{{ t('compDetail.edit.hint') }}</span>
                  <button type="button" class="btn btn--outline btn--sm" [disabled]="saving()" (click)="openAdd()">
                    <app-icon name="plus" size="0.875rem" />
                    {{ t('comps.addBuild') }}
                  </button>
                } @else {
                  <span class="cd-toolbar__note">{{ t('compDetail.roster.hint') }}</span>
                  <button type="button" class="cd-link-btn" (click)="toggleAll()">
                    {{ allOpen() ? t('comps.collapseAll') : t('comps.expandAll') }}
                  </button>
                }
              </div>

              <div class="cd-roster">
                <table class="cd-table">
                  <thead>
                    <tr>
                      <th scope="col">{{ t('compDetail.col.build') }}</th>
                      <th scope="col" class="cd-col--role">{{ t('common.role') }}</th>
                      <th scope="col" class="cd-num">{{ t('compDetail.col.players') }}</th>
                      <th scope="col"><span class="sr-only">{{ t('common.actions') }}</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (entry of rosterEntries(); track entry.build_id) {
                      <tr class="cd-tr" [class.cd-tr--open]="isOpen(entry.build_id)">
                        <td>
                          <button
                            type="button"
                            class="cd-toggle"
                            [attr.aria-expanded]="isOpen(entry.build_id)"
                            [attr.aria-controls]="'cd-detail-' + entry.build_id"
                            (click)="toggleBuild(entry.build_id)"
                          >
                            <span class="cd-chevron" aria-hidden="true">
                              <app-icon [name]="isOpen(entry.build_id) ? 'chevron-down' : 'chevron-right'" size="1rem" />
                            </span>
                            <app-weapon-icon [weaponKey]="entry.build.weapon_key" [fallback]="glyph(entry.build.role)" />
                            <span class="cd-build">
                              <span class="cd-build__name">
                                {{ entry.build.name }}
                                <span class="cd-build__version">v{{ entry.build.version }}</span>
                              </span>
                              <span class="cd-build__sub">
                                <app-role-tag class="cd-role-inline" [role]="entry.build.role" />
                                <span>{{ entry.build.weapon_name || t('comps.noWeapon') }}</span>
                              </span>
                            </span>
                          </button>
                        </td>
                        <td class="cd-col--role"><app-role-tag [role]="entry.build.role" /></td>
                        <td class="cd-num">
                          @if (editing()) {
                            <span class="cd-stepper" role="group" [attr.aria-label]="t('compDetail.quantity.of', { name: entry.build.name })">
                              <button
                                type="button"
                                class="cd-step"
                                [disabled]="saving() || displayedQuantity(entry) <= 1"
                                [attr.aria-label]="t('compDetail.quantity.decreaseNamed', { name: entry.build.name })"
                                (click)="step(entry, -1)"
                              >
                                −
                              </button>
                              <output class="cd-step__value" aria-live="polite">{{ displayedQuantity(entry) }}</output>
                              <button
                                type="button"
                                class="cd-step"
                                [disabled]="saving()"
                                [attr.aria-label]="t('compDetail.quantity.increaseNamed', { name: entry.build.name })"
                                (click)="step(entry, 1)"
                              >
                                +
                              </button>
                            </span>
                          } @else {
                            <span class="cd-qty">×{{ entry.quantity }}</span>
                          }
                        </td>
                        <td class="cd-num">
                          <span class="cd-actions">
                            <a
                              class="cd-icon-btn"
                              [routerLink]="['/builds', entry.build_id]"
                              [attr.aria-label]="t('comps.openNamedBuild', { name: entry.build.name })"
                              [title]="t('comps.openBuild')"
                            >
                              <app-icon name="arrow-right" size="1rem" />
                            </a>
                            @if (editing()) {
                              <button
                                type="button"
                                class="cd-icon-btn cd-icon-btn--danger"
                                [disabled]="saving()"
                                [attr.aria-label]="t('compDetail.remove', { name: entry.build.name })"
                                [title]="t('compDetail.removeShort')"
                                (click)="removeBuild(entry.build_id)"
                              >
                                <app-icon name="close" size="1rem" />
                              </button>
                            }
                          </span>
                        </td>
                      </tr>
                      @if (isOpen(entry.build_id)) {
                        <tr class="cd-tr--detail" [id]="'cd-detail-' + entry.build_id">
                          <td colspan="4">
                            <app-loadout-view
                              [items]="buildDetails().get(entry.build_id)?.items"
                              [loading]="isBuildLoading(entry.build_id)"
                              [unavailable]="isBuildFailed(entry.build_id)"
                            />
                          </td>
                        </tr>
                      }
                    }
                  </tbody>
                </table>
              </div>
            }
          </section>
        }

        <!-- ================= PARTIES ================= -->
        @if (tab() === 'parties') {
          @if (parties().length === 0) {
            <app-empty-state icon="package" [message]="t('comps.noBuilds')" />
          } @else {
            <div class="cd-parties">
              @for (party of parties(); track party.partyNumber) {
                <section class="cd-panel" [attr.aria-labelledby]="'cd-party-' + party.partyNumber">
                  <header class="cd-party__head">
                    <h2 class="cd-party__title" [id]="'cd-party-' + party.partyNumber">
                      {{ t('comps.partyNum', { number: party.partyNumber }) }}
                    </h2>
                    <span class="cd-party__count">
                      @if (party.seats.length < partySize) {
                        {{ t('compDetail.party.playersPartial', { count: party.seats.length, size: partySize }) }}
                      } @else {
                        {{ t('compDetail.party.players', { count: party.seats.length }) }}
                      }
                    </span>
                  </header>
                  <p class="cd-party__mix">{{ roleMixText(party) }}</p>
                  <ul class="cd-lines">
                    @for (group of groupSeats(party); track group.buildId) {
                      <li>
                        <button
                          type="button"
                          class="cd-line"
                          [attr.aria-label]="t('comps.inspectBuild', { name: group.build.name })"
                          (click)="inspect(group.buildId)"
                        >
                          <app-weapon-icon size="sm" [weaponKey]="group.build.weapon_key" [fallback]="glyph(group.role)" />
                          <span class="cd-line__name">
                            {{ group.build.name }}
                            <span class="cd-build__version">v{{ group.build.version }}</span>
                          </span>
                          <app-role-tag [role]="group.role" />
                          <span class="cd-line__qty">×{{ group.count }}</span>
                        </button>
                      </li>
                    }
                  </ul>
                </section>
              }
            </div>
          }
        }

        <!-- ================= ANALYTICS ================= -->
        @if (tab() === 'analytics') {
          <div class="cd-analytics">
            <div class="cd-stack">
              <section class="cd-panel" aria-labelledby="cd-balance-title">
                <h2 class="cd-panel__title" id="cd-balance-title">{{ t('comps.roleBalance') }}</h2>
                @if (roleDistribution().length === 0) {
                  <p class="cd-panel__note">{{ t('comps.noBuilds') }}</p>
                } @else {
                  <ul class="cd-balance">
                    @for (dist of roleDistribution(); track dist.role) {
                      <li>
                        <app-role-tag [role]="dist.role" />
                        <span class="cd-bar" aria-hidden="true">
                          <span [style.width.%]="rolePercent(dist.quantity)"></span>
                        </span>
                        <span class="cd-balance__value">{{ dist.quantity }} · {{ rolePercent(dist.quantity) }}%</span>
                      </li>
                    }
                  </ul>
                }
              </section>

              <section class="cd-panel" aria-labelledby="cd-weapons-title">
                <h2 class="cd-panel__title" id="cd-weapons-title">{{ t('comps.weaponsInComp') }}</h2>
                @if (weapons().length === 0) {
                  <p class="cd-panel__note">{{ t('comps.noBuilds') }}</p>
                } @else {
                  <ul class="cd-weapons">
                    @for (weapon of weapons(); track weapon.key) {
                      <li>
                        <app-weapon-icon size="sm" [weaponKey]="weapon.key" fallback="–" />
                        <span class="flex-1 min-w-0 text-sm">{{ weapon.name }}</span>
                        <span class="cd-mono text-sm">×{{ weapon.players }}</span>
                      </li>
                    }
                  </ul>
                }
              </section>
            </div>

            <div class="cd-stack">
              <section class="cd-panel" aria-labelledby="cd-perf-title">
                <h2 class="cd-panel__title" id="cd-perf-title">{{ t('comps.battlePerformance') }}</h2>
                @if (performance(); as perf) {
                  @if (perf.stats.total_battles === 0) {
                    <p class="cd-panel__note">{{ t('compDetail.perf.none') }}</p>
                  } @else {
                    <dl class="cd-kv">
                      <div class="cd-stat">
                        <dt>{{ t('comps.winrate') }}</dt>
                        <dd class="cd-stat__value">{{ percentText(perf.stats.win_rate) }}</dd>
                      </div>
                      <div class="cd-stat">
                        <dt>{{ t('comps.winsLosses') }}</dt>
                        <dd class="cd-stat__value">{{ perf.stats.wins }} / {{ perf.stats.losses }}</dd>
                      </div>
                      <div class="cd-stat">
                        <dt>{{ t('comps.totalBattles') }}</dt>
                        <dd class="cd-stat__value">{{ perf.stats.total_battles }}</dd>
                      </div>
                      <div class="cd-stat">
                        <dt>{{ t('comps.kdRatio') }}</dt>
                        <dd class="cd-stat__value">{{ formatRatio(perf.stats.kill_death_ratio) }}</dd>
                        <dd class="cd-stat__hint">{{ perf.stats.total_kills }} / {{ perf.stats.total_deaths }}</dd>
                      </div>
                      <div class="cd-stat">
                        <dt>{{ t('comps.killFame') }}</dt>
                        <dd class="cd-stat__value">{{ formatNumber(perf.stats.total_kill_fame) }}</dd>
                      </div>
                    </dl>

                    @if (perf.stats.top_opponents.length > 0) {
                      <h3 class="text-sm font-semibold mb-1">{{ t('comps.topOpponents') }}</h3>
                      <div class="cd-table-scroll">
                        <table class="cd-data">
                          <thead>
                            <tr>
                              <th scope="col">{{ t('comps.opponent') }}</th>
                              <th scope="col" class="cd-num">{{ t('compDetail.perf.wins') }}</th>
                              <th scope="col" class="cd-num">{{ t('compDetail.perf.losses') }}</th>
                              <th scope="col" class="cd-num">{{ t('comps.winPercent') }}</th>
                            </tr>
                          </thead>
                          <tbody>
                            @for (opponent of perf.stats.top_opponents; track opponentKey(opponent)) {
                              <tr>
                                <th scope="row" class="font-medium">{{ opponent.guild_name }}</th>
                                <td class="cd-num cd-mono">{{ opponent.wins }}</td>
                                <td class="cd-num cd-mono">{{ opponent.losses }}</td>
                                <td class="cd-num cd-mono">
                                  <span class="cd-outcome" [class.cd-outcome--ahead]="outcome(opponent) === 'ahead'" [class.cd-outcome--behind]="outcome(opponent) === 'behind'">
                                    @switch (outcome(opponent)) {
                                      @case ('ahead') { <app-icon name="check" size="0.875rem" /> }
                                      @case ('behind') { <app-icon name="close" size="0.875rem" /> }
                                    }
                                    <span class="sr-only">{{ outcomeLabel(opponent) }}</span>
                                    {{ percentText(opponentWinRate(opponent)) }}
                                  </span>
                                </td>
                              </tr>
                            }
                          </tbody>
                        </table>
                      </div>
                    }
                  }
                } @else {
                  <p class="cd-panel__note">{{ t('compDetail.perf.unavailable') }}</p>
                }
              </section>

              <section class="cd-panel" aria-labelledby="cd-price-title">
                <div class="flex items-baseline justify-between gap-2">
                  <h2 class="cd-panel__title" id="cd-price-title">{{ t('comps.price.title') }}</h2>
                  @if (compPrice(); as price) {
                    <span class="cd-mono text-sm font-semibold">{{ formatSilver(price.total) }}</span>
                  }
                </div>
                @if (compPrice(); as price) {
                  @if (price.builds.length > 0) {
                    <div class="cd-table-scroll">
                      <table class="cd-data">
                        <thead>
                          <tr>
                            <th scope="col">{{ t('compDetail.col.build') }}</th>
                            <th scope="col" class="cd-num">{{ t('compDetail.col.players') }}</th>
                            <th scope="col" class="cd-num">{{ t('comps.price.perItem') }}</th>
                            <th scope="col" class="cd-num">{{ t('comps.price.total') }}</th>
                          </tr>
                        </thead>
                        <tbody>
                          @for (row of price.builds; track row.build_id) {
                            <tr>
                              <th scope="row" class="font-medium">{{ row.build_name }}</th>
                              <td class="cd-num cd-mono">×{{ row.quantity }}</td>
                              <td class="cd-num cd-mono">{{ formatSilver(row.unit_total) }}</td>
                              <td class="cd-num cd-mono">{{ formatSilver(row.subtotal) }}</td>
                            </tr>
                          }
                        </tbody>
                      </table>
                    </div>
                  } @else {
                    <p class="cd-panel__note">{{ t('comps.price.unavailable') }}</p>
                  }
                } @else {
                  <p class="cd-panel__note">{{ t('comps.price.unavailable') }}</p>
                }
              </section>
            </div>
          </div>
        }
      </div>

      <!-- ================= ADD BUILD ================= -->
      @if (addOpen()) {
        <app-comp-add-build-dialog
          [assignedIds]="assignedBuildIds()"
          [saving]="saving()"
          (add)="addBuild($event)"
          (closed)="addOpen.set(false)"
        />
      }

      <!-- ================= INSPECT ================= -->
      @if (inspectedEntry(); as inspected) {
        <app-dialog
          [title]="inspected.build.name"
          [subtitle]="t('compDetail.inspect.subtitle', { version: inspected.build.version })"
          size="lg"
          (closed)="inspectedBuildId.set(null)"
        >
          <div class="cd-stack">
            <div class="cd-meta text-sm cd-muted">
              <app-role-tag [role]="inspected.build.role" />
              <span>{{ inspected.build.category_name || t('comps.noCategory') }}</span>
              <span>{{ t('compDetail.byAuthor', { name: inspected.build.created_by_username }) }}</span>
              <span class="cd-mono">×{{ inspected.quantity }}</span>
            </div>
            <app-loadout-view
              [items]="buildDetails().get(inspected.build_id)?.items"
              [loading]="isBuildLoading(inspected.build_id)"
              [unavailable]="isBuildFailed(inspected.build_id)"
            />
          </div>
          <div dialogFooter class="flex items-center justify-end gap-2 w-full">
            <button type="button" class="btn btn--ghost btn--sm" (click)="inspectedBuildId.set(null)">
              {{ t('common.close') }}
            </button>
            <a
              class="btn btn--primary btn--sm"
              [routerLink]="['/builds', inspected.build_id]"
              (click)="inspectedBuildId.set(null)"
            >
              {{ t('compDetail.inspect.open') }}
              <app-icon name="arrow-right" size="0.875rem" />
            </a>
          </div>
        </app-dialog>
      }

      <!-- ================= EDIT DETAILS ================= -->
      @if (editMetaOpen()) {
        <app-dialog [title]="t('comps.editComp')" size="md" (closed)="closeEditMeta()">
          <form class="grid gap-4" (submit)="saveEdit($event)">
            <p class="text-xs text-secondary">{{ t('validation.requiredLegend') }}</p>
            <div class="grid gap-4 md:grid-cols-2">
              <label>
                <span class="label">{{ t('common.name') }} <span class="text-error" aria-hidden="true">*</span></span>
                <input
                  class="input"
                  type="text"
                  required
                  [attr.aria-invalid]="nameError() ? 'true' : null"
                  [attr.aria-describedby]="nameError() ? 'cd-name-error' : null"
                  [value]="editName()"
                  (input)="onEditNameChange($event)"
                />
                @if (nameError(); as message) {
                  <span id="cd-name-error" class="text-xs text-error" role="alert">{{ message }}</span>
                }
              </label>
              <label>
                <span class="label">{{ t('common.category') }} <span class="text-error" aria-hidden="true">*</span></span>
                <select class="select" required [value]="editCategoryId()" (change)="onEditCategoryChange($event)">
                  @for (category of editCategoryOptions(); track category.id) {
                    <option [value]="category.id" [selected]="isSelectedId(editCategoryId(), category.id)">
                      {{ category.name }}
                    </option>
                  }
                </select>
                <span class="text-xs text-secondary">{{ t('comps.categoryRequired') }}</span>
              </label>
            </div>
            <label>
              <span class="label">{{ t('common.description') }}</span>
              <textarea class="textarea" rows="3" [value]="editDescription()" (input)="onEditDescriptionChange($event)"></textarea>
            </label>
            <div class="grid gap-2">
              <app-ownership-scope-toggle [scope]="editParentScope()" (scopeChange)="setEditParentScope($event)" />
              <label>
                <span class="label">{{ t('comps.parent') }}</span>
                <select class="select" (change)="onEditParentChange($event)">
                  <option value="" [selected]="!editParentId()">{{ t('comps.noParent') }}</option>
                  @for (sibling of editParentOptions(); track sibling.id) {
                    <option [value]="sibling.id" [selected]="isSelectedId(editParentId(), sibling.id)">
                      {{ ownershipLabel(sibling.name, sibling.created_by_username) }}
                    </option>
                  }
                </select>
              </label>
            </div>
            <div class="flex justify-end gap-2 pt-2 border-t border-[var(--color-border)]">
              <button type="button" class="btn btn--ghost" (click)="closeEditMeta()">{{ t('common.cancel') }}</button>
              <button type="submit" class="btn btn--primary" [disabled]="saving()">{{ t('common.save') }}</button>
            </div>
          </form>
        </app-dialog>
      }

      <!-- ================= COMPARE VERSIONS ================= -->
      @if (comparing()) {
        <app-dialog [title]="t('comps.compare')" size="lg" (closed)="closeCompare()">
          <div class="grid gap-4">
            <label>
              <span class="label">{{ t('comps.compareWith') }}</span>
              <select class="select" [value]="compareWithId()" (change)="onCompareTargetChange($event)">
                @for (entry of current.versions ?? []; track entry.id) {
                  @if (entry.id !== current.id) {
                    <option [value]="entry.id" [selected]="compareWithId() === '' + entry.id">v{{ entry.version }}</option>
                  }
                }
              </select>
            </label>

            @if (comparison(); as pair) {
              <p class="text-sm cd-muted">
                {{ t('compDetail.compare.direction', { from: 'v' + pair.before.version, to: 'v' + pair.after.version }) }}
              </p>
              <div class="grid gap-3 sm:grid-cols-2">
                <section class="cd-panel">
                  <h3 class="text-sm font-semibold">{{ t('compDetail.compare.older', { version: pair.before.version }) }}</h3>
                  <p class="text-sm cd-muted mt-1">{{ performanceSummary(pair.beforePerformance) }}</p>
                </section>
                <section class="cd-panel">
                  <h3 class="text-sm font-semibold">{{ t('compDetail.compare.newer', { version: pair.after.version }) }}</h3>
                  <p class="text-sm cd-muted mt-1">{{ performanceSummary(pair.afterPerformance) }}</p>
                </section>
              </div>

              <app-version-diff-list
                [entries]="compareDiff()"
                [emptyLabel]="t('comps.noDifferences')"
                [subjectLabel]="t('compDetail.compare.build')"
                [beforeLabel]="'v' + pair.before.version"
                [afterLabel]="'v' + pair.after.version"
                [changeLabel]="t('compDetail.compare.change')"
                [noneLabel]="t('versionDiff.none')"
                [addedLabel]="t('comps.added')"
                [removedLabel]="t('comps.removed')"
                [changedLabel]="t('comps.changed')"
              />
            } @else if (compareLoading()) {
              <p class="text-sm cd-muted" role="status">{{ t('common.loading') }}</p>
            }
          </div>
          <div dialogFooter>
            <button type="button" class="btn btn--ghost" (click)="closeCompare()">{{ t('common.close') }}</button>
          </div>
        </app-dialog>
      }

      <!-- ================= ARCHIVE CONFIRM ================= -->
      @if (pendingArchive()) {
        <app-dialog [title]="t('common.confirm')" size="sm" (closed)="closeArchiveConfirm()">
          <p>{{ t('comps.archiveConfirm') }}</p>
          <p class="mt-2 text-sm cd-muted">{{ current.name }}</p>
          <div dialogFooter>
            <button type="button" class="btn btn--ghost" (click)="closeArchiveConfirm()">{{ t('common.cancel') }}</button>
            <button type="button" class="btn btn--tonal" [disabled]="saving()" (click)="confirmArchiveComp()">
              {{ t('comps.archive') }}
            </button>
          </div>
        </app-dialog>
      }
    } @else if (notFound()) {
      <app-empty-state icon="package" [message]="t('comps.notFound')" [hint]="t('compDetail.notFound.hint')">
        <a class="btn btn--outline btn--sm" routerLink="/comps">
          <app-icon name="chevron-left" size="0.875rem" />
          {{ t('compDetail.notFound.back') }}
        </a>
      </app-empty-state>
    } @else {
      <app-error-state
        [message]="t('common.error')"
        [hint]="t('compDetail.error.load')"
        [retryLabel]="t('common.retry')"
        (retry)="load(compId())"
      />
    }
  `,
})
export class CompDetailPage {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly notFound = signal(false);
  protected readonly saving = signal(false);

  protected readonly comp = signal<CompDetail | null>(null);
  protected readonly parentComp = signal<CompSummary | null>(null);
  protected readonly performance = signal<CompPerformanceView | null>(null);
  /** The comp's total market price, priced live from Albion Online Data (sum of build x quantity). */
  protected readonly compPrice = signal<CompPriceView | null>(null);
  protected readonly shareStatus = signal<AllianceShareStatus | null>(null);

  protected readonly tab = signal<DetailTab>('roster');
  protected readonly editing = signal(false);
  protected readonly partySize = COMP_PARTY_SIZE;
  protected readonly glyph = roleGlyph;

  // ---- lazily loaded build loadouts ----------------------------------------
  protected readonly buildDetails = signal<ReadonlyMap<number, BuildDetail>>(new Map());
  private readonly buildLoading = signal<ReadonlySet<number>>(new Set());
  private readonly buildFailed = signal<ReadonlySet<number>>(new Set());
  private readonly expanded = signal<ReadonlySet<number>>(new Set());
  protected readonly inspectedBuildId = signal<number | null>(null);

  // ---- editing ---------------------------------------------------------------
  protected readonly addOpen = signal(false);
  protected readonly pendingQuantity = signal<ReadonlyMap<number, number>>(new Map());
  private readonly quantityTimers = new Map<number, ReturnType<typeof setTimeout>>();

  protected readonly editMetaOpen = signal(false);
  protected readonly editName = signal('');
  protected readonly editDescription = signal('');
  protected readonly editCategoryId = signal('');
  protected readonly editParentId = signal('');
  protected readonly editParentScope = signal<OwnershipScope>('mine');
  protected readonly nameError = signal<string | null>(null);
  protected readonly compCategories = signal<CompCategoryView[]>([]);
  protected readonly compSummaries = signal<CompSummary[]>([]);
  protected readonly pendingArchive = signal(false);

  // ---- compare ---------------------------------------------------------------
  protected readonly comparing = signal(false);
  protected readonly compareLoading = signal(false);
  protected readonly compareWithId = signal('');
  private readonly compareWith = signal<CompDetail | null>(null);
  private readonly comparePerformance = signal<CompPerformanceView | null>(null);

  /** Older version first, so the diff always reads in chronological order. */
  protected readonly comparison = computed(() => {
    const current = this.comp();
    const other = this.compareWith();
    if (!current || !other) {
      return null;
    }
    const otherIsOlder = other.version < current.version;
    return otherIsOlder
      ? { before: other, after: current, beforePerformance: this.comparePerformance(), afterPerformance: this.performance() }
      : { before: current, after: other, beforePerformance: this.performance(), afterPerformance: this.comparePerformance() };
  });

  protected readonly compareDiff = computed<VersionDiffEntry[]>(() => {
    const pair = this.comparison();
    return pair
      ? diffCompVersions(pair.before, pair.after, {
          version: this.t('versionDiff.version'),
          players: this.t('versionDiff.players'),
        })
      : [];
  });

  /**
   * The comp row on screen.
   *
   * Switching versions navigates within the same route, so Angular reuses this component and the
   * snapshot never changes - the id has to come from the live `paramMap` instead.
   */
  protected readonly compId = signal(Number(this.route.snapshot.paramMap.get('compId')));

  // ---- permissions -----------------------------------------------------------
  /** Edit and delete apply to comps the caller authored; `comps.comps.manage` covers anyone's. */
  private canChange(own: string): boolean {
    return canChangeAuthored(
      this.comp(),
      this.auth.profile()?.user_id,
      this.auth.hasPermission(own),
      this.auth.hasPermission('comps.comps.manage'),
    );
  }

  protected readonly canManage = computed(() => this.canChange('comps.comps.edit'));
  protected readonly canDelete = computed(() => this.canChange('comps.comps.delete'));
  /** A new version joins its author's group, so it follows the same author-or-manage rule. */
  protected readonly canVersion = computed(() => this.canChange('comps.comps.create'));
  protected readonly isGuildTenant = computed(() => this.auth.profile()?.tenant_kind !== 'alliance');
  protected readonly canShare = computed(
    () => this.isGuildTenant() && this.auth.hasPermission('alliance.share'),
  );

  // ---- derived view data -----------------------------------------------------
  protected readonly menuItems = computed<EntityMenuItem[]>(() => {
    const current = this.comp();
    if (!current) {
      return [];
    }
    const disabled = this.saving();
    const items: EntityMenuItem[] = [];
    if (this.canManage()) {
      items.push({ id: 'editDetails', label: this.t('compDetail.action.editDetails'), disabled });
      items.push({ id: 'clone', label: this.t('common.clone'), disabled });
    }
    if ((current.versions ?? []).length > 1) {
      items.push({ id: 'compare', label: this.t('compDetail.action.compareVersions') });
    }
    if (this.canVersion()) {
      items.push({ id: 'newVersion', label: this.t('comps.newVersion'), disabled });
    }
    if (this.canShare()) {
      items.push(
        this.shareStatus()?.shared
          ? { id: 'unshare', label: this.t('comps.unshareWithAlliance'), disabled }
          : { id: 'share', label: this.t('comps.shareWithAlliance'), disabled },
      );
    }
    if (this.canDelete()) {
      items.push(
        current.archived_at
          ? { id: 'unarchive', label: this.t('comps.unarchive'), disabled, separatorBefore: true }
          : { id: 'archive', label: this.t('comps.archive'), disabled, danger: true, separatorBefore: true },
      );
    }
    return items;
  });

  protected readonly tabOptions = computed<readonly ViewToggleOption[]>(() => [
    { id: 'roster', label: this.t('compDetail.tab.roster') },
    { id: 'parties', label: this.t('compDetail.tab.parties') },
    { id: 'analytics', label: this.t('compDetail.tab.analytics') },
  ]);

  /** Roster order: front line first (role priority), then by name and version. */
  protected readonly rosterEntries = computed<CompBuildEntry[]>(() => {
    const entries = [...(this.comp()?.builds ?? [])];
    return entries.sort(
      (left, right) =>
        BUILD_ROLES.indexOf(left.build.role) - BUILD_ROLES.indexOf(right.build.role) ||
        left.build.name.localeCompare(right.build.name, this.translate.locale()) ||
        left.build.version - right.build.version,
    );
  });

  protected readonly assignedBuildIds = computed(() =>
    (this.comp()?.builds ?? []).map((entry) => entry.build_id),
  );

  protected readonly parties = computed(() => simulateCompParties(this.comp()?.builds ?? []));

  /** Seats in the last party when it is not full, so the header can say the last party is short. */
  protected readonly lastPartyShort = computed(() => {
    const parties = this.parties();
    const last = parties[parties.length - 1];
    return last && last.seats.length < COMP_PARTY_SIZE ? last.seats.length : null;
  });

  protected readonly roleDistribution = computed(() => {
    const quantities = new Map<BuildRole, number>();
    for (const entry of this.comp()?.builds ?? []) {
      quantities.set(entry.build.role, (quantities.get(entry.build.role) ?? 0) + entry.quantity);
    }
    return BUILD_ROLES.filter((role) => quantities.has(role)).map((role) => ({
      role,
      quantity: quantities.get(role) ?? 0,
    }));
  });

  /** One line per weapon with the players carrying it, most used first. */
  protected readonly weapons = computed(() => {
    const byWeapon = new Map<string, { key: string; name: string; players: number }>();
    for (const entry of this.comp()?.builds ?? []) {
      const key = entry.build.weapon_key ?? '';
      const existing = byWeapon.get(key);
      if (existing) {
        existing.players += entry.quantity;
      } else {
        byWeapon.set(key, {
          key,
          name: entry.build.weapon_name ?? this.t('comps.noWeapon'),
          players: entry.quantity,
        });
      }
    }
    return [...byWeapon.values()].sort(
      (left, right) => right.players - left.players || left.name.localeCompare(right.name),
    );
  });

  protected readonly allOpen = computed(() => {
    const builds = this.comp()?.builds ?? [];
    return builds.length > 0 && builds.every((entry) => this.expanded().has(entry.build_id));
  });

  protected readonly inspectedEntry = computed(() => {
    const id = this.inspectedBuildId();
    return id === null ? null : (this.comp()?.builds.find((entry) => entry.build_id === id) ?? null);
  });

  protected readonly winRateText = computed(() => {
    const stats = this.performance()?.stats;
    return stats && stats.total_battles > 0 ? this.percentText(stats.win_rate) : '—';
  });

  protected readonly winRateHint = computed(() => {
    const stats = this.performance()?.stats;
    if (!stats) {
      return this.t('compDetail.perf.unavailableShort');
    }
    return stats.total_battles === 0
      ? this.t('compDetail.perf.noBattles')
      : this.t('compDetail.stat.record', { wins: stats.wins, losses: stats.losses });
  });

  // Keep the current values visible even when the options request is paginated or temporarily
  // unavailable. Native selects otherwise fall back to the first option (usually "No ...").
  protected readonly editCategoryOptions = computed(() => {
    const current = this.comp();
    const categories = this.compCategories();
    if (!current || categories.some((category) => category.id === current.category_id)) {
      return categories;
    }
    return [
      {
        id: current.category_id,
        name: current.category_name ?? `${this.t('common.category')} #${current.category_id}`,
      },
      ...categories,
    ];
  });

  protected readonly editParentOptions = computed(() => {
    const current = this.comp();
    const parents = this.compSummaries().filter((sibling) => sibling.id !== current?.id);
    const parent = this.parentComp();
    if (!current || !parent || parents.some((candidate) => candidate.id === parent.id)) {
      return parents;
    }
    return [parent, ...parents];
  });

  constructor() {
    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const id = Number(params.get('compId'));
      if (id === this.compId() && this.comp()) {
        return;
      }
      this.compId.set(id);
      this.resetForNewComp();
      void this.load(id);
    });
    this.destroyRef.onDestroy(() => this.clearQuantityTimers());
  }

  // ===========================================================================
  // Header
  // ===========================================================================

  protected onMenu(id: string): void {
    switch (id) {
      case 'editDetails':
        this.openEditMeta();
        break;
      case 'clone':
        void this.cloneComp();
        break;
      case 'compare':
        this.openCompare();
        break;
      case 'newVersion':
        void this.createVersion();
        break;
      case 'share':
        void this.shareWithAlliance();
        break;
      case 'unshare':
        void this.unshareWithAlliance();
        break;
      case 'archive':
        this.pendingArchive.set(true);
        break;
      case 'unarchive':
        void this.unarchiveComp();
        break;
    }
  }

  protected onTabChange(id: string): void {
    if (id === 'roster' || id === 'parties' || id === 'analytics') {
      this.tab.set(id);
    }
  }

  protected async openVersion(compId: number): Promise<void> {
    if (compId === this.comp()?.id) {
      return;
    }
    await this.router.navigate(['/comps', compId]);
  }

  // ===========================================================================
  // Roster
  // ===========================================================================

  protected isOpen(buildId: number): boolean {
    return this.expanded().has(buildId);
  }

  protected toggleBuild(buildId: number): void {
    const opening = !this.expanded().has(buildId);
    this.expanded.update((current) => {
      const next = new Set(current);
      if (opening) {
        next.add(buildId);
      } else {
        next.delete(buildId);
      }
      return next;
    });
    if (opening) {
      void this.loadBuildDetail(buildId);
    }
  }

  protected toggleAll(): void {
    const builds = this.comp()?.builds ?? [];
    if (this.allOpen()) {
      this.expanded.set(new Set());
      return;
    }
    this.expanded.set(new Set(builds.map((entry) => entry.build_id)));
    for (const entry of builds) {
      void this.loadBuildDetail(entry.build_id);
    }
  }

  protected isBuildLoading(buildId: number): boolean {
    return this.buildLoading().has(buildId);
  }

  protected isBuildFailed(buildId: number): boolean {
    return this.buildFailed().has(buildId) && !this.buildDetails().has(buildId);
  }

  protected inspect(buildId: number): void {
    this.inspectedBuildId.set(buildId);
    void this.loadBuildDetail(buildId);
  }

  /** Fetches one build's loadout the first time it is needed; later calls reuse the cache. */
  private async loadBuildDetail(buildId: number): Promise<void> {
    if (this.buildDetails().has(buildId) || this.buildLoading().has(buildId)) {
      return;
    }
    this.buildLoading.update((current) => new Set(current).add(buildId));
    this.buildFailed.update((current) => withoutId(current, buildId));
    try {
      const detail = await firstValueFrom(this.api.get<BuildDetail>(`api/comps/builds/${buildId}`));
      this.buildDetails.update((current) => new Map(current).set(buildId, detail));
    } catch {
      this.buildFailed.update((current) => new Set(current).add(buildId));
    } finally {
      this.buildLoading.update((current) => withoutId(current, buildId));
    }
  }

  // ===========================================================================
  // Edit mode: quantities, add, remove
  // ===========================================================================

  protected async toggleEdit(): Promise<void> {
    if (this.editing()) {
      await this.flushAllQuantities();
      this.editing.set(false);
      return;
    }
    this.editing.set(true);
    this.tab.set('roster');
  }

  protected displayedQuantity(entry: CompBuildEntry): number {
    return this.pendingQuantity().get(entry.build_id) ?? entry.quantity;
  }

  /**
   * Steps a quantity. The number on screen changes at once; the save waits a moment so several
   * clicks in a row become one request.
   */
  protected step(entry: CompBuildEntry, delta: number): void {
    const next = Math.max(1, this.displayedQuantity(entry) + delta);
    if (next === this.displayedQuantity(entry)) {
      return;
    }
    this.pendingQuantity.update((current) => new Map(current).set(entry.build_id, next));
    const timer = this.quantityTimers.get(entry.build_id);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    this.quantityTimers.set(
      entry.build_id,
      setTimeout(() => void this.flushQuantity(entry.build_id), QUANTITY_SAVE_DELAY_MS),
    );
  }

  private async flushAllQuantities(): Promise<void> {
    for (const buildId of [...this.pendingQuantity().keys()]) {
      await this.flushQuantity(buildId);
    }
  }

  private async flushQuantity(buildId: number): Promise<void> {
    const comp = this.comp();
    const quantity = this.pendingQuantity().get(buildId);
    const timer = this.quantityTimers.get(buildId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.quantityTimers.delete(buildId);
    }
    if (!comp || quantity === undefined) {
      return;
    }
    this.saving.set(true);
    try {
      const updated = await firstValueFrom(
        this.api.patch<CompDetail>(`api/comps/${comp.id}/builds/${buildId}`, { quantity }),
      );
      this.comp.set(updated);
      this.toasts.success(this.t('comps.quantityUpdated'));
    } catch {
      this.toasts.error(this.t('compDetail.error.save'));
    } finally {
      this.pendingQuantity.update((current) => {
        const next = new Map(current);
        next.delete(buildId);
        return next;
      });
      this.saving.set(false);
    }
  }

  private clearQuantityTimers(): void {
    for (const timer of this.quantityTimers.values()) {
      clearTimeout(timer);
    }
    this.quantityTimers.clear();
  }

  protected openAdd(): void {
    if (!this.editing()) {
      this.editing.set(true);
    }
    this.tab.set('roster');
    this.addOpen.set(true);
  }

  protected async addBuild(addition: CompBuildAddition): Promise<void> {
    const comp = this.comp();
    if (!comp) {
      return;
    }
    this.saving.set(true);
    try {
      const updated = await firstValueFrom(
        this.api.post<CompDetail>(`api/comps/${comp.id}/builds`, {
          build_id: addition.build.id,
          quantity: addition.quantity,
        }),
      );
      this.comp.set(updated);
      this.toasts.success(this.t('comps.buildAdded'));
    } catch {
      this.toasts.error(this.t('compDetail.error.save'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async removeBuild(buildId: number): Promise<void> {
    const comp = this.comp();
    if (!comp) {
      return;
    }
    this.saving.set(true);
    try {
      await firstValueFrom(this.api.delete(`api/comps/${comp.id}/builds/${buildId}`));
      await this.load(this.compId(), true);
      this.toasts.success(this.t('comps.buildRemoved'));
    } catch {
      this.toasts.error(this.t('compDetail.error.save'));
    } finally {
      this.saving.set(false);
    }
  }

  // ===========================================================================
  // Parties and analytics helpers
  // ===========================================================================

  protected groupSeats(party: CompPartyView) {
    return groupPartySeats(party);
  }

  /** "Tank 4 · Healer 5 · DPS 11", plain text so role never relies on colour. */
  protected roleMixText(party: CompPartyView): string {
    return partyRoleMix(party)
      .map(({ role, count }) => `${this.t(roleLabelKey(role))} ${count}`)
      .join(' · ');
  }

  protected rolePercent(quantity: number): number {
    const total = this.comp()?.total_quantity ?? 0;
    return total > 0 ? Math.round((quantity / total) * 100) : 0;
  }

  protected opponentKey(opponent: OpponentPerformanceView): string {
    return opponent.guild_id ?? opponent.guild_name;
  }

  protected opponentWinRate(opponent: OpponentPerformanceView): number {
    return opponent.battles === 0 ? 0 : (opponent.wins / opponent.battles) * 100;
  }

  /** Win or loss against an opponent, stated as an icon and a hidden label as well as a colour. */
  protected outcome(opponent: OpponentPerformanceView): 'ahead' | 'behind' | 'even' {
    if (opponent.wins > opponent.losses) return 'ahead';
    if (opponent.wins < opponent.losses) return 'behind';
    return 'even';
  }

  protected outcomeLabel(opponent: OpponentPerformanceView): string {
    switch (this.outcome(opponent)) {
      case 'ahead':
        return this.t('compDetail.outcome.ahead');
      case 'behind':
        return this.t('compDetail.outcome.behind');
      default:
        return this.t('compDetail.outcome.even');
    }
  }

  // ===========================================================================
  // Formatting
  // ===========================================================================

  protected formatDate(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? value
      : new Intl.DateTimeFormat(this.translate.locale(), { dateStyle: 'medium' }).format(date);
  }

  protected formatNumber(value: number): string {
    return new Intl.NumberFormat(this.translate.locale()).format(value);
  }

  protected percentText(value: number): string {
    return `${Math.round(value)}%`;
  }

  protected formatRatio(value: number): string {
    return value.toFixed(2);
  }

  /** Comp/build prices arrive as `Decimal` strings from the backend; format them like silver. */
  protected formatSilver(value: number | string): string {
    const numeric = typeof value === 'string' ? Number(value) : value;
    if (Number.isNaN(numeric)) {
      return String(value);
    }
    return numeric.toLocaleString(this.translate.locale(), { maximumFractionDigits: 0 });
  }

  /**
   * A one-line performance summary, saying "no data" rather than implying a 0% win rate.
   *
   * A version with battles but none decided must not read as a loss either, hence the dash.
   */
  protected performanceSummary(report: CompPerformanceView | null): string {
    const stats = report?.stats;
    if (!stats || stats.total_battles === 0) {
      return this.t('comps.noBattleData');
    }
    const decided = stats.wins + stats.losses;
    return this.t('compDetail.compare.summary', {
      rate: decided === 0 ? '—' : `${Math.round((stats.wins / decided) * 100)}%`,
      kills: stats.total_kills,
      deaths: stats.total_deaths,
      battles: stats.total_battles,
    });
  }

  // ===========================================================================
  // Edit details dialog
  // ===========================================================================

  protected openEditMeta(): void {
    const current = this.comp();
    if (!current) return;
    this.editName.set(current.name);
    this.editCategoryId.set(current.category_id ? String(current.category_id) : '');
    this.editParentId.set(current.parent_id ? String(current.parent_id) : '');
    this.editDescription.set(current.description ?? '');
    this.editParentScope.set('mine');
    this.nameError.set(null);
    this.editMetaOpen.set(true);
    // The category and parent selects read `compCategories()` / `compSummaries()`, and only this
    // call fills them. Without it the dialog opens with nothing to switch to.
    void this.loadEditOptions();
  }

  protected closeEditMeta(): void {
    this.editMetaOpen.set(false);
  }

  protected onEditNameChange(event: Event): void {
    this.editName.set((event.target as HTMLInputElement).value);
    this.nameError.set(null);
  }

  protected onEditDescriptionChange(event: Event): void {
    this.editDescription.set((event.target as HTMLTextAreaElement).value);
  }

  /**
   * Options for these selects load asynchronously, so a `[value]` binding on the `<select>` is
   * applied while the list is still empty and the browser silently resets it. Marking the matching
   * `<option>` as selected instead keeps the current value visible once the options arrive.
   */
  protected isSelectedId(selected: string, id: number | null | undefined): boolean {
    return id != null && selected === String(id);
  }

  protected onEditCategoryChange(event: Event): void {
    this.editCategoryId.set((event.target as HTMLSelectElement).value);
  }

  protected onEditParentChange(event: Event): void {
    this.editParentId.set((event.target as HTMLSelectElement).value);
  }

  protected setEditParentScope(scope: OwnershipScope): void {
    if (this.editParentScope() === scope) {
      return;
    }
    this.editParentScope.set(scope);
    void this.loadEditOptions();
  }

  protected ownershipLabel(name: string, createdBy: string): string {
    return ownershipOptionLabel(name, createdBy, this.editParentScope());
  }

  /** The name rules, as translated messages: required, not too long, not already taken. */
  private validateName(name: string, current: string): string | null {
    const trimmed = name.trim();
    if (!trimmed) {
      return this.t('validation.required');
    }
    if (trimmed.length > MAX_NAME_LENGTH) {
      return this.t('compDetail.validation.nameLong', { max: MAX_NAME_LENGTH });
    }
    const lowered = trimmed.toLowerCase();
    const taken = this.compSummaries().some((summary) => {
      const existing = summary.name.trim().toLowerCase();
      return existing === lowered && existing !== current.trim().toLowerCase();
    });
    return taken ? this.t('compDetail.validation.nameTaken') : null;
  }

  protected async saveEdit(event: Event): Promise<void> {
    event.preventDefault();
    const comp = this.comp();
    if (!comp) {
      return;
    }

    const error = this.validateName(this.editName(), comp.name);
    this.nameError.set(error);
    if (error) {
      return;
    }

    const request: UpdateCompRequest = {};
    const name = this.editName().trim();
    if (name !== comp.name) request.name = name;
    // Compared against the current value rather than tested for truthiness, so an emptied
    // description actually clears instead of being dropped.
    if (this.editDescription() !== (comp.description ?? '')) {
      request.description = this.editDescription();
    }
    const categoryId = this.editCategoryId() ? Number(this.editCategoryId()) : undefined;
    if (categoryId && categoryId !== comp.category_id) request.category_id = categoryId;
    const parentId = this.editParentId() ? Number(this.editParentId()) : null;
    if ((parentId ?? null) !== (comp.parent_id ?? null)) {
      request.parent_id = parentId;
    }

    if (Object.keys(request).length === 0) {
      this.editMetaOpen.set(false);
      return;
    }

    this.saving.set(true);
    try {
      await firstValueFrom(this.api.patch<CompDetail>(`api/comps/${comp.id}`, request));
      this.editMetaOpen.set(false);
      await this.load(this.compId(), true);
      this.toasts.success(this.t('common.save'));
    } catch {
      this.toasts.error(this.t('compDetail.error.save'));
    } finally {
      this.saving.set(false);
    }
  }

  private async loadEditOptions(): Promise<void> {
    const [categories, summaries] = await Promise.all([
      firstValueFrom(this.api.get<CompCategoryView[]>('api/comps/comp-categories')).catch(() => []),
      firstValueFrom(
        this.api.get<PaginatedData<CompSummary>>('api/comps', {
          page: 1,
          limit: 500,
          sort: 'name',
          order: 'asc',
          ...ownershipListParams(this.editParentScope()),
        }),
      ).catch(() => ({ items: [] as CompSummary[] })),
    ]);
    this.compCategories.set(categories);
    this.compSummaries.set(summaries.items);
  }

  // ===========================================================================
  // Compare versions
  // ===========================================================================

  protected openCompare(): void {
    const versions = this.comp()?.versions ?? [];
    const other = versions.find((entry) => entry.id !== this.comp()?.id);
    this.comparing.set(true);
    if (other) {
      this.compareWithId.set(String(other.id));
      void this.loadComparison(other.id);
    }
  }

  protected closeCompare(): void {
    this.comparing.set(false);
    this.compareWith.set(null);
    this.comparePerformance.set(null);
  }

  protected onCompareTargetChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.compareWithId.set(value);
    void this.loadComparison(Number(value));
  }

  private async loadComparison(compId: number): Promise<void> {
    this.compareLoading.set(true);
    this.compareWith.set(null);
    try {
      const [detail, performance] = await Promise.all([
        firstValueFrom(this.api.get<CompDetail>(`api/comps/${compId}`)),
        firstValueFrom(this.api.get<CompPerformanceView>(`api/comps/${compId}/performance`)).catch(
          () => null,
        ),
      ]);
      // Discard if the user has since picked a different comparison target.
      if (Number(this.compareWithId()) !== compId) return;
      this.compareWith.set(detail);
      this.comparePerformance.set(performance);
    } catch {
      if (Number(this.compareWithId()) !== compId) return;
      this.toasts.error(this.t('compDetail.error.compare'));
    } finally {
      if (Number(this.compareWithId()) === compId) {
        this.compareLoading.set(false);
      }
    }
  }

  // ===========================================================================
  // Actions: version, clone, archive, share
  // ===========================================================================

  protected async createVersion(): Promise<void> {
    const comp = this.comp();
    if (!comp) {
      return;
    }
    this.saving.set(true);
    try {
      const created = await firstValueFrom(
        this.api.post<CompDetail>(`api/comps/${comp.id}/versions`, {}),
      );
      this.toasts.success(this.t('comps.versionCreated'));
      await this.router.navigate(['/comps', created.id]);
    } catch {
      this.toasts.error(this.t('compDetail.error.action'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async cloneComp(): Promise<void> {
    const comp = this.comp();
    if (!comp) {
      return;
    }
    this.saving.set(true);
    try {
      const request: CreateCompRequest = {
        name: this.t('compDetail.cloneName', { name: comp.name }),
        category_id: comp.category_id,
        builds: comp.builds.map((entry) => ({
          build_id: entry.build_id,
          quantity: entry.quantity,
        })),
      };
      const created = await firstValueFrom(this.api.post<CompDetail>('api/comps', request));
      this.toasts.success(this.t('comps.cloneSuccess'));
      await this.router.navigate(['/comps', created.id]);
    } catch {
      this.toasts.error(this.t('compDetail.error.action'));
    } finally {
      this.saving.set(false);
    }
  }

  protected closeArchiveConfirm(): void {
    this.pendingArchive.set(false);
  }

  /**
   * Archives the comp in place - unlike the old hard delete, this never fails on references, so
   * there's no blocking-reference branch to fall back to and no need to leave the page.
   */
  protected async confirmArchiveComp(): Promise<void> {
    const comp = this.comp();
    if (!comp) {
      return;
    }
    this.saving.set(true);
    try {
      await firstValueFrom(this.api.post(`api/comps/${comp.id}/archive`, {}));
      this.pendingArchive.set(false);
      this.toasts.success(this.t('comps.archiveSuccess'));
      await this.load(this.compId(), true);
    } catch {
      this.toasts.error(this.t('compDetail.error.action'));
    } finally {
      this.saving.set(false);
    }
  }

  /** Unarchiving is always safe - no dialog, one click, back into every picker. */
  protected async unarchiveComp(): Promise<void> {
    const comp = this.comp();
    if (!comp) {
      return;
    }
    this.saving.set(true);
    try {
      await firstValueFrom(this.api.post(`api/comps/${comp.id}/unarchive`, {}));
      this.toasts.success(this.t('comps.unarchiveSuccess'));
      await this.load(this.compId(), true);
    } catch {
      this.toasts.error(this.t('compDetail.error.action'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async shareWithAlliance(): Promise<void> {
    const comp = this.comp();
    if (!comp) {
      return;
    }
    this.saving.set(true);
    try {
      await firstValueFrom(
        this.api.post<AllianceShareStatus['share']>('api/alliance/shares', {
          type: 'comp',
          id: comp.id,
        }),
      );
      this.toasts.success(this.t('comps.shareCompSuccess'));
      await this.loadShareStatus(comp.id);
    } catch (error) {
      this.toasts.error(this.shareErrorMessage(error));
    } finally {
      this.saving.set(false);
    }
  }

  protected async unshareWithAlliance(): Promise<void> {
    const comp = this.comp();
    if (!comp) {
      return;
    }
    this.saving.set(true);
    try {
      await firstValueFrom(this.api.delete(`api/alliance/shares/comp/${comp.id}`));
      this.toasts.success(this.t('comps.unshareCompSuccess'));
      this.shareStatus.set({ shared: false });
    } catch (error) {
      this.toasts.error(this.shareErrorMessage(error));
    } finally {
      this.saving.set(false);
    }
  }

  /** Only the one conflict a person can act on gets its own message; the rest stay generic. */
  private shareErrorMessage(error: unknown): string {
    if (
      error instanceof ApiError &&
      error.status === 409 &&
      error.message === 'guild is not an active member of an alliance'
    ) {
      return this.t('comps.shareNoAlliance');
    }
    return this.t('compDetail.error.action');
  }

  private async loadShareStatus(compId: number): Promise<void> {
    if (!this.isGuildTenant()) {
      this.shareStatus.set(null);
      return;
    }
    try {
      const status = await firstValueFrom(
        this.api.get<AllianceShareStatus>(`api/alliance/shares/comp/${compId}`),
      );
      if (compId !== this.compId()) {
        return;
      }
      this.shareStatus.set(status);
    } catch {
      if (compId !== this.compId()) {
        return;
      }
      this.shareStatus.set({ shared: false });
    }
  }

  // ===========================================================================
  // Loading
  // ===========================================================================

  private resetForNewComp(): void {
    this.editing.set(false);
    this.addOpen.set(false);
    this.inspectedBuildId.set(null);
    this.expanded.set(new Set());
    this.pendingQuantity.set(new Map());
    this.clearQuantityTimers();
    this.comparing.set(false);
    this.parentComp.set(null);
    this.compPrice.set(null);
  }

  private async loadCompPrice(compId: number): Promise<void> {
    try {
      const price = await firstValueFrom(this.api.get<CompPriceView>(`api/comps/${compId}/price`));
      if (compId !== this.compId()) return;
      this.compPrice.set(price);
    } catch {
      if (compId !== this.compId()) return;
      this.compPrice.set(null);
    }
  }

  /**
   * Loads the composition and its performance.
   *
   * `silent` refreshes in place (after a remove, an archive, a save) without swapping the page for
   * the loading skeleton.
   */
  protected async load(compId: number, silent = false): Promise<void> {
    if (!Number.isFinite(compId) || compId <= 0) {
      this.comp.set(null);
      this.notFound.set(true);
      this.loading.set(false);
      return;
    }
    if (!silent) {
      this.loading.set(true);
    }
    this.loadFailed.set(false);
    this.notFound.set(false);
    try {
      const [comp, performance] = await Promise.all([
        firstValueFrom(this.api.get<CompDetail>(`api/comps/${compId}`)),
        firstValueFrom(this.api.get<CompPerformanceView>(`api/comps/${compId}/performance`)).catch(
          () => null,
        ),
      ]);
      // Discard if the page has since switched to a different version's comp id.
      if (compId !== this.compId()) return;
      this.comp.set(comp);
      this.performance.set(performance);
      void this.loadShareStatus(compId);
      void this.loadCompPrice(compId);
      if (comp.parent_id) {
        const parent = await firstValueFrom(
          this.api.get<CompSummary>(`api/comps/${comp.parent_id}`),
        ).catch(() => null);
        if (compId !== this.compId()) return;
        this.parentComp.set(parent);
      } else {
        this.parentComp.set(null);
      }
    } catch (error) {
      if (compId !== this.compId()) return;
      if (silent) {
        this.toasts.error(this.t('compDetail.error.action'));
      } else if (error instanceof ApiError && error.status === 404) {
        this.comp.set(null);
        this.notFound.set(true);
      } else {
        this.comp.set(null);
        this.loadFailed.set(true);
      }
    } finally {
      if (compId === this.compId()) {
        this.loading.set(false);
      }
    }
  }
}

/** A copy of `set` without `id`, for the immutable signal sets above. */
function withoutId(set: ReadonlySet<number>, id: number): Set<number> {
  const next = new Set(set);
  next.delete(id);
  return next;
}
