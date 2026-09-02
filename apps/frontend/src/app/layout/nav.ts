import type { TranslationKey } from '../i18n/en';
import type { IconName } from '../shared/components/icon/icon';

/** Single entry in the sidebar. */
export interface NavItem {
  readonly path: string;
  readonly icon: IconName;
  readonly labelKey: TranslationKey;
  /** Restrict visibility by permission keys (OR); undefined = everyone authenticated. */
  readonly permissions?: readonly string[];
  /** When true, the item is active only on that exact URL (not its children). */
  readonly exact?: boolean;
}

/** Group of nav entries with a small heading label. */
export interface NavSection {
  readonly headingKey: TranslationKey;
  readonly items: NavItem[];
}

/** Card on the admin hub: a panel plus the copy that explains it. */
export interface AdminPanel {
  readonly path: string;
  readonly icon: IconName;
  readonly labelKey: TranslationKey;
  readonly hintKey: TranslationKey;
  readonly permissions?: readonly string[];
  readonly exact?: boolean;
}

/** Any of these is enough to enter the admin console. */
export const ADMIN_ACCESS_PERMISSIONS = [
  'roles.manage',
  'permissions.reload',
  'admin.settings.manage',
  'autorole.manage',
  'progression.settings.manage',
  'regear.settings.manage',
  'splits.islands.manage',
  'bank.view_others',
  'bank.withdraw.accept',
] as const;

/**
 * True for the admin console and its child panels.
 *
 * `/administrator` must not match: the prefix is `/admin/` (or exact `/admin`).
 */
export function isAdminUrl(url: string): boolean {
  const path = url.split('?')[0].split('#')[0];
  return (
    path === '/admin' ||
    path === '/admin/' ||
    path.startsWith('/admin/') ||
    path === '/users' ||
    path.startsWith('/users/')
  );
}

/** Hide items the session cannot reach; drop sections that become empty. */
export function filterNavSections(
  sections: readonly NavSection[],
  hasPermission: (permission: string) => boolean,
): NavSection[] {
  return sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => {
        if (!item.permissions?.length) {
          return true;
        }
        return item.permissions.some((permission) => hasPermission(permission));
      }),
    }))
    .filter((section) => section.items.length > 0);
}

export const APP_NAV_SECTIONS: NavSection[] = [
  {
    headingKey: 'nav.section.main',
    items: [
      { path: '/dashboard', icon: 'chart', labelKey: 'nav.dashboard' },
      { path: '/season', icon: 'trophy', labelKey: 'nav.season' },
    ],
  },
  {
    headingKey: 'nav.section.guild',
    items: [
      {
        path: '/guild',
        icon: 'users',
        labelKey: 'nav.guild',
        permissions: ['intel.report.view'],
      },
      { path: '/bank', icon: 'bank', labelKey: 'nav.bank' },
      { path: '/splits', icon: 'swords', labelKey: 'nav.splits' },
      { path: '/events', icon: 'calendar', labelKey: 'nav.events' },
      { path: '/battles', icon: 'shield', labelKey: 'nav.battles' },
      { path: '/intel', icon: 'scan', labelKey: 'nav.intel' },
      { path: '/comps', icon: 'package', labelKey: 'nav.comps' },
      { path: '/siphoned', icon: 'activity', labelKey: 'nav.siphoned' },
      { path: '/regears', icon: 'shield', labelKey: 'nav.regears' },
      {
        path: '/warns',
        icon: 'alert',
        labelKey: 'nav.warns',
        permissions: ['warns.view'],
      },
    ],
  },
  {
    headingKey: 'nav.section.system',
    items: [
      {
        path: '/admin',
        icon: 'hammer',
        labelKey: 'nav.admin',
        permissions: [...ADMIN_ACCESS_PERMISSIONS],
      },
      {
        path: '/audit',
        icon: 'activity',
        labelKey: 'nav.audit',
        permissions: ['audit.view'],
      },
      { path: '/profile', icon: 'users', labelKey: 'nav.profile' },
    ],
  },
];

export const ADMIN_PANELS: readonly AdminPanel[] = [
  {
    path: '/admin/withdrawals',
    icon: 'bank',
    labelKey: 'nav.admin.withdrawals',
    hintKey: 'admin.hub.withdrawalsHint',
    permissions: ['bank.withdraw.accept'],
  },
  {
    path: '/admin/finance',
    icon: 'chart',
    labelKey: 'nav.admin.finance',
    hintKey: 'admin.hub.financeHint',
    permissions: ['bank.view_others'],
  },
  {
    path: '/admin/transactions',
    icon: 'bank',
    labelKey: 'nav.admin.transactions',
    hintKey: 'admin.hub.transactionsHint',
    permissions: ['bank.view_others'],
  },
  {
    path: '/users',
    icon: 'users',
    labelKey: 'nav.admin.users',
    hintKey: 'admin.hub.usersHint',
    permissions: ['roles.manage', 'admin.settings.manage'],
  },
  {
    path: '/admin/roles',
    icon: 'users',
    labelKey: 'nav.admin.roles',
    hintKey: 'admin.hub.rolesHint',
    permissions: ['roles.manage'],
  },
  {
    path: '/admin/permissions',
    icon: 'shield',
    labelKey: 'nav.admin.permissions',
    hintKey: 'admin.hub.permissionsHint',
    permissions: ['roles.manage', 'permissions.reload'],
  },
  {
    path: '/admin/discord',
    icon: 'discord',
    labelKey: 'nav.admin.discord',
    hintKey: 'admin.hub.discordHint',
    permissions: ['admin.settings.manage', 'autorole.manage'],
  },
  {
    path: '/admin/progression',
    icon: 'trophy',
    labelKey: 'nav.admin.progression',
    hintKey: 'admin.hub.progressionHint',
    permissions: ['progression.settings.manage'],
  },
  {
    path: '/admin/regears',
    icon: 'shield',
    labelKey: 'nav.admin.regears',
    hintKey: 'admin.hub.regearsHint',
    permissions: ['regear.settings.manage'],
  },
  {
    path: '/admin/islands',
    icon: 'swords',
    labelKey: 'nav.admin.islands',
    hintKey: 'admin.hub.islandsHint',
    permissions: ['splits.islands.manage'],
  },
];

export const ADMIN_NAV_SECTIONS: NavSection[] = [
  {
    headingKey: 'nav.section.admin',
    items: [
      { path: '/dashboard', icon: 'chevron-left', labelKey: 'nav.admin.back' },
      { path: '/admin', icon: 'hammer', labelKey: 'nav.admin.overview', exact: true },
      ...ADMIN_PANELS.map((panel) => ({
        path: panel.path,
        icon: panel.icon,
        labelKey: panel.labelKey,
        permissions: panel.permissions,
        exact: panel.exact,
      })),
    ],
  },
];

export const ADMIN_ELSEWHERE_LINKS: readonly {
  readonly path: string;
  readonly labelKey: TranslationKey;
  readonly hintKey: TranslationKey;
}[] = [
  { path: '/regears', labelKey: 'admin.link.regear', hintKey: 'admin.link.regearHint' },
  { path: '/comps', labelKey: 'admin.link.comps', hintKey: 'admin.link.compsHint' },
  { path: '/audit', labelKey: 'admin.link.audit', hintKey: 'admin.link.auditHint' },
  { path: '/splits', labelKey: 'admin.link.splits', hintKey: 'admin.link.splitsHint' },
];
