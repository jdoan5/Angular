import { TestBed } from '@angular/core/testing';
import { DAILY_SCHEDULE } from '../data/daily-schedule';
import { findCategoryById, findEntryById } from '../data/word-banks';
import { WordEntry } from '../models/word';
import { CLOCK, GameStore, MAX_MISSES } from './game-store';

const ALPHABET = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];

/** Letters that are certainly in / not in a word, for scripted rounds. */
const hits = (word: string) => [...new Set(word.replace(/[^A-Z]/g, ''))];
const misses = (word: string, n: number) => ALPHABET.filter((l) => !word.includes(l)).slice(0, n);

describe('GameStore', () => {
  let now: Date;

  function create(): GameStore {
    TestBed.configureTestingModule({ providers: [{ provide: CLOCK, useValue: () => now }] });
    return TestBed.inject(GameStore);
  }

  beforeEach(() => {
    localStorage.clear();
    // Before the first daily unless a test says otherwise.
    now = new Date(2026, 9, 15, 12);
  });

  afterEach(() => vi.restoreAllMocks());

  describe('free play', () => {
    it('starts a round in the chosen volume', () => {
      const store = create();
      store.start('animals');
      expect(store.mode()).toBe('free');
      expect(store.phase()).toBe('playing');
      expect(store.category()?.id).toBe('animals');
      expect(store.entry()?.id).toMatch(/^animals:/);
      expect(store.misses()).toBe(0);
      expect(store.hintUsed()).toBe(false);
    });

    it('collects the entry and extends the streak on a win', () => {
      const store = create();
      store.start('animals');
      const entry = store.entry()!;
      for (const letter of hits(entry.word)) store.guess(letter);
      expect(store.phase()).toBe('won');
      expect(store.stats()).toEqual({ wins: 1, losses: 0, streak: 1, bestStreak: 1 });
      expect(entry.id in store.collection()).toBe(true);
    });

    it('loses on the sixth miss and resets the streak', () => {
      const store = create();
      store.stats.set({ wins: 2, losses: 0, streak: 2, bestStreak: 2 });
      store.start('space');
      for (const letter of misses(store.entry()!.word, MAX_MISSES)) store.guess(letter);
      expect(store.phase()).toBe('lost');
      expect(store.stats()).toEqual({ wins: 2, losses: 1, streak: 0, bestStreak: 2 });
      expect(store.collectedCount()).toBe(0);
    });

    it('charges one miss for the hint, and never lets it be the losing one', () => {
      const store = create();
      store.start('science');
      const word = store.entry()!.word;
      const wrong = misses(word, 5);

      for (const letter of wrong.slice(0, 4)) store.guess(letter);
      expect(store.hintAvailable()).toBe(true);
      store.useHint();
      expect(store.hintUsed()).toBe(true);
      expect(store.hintAt()).toBe(4);
      expect(store.misses()).toBe(5);
      expect(store.hintAvailable()).toBe(false);

      store.start('science');
      for (const letter of misses(store.entry()!.word, 5)) store.guess(letter);
      expect(store.hintAvailable()).toBe(false);
      store.useHint();
      expect(store.hintUsed()).toBe(false);
      expect(store.phase()).toBe('playing');
    });

    it('counts walking away from a started round as a loss, but not an untouched one', () => {
      const store = create();
      store.stats.set({ wins: 3, losses: 0, streak: 3, bestStreak: 3 });

      store.start('music');
      store.backToCategories();
      expect(store.stats()).toEqual({ wins: 3, losses: 0, streak: 3, bestStreak: 3 });

      store.start('music');
      store.guess(misses(store.entry()!.word, 1)[0]);
      store.backToCategories();
      expect(store.phase()).toBe('home');
      expect(store.entry()).toBeNull();
      expect(store.stats()).toEqual({ wins: 3, losses: 1, streak: 0, bestStreak: 3 });

      store.start('music');
      store.useHint();
      store.backToCategories();
      expect(store.stats().losses).toBe(2);
    });

    it('deals the next word from the same volume, never the same one twice running', () => {
      const store = create();
      vi.spyOn(Math, 'random').mockReturnValue(0);
      store.start('food');
      const first = store.entry()!.id;
      store.giveUp();
      store.nextWord();
      expect(store.phase()).toBe('playing');
      expect(store.category()?.id).toBe('food');
      expect(store.entry()!.id).not.toBe(first);
    });

    it('prefers entries not yet collected', () => {
      const store = create();
      const food = findCategoryById('food')!;
      const keep = food.entries[food.entries.length - 1];
      store.collection.set(
        Object.fromEntries(food.entries.filter((e) => e !== keep).map((e) => [e.id, 'x'])),
      );
      store.start('food');
      expect(store.entry()!.id).toBe(keep.id);
    });

    it("never serves today's daily entry", () => {
      now = new Date(2026, 10, 2, 12); // launch day
      const store = create();
      const daily = findEntryById(DAILY_SCHEDULE[0])!;
      // Everything else in its volume is collected, so before the daily
      // existed this pick would have been forced onto today's entry.
      store.collection.set(
        Object.fromEntries(
          daily.category.entries.filter((e) => e !== daily.entry).map((e) => [e.id, 'x']),
        ),
      );
      for (let i = 0; i < 40; i++) {
        store.start(daily.category.id);
        expect(store.entry()!.id).not.toBe(daily.entry.id);
      }
    });

    it('can serve that entry again on another day', () => {
      now = new Date(2026, 9, 15, 12); // before the epoch: no daily to protect
      const store = create();
      const daily = findEntryById(DAILY_SCHEDULE[0])!;
      store.collection.set(
        Object.fromEntries(
          daily.category.entries.filter((e) => e !== daily.entry).map((e) => [e.id, 'x']),
        ),
      );
      store.start(daily.category.id);
      expect(store.entry()!.id).toBe(daily.entry.id);
    });
  });

  describe('daily rounds', () => {
    const { entry, category } = findEntryById('animals:elephant')!;
    const [m1, m2] = misses(entry.word, 2);
    /** Miss, hit, miss, hit: E and L are in ELEPHANT. */
    const saved = `${m1}E${m2}L`;

    function startDaily(
      store: GameStore,
      resume = { guesses: saved, hintAt: 2 },
      at: WordEntry = entry,
    ) {
      store.startDaily(at, category, resume);
    }

    it('replays saved guesses in order, with the hint bought at the same point', () => {
      const store = create();
      startDaily(store);
      expect(store.mode()).toBe('daily');
      expect(store.phase()).toBe('playing');
      expect([...store.guessed()].join('')).toBe(saved);
      expect(store.hintAt()).toBe(2);
      expect(store.hintUsed()).toBe(true);
      expect(store.misses()).toBe(3);
      expect(store.snapshot()).toEqual({
        entryId: entry.id,
        guesses: saved,
        hintAt: 2,
        result: null,
      });
    });

    it('replays a hint bought after the last guess, or before any', () => {
      const store = create();
      startDaily(store, { guesses: 'EL', hintAt: 2 });
      expect(store.snapshot()).toEqual({
        entryId: entry.id,
        guesses: 'EL',
        hintAt: 2,
        result: null,
      });
      startDaily(store, { guesses: '', hintAt: 0 });
      expect(store.snapshot()).toEqual({ entryId: entry.id, guesses: '', hintAt: 0, result: null });
      startDaily(store, { guesses: '', hintAt: -1 });
      expect(store.snapshot()).toEqual({
        entryId: entry.id,
        guesses: '',
        hintAt: -1,
        result: null,
      });
    });

    it('pauses when leaving: home, no loss, streak intact', () => {
      const store = create();
      store.stats.set({ wins: 4, losses: 1, streak: 4, bestStreak: 4 });
      startDaily(store);
      store.backToCategories();
      expect(store.phase()).toBe('home');
      expect(store.mode()).toBe('free');
      expect(store.snapshot()).toBeNull();
      expect(store.stats()).toEqual({ wins: 4, losses: 1, streak: 4, bestStreak: 4 });

      startDaily(store);
      store.nextWord();
      expect(store.phase()).toBe('home');
      expect(store.entry()).toBeNull();
      expect(store.stats()).toEqual({ wins: 4, losses: 1, streak: 4, bestStreak: 4 });
    });

    it('treats conceding as a loss', () => {
      const store = create();
      store.stats.set({ wins: 4, losses: 1, streak: 4, bestStreak: 4 });
      startDaily(store);
      store.giveUp();
      expect(store.phase()).toBe('lost');
      expect(store.snapshot()?.result).toBe('lost');
      expect(store.stats()).toEqual({ wins: 4, losses: 2, streak: 0, bestStreak: 4 });
    });

    it('sends a win through the usual stats and collection', () => {
      const store = create();
      startDaily(store);
      for (const letter of hits(entry.word)) store.guess(letter);
      expect(store.phase()).toBe('won');
      expect(store.snapshot()?.result).toBe('won');
      expect(store.stats()).toEqual({ wins: 1, losses: 0, streak: 1, bestStreak: 1 });
      expect(entry.id in store.collection()).toBe(true);

      // Finished: the fact card's "continue" heads home rather than dealing a word.
      store.nextWord();
      expect(store.phase()).toBe('home');
      expect(store.mode()).toBe('free');
    });

    it('returns to free play, walk-away rule and all, on the next start()', () => {
      const store = create();
      startDaily(store);
      store.backToCategories();
      store.start('animals');
      expect(store.mode()).toBe('free');
      expect(store.hintUsed()).toBe(false);
      store.guess('Q');
      store.backToCategories();
      expect(store.stats().losses).toBe(1);
    });
  });
});
