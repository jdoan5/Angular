import {
  afterNextRender,
  Component,
  computed,
  DestroyRef,
  DOCUMENT,
  ElementRef,
  inject,
  Injector,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { DailyService } from '../../services/daily';
import { formatCountdown, weekdayIndex } from '../../services/daily-math';
import { MAX_MISSES } from '../../services/game-store';

/**
 * 'Share result' button. Touch devices get the native share sheet; everything
 * else copies to the clipboard; if neither API exists, the text appears in a
 * pre-selected read-only box to copy by hand. The outcome is announced through
 * a role=status line that is always in the DOM, so screen readers hear it.
 */
@Component({
  selector: 'app-share-result',
  template: `
    <button type="button" class="btn btn-ghost share-btn" [disabled]="!text()" (click)="share()">
      Share result
    </button>
    <!-- The live region is always rendered (visually hidden, so an empty one
         adds no flex gap); a live region that appears with its text is
         often skipped. The visible copy is for sighted players only. -->
    <span class="sr-only" role="status">{{ status() }}</span>
    @if (status()) {
      <span class="share-status" aria-hidden="true">{{ status() }}</span>
    }
    @if (manual()) {
      <label class="share-manual">
        <span class="share-manual-label">Your result, ready to copy</span>
        <textarea #manualBox readonly rows="4" [value]="text()"></textarea>
      </label>
    }
  `,
  styles: `
    :host {
      display: contents;
    }
    .share-btn {
      min-height: 44px;
    }
    .share-status {
      font-size: 0.85rem;
      font-weight: 650;
      color: var(--good);
    }
    .share-manual {
      flex-basis: 100%;
      display: grid;
      gap: 0.3rem;
      text-align: left;
      font-size: 0.82rem;
      color: var(--muted);
    }
    textarea {
      width: 100%;
      resize: none;
      padding: 0.55rem 0.7rem;
      border-radius: 10px;
      border: 1.5px solid var(--ink-faint);
      background: var(--paper-deep);
      color: var(--ink);
      font: inherit;
      font-size: 0.88rem;
      line-height: 1.45;
    }
  `,
})
export class ShareResult {
  readonly text = input<string | null>(null);

  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  private readonly manualBox = viewChild<ElementRef<HTMLTextAreaElement>>('manualBox');

  protected readonly status = signal('');
  protected readonly manual = signal(false);
  private announceTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.announceTimer));
  }

  /**
   * A live region speaks only when its text changes, so a second 'Copied'
   * must first be cleared and then set on a later task, after the empty
   * state has rendered.
   */
  private announce(message: string): void {
    clearTimeout(this.announceTimer);
    this.status.set('');
    this.announceTimer = setTimeout(() => this.status.set(message), 120);
  }

  protected async share(): Promise<void> {
    const text = this.text();
    if (!text) return;
    const nav = this.document.defaultView?.navigator;
    const coarse = this.document.defaultView?.matchMedia?.('(pointer: coarse)').matches ?? false;
    clearTimeout(this.announceTimer);
    this.status.set('');

    if (nav?.share && coarse && nav.canShare?.({ text })) {
      try {
        await nav.share({ text });
        this.announce('Shared');
        return;
      } catch (err) {
        // The player closed the share sheet: not an error, and not a reason to copy.
        if ((err as DOMException)?.name === 'AbortError') return;
      }
    }

    if (nav?.clipboard?.writeText) {
      try {
        await nav.clipboard.writeText(text);
        this.announce('Copied');
        return;
      } catch {
        // Permission denied or insecure context: fall through to the manual box.
      }
    }

    this.manual.set(true);
    this.announce('Select the text below to copy it');
    afterNextRender(
      () => {
        const box = this.manualBox()?.nativeElement;
        box?.focus();
        box?.select();
      },
      { injector: this.injector },
    );
  }
}

/** Today's Entry on the home screen: open it, resume it, or share how it went. */
@Component({
  selector: 'app-daily-card',
  imports: [ShareResult],
  templateUrl: './daily-card.html',
  styleUrl: './daily-card.scss',
})
export class DailyCard {
  protected readonly daily = inject(DailyService);
  protected readonly maxMisses = MAX_MISSES;
  /** Inline 'Read the entry' panel: re-reading a finished day never replays it. */
  protected readonly reading = signal(false);

  protected readonly dateLabel = computed(() => {
    const t = this.daily.today();
    return t ? DATE_FORMAT.format(dateFromKey(t.key)) : '';
  });

  /** Sunday is the week's big one; other days let the difficulty pill speak. */
  protected readonly bigOne = computed(() => {
    const t = this.daily.today();
    return !!t && weekdayIndex(t.key) === 6;
  });

  /** Letters as dots, spaces kept, exactly like a locked encyclopedia entry. */
  protected readonly pattern = computed(() => this.daily.today()?.entry.word.replace(/[A-Z]/g, '•') ?? '');

  protected readonly patternLabel = computed(() => {
    const word = this.daily.today()?.entry.word ?? '';
    const lengths = word.split(' ').map((w) => w.replace(/[^A-Z]/g, '').length);
    return lengths.length === 1
      ? `Hidden word, ${lengths[0]} letters`
      : `Hidden phrase, ${lengths.length} words of ${lengths.join(', ')} letters`;
  });

  protected readonly pips = computed(() => {
    const misses = this.daily.missesUsed();
    return Array.from({ length: MAX_MISSES }, (_, i) => i < misses);
  });

  protected readonly countdown = computed(() => formatCountdown(this.daily.msUntilNextDay()));
}

const DATE_FORMAT = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

/** 'YYYY-MM-DD' → local midnight of that calendar day (for formatting only). */
function dateFromKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
