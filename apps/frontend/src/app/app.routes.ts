import { Routes } from '@angular/router';

import { authGuard, redirectIfAuthenticatedGuard, roleGuard } from './core/guards/auth.guard';

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
        path: 'leaderboards',
        loadComponent: () =>
          import('./features/leaderboards/leaderboards').then((m) => m.Leaderboards),
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
        path: 'events',
        loadComponent: () => import('./features/events/events').then((m) => m.Events),
      },
      {
        path: 'events/new',
        canActivate: [roleGuard('Officer', 'Admin', 'SuperAdmin')],
        loadComponent: () =>
          import('./features/events/event-create').then((m) => m.EventCreatePage),
      },
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
        path: 'users',
        loadComponent: () => import('./features/users/users').then((m) => m.Users),
      },
      {
        path: 'admin',
        canActivate: [roleGuard('Officer', 'Admin', 'SuperAdmin')],
        loadComponent: () => import('./features/admin/admin').then((m) => m.Admin),
      },
      {
        path: 'audit',
        canActivate: [roleGuard('Officer', 'Admin', 'SuperAdmin')],
        loadComponent: () => import('./features/audit/audit').then((m) => m.Audit),
      },
      {
        path: 'profile',
        loadComponent: () => import('./features/settings/settings').then((m) => m.Settings),
      },
      {
        path: 'settings',
        loadComponent: () =>
          import('./features/albion-settings/albion-settings').then((m) => m.AlbionSettings),
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
