import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
  viewChild,
  type OnInit,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { BuildCategoryView, CompCategoryView, CompSummary } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Icon } from '../../shared/components/icon/icon';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { ViewToggle, type ViewToggleOption } from '../../shared/components/view-toggle/view-toggle';
import { BuildCreateDialog } from './build-create-dialog';
import { BuildsList } from './builds-list';
import { CompCategories } from './comp-categories';
import { CompCreateDialog } from './comp-create-dialog';
import { CompsList } from './comps-list';

type TabId = 'list' | 'categories';

/**
 * Compositions and builds workspace: the page shell both `/comps` and `/builds` render.
 *
 * It owns what the two tabs share: the header (refresh, the create action of the current tab), the
 * category lists (they feed the filters and the create flows) and the open create dialog. The
 * list itself lives in `CompsList` or `BuildsList`, the categories table in `CompCategories`, and
 * the create flows in `CompCreateDialog` and `BuildCreateDialog`.
 *
 * The lists stay mounted (only hidden) when the Categories tab is open, so filters and scroll
 * survive a visit to the other tab.
 */
@Component({
  selector: 'app-comps',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    BuildCreateDialog,
    BuildsList,
    CompCategories,
    CompCreateDialog,
    CompsList,
    Icon,
    PageHeader,
    PageStack,
    ViewToggle,
  ],
  styles: `
    :host {
      display: block;
      color: var(--color-text);
    }
  `,
  template: `
    <app-page-header
      [title]="page() === 'builds' ? t('comps.builds') : t('comps.title')"
      [subtitle]="t('comps.subtitle')"
    >
      <button
        type="button"
        class="btn btn--outline btn--sm"
        [disabled]="categoriesLoading()"
        (click)="refreshNow()"
      >
        <app-icon name="refresh" size="0.875rem" />
        {{ t('common.refreshNow') }}
      </button>

      @if (canCreateCurrent()) {
        <button type="button" class="btn btn--primary btn--sm" (click)="openCreate()">
          <app-icon name="plus" size="0.875rem" />
          {{ createButtonLabel() }}
        </button>
      }
      <app-view-toggle
        pageTabs
        [options]="tabOptions()"
        [active]="tab()"
        (activeChange)="switchTab($event)"
      />
    </app-page-header>

    <app-page-stack>
      <div [hidden]="tab() !== 'list'">
        @if (page() === 'comps') {
          <app-comps-list
            [categories]="compCategories()"
            (createRequested)="openCreate()"
            (variantRequested)="openVariant($event)"
          />
        } @else {
          <app-builds-list [categories]="buildCategories()" (createRequested)="openCreate()" />
        }
      </div>
      <div [hidden]="tab() !== 'categories'">
        <app-comp-categories
          [kind]="page() === 'builds' ? 'build' : 'comp'"
          [categories]="page() === 'builds' ? buildCategories() : compCategories()"
          [loading]="categoriesLoading()"
          [failed]="categoriesFailed()"
          (changed)="loadCategories()"
          (retry)="loadCategories()"
        />
      </div>
    </app-page-stack>

    @if (createOpen()) {
      @if (page() === 'comps') {
        <app-comp-create-dialog
          [categories]="compCategories()"
          [parent]="variantParent()"
          (created)="onCreated()"
          (closed)="closeCreate()"
        />
      } @else {
        <app-build-create-dialog
          [categories]="buildCategories()"
          (created)="onCreated()"
          (closed)="closeCreate()"
        />
      }
    }
  `,
})
export class Comps implements OnInit {
  /** Which workspace is exposed by the route: compositions or builds. */
  readonly page = input<'comps' | 'builds'>('comps');

  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly translate = inject(TranslateService);

  private readonly compsList = viewChild(CompsList);
  private readonly buildsList = viewChild(BuildsList);
  private readonly categoriesTab = viewChild(CompCategories);

  protected readonly tab = signal<TabId>('list');
  protected readonly createOpen = signal(false);
  /** Set when the create dialog opens as "New variant of this composition". */
  protected readonly variantParent = signal<CompSummary | null>(null);
  protected readonly categoriesLoading = signal(true);
  protected readonly categoriesFailed = signal(false);
  protected readonly buildCategories = signal<readonly BuildCategoryView[]>([]);
  protected readonly compCategories = signal<readonly CompCategoryView[]>([]);

  protected readonly tabOptions = computed<ViewToggleOption[]>(() =>
    this.page() === 'comps'
      ? [
          { id: 'list', label: this.t('comps.comps') },
          { id: 'categories', label: this.t('comps.compCategories') },
        ]
      : [
          { id: 'list', label: this.t('comps.builds') },
          { id: 'categories', label: this.t('comps.buildCategories') },
        ],
  );

  protected readonly canCreateCurrent = computed(() => {
    const builds = this.page() === 'builds';
    if (this.tab() === 'categories') {
      return this.auth.hasPermission(
        builds ? 'comps.build_categories.create' : 'comps.comp_categories.create',
      );
    }
    return this.auth.hasPermission(builds ? 'comps.builds.create' : 'comps.comps.create');
  });

  ngOnInit(): void {
    // The route input is only known now, and it decides which category list to fetch.
    void this.loadCategories();
  }

  protected createButtonLabel(): string {
    if (this.tab() === 'categories') {
      return this.t('comps.createCategory');
    }
    return this.t(this.page() === 'builds' ? 'comps.createBuild' : 'comps.createComp');
  }

  protected switchTab(next: string): void {
    if (next === 'list' || next === 'categories') {
      this.tab.set(next);
    }
  }

  protected openCreate(): void {
    if (this.tab() === 'categories') {
      this.categoriesTab()?.openCreate();
      return;
    }
    this.variantParent.set(null);
    this.createOpen.set(true);
  }

  protected openVariant(parent: CompSummary): void {
    this.variantParent.set(parent);
    this.createOpen.set(true);
  }

  protected closeCreate(): void {
    this.createOpen.set(false);
    this.variantParent.set(null);
  }

  protected onCreated(): void {
    this.closeCreate();
    void (this.page() === 'comps' ? this.compsList()?.reload() : this.buildsList()?.reload());
  }

  protected async refreshNow(): Promise<void> {
    await Promise.all([
      this.loadCategories(),
      this.page() === 'comps' ? this.compsList()?.reload() : this.buildsList()?.reload(),
    ]);
  }

  protected async loadCategories(): Promise<void> {
    this.categoriesLoading.set(true);
    this.categoriesFailed.set(false);
    try {
      if (this.page() === 'builds') {
        this.buildCategories.set(
          await firstValueFrom(this.api.get<BuildCategoryView[]>('api/comps/build-categories')),
        );
      } else {
        this.compCategories.set(
          await firstValueFrom(this.api.get<CompCategoryView[]>('api/comps/comp-categories')),
        );
      }
    } catch {
      this.categoriesFailed.set(true);
    } finally {
      this.categoriesLoading.set(false);
    }
  }

  protected readonly t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);
}
