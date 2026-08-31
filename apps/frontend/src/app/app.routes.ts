import { Routes } from '@angular/router';

import { authGuard, permissionGuard, permissionGuardTo, redirectIfAuthenticatedGuard } from './core/guards/auth.guard';
import { ADMIN_ACCESS_PERMISSIONS } from './layout/nav';

/**
 * Top-level routes.
 *
 * The authenticated experience lives under the `Shell` layout component, so
 * every protected route is a child of `''` with `appShell` as its component.
 * Public routes (login, error pages) are siblings of the shell group.
 */
export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./layout/shell/shell').then((m) => m.Shell),
    canActivate: [authGuard],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
      {
        path: 'dashboard',
        loadComponent: () => import('./features/dashboard/dashboard').then((m) => m.Dashboard),
      },
      {
        path: 'season',
        loadComponent: () =>
          import('./features/leaderboards/leaderboards').then((m) => m.SeasonOverview),
      },
      {
        path: 'leaderboards',
        redirectTo: 'season',
      },
      {
        path: 'bank',
        loadComponent: () => import('./features/bank/bank').then((m) => m.Bank),
      },
      {
        path: 'splits',
        loadComponent: () => import('./features/splits/splits').then((m) => m.Splits),
      },
      {
        path: 'splits/:splitId',
        loadComponent: () =>
          import('./features/splits/split-detail').then((m) => m.SplitDetailPage),
      },
      {
        path: 'islands/:islandId',
        redirectTo: (route) => `/admin/islands/${route.params['islandId'] ?? ''}`,
      },
      {
        path: 'islands',
        redirectTo: '/admin/islands',
      },
      {
        path: 'manage-islands',
        redirectTo: '/admin/islands',
      },
      {
        path: 'events',
        loadComponent: () => import('./features/events/events').then((m) => m.Events),
      },
      { path: 'events/new', redirectTo: '/events' },
      {
        path: 'events/:eventId',
        loadComponent: () =>
          import('./features/events/event-detail').then((m) => m.EventDetailPage),
      },
      {
        path: 'battles/group',
        loadComponent: () =>
          import('./features/battles/battle-group').then((m) => m.BattleGroupPage),
      },
      {
        path: 'battles/:battleId',
        loadComponent: () =>
          import('./features/battles/battle-detail').then((m) => m.BattleDetailPage),
      },
      {
        path: 'battles',
        loadComponent: () => import('./features/battles/battles').then((m) => m.Battles),
      },
      {
        path: 'intel',
        loadComponent: () => import('./features/intel/intel').then((m) => m.Intel),
      },
      {
        path: 'intel/:scoutId',
        loadComponent: () =>
          import('./features/intel/intel-detail').then((m) => m.IntelDetailPage),
      },
      {
        path: 'comps',
        loadComponent: () => import('./features/comps/comps').then((m) => m.Comps),
      },
      {
        path: 'comps/builds/:buildId',
        loadComponent: () =>
          import('./features/comps/comp-build-detail').then((m) => m.CompBuildDetailPage),
      },
      {
        path: 'comps/:compId',
        loadComponent: () => import('./features/comps/comp-detail').then((m) => m.CompDetailPage),
      },
      {
        path: 'siphoned',
        loadComponent: () => import('./features/siphoned/siphoned').then((m) => m.Siphoned),
      },
      {
        path: 'regears',
        loadComponent: () => import('./features/regears/regears').then((m) => m.Regears),
      },
      {
        path: 'regears/:deathId',
        loadComponent: () =>
          import('./features/regears/regear-detail').then((m) => m.RegearDetailPage),
      },
      {
        path: 'users',
        loadComponent: () => import('./features/users/users').then((m) => m.Users),
      },
      {
        path: 'users/:userId',
        loadComponent: () => import('./features/users/user-detail').then((m) => m.UserDetailPage),
      },
      {
        path: 'warns',
        canActivate: [permissionGuard('warns.view')],
        loadComponent: () => import('./features/warns/warns').then((m) => m.Warns),
      },
      {
        path: 'admin',
        canActivate: [permissionGuard(...ADMIN_ACCESS_PERMISSIONS)],
        children: [
          {
            path: '',
            pathMatch: 'full',
            loadComponent: () => import('./features/admin/admin-hub').then((m) => m.AdminHub),
          },
          {
            path: 'roles',
            canActivate: [permissionGuardTo('/admin', 'roles.manage')],
            loadComponent: () => import('./features/admin/admin-roles').then((m) => m.AdminRoles),
          },
          {
            path: 'permissions',
            canActivate: [permissionGuardTo('/admin', 'roles.manage', 'permissions.reload')],
            loadComponent: () =>
              import('./features/admin/admin-permissions').then((m) => m.AdminPermissions),
          },
          {
            path: 'discord',
            canActivate: [permissionGuardTo('/admin', 'admin.settings.manage', 'autorole.manage')],
            loadComponent: () => import('./features/admin/admin-discord').then((m) => m.AdminDiscord),
          },
          {
            path: 'progression',
            canActivate: [permissionGuardTo('/admin', 'progression.settings.manage')],
            loadComponent: () =>
              import('./features/admin/admin-progression').then((m) => m.AdminProgression),
          },
          {
            path: 'regears',
            canActivate: [permissionGuardTo('/admin', 'regear.settings.manage')],
            loadComponent: () =>
              import('./features/admin/admin-regears').then((m) => m.AdminRegears),
          },
          {
            path: 'islands',
            canActivate: [permissionGuardTo('/admin', 'splits.islands.manage')],
            loadComponent: () =>
              import('./features/admin/admin-islands').then((m) => m.AdminIslands),
          },
          {
            path: 'islands/:islandId',
            canActivate: [permissionGuardTo('/admin', 'splits.islands.manage')],
            loadComponent: () =>
              import('./features/admin/admin-island-detail').then((m) => m.AdminIslandDetail),
          },
          {
            path: 'users',
            redirectTo: '/users',
          },
        ],
      },
      {
        path: 'audit',
        canActivate: [permissionGuard('audit.view')],
        loadComponent: () => import('./features/audit/audit').then((m) => m.Audit),
      },
      {
        path: 'profile',
        loadComponent: () => import('./features/settings/settings').then((m) => m.Settings),
      },
      {
        path: 'settings',
        redirectTo: 'profile',
      },
    ],
  },
  {
    path: 'login',
    canActivate: [redirectIfAuthenticatedGuard],
    loadComponent: () => import('./features/auth/login').then((m) => m.Login),
  },
  { path: '**', redirectTo: '' },
];
