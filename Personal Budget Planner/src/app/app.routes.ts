import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
  {
    path: 'dashboard',
    title: 'Dashboard · Budget Planner',
    loadComponent: () => import('./components/dashboard/dashboard').then((m) => m.Dashboard),
  },
  {
    path: 'transactions',
    title: 'Transactions · Budget Planner',
    loadComponent: () =>
      import('./components/transactions/transactions').then((m) => m.Transactions),
  },
  {
    path: 'budgets',
    title: 'Budgets · Budget Planner',
    loadComponent: () => import('./components/budgets/budgets').then((m) => m.Budgets),
  },
  { path: '**', redirectTo: 'dashboard' },
];
