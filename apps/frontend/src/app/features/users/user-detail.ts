import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { DatePipe } from '@angular/common';
import { firstValueFrom } from 'rxjs';

import type {
  AdjustProgressionRequest,
  AlbionGuildMember,
  AlbionLinkStatus,
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
import { Icon } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { StatCard } from '../../shared/components/stat-card/stat-card';
import { TooltipDirective } from '../../shared/directives/tooltip.directive';

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
 * Admin and officer member detail page.
 *
 * Provides full management of the user's role, season XP adjustments, discipline
 * records (warns), and administrative Albion Online character link management.
 */
@Component({
  selector: 'app-user-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    Dialog,
    EmptyState,
    ErrorState,
    Icon,
    Loading,
    PageHeader,
    PageStack,
    RouterLink,
    StatCard,
    TooltipDirective,
  ],
  template: `
    @if (loading()) {
      <div class="p-8 flex justify-center">
        <app-loading [label]="t('common.loading')" />
      </div>
    } @else if (loadFailed()) {
      <app-error-state [message]="t('common.error')" [retryLabel]="t('common.retry')" (retry)="load()" />
    } @else if (!member()) {
      <app-empty-state icon="users" [message]="t('users.detail.notFound')" />
    } @else if (member(); as user) {
      <app-page-header [title]="user.username" [subtitle]="user.email">
        <a
          class="btn btn--ghost btn--sm flex items-center gap-1.5"
          routerLink="/users"
          [appTooltip]="'Torna all\\'elenco utenti'"
          tooltipPosition="bottom"
        >
          <app-icon name="chevron-left" size="0.875rem" />
          {{ t('users.detail.back') }}
        </a>

        @if (canAdjust()) {
          <button
            type="button"
            class="btn btn--outline btn--sm flex items-center gap-1.5"
            (click)="toggleEditing()"
            [appTooltip]="'Modifica livello o XP della stagione'"
            tooltipPosition="bottom"
          >
            <app-icon name="sparkles" size="0.875rem" />
            {{ editing() ? t('common.close') : t('users.adjust.open') }}
          </button>
        }
      </app-page-header>

      <app-page-stack>
        <!-- User Profile Hero -->
        <section class="card p-6">
          <div class="flex flex-wrap items-center justify-between gap-4">
            <div class="flex items-center gap-4">
              <div
                class="flex h-16 w-16 items-center justify-center rounded-2xl font-bold text-xl select-none"
                style="background: var(--color-primary-soft); color: var(--color-primary); border: 1px solid var(--color-border)"
              >
                {{ getInitials(user.username) }}
              </div>
              <div>
                <div class="flex items-center gap-2">
                  <h1 class="text-xl font-bold tracking-tight" style="color: var(--color-text)">
                    {{ user.username }}
                  </h1>
                  <span class="chip" [class]="roleChip(user.role)">{{ user.role }}</span>
                </div>
                <p class="text-sm mt-0.5" style="color: var(--color-text-secondary)">
                  {{ user.email || 'Nessuna email registrata' }} · ID #{{ user.id }}
                </p>
              </div>
            </div>

            <!-- Albion Character Link Badge -->
            <div
              class="flex items-center gap-3 rounded-xl p-3 border"
              style="background: var(--color-surface-2); border-color: var(--color-border)"
            >
              <div class="flex items-center gap-2">
                <span
                  class="h-2.5 w-2.5 rounded-full"
                  [style.background]="albionLink()?.linked ? 'var(--color-success)' : 'var(--color-warning)'"
                ></span>
                <div>
                  <p class="text-xs uppercase tracking-wider font-semibold" style="color: var(--color-text-secondary)">
                    Albion Online Link
                  </p>
                  <p class="text-sm font-semibold mono" style="color: var(--color-text)">
                    {{ albionLink()?.linked ? albionLink()?.albion_player_name : 'Non collegato' }}
                  </p>
                </div>
              </div>

              @if (canManageLinks()) {
                <div class="flex items-center gap-1.5 ml-2">
                  @if (albionLink()?.linked) {
                    <button
                      type="button"
                      class="btn btn--outline btn--sm text-xs py-1 px-2.5"
                      (click)="askUnlink()"
                      [appTooltip]="'Scollega il personaggio Albion da questo utente'"
                      tooltipPosition="top"
                    >
                      Scollega
                    </button>
                  }
                  <button
                    type="button"
                    class="btn btn--primary btn--sm text-xs py-1 px-2.5 flex items-center gap-1"
                    (click)="openLinkDialog()"
                    [appTooltip]="albionLink()?.linked ? 'Modifica personaggio collegato' : 'Collega personaggio del roster'"
                    tooltipPosition="top"
                  >
                    <app-icon name="plus" size="0.75rem" />
                    {{ albionLink()?.linked ? 'Cambia' : 'Collega' }}
                  </button>
                </div>
              }
            </div>
          </div>
        </section>

        <!-- KPI Strip for Member -->
        <section class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Member KPIs">
          <app-stat-card
            label="Livello Stagione"
            [value]="progression()?.level ?? 1"
            icon="trophy"
            tone="primary"
          />
          <app-stat-card
            label="XP Stagione"
            [value]="formatAmount(progression()?.xp ?? 0)"
            icon="sparkles"
            tone="neutral"
          />
          <app-stat-card
            label="Moltiplicatore XP"
            [value]="'×' + formatMultiplier(progression()?.multiplier ?? 1)"
            icon="activity"
            tone="warning"
          />
          <app-stat-card
            label="Rank Gilda"
            [value]="progression()?.rank != null ? '#' + progression()?.rank : 'N/A'"
            icon="shield"
            tone="success"
          />
        </section>

        <!-- Adjust Progression Form (if active) -->
        @if (editing()) {
          <form class="card grid gap-4 p-6 border-primary" (submit)="onAdjustSubmit($event)">
            <div>
              <h2 class="text-base font-semibold" style="color: var(--color-text)">
                {{ t('users.adjust.title') }}
              </h2>
              <p class="text-xs mt-1" style="color: var(--color-text-secondary)">
                {{ t('users.adjust.hint') }}
              </p>
            </div>

            <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <label class="block">
                <span class="label text-xs mb-1 block">{{ t('users.adjust.addXp') }}</span>
                <input
                  class="input w-full"
                  type="number"
                  placeholder="+500 o -200"
                  [value]="draft().addXp"
                  (input)="updateDraft('addXp', $event)"
                />
              </label>
              <label class="block">
                <span class="label text-xs mb-1 block">{{ t('users.adjust.setLevel') }}</span>
                <input
                  class="input w-full"
                  type="number"
                  min="1"
                  placeholder="Es. 10"
                  [value]="draft().setLevel"
                  (input)="updateDraft('setLevel', $event)"
                />
              </label>
              <label class="block">
                <span class="label text-xs mb-1 block">{{ t('users.adjust.setMultiplier') }}</span>
                <input
                  class="input w-full"
                  type="number"
                  min="0"
                  max="5"
                  step="0.1"
                  placeholder="Es. 1.5"
                  [value]="draft().setMultiplier"
                  (input)="updateDraft('setMultiplier', $event)"
                />
              </label>
              <label class="block">
                <span class="label text-xs mb-1 block">{{ t('users.adjust.expires') }}</span>
                <input
                  class="input w-full"
                  type="datetime-local"
                  [value]="draft().expiresAt"
                  (input)="updateDraft('expiresAt', $event)"
                />
              </label>
            </div>

            <label class="block">
              <span class="label text-xs mb-1 block">{{ t('users.adjust.reason') }} *</span>
              <input
                class="input w-full"
                required
                placeholder="Motivazione per il registro di audit"
                [value]="draft().reason"
                (input)="updateDraft('reason', $event)"
              />
            </label>

            <div class="flex justify-end gap-2 pt-2 border-t" style="border-color: var(--color-border)">
              <button type="button" class="btn btn--ghost btn--sm" (click)="toggleEditing()">
                {{ t('common.cancel') }}
              </button>
              <button type="submit" class="btn btn--primary btn--sm" [disabled]="saving()">
                {{ t('users.adjust.submit') }}
              </button>
            </div>
          </form>
        }

        <!-- Warns Section -->
        @if (canViewWarns()) {
          <section class="card p-6">
            <div class="flex items-center justify-between mb-4">
              <h2 class="text-base font-semibold" style="color: var(--color-text)">
                {{ t('users.warns.title') }}
              </h2>
              <span class="chip font-mono text-xs">{{ warns().length }} infrazioni</span>
            </div>

            @if (warns().length === 0) {
              <div class="p-6 text-center rounded-xl border" style="background: var(--color-surface-2); border-color: var(--color-border)">
                <p class="text-sm" style="color: var(--color-text-secondary)">
                  Nessun warn o sanzione registrata per questo membro.
                </p>
              </div>
            } @else {
              <ul class="grid gap-2.5">
                @for (warn of warns(); track warn.id) {
                  <li
                    class="rounded-xl p-3.5 border text-sm transition-colors"
                    style="background: var(--color-surface-2); border-color: var(--color-border)"
                  >
                    <div class="flex items-center justify-between gap-2">
                      <span class="chip" [class]="severityChip(warn.severity)">{{ warn.severity }}</span>
                      @if (warn.revoked_at) {
                        <span class="chip chip--neutral text-xs">{{ t('warns.revoked') }}</span>
                      }
                    </div>
                    <p class="mt-2 font-medium" style="color: var(--color-text)">{{ warn.reason }}</p>
                    <p class="mt-1 text-xs" style="color: var(--color-text-secondary)">
                      Registrato il {{ formatDate(warn.created_at) }}
                    </p>
                  </li>
                }
              </ul>
            }
          </section>
        }
      </app-page-stack>
    }

    <!-- Adjust Progression Confirmation Dialog -->
    @if (confirmOpen()) {
      <app-dialog [title]="t('users.adjust.confirm')" (closed)="closeConfirm()">
        <p class="text-sm" style="color: var(--color-text-secondary)">
          {{ t('users.adjust.hint') }}
        </p>
        <div dialogFooter class="flex justify-end gap-2">
          <button type="button" class="btn btn--ghost btn--sm" (click)="closeConfirm()">
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            class="btn btn--primary btn--sm"
            (click)="confirmAdjust()"
            [disabled]="saving()"
          >
            {{ t('users.adjust.submit') }}
          </button>
        </div>
      </app-dialog>
    }

    <!-- Admin Link Albion Character Dialog -->
    @if (linkDialogOpen()) {
      <app-dialog title="Collega Personaggio Albion" (closed)="closeLinkDialog()">
        <div class="grid gap-3">
          <p class="text-xs" style="color: var(--color-text-secondary)">
            Cerca e seleziona un membro del roster attuale della gilda per collegarlo all'account di {{ member()?.username }}.
          </p>

          <input
            type="search"
            class="input w-full"
            placeholder="Cerca nome giocatore nel roster..."
            [value]="rosterSearch()"
            (input)="onRosterSearchInput($event)"
            autofocus
          />

          @if (rosterLoading()) {
            <div class="p-6 flex justify-center">
              <app-loading label="Caricamento roster di gilda..." />
            </div>
          } @else {
            <div class="max-h-64 overflow-y-auto grid gap-1.5 pr-1">
              @for (player of filteredRoster(); track player.id) {
                <button
                  type="button"
                  class="flex items-center justify-between p-2.5 rounded-xl border text-left transition-colors hover:border-primary hover:bg-surface-2"
                  style="border-color: var(--color-border); background: var(--color-surface-1)"
                  (click)="confirmLink(player)"
                  [disabled]="savingLink()"
                >
                  <div>
                    <p class="text-sm font-semibold mono" style="color: var(--color-text)">
                      {{ player.name }}
                    </p>
                    <p class="text-xs" style="color: var(--color-text-secondary)">
                      ID: {{ player.id }}
                    </p>
                  </div>
                  <span class="btn btn--tonal btn--sm text-xs py-1 px-2.5">
                    Collega
                  </span>
                </button>
              } @empty {
                <p class="text-sm text-center py-4" style="color: var(--color-text-secondary)">
                  Nessun giocatore trovato nel roster con questo nome.
                </p>
              }
            </div>
          }
        </div>

        <div dialogFooter class="flex justify-end gap-2">
          <button type="button" class="btn btn--ghost btn--sm" (click)="closeLinkDialog()">
            {{ t('common.cancel') }}
          </button>
        </div>
      </app-dialog>
    }

    <!-- Admin Unlink Albion Character Dialog -->
    @if (unlinkConfirmOpen()) {
      <app-dialog title="Scollega Personaggio Albion" (closed)="unlinkConfirmOpen.set(false)">
        <p class="text-sm" style="color: var(--color-text-secondary)">
          Sei sicuro di voler scollegare il personaggio <strong>{{ albionLink()?.albion_player_name }}</strong> dall'utente <strong>{{ member()?.username }}</strong>?
        </p>
        <div dialogFooter class="flex justify-end gap-2">
          <button type="button" class="btn btn--ghost btn--sm" (click)="unlinkConfirmOpen.set(false)">
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            class="btn btn--outline btn--sm text-red-400 border-red-500/30 hover:bg-red-500/10"
            (click)="confirmUnlink()"
            [disabled]="savingLink()"
          >
            Conferma Scollegamento
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
  protected readonly albionLink = signal<AlbionLinkStatus | null>(null);
  protected readonly draft = signal<AdjustDraft>(emptyAdjustDraft());

  // Albion Link Management State
  protected readonly linkDialogOpen = signal(false);
  protected readonly unlinkConfirmOpen = signal(false);
  protected readonly rosterLoading = signal(false);
  protected readonly savingLink = signal(false);
  protected readonly rosterSearch = signal('');
  protected readonly rosterMembers = signal<AlbionGuildMember[]>([]);

  private pendingBody: AdjustProgressionRequest | null = null;

  protected readonly canAdjust = computed(() => this.auth.hasPermission('progression.adjust'));
  protected readonly canViewWarns = computed(() => this.auth.hasPermission('warns.view'));
  protected readonly canManageLinks = computed(
    () =>
      this.auth.hasPermission('roles.manage') ||
      this.auth.hasPermission('admin.settings.manage'),
  );

  protected readonly filteredRoster = computed(() => {
    const q = this.rosterSearch().toLowerCase().trim();
    if (!q) return this.rosterMembers().slice(0, 30);
    return this.rosterMembers()
      .filter((m) => m.name.toLowerCase().includes(q))
      .slice(0, 30);
  });

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.load();
  }

  protected getInitials(username: string): string {
    if (!username) return '?';
    return username.slice(0, 2).toUpperCase();
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

  protected async openLinkDialog(): Promise<void> {
    this.linkDialogOpen.set(true);
    this.rosterSearch.set('');
    if (this.rosterMembers().length === 0) {
      this.rosterLoading.set(true);
      try {
        const roster = await firstValueFrom(
          this.api.get<PaginatedData<AlbionGuildMember> | AlbionGuildMember[]>('api/albion/guild/roster'),
        );
        this.rosterMembers.set(asPaginated(roster));
      } catch {
        this.toasts.error('Impossibile caricare il roster di gilda da Albion');
      } finally {
        this.rosterLoading.set(false);
      }
    }
  }

  protected closeLinkDialog(): void {
    this.linkDialogOpen.set(false);
    this.rosterSearch.set('');
  }

  protected onRosterSearchInput(event: Event): void {
    this.rosterSearch.set((event.target as HTMLInputElement).value);
  }

  protected async confirmLink(player: AlbionGuildMember): Promise<void> {
    const member = this.member();
    if (!member || this.savingLink()) return;

    this.savingLink.set(true);
    try {
      const linkStatus = await firstValueFrom(
        this.api.post<AlbionLinkStatus>(`api/albion/link/users/${member.id}`, {
          albion_player_id: player.id,
          albion_player_name: player.name,
        }),
      );
      this.albionLink.set(linkStatus);
      this.closeLinkDialog();
      this.toasts.success(`Personaggio ${player.name} collegato a ${member.username}`);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : 'Errore durante il collegamento');
    } finally {
      this.savingLink.set(false);
    }
  }

  protected askUnlink(): void {
    this.unlinkConfirmOpen.set(true);
  }

  protected async confirmUnlink(): Promise<void> {
    const member = this.member();
    if (!member || this.savingLink()) return;

    this.savingLink.set(true);
    try {
      await firstValueFrom(this.api.delete<void>(`api/albion/link/users/${member.id}`));
      this.albionLink.set(null);
      this.unlinkConfirmOpen.set(false);
      this.toasts.success('Personaggio scollegato con successo');
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : 'Errore durante lo scollegamento');
    } finally {
      this.savingLink.set(false);
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

      const [xp, link] = await Promise.all([
        firstValueFrom(this.api.get<ProgressionMeView>(`api/progression/users/${userId}`)).catch(
          () => null,
        ),
        firstValueFrom(this.api.get<AlbionLinkStatus>(`api/albion/link/users/${userId}`)).catch(
          () => null,
        ),
      ]);
      this.progression.set(xp);
      this.albionLink.set(link);

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
