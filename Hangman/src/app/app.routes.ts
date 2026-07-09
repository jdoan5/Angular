import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    title: 'Play · Hangman Encyclopedia',
    loadComponent: () => import('./components/play/play').then((m) => m.Play),
  },
  {
    path: 'encyclopedia',
    title: 'My Encyclopedia · Hangman Encyclopedia',
    loadComponent: () =>
      import('./components/encyclopedia/encyclopedia').then((m) => m.Encyclopedia),
  },
  { path: '**', redirectTo: '' },
];
