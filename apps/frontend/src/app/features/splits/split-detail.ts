import { NgTemplateOutlet } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  signal,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  EventView,
  PaginatedData,
  SplitDetail,
  SplitIsland,
  SplitIslandCity,
  SplitParticipant,
  TransactionStatus,
  TransactionView,
  UpdateSplitRequest,
  UpdateTransactionRequest,
  UserProfile,
} from '../../core/models/api.models';
import { ApiError, ApiService } from '../../core/services/api.service';

interface AllianceShareStatus {
  shared: boolean;
  share?: {
    published_id: number;
    shared_at: string;
  };
}
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Dialog } from '../../shared/components/dialog/dialog';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Icon, type IconName } from '../../shared/components/icon/icon';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import {
  SearchDialog,
  type SearchDialogOption,
} from '../../shared/components/search-dialog/search-dialog';
import {
  evenParticipantWeight,
  participantWeightsAreValid,
  redistributeWeights,
  upgradeLegacyUnitShares,
} from './splits';
import { canActOnSplit } from './split-access';

type DetailMode = 'view' | 'edit';
type StatusTone = 'warning' | 'success' | 'neutral' | 'error';
type PrimaryAction = 'complete' | 'edit' | 'unarchive' | null;
type CloseAction = 'not-completed' | 'lost';
type PayoutKind = 'paid' | 'donated' | 'requested' | 'pending' | 'none';
type ParticipantSortKey = 'username' | 'amount' | 'weight';

interface ParticipantSort {
  readonly key: ParticipantSortKey;
  readonly direction: 'asc' | 'desc';
}

/** One participant as shown in the read-only table. */
interface ParticipantRow {
  readonly user_id: number;
  readonly username: string;
  readonly weight: number;
  /** Weight as a percentage of the total weight of every participant. */
  readonly poolPct: number;
  readonly amount: number;
  readonly payout: PayoutKind;
}

/** Money flow from loot value to the amount shared out, all in silver. */
interface Ledger {
  readonly estimated: number;
  readonly bags: number;
  readonly bagList: readonly number[];
  readonly repair: number;
  readonly subtotal: number;
  readonly feePct: number;
  readonly feeAmount: number;
  readonly net: number;
}

interface Presentation {
  readonly label: TranslationKey;
  readonly icon: IconName;
  readonly tone: StatusTone;
}

const DEFAULT_SPLIT_FEE = 20;

interface SplitBagDraft {
  readonly key: number;
  amount: number;
}

let nextSplitBagKey = 1;

function newSplitBag(amount = 0): SplitBagDraft {
  return { key: nextSplitBagKey++, amount };
}

function bagsFromDetail(detail: SplitDetail): SplitBagDraft[] {
  const listed = (detail.bags ?? []).map((amount) => Number(amount) || 0).filter((amount) => amount > 0);
  if (listed.length > 0) {
    return listed.map((amount) => newSplitBag(amount));
  }
  const total = Number(detail.bags_value) || 0;
  return total > 0 ? [newSplitBag(total)] : [];
}

function parsePercentageInput(raw: string): number | null {
  const normalized = raw.trim().replace(/%\s*$/, '').replace(',', '.');
  if (!normalized || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) {
    return null;
  }
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function buildLedger(
  estimated: number,
  bags: number,
  bagList: readonly number[],
  repair: number,
  feePct: number,
  netOverride: number | null,
): Ledger {
  const subtotal = estimated - repair + bags;
  const net = netOverride ?? Math.max(0, subtotal * (1 - feePct / 100));
  // Derived from the net so the lines always add up to the amount that is shared out.
  const feeAmount = Math.max(0, subtotal - net);
  return { estimated, bags, bagList, repair, subtotal, feePct, feeAmount, net };
}

const STATUS_ICONS: Readonly<Record<string, IconName>> = {
  pending: 'circle-dot',
  awaiting_event: 'calendar',
  completed: 'check',
  not_completed: 'lock',
  lost: 'close',
};

const PAYOUT_PRESENTATION: Readonly<Record<PayoutKind, Presentation>> = {
  paid: { label: 'bank.status.withdrawn', icon: 'check', tone: 'success' },
  donated: { label: 'bank.status.donated', icon: 'check', tone: 'success' },
  requested: { label: 'bank.status.requested', icon: 'bank', tone: 'warning' },
  pending: { label: 'bank.status.pending', icon: 'circle-dot', tone: 'warning' },
  none: { label: 'splits.detail.payout.none', icon: 'circle-dot', tone: 'neutral' },
};

const TRANSACTION_PRESENTATION: Readonly<Record<TransactionStatus, Presentation>> = {
  pending: { label: 'bank.status.pending', icon: 'circle-dot', tone: 'warning' },
  requested: { label: 'bank.status.requested', icon: 'bank', tone: 'warning' },
  rejected: { label: 'bank.status.rejected', icon: 'close', tone: 'error' },
  withdrawn: { label: 'bank.status.withdrawn', icon: 'check', tone: 'success' },
  donated: { label: 'bank.status.donated', icon: 'check', tone: 'success' },
};

/**
 * Split detail page: what the split is, how the money flows from loot to net, who gets what
 * and whether they were paid, plus the one next action for the current state. Officers switch
 * to edit mode while the split can still change.
 */
@Component({
  selector: 'app-split-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    Dialog,
    EmptyState,
    ErrorState,
    Icon,
    NgTemplateOutlet,
    PageHeader,
    PageStack,
    RouterLink,
    SearchDialog,
  ],
  host: {
    '(document:pointerdown)': 'onDocumentPointer($event)',
  },
  templateUrl: './split-detail.html',
  styleUrl: './split-detail.css',
})
export class SplitDetailPage {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly menuRoot = viewChild<ElementRef<HTMLElement>>('menuRoot');

  protected readonly split = signal<SplitDetail | null>(null);
  protected readonly loading = signal(false);
  protected readonly loadFailed = signal(false);
  protected readonly notFound = signal(false);
  protected readonly saving = signal(false);
  protected readonly mode = signal<DetailMode>('view');
  protected readonly menuOpen = signal(false);
  protected readonly showArchive = signal(false);
  protected readonly showCompleteConfirmDialog = signal(false);
  protected readonly closeConfirm = signal<CloseAction | null>(null);
  protected readonly islands = signal<SplitIsland[]>([]);

  protected readonly participantSort = signal<ParticipantSort | null>(null);

  protected readonly submitted = signal(false);
  protected readonly editNote = signal('');
  protected readonly editEstimated = signal(0);
  protected readonly editFeeInput = signal(String(DEFAULT_SPLIT_FEE));
  protected readonly editRepair = signal(0);
  protected readonly editBagRows = signal<SplitBagDraft[]>([]);
  protected readonly editBags = computed(() =>
    this.editBagRows().reduce((sum, bag) => sum + (Number(bag.amount) || 0), 0),
  );
  protected readonly editEventId = signal<number | null>(null);
  protected readonly editEventTitle = signal('');
  protected readonly editIslandId = signal('');
  protected readonly editTabId = signal('');
  protected readonly editParticipants = signal<SplitParticipant[]>([]);
  protected readonly editWeightInputs = signal<Record<number, string>>({});

  protected readonly showEventSearch = signal(false);
  protected readonly eventSearchOptions = signal<SearchDialogOption[]>([]);
  protected readonly eventSearchLoading = signal(false);
  protected readonly showParticipantSearch = signal(false);
  protected readonly participantSearchOptions = signal<SearchDialogOption[]>([]);
  protected readonly searchingRoster = signal(false);

  protected readonly splitTransactions = signal<TransactionView[]>([]);
  protected readonly transactionsLoading = signal(false);
  protected readonly transactionsLoadFailed = signal(false);
  protected readonly transactionsComplete = signal(false);
  protected readonly editTransactionTarget = signal<TransactionView | null>(null);
  protected readonly editTransactionAmount = signal<number | null>(null);
  protected readonly editTransactionStatus = signal<TransactionStatus>('pending');
  protected readonly editTransactionType = signal('');
  protected readonly editTransactionSubmitted = signal(false);
  protected readonly savingTransaction = signal(false);

  private eventsRequested = false;

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  // ---------------------------------------------------------------- permissions

  protected readonly isAllianceTenant = computed(
    () => this.auth.profile()?.tenant_kind === 'alliance',
  );
  protected readonly isReadOnly = computed(
    () => this.isAllianceTenant() || Boolean(this.split()?.origin_read_only),
  );
  protected readonly canShare = computed(
    () => !this.isAllianceTenant() && this.auth.hasPermission('alliance.share'),
  );
  protected readonly shareStatus = signal<AllianceShareStatus | null>(null);
  protected readonly canAct = computed(
    () =>
      !this.isReadOnly() &&
      this.split() !== null &&
      canActOnSplit(
        this.split()!,
        this.auth.profile()?.user_id,
        this.auth.hasPermission('splits.edit'),
      ),
  );
  protected readonly canDelete = computed(
    () =>
      !this.isReadOnly() &&
      this.split() !== null &&
      canActOnSplit(
        this.split()!,
        this.auth.profile()?.user_id,
        this.auth.hasPermission('splits.delete'),
      ),
  );
  protected readonly isCompletedSplit = computed(() => this.split()?.status === 'completed');
  protected readonly canEdit = computed(
    () =>
      !this.isReadOnly() &&
      this.auth.hasPermission('splits.edit') &&
      !this.split()?.archived_at &&
      ['pending', 'awaiting_event', 'completed'].includes(this.split()?.status ?? ''),
  );
  protected readonly canViewSplitTransactions = computed(
    () =>
      !this.isReadOnly() &&
      (this.auth.hasPermission('bank.view_others') || this.auth.hasPermission('bank.withdraw.accept')),
  );
  protected readonly canEditTransactions = computed(
    () => this.auth.hasPermission('bank.transactions.edit') && !this.isReadOnly(),
  );

  /** True while the split is open for completion by someone allowed to close it. */
  protected readonly canClose = computed(() => {
    const detail = this.split();
    return detail !== null && detail.status === 'pending' && this.canAct() && !detail.archived_at;
  });

  /** The single most useful action for the current state; everything else is secondary. */
  protected readonly primaryAction = computed<PrimaryAction>(() => {
    const detail = this.split();
    if (!detail) {
      return null;
    }
    if (detail.archived_at) {
      return this.canDelete() ? 'unarchive' : null;
    }
    if (this.canClose()) {
      return 'complete';
    }
    return this.canEdit() ? 'edit' : null;
  });

  /** Whether the overflow menu has anything to offer. */
  protected readonly hasMenu = computed(
    () => this.canShare() || this.canClose() || (this.canDelete() && !this.split()?.archived_at),
  );

  // ---------------------------------------------------------------- derived view data

  protected readonly netValue = computed(() => {
    const detail = this.split();
    return detail ? this.netOf(detail) : 0;
  });

  protected readonly ledger = computed<Ledger | null>(() => {
    const detail = this.split();
    if (!detail) {
      return null;
    }
    const bagList = (detail.bags ?? []).map((amount) => Number(amount) || 0).filter((amount) => amount > 0);
    return buildLedger(
      this.toNumber(detail.estimated_market_value),
      this.toNumber(detail.bags_value),
      bagList,
      this.toNumber(detail.repair_value),
      this.toNumber(detail.fee ?? DEFAULT_SPLIT_FEE),
      this.netOf(detail),
    );
  });

  protected readonly payoutByUser = computed(() => {
    const byUser = new Map<number, TransactionView[]>();
    for (const transaction of this.splitTransactions()) {
      const list = byUser.get(transaction.to_user_id) ?? [];
      list.push(transaction);
      byUser.set(transaction.to_user_id, list);
    }
    const result = new Map<number, PayoutKind>();
    for (const [userId, list] of byUser) {
      if (list.some((tx) => tx.status === 'requested')) {
        result.set(userId, 'requested');
      } else if (list.some((tx) => tx.status === 'pending' || tx.status === 'rejected')) {
        result.set(userId, 'pending');
      } else if (list.every((tx) => tx.status === 'donated')) {
        result.set(userId, 'donated');
      } else {
        result.set(userId, 'paid');
      }
    }
    return result;
  });

  /** The payout column is for people who can see bank credits, once the split has been credited. */
  protected readonly showPayoutColumn = computed(
    () => this.split()?.status === 'completed' && this.canViewSplitTransactions(),
  );

  /** Per-participant payout state is only trustworthy once every credit row has loaded. */
  protected readonly payoutReady = computed(
    () =>
      this.transactionsComplete() && !this.transactionsLoading() && !this.transactionsLoadFailed(),
  );

  protected readonly participantRows = computed<ParticipantRow[]>(() => {
    const detail = this.split();
    if (!detail) {
      return [];
    }
    const participants = this.normalizeParticipants(detail.participants ?? []);
    const net = this.netOf(detail);
    const totalWeight = this.participantsTotalWeight(participants);
    const payouts = this.payoutByUser();
    return participants.map((participant) => {
      const weight = this.toNumber(participant.weight);
      return {
        user_id: participant.user_id,
        username: participant.username,
        weight,
        poolPct: totalWeight > 0 ? (weight / totalWeight) * 100 : 0,
        amount:
          participant.share_amount !== null && participant.share_amount !== undefined
            ? this.toNumber(participant.share_amount)
            : this.estimatedShare(net, weight, totalWeight),
        payout: payouts.get(participant.user_id) ?? 'none',
      };
    });
  });

  protected readonly sortedParticipantRows = computed<ParticipantRow[]>(() => {
    const rows = [...this.participantRows()];
    const sort = this.participantSort();
    if (!sort) {
      return rows;
    }
    const factor = sort.direction === 'asc' ? 1 : -1;
    const locale = this.translate.locale();
    rows.sort((a, b) => {
      if (sort.key === 'username') {
        return a.username.localeCompare(b.username, locale) * factor;
      }
      return (a[sort.key] - b[sort.key]) * factor;
    });
    return rows;
  });

  protected readonly participantTotals = computed(() => {
    const rows = this.participantRows();
    return {
      weight: rows.reduce((sum, row) => sum + row.weight, 0),
      amount: rows.reduce((sum, row) => sum + row.amount, 0),
      paid: rows.filter((row) => row.payout === 'paid' || row.payout === 'donated').length,
      count: rows.length,
    };
  });

  protected readonly splitPayoutComplete = computed(() => {
    const transactions = this.splitTransactions();
    return (
      this.transactionsComplete() &&
      !this.transactionsLoading() &&
      !this.transactionsLoadFailed() &&
      transactions.length > 0 &&
      transactions.every(
        (transaction) => transaction.status === 'withdrawn' || transaction.status === 'donated',
      )
    );
  });

  // ---------------------------------------------------------------- edit state

  protected readonly editFee = computed(() => parsePercentageInput(this.editFeeInput()) ?? DEFAULT_SPLIT_FEE);
  protected readonly editNetPreview = computed(() =>
    Math.max(
      0,
      (this.editEstimated() - this.editRepair() + this.editBags()) * (1 - this.editFee() / 100),
    ),
  );
  protected readonly editLedger = computed<Ledger>(() =>
    buildLedger(
      this.editEstimated(),
      this.editBags(),
      this.editBagRows()
        .map((bag) => Number(bag.amount) || 0)
        .filter((amount) => amount > 0),
      this.editRepair(),
      this.editFee(),
      this.editNetPreview(),
    ),
  );
  protected readonly editIslandTabs = computed(() => {
    const id = Number(this.editIslandId());
    return this.islands().find((island) => island.id === id)?.tabs ?? [];
  });

  /** Field errors only appear after a save attempt, then stay live while the user fixes them. */
  protected readonly feeError = computed<string | null>(() => {
    if (!this.submitted()) {
      return null;
    }
    const fee = parsePercentageInput(this.editFeeInput());
    return fee === null || fee < 0 || fee > 100 ? this.t('splits.fee_invalid') : null;
  });
  protected readonly weightErrors = computed<Record<number, string>>(() => {
    if (!this.submitted()) {
      return {};
    }
    const errors: Record<number, string> = {};
    for (const participant of this.editParticipants()) {
      const weight = parsePercentageInput(this.editWeightValue(participant));
      if (weight === null || weight <= 0) {
        errors[participant.user_id] = this.t('validation.positive');
      }
    }
    return errors;
  });
  protected readonly rosterError = computed<string | null>(() =>
    this.submitted() && this.editParticipants().length === 0 ? this.t('splits.roster_empty') : null,
  );
  protected readonly hasEditErrors = computed(
    () =>
      this.feeError() !== null ||
      this.rosterError() !== null ||
      Object.keys(this.weightErrors()).length > 0,
  );
  protected readonly transactionAmountError = computed<string | null>(() => {
    if (!this.editTransactionSubmitted()) {
      return null;
    }
    const amount = this.editTransactionAmount();
    return amount === null || amount <= 0 ? this.t('validation.positive') : null;
  });

  constructor() {
    void this.loadIslands();
    this.route.paramMap.subscribe((params) => {
      const id = Number(params.get('splitId'));
      if (!Number.isFinite(id) || id <= 0) {
        this.loading.set(false);
        this.loadFailed.set(false);
        this.notFound.set(true);
        this.split.set(null);
        return;
      }
      void this.load(id);
    });
  }

  // ---------------------------------------------------------------- presentation helpers

  protected statusLabel(status: SplitDetail['status']): string {
    return this.t(`splits.status.${status}` as TranslationKey);
  }

  protected statusIcon(status: SplitDetail['status']): IconName {
    return STATUS_ICONS[status] ?? 'circle-dot';
  }

  /** A completed split whose credits are not all paid out yet is still in progress, so no tick. */
  protected lifecycleIcon(split: SplitDetail): IconName {
    if (
      split.status === 'completed' &&
      this.canViewSplitTransactions() &&
      this.payoutReady() &&
      !this.splitPayoutComplete()
    ) {
      return 'bank';
    }
    return this.statusIcon(split.status);
  }

  protected statusTone(status: SplitDetail['status']): StatusTone {
    switch (status) {
      case 'pending':
      case 'awaiting_event':
        return 'warning';
      case 'completed':
        return 'success';
      case 'lost':
        return 'error';
      default:
        return 'neutral';
    }
  }

  protected payoutPresentation(kind: PayoutKind): Presentation {
    return PAYOUT_PRESENTATION[kind];
  }

  protected transactionPresentation(status: TransactionStatus): Presentation {
    return TRANSACTION_PRESENTATION[status] ?? PAYOUT_PRESENTATION.none;
  }

  protected payoutLifecycleLabel(split: SplitDetail): string {
    if (split.status === 'pending') {
      return this.t('splits.pending_payout');
    }
    if (split.status === 'awaiting_event') {
      return this.t('splits.awaiting_event.label');
    }
    if (
      split.status !== 'completed' ||
      !this.canViewSplitTransactions() ||
      this.transactionsLoading() ||
      this.transactionsLoadFailed() ||
      !this.transactionsComplete()
    ) {
      return this.statusLabel(split.status);
    }

    const transactions = this.splitTransactions();
    if (transactions.some((transaction) => transaction.status === 'requested')) {
      return this.t('bank.status.requested');
    }
    if (transactions.some((transaction) => transaction.status === 'pending' || transaction.status === 'rejected')) {
      return this.t('bank.status.pending');
    }
    if (transactions.length > 0 && transactions.every((transaction) => transaction.status === 'withdrawn')) {
      return this.t('bank.status.withdrawn');
    }
    if (transactions.length > 0 && transactions.every((transaction) => transaction.status === 'donated')) {
      return this.t('bank.status.donated');
    }
    return this.statusLabel(split.status);
  }

  /** Plain-language "what happens next" for the current state. */
  protected nextStep(detail: SplitDetail): string | null {
    if (detail.archived_at) {
      return this.t('splits.detail.next.archived');
    }
    switch (detail.status) {
      case 'pending':
        return this.t(this.canClose() ? 'splits.detail.next.pending' : 'splits.detail.next.pendingView');
      case 'awaiting_event':
        return this.t('splits.awaiting_event.message');
      case 'completed':
        return this.t('splits.detail.next.completed');
      case 'not_completed':
        return this.t('splits.detail.next.not_completed');
      case 'lost':
        return this.t('splits.detail.next.lost');
      default:
        return null;
    }
  }

  protected cityLabel(city: SplitIslandCity): string {
    return this.t(`splits.city.${city}` as TranslationKey);
  }

  protected locationLabel(split: SplitDetail): string {
    if (
      !split.island_tab_id ||
      !split.island_name ||
      !split.island_city ||
      !split.island_tab_name
    ) {
      return this.t('splits.no_location');
    }
    return `${this.cityLabel(split.island_city as SplitIslandCity)} · ${split.island_name} · ${split.island_tab_name}`;
  }

  protected netOf(split: SplitDetail): number {
    if (split.net_value !== null && split.net_value !== undefined) {
      return Number(split.net_value);
    }
    const estimated = Number(split.estimated_market_value);
    return Math.max(
      0,
      (estimated - Number(split.repair_value) + Number(split.bags_value)) *
        (1 - Number(split.fee ?? DEFAULT_SPLIT_FEE) / 100),
    );
  }

  protected editTotalWeight(): number {
    return this.editParticipants().reduce(
      (sum, participant) => sum + Number(participant.weight),
      0,
    );
  }

  /** Real sum of participant weights, used instead of assuming they already total 100. */
  protected participantsTotalWeight(participants: readonly SplitParticipant[]): number {
    return participants.reduce((sum, participant) => sum + this.toNumber(participant.weight), 0);
  }

  protected editWeightValue(participant: SplitParticipant): string {
    return this.editWeightInputs()[participant.user_id] ?? this.formatWeightInput(participant.weight);
  }

  protected toNumber(value: number | string | null | undefined): number {
    return Number(value) || 0;
  }

  protected estimatedShare(netValue: number, weight: number, totalWeight: number): number {
    if (totalWeight <= 0 || netValue <= 0) {
      return 0;
    }
    return Math.round(netValue * (weight / totalWeight) * 100) / 100;
  }

  protected formatAmount(value: number | string | null | undefined): string {
    if (value === null || value === undefined) {
      return '—';
    }
    const amount = Number(value);
    return Number.isFinite(amount)
      ? new Intl.NumberFormat(this.translate.locale(), { maximumFractionDigits: 0 }).format(amount)
      : '—';
  }

  /** Amount with an explicit sign, so additions and deductions never rely on colour alone. */
  protected formatSigned(value: number, sign: '+' | '−'): string {
    return value === 0 ? this.formatAmount(0) : `${sign}${this.formatAmount(Math.abs(value))}`;
  }

  protected formatPercent(value: number | string | null | undefined): string {
    const amount = Number(value);
    if (value === null || value === undefined || !Number.isFinite(amount)) {
      return '—';
    }
    return `${new Intl.NumberFormat(this.translate.locale(), { maximumFractionDigits: 2 }).format(amount)}%`;
  }

  protected formatDate(iso: string | null | undefined): string {
    if (!iso) {
      return '—';
    }
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
      ? '—'
      : date.toLocaleString(this.translate.locale(), { dateStyle: 'medium', timeStyle: 'short' });
  }

  // ---------------------------------------------------------------- sorting

  protected toggleParticipantSort(key: ParticipantSortKey): void {
    const current = this.participantSort();
    if (!current || current.key !== key) {
      this.participantSort.set({ key, direction: 'asc' });
    } else if (current.direction === 'asc') {
      this.participantSort.set({ key, direction: 'desc' });
    } else {
      this.participantSort.set(null);
    }
  }

  protected ariaSort(key: ParticipantSortKey): 'ascending' | 'descending' | 'none' {
    const current = this.participantSort();
    if (!current || current.key !== key) {
      return 'none';
    }
    return current.direction === 'asc' ? 'ascending' : 'descending';
  }

  protected sortIcon(key: ParticipantSortKey): IconName {
    return this.participantSort()?.key === key && this.participantSort()?.direction === 'asc'
      ? 'chevron-up'
      : 'chevron-down';
  }

  // ---------------------------------------------------------------- overflow menu

  protected toggleMenu(): void {
    const open = !this.menuOpen();
    this.menuOpen.set(open);
    if (open) {
      this.focusSoon('.sd-menu__item');
    }
  }

  protected onDocumentPointer(event: Event): void {
    if (!this.menuOpen()) {
      return;
    }
    const root = this.menuRoot()?.nativeElement;
    if (root && !root.contains(event.target as Node)) {
      this.menuOpen.set(false);
    }
  }

  protected onMenuKeydown(event: KeyboardEvent): void {
    if (!this.menuOpen()) {
      return;
    }
    if (event.key === 'Escape') {
      event.stopPropagation();
      this.closeMenu();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const items = Array.from(
        this.menuRoot()?.nativeElement.querySelectorAll<HTMLElement>('.sd-menu__item') ?? [],
      );
      if (items.length === 0) {
        return;
      }
      event.preventDefault();
      const index = items.indexOf(document.activeElement as HTMLElement);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      items[(index + step + items.length) % items.length]?.focus();
    }
  }

  /** Closes the menu and parks focus on its trigger so a dialog opened next restores focus there. */
  protected closeMenu(): void {
    this.menuOpen.set(false);
    this.menuRoot()?.nativeElement.querySelector<HTMLElement>('.sd-menu-trigger')?.focus();
  }

  // ---------------------------------------------------------------- edit mode

  protected toggleMode(): void {
    if (this.mode() === 'edit') {
      this.cancelEdit();
      return;
    }
    this.hydrateEdit();
    this.ensureEventOptions();
    this.mode.set('edit');
    this.focusSoon('#sd-edit-note');
  }

  protected cancelEdit(): void {
    this.mode.set('view');
    this.submitted.set(false);
    this.showEventSearch.set(false);
    this.showParticipantSearch.set(false);
    this.focusSoon('[data-sd-focus-return]');
  }

  protected onEditNoteChange(event: Event): void {
    this.editNote.set((event.target as HTMLInputElement).value);
  }
  protected onEditEstimatedChange(event: Event): void {
    this.editEstimated.set(Number((event.target as HTMLInputElement).value) || 0);
  }
  protected onEditFeeChange(event: Event): void {
    this.editFeeInput.set((event.target as HTMLInputElement).value);
  }
  protected onEditRepairChange(event: Event): void {
    this.editRepair.set(Number((event.target as HTMLInputElement).value) || 0);
  }
  protected addEditBag(): void {
    this.editBagRows.update((rows) => [...rows, newSplitBag()]);
  }

  protected removeEditBag(key: number): void {
    this.editBagRows.update((rows) => rows.filter((bag) => bag.key !== key));
  }

  protected onEditBagAmountChange(key: number, event: Event): void {
    const amount = Math.max(0, Number((event.target as HTMLInputElement).value) || 0);
    this.editBagRows.update((rows) =>
      rows.map((bag) => (bag.key === key ? { ...bag, amount } : bag)),
    );
  }
  protected onEditIslandChange(event: Event): void {
    this.editIslandId.set((event.target as HTMLSelectElement).value);
    this.editTabId.set('');
  }
  protected onEditTabChange(event: Event): void {
    this.editTabId.set((event.target as HTMLSelectElement).value);
  }
  protected onEditWeightChange(userId: number, event: Event): void {
    const raw = (event.target as HTMLInputElement).value;
    this.editWeightInputs.update((inputs) => ({ ...inputs, [userId]: raw }));
    const weight = parsePercentageInput(raw);
    if (weight === null) {
      return;
    }
    this.editParticipants.update((list) =>
      list.map((participant) =>
        participant.user_id === userId ? { ...participant, weight } : participant,
      ),
    );
  }

  protected distributeEditWeightsEvenly(): void {
    const list = this.editParticipants();
    if (list.length === 0) {
      return;
    }
    const redistributed = redistributeWeights(
      list.map((participant) => ({
        ...participant,
        weight: Number(participant.weight),
      })),
    );
    this.editParticipants.set(redistributed);
    this.editWeightInputs.set(this.weightInputsFor(redistributed));
  }

  protected unlinkEditEvent(): void {
    this.editEventId.set(null);
    this.editEventTitle.set('');
  }

  protected onEditEventSelect(opt: SearchDialogOption): void {
    this.editEventId.set(Number(opt.id));
    this.editEventTitle.set(opt.title);
    this.showEventSearch.set(false);
  }

  protected async onEventSearchFilter(filters: {
    search: string;
    dateFrom: string;
    dateTo: string;
  }): Promise<void> {
    this.eventSearchLoading.set(true);
    try {
      const params: Record<string, string> = { page: '1', limit: '50' };
      if (filters.search) {
        params['search'] = filters.search;
      }
      if (filters.dateFrom) {
        params['date_from'] = filters.dateFrom;
      }
      if (filters.dateTo) {
        params['date_to'] = filters.dateTo;
      }
      const res = await firstValueFrom(
        this.api.get<PaginatedData<EventView>>('/api/events', params),
      );
      this.eventSearchOptions.set(
        res.items.map((event) => ({
          id: event.id,
          title: event.title,
          subtitle: this.formatDate(event.event_date_utc),
          chip: event.status,
        })),
      );
    } catch {
      this.toasts.error(this.t('splits.detail.error.search'));
    } finally {
      this.eventSearchLoading.set(false);
    }
  }

  protected async onParticipantSearchFilter(filters: {
    search: string;
    dateFrom: string;
    dateTo: string;
  }): Promise<void> {
    const query = filters.search.trim();
    if (!query) {
      this.participantSearchOptions.set([]);
      return;
    }
    this.searchingRoster.set(true);
    try {
      // Search every registered site user, not just guild members — anyone with an account
      // can be a split participant (`GET /api/users` filters by username substring).
      const usersPage = await firstValueFrom(
        this.api.get<PaginatedData<UserProfile>>('api/users', {
          page: 1,
          limit: 25,
          username: query,
        }),
      );
      this.participantSearchOptions.set(
        usersPage.items.map((user) => ({
          id: user.id,
          title: user.username,
          chip: user.role,
        })),
      );
    } catch {
      this.toasts.error(this.t('splits.detail.error.search'));
    } finally {
      this.searchingRoster.set(false);
    }
  }

  protected async onParticipantSelect(opt: SearchDialogOption): Promise<void> {
    const current = this.split();
    if (!current) {
      return;
    }
    const userId = Number(opt.id);
    if (this.editParticipants().some((participant) => participant.user_id === userId)) {
      this.showParticipantSearch.set(false);
      return;
    }
    if (this.isCompletedSplit()) {
      const added: SplitParticipant = {
        user_id: userId,
        username: opt.title,
        weight: evenParticipantWeight(1),
        share_amount: null,
      };
      const next = this.normalizeParticipants([...this.editParticipants(), added]);
      this.editParticipants.set(next);
      this.editWeightInputs.set(this.weightInputsFor(next));
      this.toasts.success(this.t('splits.added_to_split', { name: opt.title }));
      this.showParticipantSearch.set(false);
      return;
    }
    try {
      // The user id comes straight from the picker, so no Albion-character matching is needed.
      const detail = await firstValueFrom(
        this.api.post<SplitDetail>(`api/splits/${current.id}/participants`, {
          user_id: userId,
          weight: evenParticipantWeight(1),
        }),
      );
      this.split.set(detail);
      const participants = this.normalizeParticipants(detail.participants);
      this.editParticipants.set(participants);
      this.editWeightInputs.set(this.weightInputsFor(participants));
      this.toasts.success(this.t('splits.added_to_split', { name: opt.title }));
      this.showParticipantSearch.set(false);
    } catch {
      this.toasts.error(this.t('splits.detail.error.action'));
    }
  }

  protected async removeEditParticipant(userId: number): Promise<void> {
    const current = this.split();
    if (!current) {
      return;
    }
    if (this.isCompletedSplit()) {
      this.editParticipants.update((list) =>
        list.filter((participant) => participant.user_id !== userId),
      );
      this.editWeightInputs.update((inputs) => {
        const next = { ...inputs };
        delete next[userId];
        return next;
      });
      return;
    }
    try {
      const detail = await firstValueFrom(
        this.api.delete<SplitDetail>(`api/splits/${current.id}/participants/${userId}`),
      );
      if (detail?.participants) {
        this.split.set(detail);
        const participants = this.normalizeParticipants(detail.participants);
        this.editParticipants.set(participants);
        this.editWeightInputs.set(this.weightInputsFor(participants));
      } else {
        this.editParticipants.update((list) =>
          list.filter((participant) => participant.user_id !== userId),
        );
        this.editWeightInputs.update((inputs) => {
          const next = { ...inputs };
          delete next[userId];
          return next;
        });
      }
    } catch {
      this.toasts.error(this.t('splits.detail.error.action'));
    }
  }

  protected async onEditSubmit(event: Event): Promise<void> {
    event.preventDefault();
    const current = this.split();
    if (!current) {
      return;
    }
    this.submitted.set(true);

    const fee = parsePercentageInput(this.editFeeInput());
    let valid = fee !== null && fee >= 0 && fee <= 100 && this.editParticipants().length > 0;

    const weights: Array<{ participant: SplitParticipant; weight: number }> = [];
    for (const participant of this.editParticipants()) {
      const weight = parsePercentageInput(this.editWeightValue(participant));
      if (weight === null || weight <= 0) {
        valid = false;
        continue;
      }
      weights.push({ participant, weight });
    }
    if (!valid || fee === null || !participantWeightsAreValid(weights.map(({ weight }) => weight))) {
      this.focusSoon('[aria-invalid="true"], #sd-edit-errors');
      return;
    }

    this.saving.set(true);
    try {
      const request: UpdateSplitRequest = {
        note: this.editNote().trim(),
        estimated_market_value: this.editEstimated(),
        fee,
        repair_value: this.editRepair(),
        bags_value: this.editBags(),
        bags: this.editBagRows()
          .map((bag) => bag.amount)
          .filter((amount) => amount > 0),
        island_tab_id: this.editTabId() ? Number(this.editTabId()) : undefined,
      };
      if (!this.isCompletedSplit() && this.editEventId() !== (current.event_id ?? null)) {
        request.event_id = this.editEventId();
      }
      if (this.isCompletedSplit()) {
        request.participants = weights.map(({ participant, weight }) => ({
          user_id: participant.user_id,
          weight,
        }));
      }
      let detail = await firstValueFrom(
        this.api.patch<SplitDetail>(`api/splits/${current.id}`, request),
      );
      if (!this.isCompletedSplit()) {
        for (const { participant, weight } of weights) {
          detail = await firstValueFrom(
            this.api.post<SplitDetail>(`api/splits/${current.id}/participants`, {
              user_id: participant.user_id,
              weight,
            }),
          );
        }
      }
      this.split.set(detail);
      this.mode.set('view');
      this.submitted.set(false);
      this.toasts.success(this.t('common.save'));
      this.focusSoon('[data-sd-focus-return]');
      if (this.canViewSplitTransactions()) {
        void this.loadTransactions(current.id);
      }
    } catch {
      this.toasts.error(this.t('splits.detail.error.save'));
    } finally {
      this.saving.set(false);
    }
  }

  // ---------------------------------------------------------------- lifecycle actions

  protected async closeSplit(action: 'complete' | CloseAction): Promise<void> {
    const current = this.split();
    if (!current || this.saving()) {
      return;
    }
    this.saving.set(true);
    try {
      const detail = await firstValueFrom(
        this.api.post<SplitDetail>(`api/splits/${current.id}/${action}`, {}),
      );
      this.split.set(detail);
      this.mode.set('view');
      const toastKey: TranslationKey =
        action === 'complete'
          ? 'splits.status.completed'
          : action === 'not-completed'
            ? 'splits.status.not_completed'
            : 'splits.status.lost';
      this.toasts.success(this.t(toastKey));
      if (this.canViewSplitTransactions()) {
        void this.loadTransactions(current.id);
      }
    } catch {
      this.toasts.error(this.t('splits.detail.error.action'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async executeCompleteSplit(): Promise<void> {
    this.showCompleteConfirmDialog.set(false);
    await this.closeSplit('complete');
  }

  protected async confirmClose(): Promise<void> {
    const action = this.closeConfirm();
    this.closeConfirm.set(null);
    if (action) {
      await this.closeSplit(action);
    }
  }

  protected async confirmArchive(): Promise<void> {
    const current = this.split();
    if (!current) {
      return;
    }
    this.saving.set(true);
    try {
      await firstValueFrom(this.api.post(`api/splits/${current.id}/archive`, {}));
      this.toasts.success(this.t('splits.archiveSuccess'));
      void this.router.navigate(['/splits']);
    } catch {
      this.toasts.error(this.t('splits.detail.error.action'));
    } finally {
      this.saving.set(false);
      this.showArchive.set(false);
    }
  }

  protected async unarchiveSplit(): Promise<void> {
    const current = this.split();
    if (!current) {
      return;
    }
    this.saving.set(true);
    try {
      await firstValueFrom(this.api.post(`api/splits/${current.id}/unarchive`, {}));
      this.toasts.success(this.t('splits.unarchiveSuccess'));
      this.reload();
    } catch {
      this.toasts.error(this.t('splits.detail.error.action'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async shareWithAlliance(): Promise<void> {
    const current = this.split();
    if (!current) {
      return;
    }
    this.saving.set(true);
    try {
      await firstValueFrom(
        this.api.post<AllianceShareStatus['share']>('api/alliance/shares', {
          type: 'split',
          id: current.id,
        }),
      );
      this.toasts.success(this.t('splits.shareSuccess'));
      await this.loadShareStatus(current.id);
    } catch (error) {
      this.toasts.error(this.shareErrorMessage(error));
    } finally {
      this.saving.set(false);
    }
  }

  protected async unshareWithAlliance(): Promise<void> {
    const current = this.split();
    if (!current) {
      return;
    }
    this.saving.set(true);
    try {
      await firstValueFrom(this.api.delete(`api/alliance/shares/split/${current.id}`));
      this.toasts.success(this.t('splits.unshareSuccess'));
      this.shareStatus.set({ shared: false });
    } catch (error) {
      this.toasts.error(this.shareErrorMessage(error));
    } finally {
      this.saving.set(false);
    }
  }

  private shareErrorMessage(error: unknown): string {
    if (error instanceof ApiError && error.status === 409) {
      return this.t('splits.shareNoAlliance');
    }
    return this.t('splits.detail.error.action');
  }

  private async loadShareStatus(splitId: number): Promise<void> {
    if (this.isAllianceTenant()) {
      this.shareStatus.set(null);
      return;
    }
    try {
      const status = await firstValueFrom(
        this.api.get<AllianceShareStatus>(`api/alliance/shares/split/${splitId}`),
      );
      if (this.split()?.id !== splitId) {
        return;
      }
      this.shareStatus.set(status);
    } catch {
      if (this.split()?.id !== splitId) {
        return;
      }
      this.shareStatus.set({ shared: false });
    }
  }

  // ---------------------------------------------------------------- loading

  protected reload(): void {
    const id = Number(this.route.snapshot.paramMap.get('splitId'));
    if (Number.isFinite(id) && id > 0) {
      void this.load(id);
    }
  }

  private async load(id: number): Promise<void> {
    this.loading.set(true);
    this.loadFailed.set(false);
    this.notFound.set(false);
    if (this.split()?.id !== id) {
      this.split.set(null);
      this.shareStatus.set(null);
      this.splitTransactions.set([]);
      this.transactionsComplete.set(false);
      this.participantSort.set(null);
      this.menuOpen.set(false);
    }
    try {
      const detail = await firstValueFrom(this.api.get<SplitDetail>(`api/splits/${id}`));
      this.split.set(detail);
      this.mode.set('view');
      await this.loadShareStatus(id);
    } catch (error) {
      this.split.set(null);
      if (error instanceof ApiError && error.status === 404) {
        this.notFound.set(true);
      } else {
        this.loadFailed.set(true);
      }
    } finally {
      this.loading.set(false);
    }
    if (this.split() && this.canViewSplitTransactions()) {
      void this.loadTransactions(id);
    }
  }

  protected async loadTransactions(id: number): Promise<void> {
    this.splitTransactions.set([]);
    this.transactionsComplete.set(false);
    this.transactionsLoadFailed.set(false);
    this.transactionsLoading.set(true);
    try {
      const data = await firstValueFrom(
        this.api.get<PaginatedData<TransactionView>>('api/bank/transactions', {
          split_id: id,
          limit: 100,
        }),
      );
      this.splitTransactions.set(data.items);
      this.transactionsComplete.set(data.total_items === data.items.length);
    } catch {
      this.splitTransactions.set([]);
      this.transactionsLoadFailed.set(true);
    } finally {
      this.transactionsLoading.set(false);
    }
  }

  protected retryTransactions(): void {
    const id = this.split()?.id;
    if (id !== undefined) {
      void this.loadTransactions(id);
    }
  }

  // ---------------------------------------------------------------- transaction editing

  protected openEditTransaction(row: TransactionView): void {
    this.editTransactionSubmitted.set(false);
    this.editTransactionTarget.set(row);
    this.editTransactionAmount.set(Number(row.amount));
    this.editTransactionStatus.set(row.status);
    this.editTransactionType.set(row.type);
  }

  protected closeEditTransaction(): void {
    this.editTransactionTarget.set(null);
  }

  protected onEditTransactionAmount(event: Event): void {
    const raw = (event.target as HTMLInputElement).value;
    const value = Number(raw);
    this.editTransactionAmount.set(raw.trim() !== '' && Number.isFinite(value) ? value : null);
  }
  protected onEditTransactionStatus(event: Event): void {
    this.editTransactionStatus.set((event.target as HTMLSelectElement).value as TransactionStatus);
  }
  protected onEditTransactionType(event: Event): void {
    this.editTransactionType.set((event.target as HTMLInputElement).value);
  }

  protected async saveEditTransaction(event: Event): Promise<void> {
    event.preventDefault();
    const target = this.editTransactionTarget();
    const amount = this.editTransactionAmount();
    const current = this.split();
    if (!target || !current) {
      return;
    }
    this.editTransactionSubmitted.set(true);
    if (!amount || amount <= 0) {
      this.focusSoon('#sd-tx-amount');
      return;
    }
    this.savingTransaction.set(true);
    try {
      const payload: UpdateTransactionRequest = {
        amount,
        status: this.editTransactionStatus(),
        type: this.editTransactionType().trim() || undefined,
      };
      await firstValueFrom(
        this.api.patch<TransactionView>(`api/bank/transactions/${target.id}`, payload),
      );
      this.closeEditTransaction();
      await this.loadTransactions(current.id);
      this.toasts.success(this.t('common.save'));
    } catch {
      this.toasts.error(this.t('splits.detail.error.save'));
    } finally {
      this.savingTransaction.set(false);
    }
  }

  /**
   * Options for these selects load asynchronously, so a `[value]` binding on the `<select>` is
   * applied while the list is still empty and the browser silently resets it. Marking the matching
   * `<option>` as selected instead keeps the current island/tab visible once the catalog arrives.
   */
  protected isSelectedId(selected: string, id: number | null | undefined): boolean {
    return id != null && selected === String(id);
  }

  // ---------------------------------------------------------------- internals

  private hydrateEdit(): void {
    const detail = this.split();
    if (!detail) {
      return;
    }
    this.submitted.set(false);
    this.editNote.set(detail.note || '');
    this.editEstimated.set(Number(detail.estimated_market_value) || 0);
    this.editFeeInput.set(String(detail.fee ?? DEFAULT_SPLIT_FEE));
    this.editRepair.set(Number(detail.repair_value) || 0);
    this.editBagRows.set(bagsFromDetail(detail));
    this.editEventId.set(detail.event_id ?? null);
    this.editEventTitle.set(detail.event_title || '');
    this.editIslandId.set(detail.island_id ? String(detail.island_id) : '');
    this.editTabId.set(detail.island_tab_id ? String(detail.island_tab_id) : '');
    const participants = this.normalizeParticipants(detail.participants);
    this.editParticipants.set(participants);
    this.editWeightInputs.set(this.weightInputsFor(participants));
  }

  /** Focus the first element matching `selector` once the next render has produced it. */
  private focusSoon(selector: string): void {
    afterNextRender(
      () => {
        this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus();
      },
      { injector: this.injector },
    );
  }

  private ensureEventOptions(): void {
    if (this.eventsRequested) {
      return;
    }
    this.eventsRequested = true;
    void this.onEventSearchFilter({ search: '', dateFrom: '', dateTo: '' });
  }

  private normalizeParticipants(participants: SplitParticipant[]): SplitParticipant[] {
    return upgradeLegacyUnitShares(
      participants.map((participant) => ({
        ...participant,
        weight: Number(participant.weight),
      })),
    );
  }

  private weightInputsFor(participants: SplitParticipant[]): Record<number, string> {
    return Object.fromEntries(
      participants.map((participant) => [
        participant.user_id,
        this.formatWeightInput(participant.weight),
      ]),
    );
  }

  private formatWeightInput(value: number | string): string {
    const parsed = Number(String(value).replace(',', '.'));
    if (!Number.isFinite(parsed)) {
      return '';
    }
    return String(parsed).replace('.', ',');
  }

  private async loadIslands(): Promise<void> {
    try {
      const islands = await firstValueFrom(this.api.get<SplitIsland[]>('api/splits/islands'));
      this.islands.set(islands);
    } catch {
      this.toasts.error(this.t('splits.detail.error.search'));
    }
  }
}
