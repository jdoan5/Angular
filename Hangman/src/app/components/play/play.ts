import { Component, computed, DOCUMENT, effect, ElementRef, inject, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TOTAL_ENTRIES } from '../../data/word-banks';
import { DailyService } from '../../services/daily';
import { GameStore, MAX_MISSES, WordTile } from '../../services/game-store';
import { DailyCard, ShareResult } from '../daily-card/daily-card';
import { STAMP, WEEKDAYS } from '../daily-ledger/daily-ledger';
import { Gallows } from '../gallows/gallows';
import { Keyboard } from '../keyboard/keyboard';

interface WeekDot {
  key: string;
  initial: string;
  state: 'won' | 'lost' | 'open';
  glyph: string;
  today: boolean;
  label: string;
}

@Component({
  selector: 'app-play',
  imports: [RouterLink, Gallows, Keyboard, DailyCard, ShareResult],
  templateUrl: './play.html',
  styleUrl: './play.scss',
  host: { '(window:keydown)': 'onKey($event)' },
})
export class Play {
  protected readonly store = inject(GameStore);
  private readonly daily = inject(DailyService);
  protected readonly totalEntries = TOTAL_ENTRIES;

  protected readonly isDaily = computed(() => this.store.mode() === 'daily');
  // The round on the board, not today: a daily opened before midnight keeps its own No. and share line.
  protected readonly dailyNo = this.daily.activeDayNo;
  protected readonly shareText = this.daily.roundShareText;

  /** Mon–Sun of this week for the fact card: ◉ solved, ✕ missed, ○ open, ring on today. */
  protected readonly week = computed<WeekDot[]>(() =>
    this.daily.weekStrip().map((day, i) => {
      const state = day.state === 'won' || day.state === 'lost' ? day.state : 'open';
      const word = day.state === 'future' ? 'still to come' : state === 'open' ? 'open' : STAMP[state].word;
      return {
        key: day.key,
        initial: day.weekday[0],
        state,
        glyph: state === 'open' ? '○' : STAMP[state].glyph,
        today: day.isToday,
        label: `${WEEKDAYS[i].long}${day.isToday ? ', today' : ''}: ${word}`,
      };
    }),
  );

  private readonly document = inject(DOCUMENT);
  private readonly nextBtn = viewChild<ElementRef<HTMLButtonElement>>('nextBtn');
  private readonly factCard = viewChild<ElementRef<HTMLElement>>('factCard');

  constructor() {
    // Move focus into the round-over dialog so Enter/Tab act on it — not on
    // whatever button (e.g. concede) was focused behind the overlay.
    // preventScroll: on a short screen the card scrolls, and it should open
    // on the verdict, not jump down to the button.
    effect(() => {
      const phase = this.store.phase();
      if (phase === 'won' || phase === 'lost') {
        setTimeout(() => this.nextBtn()?.nativeElement.focus({ preventScroll: true }));
      }
    });
  }

  /** One pip per allowed miss, filled as they're spent. */
  protected readonly pips = computed(() => {
    const misses = this.store.misses();
    return Array.from({ length: MAX_MISSES }, (_, i) => i < misses);
  });

  /** The tile row spoken as one pattern: 'A word of 6 letters: M, blank, …'. */
  protected readonly tilesLabel = computed(() => {
    const word = this.store.entry()?.word ?? '';
    const lengths = word.split(' ').map((w) => w.replace(/[^A-Z]/g, '').length);
    const head =
      lengths.length === 1
        ? `A word of ${lengths[0]} letters`
        : `${lengths.length} words of ${listJoin(lengths.map(String))} letters`;
    const spoken = this.store
      .tiles()
      .map((t) => (!t.isLetter ? (t.char === ' ' ? 'space' : 'hyphen') : t.revealed ? t.char : 'blank'));
    return `${head}: ${spoken.join(', ')}`;
  });

  /** The hint is held back on the last miss; say so rather than just greying it out. */
  protected readonly hintLocked = computed(
    () => this.store.phase() === 'playing' && !this.store.hintUsed() && !this.store.hintAvailable(),
  );

  protected onKey(event: KeyboardEvent): void {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const phase = this.store.phase();
    const key = event.key;
    if ((phase === 'won' || phase === 'lost') && key === 'Tab') {
      this.wrapFocus(event);
    } else if (phase === 'playing' && /^[a-zA-Z]$/.test(key)) {
      this.store.guess(key);
    } else if ((phase === 'won' || phase === 'lost') && key === 'Enter') {
      // Enter on any other control (Share, All volumes, My encyclopedia, the
      // copy box) does that control's own job; only the primary button, or
      // no control at all, continues.
      const control = (event.target as Element | null)?.closest?.('a, button, textarea, input, select');
      if (control && control !== this.nextBtn()?.nativeElement) return;
      // Without preventDefault the browser would ALSO fire a click on the
      // focused button, double-acting on the brand-new round.
      event.preventDefault();
      // In a daily this heads home: there is no next daily.
      this.store.nextWord();
    }
  }

  /** On a loss, the letters the player never found are called out in red. */
  protected isMissedLetter(tile: WordTile): boolean {
    return this.store.phase() === 'lost' && tile.isLetter && !this.store.guessed().has(tile.char);
  }

  /**
   * Keep Tab inside the modal fact card. The board behind it is inert, but
   * the topbar isn't, so without this focus walks out of an aria-modal dialog.
   */
  private wrapFocus(event: KeyboardEvent): void {
    const card = this.factCard()?.nativeElement;
    if (!card) return;
    const items = [...card.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) return;
    const active = this.document.activeElement;
    const inside = !!active && card.contains(active);
    if (event.shiftKey && (active === first || !inside)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !inside)) {
      event.preventDefault();
      first.focus();
    }
  }
}

const FOCUSABLE = 'button:not([disabled]), a[href], textarea, [tabindex]:not([tabindex="-1"])';

/** ['3', '4', '5'] → '3, 4 and 5'. */
function listJoin(parts: string[]): string {
  return parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}
