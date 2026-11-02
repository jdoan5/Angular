import { computed, effect, inject, Injectable, InjectionToken, signal } from '@angular/core';
import { DAILY_SCHEDULE } from '../data/daily-schedule';
import { findCategoryById, WORD_BANKS } from '../data/word-banks';
import { WordCategory, WordEntry } from '../models/word';
import { dayNumber, localDayKey, scheduledIdFor } from './daily-math';
import { StorageService } from './storage';

export const MAX_MISSES = 6;

/**
 * The time, as a seam: tests swap in a fixed clock. Lives here (not in
 * daily.ts) because GameStore needs it too, and DailyService already depends
 * on GameStore, so the reverse import would be a cycle.
 */
export const CLOCK = new InjectionToken<() => Date>('CLOCK', {
  providedIn: 'root',
  factory: () => () => new Date(),
});

const STATS_KEY = 'he.stats';
const COLLECTION_KEY = 'he.collection';

export type GamePhase = 'home' | 'playing' | 'won' | 'lost';

/** `daily` rounds pause instead of counting a walk-away as a loss. */
export type GameMode = 'free' | 'daily';

/** The round as DailyService saves it after every guess and hint. */
export interface RoundSnapshot {
  entryId: string;
  /** Letters in the order they were guessed. */
  guesses: string;
  /** Guesses made before the hint was bought; -1 = no hint. */
  hintAt: number;
  result: 'won' | 'lost' | null;
}

/** Where to pick a daily round back up: the saved guesses, replayed in order. */
export interface DailyResume {
  guesses: string;
  hintAt: number;
}

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
  private readonly clock = inject(CLOCK);

  readonly mode = signal<GameMode>('free');
  readonly phase = signal<GamePhase>('home');
  readonly category = signal<WordCategory | null>(null);
  readonly entry = signal<WordEntry | null>(null);
  /** Guessed letters; a Set keeps insertion order, so this is also the play order. */
  readonly guessed = signal<ReadonlySet<string>>(new Set());
  /** How many guesses had been made when the hint was bought; -1 = not bought. */
  readonly hintAt = signal(-1);
  readonly hintUsed = computed(() => this.hintAt() >= 0);

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

  /** The round in saveable form (null between rounds); DailyService persists it. */
  readonly snapshot = computed<RoundSnapshot | null>(() => {
    const entry = this.entry();
    if (!entry) return null;
    const phase = this.phase();
    return {
      entryId: entry.id,
      guesses: [...this.guessed()].join(''),
      hintAt: this.hintAt(),
      result: phase === 'won' ? 'won' : phase === 'lost' ? 'lost' : null,
    };
  });

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
    this.mode.set('free');
    this.category.set(category);
    this.entry.set(this.pickEntry(category));
    this.guessed.set(new Set());
    this.hintAt.set(-1);
    this.phase.set('playing');
  }

  /**
   * Begin (or pick back up) today's daily round. Saved guesses are replayed
   * in their original order with the hint bought at the same point, so the
   * board, misses, and share glyphs come back exactly as they were left.
   */
  startDaily(entry: WordEntry, category: WordCategory, resume: DailyResume): void {
    this.mode.set('daily');
    this.category.set(category);
    this.entry.set(entry);
    this.guessed.set(new Set());
    this.hintAt.set(-1);
    this.phase.set('playing');

    const letters = [...resume.guesses];
    letters.forEach((letter, i) => {
      if (i === resume.hintAt) this.useHint();
      this.guess(letter);
    });
    if (resume.hintAt >= letters.length) this.useHint();
  }

  /**
   * Prefer words not yet in the encyclopedia, and avoid an immediate repeat.
   * Today's daily entry is never served here, so free play can't spoil it.
   * (Worked out from the schedule directly rather than by asking
   * DailyService, which itself depends on this store.)
   */
  private pickEntry(category: WordCategory): WordEntry {
    const collection = this.collection();
    const dailyId = scheduledIdFor(dayNumber(localDayKey(this.clock())), DAILY_SCHEDULE);
    const playable = category.entries.filter((e) => e.id !== dailyId);
    const fresh = playable.filter((e) => !(e.id in collection));
    let pool = fresh.length > 0 ? fresh : playable;
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
    this.hintAt.set(this.guessed().size);
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

  /** Free play deals another word; a daily has no "next", so it heads home. */
  nextWord(): void {
    if (this.mode() === 'daily') {
      this.backToCategories();
      return;
    }
    const category = this.category();
    if (category) this.start(category.id);
  }

  backToCategories(): void {
    // Walking away from a round you've started counts as a concession —
    // otherwise streaks could be farmed by bailing out of every losing word.
    // A daily round only pauses: its progress is saved and it can't be
    // re-rolled, so there's nothing to farm.
    if (
      this.mode() === 'free' &&
      this.phase() === 'playing' &&
      (this.guessed().size > 0 || this.hintUsed())
    ) {
      this.stats.update((s) => ({ ...s, losses: s.losses + 1, streak: 0 }));
    }
    this.mode.set('free');
    this.phase.set('home');
    this.category.set(null);
    this.entry.set(null);
  }
}
