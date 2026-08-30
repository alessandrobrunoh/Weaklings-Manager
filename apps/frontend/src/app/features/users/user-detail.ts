import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  AdjustProgressionRequest,
  PaginatedData,
  ProgressionMeView,
  Role,
  UserProfile,
  WarnView,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Dialog } from '../../shared/components/dialog/dialog';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';

interface AdjustDraft {
  addXp: string;
  setLevel: string;
  setMultiplier: string;
  expiresAt: string;
  reason: string;
}

function emptyAdjustDraft(): AdjustDraft {
  return { addXp: '', setLevel: '', setMultiplier: '', expiresAt: '', reason: '' };
}

function asPaginated<T>(data: PaginatedData<T> | T[]): T[] {
  return Array.isArray(data) ? data : (data.items ?? []);
}

/**
 * View-first member page: profile and season XP, with an officer adjust form.
 *
 * The list no longer opens a drawer. Officers with `progression.adjust` enter
 * edit mode, confirm through `app-dialog`, and return to the view on save.
 */
@Component({
  selector: 'app-user-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Dialog, EmptyState, ErrorState, Loading, PageHeader, PageStack],
  template: `
    @if (loading()) {
      <app-loading [label]="t('common.loading')" />
    } @else if (loadFailed()) {
      <app-error-state [message]="t('common.error')" [retryLabel]="t('common.retry')" (retry)="load()" />
    } @else if (!member()) {
      <app-empty-state icon="users" [message]="t('users.detail.notFound')" />
    } @else if (member(); as user) {
      <app-page-header [title]="user.username" [subtitle]="user.email">
        <a class="btn btn--ghost" routerLink="/users">← {{ t('users.detail.back') }}</a>
        @if (canAdjust()) {
          <button type="button" class="btn btn--outline" (click)="toggleEditing()">
            {{ editing() ? t('common.close') : t('users.adjust.open') }}
          </button>
        }
      </app-page-header>

      <app-page-stack>
        <section class="card p-5">
          <h2 class="mb-3 text-base font-semibold">{{ t('users.detail.profile') }}</h2>
          <dl class="grid gap-3 sm:grid-cols-2 text-sm">
            <div>
              <dt style="color: var(--color-text-secondary)">{{ t('common.username') }}</dt>
              <dd class="font-semibold">{{ user.username }}</dd>
            </div>
            <div>
              <dt style="color: var(--color-text-secondary)">{{ t('common.email') }}</dt>
              <dd>{{ user.email }}</dd>
            </div>
            <div>
              <dt style="color: var(--color-text-secondary)">{{ t('common.role') }}</dt>
              <dd>
                <span class="chip" [class]="roleChip(user.role)">{{ user.role }}</span>
              </dd>
            </div>
          </dl>
        </section>

        <section class="card p-5">
          <h2 class="mb-3 text-base font-semibold">{{ t('profile.xp.title') }}</h2>
          @if (progression(); as xp) {
            <p class="text-sm" style="color: var(--color-text-secondary)">
              {{ t('profile.xp.season') }}: {{ xp.season?.name || t('profile.xp.noSeason') }}
            </p>
            <dl class="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4 text-sm">
              <div>
                <dt style="color: var(--color-text-secondary)">{{ t('users.level') }}</dt>
                <dd class="font-semibold">{{ xp.level }}</dd>
              </div>
              <div>
                <dt style="color: var(--color-text-secondary)">{{ t('users.xp') }}</dt>
                <dd class="font-semibold">{{ formatAmount(xp.xp) }}</dd>
              </div>
              <div>
                <dt style="color: var(--color-text-secondary)">{{ t('users.multiplier') }}</dt>
                <dd class="font-semibold">×{{ formatMultiplier(xp.multiplier) }}</dd>
              </div>
              <div>
                <dt style="color: var(--color-text-secondary)">{{ t('profile.xp.rank') }}</dt>
                <dd class="font-semibold">
                  {{ xp.rank != null ? '#' + xp.rank : t('profile.xp.unranked') }}
                </dd>
              </div>
            </dl>
          } @else {
            <p class="text-sm" style="color: var(--color-text-secondary)">{{ t('common.empty') }}</p>
          }
        </section>

        @if (editing()) {
          <form class="card grid gap-3 p-5" (submit)="onAdjustSubmit($event)">
            <h2 class="text-base font-semibold">{{ t('users.adjust.title') }}</h2>
            <p class="text-xs" style="color: var(--color-text-secondary)">
              {{ t('users.adjust.hint') }}
            </p>
            <label>
              <span class="label">{{ t('users.adjust.addXp') }}</span>
              <input
                class="input"
                type="number"
                [value]="draft().addXp"
                (input)="updateDraft('addXp', $event)"
              />
            </label>
            <label>
              <span class="label">{{ t('users.adjust.setLevel') }}</span>
              <input
                class="input"
                type="number"
                min="1"
                [value]="draft().setLevel"
                (input)="updateDraft('setLevel', $event)"
              />
            </label>
            <label>
              <span class="label">{{ t('users.adjust.setMultiplier') }}</span>
              <input
                class="input"
                type="number"
                min="0"
                max="5"
                step="0.1"
                [value]="draft().setMultiplier"
                (input)="updateDraft('setMultiplier', $event)"
              />
            </label>
            <label>
              <span class="label">{{ t('users.adjust.expires') }}</span>
              <input
                class="input"
                type="datetime-local"
                [value]="draft().expiresAt"
                (input)="updateDraft('expiresAt', $event)"
              />
            </label>
            <label>
              <span class="label">{{ t('users.adjust.reason') }}</span>
              <input
                class="input"
                required
                [value]="draft().reason"
                (input)="updateDraft('reason', $event)"
              />
            </label>
            <div class="flex justify-end gap-2">
              <button type="button" class="btn btn--ghost" (click)="toggleEditing()">
                {{ t('common.cancel') }}
              </button>
              <button type="submit" class="btn btn--primary" [disabled]="saving()">
                {{ t('users.adjust.submit') }}
              </button>
            </div>
          </form>
        }

        @if (canViewWarns()) {
          <section class="card p-5">
            <h2 class="mb-3 text-base font-semibold">{{ t('users.warns.title') }}</h2>
            @if (warns().length === 0) {
              <p class="text-sm" style="color: var(--color-text-secondary)">{{ t('common.empty') }}</p>
            } @else {
              <ul class="grid gap-2">
                @for (warn of warns(); track warn.id) {
                  <li class="surface p-3 text-sm">
                    <div class="flex items-center justify-between gap-2">
                      <span class="chip" [class]="severityChip(warn.severity)">{{ warn.severity }}</span>
                      @if (warn.revoked_at) {
                        <span class="chip">{{ t('warns.revoked') }}</span>
                      }
                    </div>
                    <p class="mt-2">{{ warn.reason }}</p>
                    <p class="mt-1 text-xs" style="color: var(--color-text-secondary)">
                      {{ formatDate(warn.created_at) }}
                    </p>
                  </li>
                }
              </ul>
            }
          </section>
        }
      </app-page-stack>
    }

    @if (confirmOpen()) {
      <app-dialog [title]="t('users.adjust.confirm')" (closed)="closeConfirm()">
        <p class="text-sm" style="color: var(--color-text-secondary)">
          {{ t('users.adjust.hint') }}
        </p>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="closeConfirm()">
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            class="btn btn--primary"
            (click)="confirmAdjust()"
            [disabled]="saving()"
          >
            {{ t('users.adjust.submit') }}
          </button>
        </div>
      </app-dialog>
    }
  `,
})
export class UserDetailPage {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly loading = signal(false);
  protected readonly loadFailed = signal(false);
  protected readonly saving = signal(false);
  protected readonly editing = signal(false);
  protected readonly confirmOpen = signal(false);
  protected readonly member = signal<UserProfile | null>(null);
  protected readonly progression = signal<ProgressionMeView | null>(null);
  protected readonly warns = signal<WarnView[]>([]);
  protected readonly draft = signal<AdjustDraft>(emptyAdjustDraft());
  private pendingBody: AdjustProgressionRequest | null = null;

  protected readonly canAdjust = computed(() => this.auth.hasPermission('progression.adjust'));
  protected readonly canViewWarns = computed(() => this.auth.hasPermission('warns.view'));

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.load();
  }

  protected roleChip(role: Role): string {
    if (role === 'SuperAdmin') {
      return 'chip chip--error';
    }
    if (role === 'Admin') {
      return 'chip chip--warning';
    }
    if (role === 'Officer') {
      return 'chip chip--success';
    }
    return 'chip';
  }

  protected severityChip(severity: WarnView['severity']): string {
    if (severity === 'strike') {
      return 'chip chip--error';
    }
    if (severity === 'warn') {
      return 'chip chip--warning';
    }
    return 'chip';
  }

  protected formatAmount(value: number): string {
    return new Intl.NumberFormat().format(value);
  }

  protected formatMultiplier(value: string | number): string {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      return String(value);
    }
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  protected formatDate(value: string): string {
    return new Date(value).toLocaleString();
  }

  protected toggleEditing(): void {
    if (!this.canAdjust()) {
      return;
    }
    this.editing.update((open) => !open);
    if (!this.editing()) {
      this.draft.set(emptyAdjustDraft());
      this.closeConfirm();
    }
  }

  protected updateDraft(field: keyof AdjustDraft, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.draft.update((current) => ({ ...current, [field]: value }));
  }

  protected closeConfirm(): void {
    this.confirmOpen.set(false);
    this.pendingBody = null;
  }

  protected onAdjustSubmit(event: Event): void {
    event.preventDefault();
    if (!this.canAdjust() || this.saving()) {
      return;
    }
    const member = this.member();
    if (!member) {
      return;
    }
    const draft = this.draft();
    const reason = draft.reason.trim();
    if (!reason) {
      this.toasts.error(this.t('validation.required'));
      return;
    }
    const body: AdjustProgressionRequest = { reason };
    if (draft.addXp.trim() !== '') {
      body.add_xp = Number(draft.addXp);
    }
    if (draft.setLevel.trim() !== '') {
      body.set_level = Number(draft.setLevel);
    }
    if (draft.setMultiplier.trim() !== '') {
      body.set_multiplier = Number(draft.setMultiplier);
    }
    if (draft.expiresAt.trim() !== '') {
      body.multiplier_expires_at = new Date(draft.expiresAt).toISOString();
    }
    if (
      body.add_xp === undefined &&
      body.set_level === undefined &&
      body.set_multiplier === undefined
    ) {
      this.toasts.error(this.t('users.adjust.hint'));
      return;
    }
    this.pendingBody = body;
    this.confirmOpen.set(true);
  }

  protected async confirmAdjust(): Promise<void> {
    const member = this.member();
    const body = this.pendingBody;
    if (!member || !body || this.saving()) {
      return;
    }
    this.saving.set(true);
    try {
      const updated = await firstValueFrom(
        this.api.post<ProgressionMeView>(`api/progression/users/${member.id}/adjust`, body),
      );
      this.progression.set(updated);
      this.draft.set(emptyAdjustDraft());
      this.editing.set(false);
      this.closeConfirm();
      this.toasts.success(this.t('users.adjust.success'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async load(): Promise<void> {
    const userId = Number(this.route.snapshot.paramMap.get('userId'));
    if (!Number.isFinite(userId) || userId <= 0) {
      this.member.set(null);
      return;
    }
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const member = await firstValueFrom(this.api.get<UserProfile>(`api/users/${userId}`));
      this.member.set(member);

      const xp = await firstValueFrom(
        this.api.get<ProgressionMeView>(`api/progression/users/${userId}`),
      ).catch(() => null);
      this.progression.set(xp);

      if (this.canViewWarns()) {
        const warns = await firstValueFrom(
          this.api.get<PaginatedData<WarnView> | WarnView[]>('api/warns', {
            user_id: userId,
            page: 1,
            limit: 50,
          }),
        ).catch((): WarnView[] => []);
        this.warns.set(asPaginated(warns));
      }
    } catch (error) {
      this.member.set(null);
      this.loadFailed.set(true);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }
}
