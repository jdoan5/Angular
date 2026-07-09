import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { findCategoryById, WORD_BANKS } from '../data/word-banks';
import { WordCategory, WordEntry } from '../models/word';
import { StorageService } from './storage';

export const MAX_MISSES = 6;

const STATS_KEY = 'he.stats';
const COLLECTION_KEY = 'he.collection';

export type GamePhase = 'home' | 'playing' | 'won' | 'lost';

export interface GameStats {
  wins: number;
  losses: number;
  streak: number;
  bestStreak: number;
}

const EMPTY_STATS: GameStats = { wins: 0, losses: 0, streak: 0, bestStreak: 0 };

/** One tile in the on-screen word display. */
export interface WordTile {
  char: string;
  /** Letters A–Z are hidden until guessed; spaces/hyphens are always shown. */
  revealed: boolean;
  isLetter: boolean;
}

/**
 * The whole game as signals: current round state, lifetime stats, and the
 * player's collected encyclopedia. Stats and collection persist to
 * `localStorage` through effects.
 */
@Injectable({ providedIn: 'root' })
export class GameStore {
  private readonly storage = inject(StorageService);

  readonly phase = signal<GamePhase>('home');
  readonly category = signal<WordCategory | null>(null);
  readonly entry = signal<WordEntry | null>(null);
  readonly guessed = signal<ReadonlySet<string>>(new Set());
  readonly hintUsed = signal(false);

  private lastEntryId: string | null = null;

  readonly stats = signal<GameStats>(this.storage.get(STATS_KEY, EMPTY_STATS));
  /** Map of collected entry id → ISO date it was first solved. */
  readonly collection = signal<Record<string, string>>(this.storage.get(COLLECTION_KEY, {}));

  /** Wrong letter guesses; the hint, if used, costs one extra miss. */
  readonly misses = computed(() => {
    const word = this.entry()?.word ?? '';
    let wrong = 0;
    for (const letter of this.guessed()) {
      if (!word.includes(letter)) wrong++;
    }
    return wrong + (this.hintUsed() ? 1 : 0);
  });

  readonly missesLeft = computed(() => MAX_MISSES - this.misses());

  readonly tiles = computed<WordTile[]>(() => {
    const entry = this.entry();
    if (!entry) return [];
    const guessed = this.guessed();
    const revealAll = this.phase() !== 'playing';
    return [...entry.word].map((char) => {
      const isLetter = char >= 'A' && char <= 'Z';
      return { char, isLetter, revealed: !isLetter || revealAll || guessed.has(char) };
    });
  });

  /** The hint may be bought for one miss — but never the losing one. */
  readonly hintAvailable = computed(
    () => this.phase() === 'playing' && !this.hintUsed() && this.misses() < MAX_MISSES - 1,
  );

  readonly collectedCount = computed(() => Object.keys(this.collection()).length);

  readonly progressByCategory = computed(() => {
    const collection = this.collection();
    return WORD_BANKS.map((c) => ({
      category: c,
      collected: c.entries.filter((e) => e.id in collection).length,
      total: c.entries.length,
    }));
  });

  constructor() {
    effect(() => this.storage.set(STATS_KEY, this.stats()));
    effect(() => this.storage.set(COLLECTION_KEY, this.collection()));
  }

  start(categoryId: string): void {
    const category = findCategoryById(categoryId);
    if (!category || category.entries.length === 0) return;
    this.category.set(category);
    this.entry.set(this.pickEntry(category));
    this.guessed.set(new Set());
    this.hintUsed.set(false);
    this.phase.set('playing');
  }

  /** Prefer words not yet in the encyclopedia, and avoid an immediate repeat. */
  private pickEntry(category: WordCategory): WordEntry {
    const collection = this.collection();
    const fresh = category.entries.filter((e) => !(e.id in collection));
    let pool = fresh.length > 0 ? fresh : category.entries;
    if (pool.length > 1) {
      pool = pool.filter((e) => e.id !== this.lastEntryId);
    }
    const entry = pool[Math.floor(Math.random() * pool.length)];
    this.lastEntryId = entry.id;
    return entry;
  }

  guess(letter: string): void {
    letter = letter.toUpperCase();
    if (this.phase() !== 'playing' || letter < 'A' || letter > 'Z' || letter.length !== 1) return;
    if (this.guessed().has(letter)) return;

    this.guessed.update((set) => new Set(set).add(letter));

    const word = this.entry()!.word;
    const guessed = this.guessed();
    const allRevealed = [...word].every(
      (c) => !(c >= 'A' && c <= 'Z') || guessed.has(c),
    );

    if (allRevealed) {
      this.endRound(true);
    } else if (this.misses() >= MAX_MISSES) {
      this.endRound(false);
    }
  }

  useHint(): void {
    if (!this.hintAvailable()) return;
    this.hintUsed.set(true);
  }

  /** Concede the round — reveals the word and counts as a loss. */
  giveUp(): void {
    if (this.phase() !== 'playing') return;
    this.endRound(false);
  }

  private endRound(won: boolean): void {
    this.phase.set(won ? 'won' : 'lost');
    this.stats.update((s) => {
      const streak = won ? s.streak + 1 : 0;
      return {
        wins: s.wins + (won ? 1 : 0),
        losses: s.losses + (won ? 0 : 1),
        streak,
        bestStreak: Math.max(s.bestStreak, streak),
      };
    });
    if (won) {
      const id = this.entry()!.id;
      if (!(id in this.collection())) {
        this.collection.update((c) => ({ ...c, [id]: new Date().toISOString() }));
      }
    }
  }

  nextWord(): void {
    const category = this.category();
    if (category) this.start(category.id);
  }

  backToCategories(): void {
    // Walking away from a round you've started counts as a concession —
    // otherwise streaks could be farmed by bailing out of every losing word.
    if (this.phase() === 'playing' && (this.guessed().size > 0 || this.hintUsed())) {
      this.stats.update((s) => ({ ...s, losses: s.losses + 1, streak: 0 }));
    }
    this.phase.set('home');
    this.category.set(null);
    this.entry.set(null);
  }
}
