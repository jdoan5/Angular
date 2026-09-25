import { computed, DestroyRef, DOCUMENT, effect, inject, Injectable, signal } from '@angular/core';
import { StorageService } from './storage';

export type Theme = 'light' | 'dark';
/** `system` follows the OS setting; `light`/`dark` are an explicit override. */
export type ThemePreference = Theme | 'system';

/** Also read by the pre-paint script in index.html — keep the two in sync. */
export const THEME_KEY = 'he.theme';

/** Browser-chrome colour (`<meta name="theme-color">`) for each theme. */
const THEME_COLOR: Record<Theme, string> = { light: '#2b2620', dark: '#1a1612' };

function isPreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

/**
 * Light/dark theme as signals. Follows the OS until the player picks a side,
 * persists the choice, and mirrors the active theme onto `<html data-theme>`
 * so the design tokens in styles.scss can switch.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly storage = inject(StorageService);
  private readonly document = inject(DOCUMENT);

  private readonly darkQuery = this.document.defaultView?.matchMedia?.('(prefers-color-scheme: dark)');
  private readonly systemTheme = signal<Theme>(this.darkQuery?.matches ? 'dark' : 'light');

  readonly preference = signal<ThemePreference>(this.loadPreference());
  readonly theme = computed<Theme>(() => {
    const preference = this.preference();
    return preference === 'system' ? this.systemTheme() : preference;
  });
  readonly isDark = computed(() => this.theme() === 'dark');

  constructor() {
    const onSystemChange = (e: MediaQueryListEvent) => this.systemTheme.set(e.matches ? 'dark' : 'light');
    this.darkQuery?.addEventListener('change', onSystemChange);
    inject(DestroyRef).onDestroy(() => this.darkQuery?.removeEventListener('change', onSystemChange));

    effect(() => this.storage.set(THEME_KEY, this.preference()));
    effect(() => this.apply(this.theme()));
  }

  /**
   * Switch to the other theme. Landing back on the OS's own theme clears the
   * override, so the app follows the system again from then on.
   */
  toggle(): void {
    const flip = () => {
      // Resolved inside the callback so rapid double-clicks each take effect.
      const next: Theme = this.theme() === 'dark' ? 'light' : 'dark';
      this.preference.set(next === this.systemTheme() ? 'system' : next);
      // Apply synchronously so a view transition snapshots the new theme.
      this.apply(this.theme());
    };

    const reduceMotion = this.document.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (typeof this.document.startViewTransition === 'function' && !reduceMotion && !this.document.hidden) {
      // A skipped transition (e.g. the tab goes to the background mid-flip)
      // still runs `flip`; only the animation is lost, so its rejection is noise.
      this.document.startViewTransition(flip).ready.catch(() => {});
    } else {
      flip();
    }
  }

  private loadPreference(): ThemePreference {
    const stored = this.storage.get<unknown>(THEME_KEY, 'system');
    return isPreference(stored) ? stored : 'system';
  }

  private apply(theme: Theme): void {
    this.document.documentElement.setAttribute('data-theme', theme);
    this.document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme]);
  }
}
