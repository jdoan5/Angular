import { TestBed } from '@angular/core/testing';
import { THEME_KEY, ThemeService } from './theme';

describe('ThemeService', () => {
  const root = document.documentElement;
  const originalMatchMedia = window.matchMedia;
  let systemListener: ((e: MediaQueryListEvent) => void) | undefined;

  /** Fake the OS colour-scheme setting (jsdom has no matchMedia of its own). */
  function stubSystem(dark: boolean): void {
    window.matchMedia = ((query: string) => ({
      matches: query.includes('prefers-color-scheme: dark') && dark,
      media: query,
      addEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => (systemListener = fn),
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
  }

  function create(): ThemeService {
    const service = TestBed.inject(ThemeService);
    TestBed.tick();
    return service;
  }

  beforeEach(() => {
    localStorage.clear();
    root.removeAttribute('data-theme');
    systemListener = undefined;
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it('follows the system theme by default', () => {
    stubSystem(true);
    const theme = create();
    expect(theme.preference()).toBe('system');
    expect(theme.theme()).toBe('dark');
    expect(root.getAttribute('data-theme')).toBe('dark');
  });

  it('falls back to light when the system preference is unknown', () => {
    const theme = create();
    expect(theme.theme()).toBe('light');
    expect(root.getAttribute('data-theme')).toBe('light');
  });

  it('toggles to an explicit override and persists it', () => {
    stubSystem(false);
    const theme = create();
    theme.toggle();
    TestBed.tick();
    expect(theme.isDark()).toBe(true);
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem(THEME_KEY)).toBe('"dark"');
  });

  it('clears the override when toggled back to the system theme', () => {
    stubSystem(false);
    const theme = create();
    theme.toggle();
    theme.toggle();
    TestBed.tick();
    expect(theme.preference()).toBe('system');
    expect(theme.theme()).toBe('light');
    expect(localStorage.getItem(THEME_KEY)).toBe('"system"');
  });

  it('restores a saved preference over the system theme', () => {
    stubSystem(false);
    localStorage.setItem(THEME_KEY, '"dark"');
    const theme = create();
    expect(theme.theme()).toBe('dark');
    expect(root.getAttribute('data-theme')).toBe('dark');
  });

  it('ignores a corrupt saved value', () => {
    stubSystem(true);
    localStorage.setItem(THEME_KEY, '"sepia"');
    const theme = create();
    expect(theme.preference()).toBe('system');
    expect(theme.theme()).toBe('dark');
  });

  it('still flips (without an unhandled rejection) when a view transition is skipped', async () => {
    stubSystem(false);
    const skipped = Promise.reject(new DOMException('Transition was aborted', 'InvalidStateError'));
    let handled = false;
    const ready = { catch: (fn: () => void) => ((handled = true), skipped.catch(fn)) };
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      value: (update: () => void) => (update(), { ready }),
    });
    try {
      const theme = create();
      theme.toggle();
      expect(theme.theme()).toBe('dark');
      expect(root.getAttribute('data-theme')).toBe('dark');
      expect(handled).toBe(true);
    } finally {
      Reflect.deleteProperty(document, 'startViewTransition');
    }
  });

  it('tracks OS changes while following the system', () => {
    stubSystem(false);
    const theme = create();
    systemListener?.({ matches: true } as MediaQueryListEvent);
    TestBed.tick();
    expect(theme.theme()).toBe('dark');
    expect(root.getAttribute('data-theme')).toBe('dark');
  });
});
