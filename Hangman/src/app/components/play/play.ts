import { Component, computed, effect, ElementRef, inject, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TOTAL_ENTRIES } from '../../data/word-banks';
import { GameStore, MAX_MISSES, WordTile } from '../../services/game-store';
import { Gallows } from '../gallows/gallows';
import { Keyboard } from '../keyboard/keyboard';

@Component({
  selector: 'app-play',
  imports: [RouterLink, Gallows, Keyboard],
  templateUrl: './play.html',
  styleUrl: './play.scss',
  host: { '(window:keydown)': 'onKey($event)' },
})
export class Play {
  protected readonly store = inject(GameStore);
  protected readonly totalEntries = TOTAL_ENTRIES;

  private readonly nextBtn = viewChild<ElementRef<HTMLButtonElement>>('nextBtn');

  constructor() {
    // Move focus into the round-over dialog so Enter/Tab act on it — not on
    // whatever button (e.g. concede) was focused behind the overlay.
    effect(() => {
      const phase = this.store.phase();
      if (phase === 'won' || phase === 'lost') {
        setTimeout(() => this.nextBtn()?.nativeElement.focus());
      }
    });
  }

  /** One pip per allowed miss, filled as they're spent. */
  protected readonly pips = computed(() => {
    const misses = this.store.misses();
    return Array.from({ length: MAX_MISSES }, (_, i) => i < misses);
  });

  protected onKey(event: KeyboardEvent): void {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const phase = this.store.phase();
    const key = event.key;
    if (phase === 'playing' && /^[a-zA-Z]$/.test(key)) {
      this.store.guess(key);
    } else if ((phase === 'won' || phase === 'lost') && key === 'Enter') {
      // Without preventDefault the browser would ALSO fire a click on the
      // focused button, double-acting on the brand-new round.
      event.preventDefault();
      this.store.nextWord();
    }
  }

  /** On a loss, the letters the player never found are called out in red. */
  protected isMissedLetter(tile: WordTile): boolean {
    return this.store.phase() === 'lost' && tile.isLetter && !this.store.guessed().has(tile.char);
  }
}
