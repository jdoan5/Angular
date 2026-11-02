import { Component, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { GamePhase, GameStore } from './services/game-store';
import { ThemeService } from './services/theme';

/** What the narrator last saw, so each effect run can tell what just changed. */
interface Seen {
  entryId: string | null;
  guesses: number;
  hintUsed: boolean;
}

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected readonly store = inject(GameStore);
  protected readonly theme = inject(ThemeService);

  /**
   * One short line per guess for screen readers. It lives here, outside
   * <main>, because the board turns inert when the round-over dialog opens
   * and a live region inside it would go quiet on the winning guess.
   */
  protected readonly narration = signal('');
  private seen: Seen = { entryId: null, guesses: 0, hintUsed: false };

  constructor() {
    effect(() => {
      const entry = this.store.entry();
      const guessed = this.store.guessed();
      const hintUsed = this.store.hintUsed();
      const phase = this.store.phase();
      untracked(() => this.narrate(entry?.id ?? null, entry?.word ?? '', guessed, hintUsed, phase));
    });
  }

  private narrate(
    entryId: string | null,
    word: string,
    guessed: ReadonlySet<string>,
    hintUsed: boolean,
    phase: GamePhase,
  ): void {
    const before = this.seen;
    this.seen = { entryId, guesses: guessed.size, hintUsed };
    if (!entryId) {
      this.narration.set('');
      return;
    }

    const left = this.store.missesLeft();
    const leftText = left === 1 ? '1 miss left.' : `${left} misses left.`;
    const outcome = phase === 'won' ? 'Solved!' : phase === 'lost' ? 'Round over.' : leftText;

    if (entryId !== before.entryId) {
      // A new round, or a saved daily coming back: say the length, never the
      // letters. A round that opens already finished is left to its dialog.
      const letters = [...word].filter((c) => c >= 'A' && c <= 'Z').length;
      const resumed = guessed.size > 0 || hintUsed;
      this.narration.set(
        phase !== 'playing' ? '' : resumed ? `Resumed. ${leftText}` : `New word, ${letters} letters. ${leftText}`,
      );
    } else if (guessed.size > before.guesses) {
      // Usually one new letter; if fast input lands in one change-detection
      // pass, the latest guess is the one worth saying.
      const letter = [...guessed].at(-1)!;
      const count = [...word].filter((c) => c === letter).length;
      const result =
        count === 0 ? `${letter} is not in the word.` : count === 1 ? `${letter} is in the word.` : `${letter} is in the word ${count} times.`;
      this.narration.set(`${result} ${outcome}`);
    } else if (hintUsed && !before.hintUsed) {
      this.narration.set(`Hint: ${this.store.entry()?.hint} It cost 1 miss, ${leftText}`);
    } else if (phase === 'lost' && guessed.size === before.guesses) {
      this.narration.set('Conceded. Round over.');
    }
  }
}
