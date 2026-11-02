import { TestBed } from '@angular/core/testing';
import { DAILY_SCHEDULE } from '../data/daily-schedule';
import { findEntryById } from '../data/word-banks';
import { DAILY_KEY, DailyRecord, DailyService } from './daily';
import { GameStore } from './game-store';

const ALPHABET = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
const HOUR = 3_600_000;

/** Today's entry on day `n` (0-based) of the schedule. */
const dayEntry = (n: number) => findEntryById(DAILY_SCHEDULE[n])!;
const hitsOf = (word: string) => [...new Set(word.replace(/[^A-Z]/g, ''))];
const missesOf = (word: string, n: number) => ALPHABET.filter((l) => !word.includes(l)).slice(0, n);

function savedLedger(): Record<string, DailyRecord> {
  return JSON.parse(localStorage.getItem(DAILY_KEY) ?? '{}');
}

/** Day n's entry, solved without a miss. */
const wonRow = (n: number): DailyRecord => ({
  id: DAILY_SCHEDULE[n],
  guesses: hitsOf(dayEntry(n).entry.word).join(''),
  hintAt: -1,
  result: 'won',
});

/**
 * Another tab saving rows on top of what's stored. `announce: false` is a
 * save this tab never heard about (a missed event, a tab asleep overnight).
 */
function otherTabSaves(rows: Record<string, DailyRecord>, announce = true): void {
  localStorage.setItem(DAILY_KEY, JSON.stringify({ ...savedLedger(), ...rows }));
  if (announce) window.dispatchEvent(new StorageEvent('storage', { key: DAILY_KEY }));
}

/**
 * The real clock under Vitest's fake timers: the service's 60-second refresh
 * and midnight timeout run for real, just on demand.
 */
describe('DailyService', () => {
  let daily: DailyService;
  let store: GameStore;

  function boot(at: Date): void {
    vi.setSystemTime(at);
    daily = TestBed.inject(DailyService);
    store = TestBed.inject(GameStore);
  }

  /** Simulate a page reload: fresh services, same localStorage. */
  function reload(): void {
    TestBed.resetTestingModule();
    daily = TestBed.inject(DailyService);
    store = TestBed.inject(GameStore);
  }

  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  it('has no daily before the epoch', () => {
    boot(new Date(2026, 10, 1, 23, 0));
    expect(daily.available()).toBe(false);
    expect(daily.state()).toBe('none');
    expect(daily.today()).toBeNull();
    expect(daily.dayNumber()).toBe(0);
    expect(daily.weekStrip()).toEqual([]);
    daily.open();
    expect(store.phase()).toBe('home');
  });

  it('serves No. 1 on launch day', () => {
    boot(new Date(2026, 10, 2, 8, 0));
    expect(daily.available()).toBe(true);
    expect(daily.dayNumber()).toBe(1);
    expect(daily.todayKey()).toBe('2026-11-02');
    expect(daily.today()?.entry.id).toBe(DAILY_SCHEDULE[0]);
    expect(daily.today()?.category.id).toBe(DAILY_SCHEDULE[0].split(':')[0]);
    expect(daily.state()).toBe('fresh');
    expect(daily.record()).toBeNull();
    expect(daily.shareText()).toBeNull();
  });

  it('saves after every guess and hint, but not for an untouched open', () => {
    boot(new Date(2026, 10, 2, 8, 0));
    const { word } = dayEntry(0).entry;
    const [miss] = missesOf(word, 1);
    const [hit] = hitsOf(word);

    daily.open();
    TestBed.tick();
    expect(store.mode()).toBe('daily');
    expect(localStorage.getItem(DAILY_KEY)).toBeNull();
    expect(daily.state()).toBe('fresh');

    store.guess(miss);
    TestBed.tick();
    expect(savedLedger()['2026-11-02']).toEqual({
      id: DAILY_SCHEDULE[0],
      guesses: miss,
      hintAt: -1,
      result: null,
    });

    store.guess(hit);
    TestBed.tick();
    expect(savedLedger()['2026-11-02'].guesses).toBe(miss + hit);

    store.useHint();
    TestBed.tick();
    expect(savedLedger()['2026-11-02']).toEqual({
      id: DAILY_SCHEDULE[0],
      guesses: miss + hit,
      hintAt: 2,
      result: null,
    });
    expect(daily.state()).toBe('in-progress');
    expect(daily.missesUsed()).toBe(2);
  });

  it('pauses on leaving and resumes exactly, even after a reload', () => {
    boot(new Date(2026, 10, 2, 8, 0));
    const { word } = dayEntry(0).entry;
    const [m1, m2] = missesOf(word, 2);
    const [h1] = hitsOf(word);

    daily.open();
    store.guess(m1);
    TestBed.tick();
    store.useHint();
    TestBed.tick();
    store.guess(h1);
    TestBed.tick();
    store.guess(m2);
    TestBed.tick();
    store.backToCategories();
    TestBed.tick();
    expect(store.phase()).toBe('home');
    expect(store.stats()).toEqual({ wins: 0, losses: 0, streak: 0, bestStreak: 0 });
    expect(daily.state()).toBe('in-progress');

    reload();
    expect(daily.state()).toBe('in-progress');
    expect(daily.missesUsed()).toBe(3);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    daily.open();
    TestBed.tick();
    expect([...store.guessed()].join('')).toBe(m1 + h1 + m2);
    expect(store.hintAt()).toBe(1);
    expect(store.misses()).toBe(3);
    // Replaying the saved guesses doesn't write them back.
    expect(setItem.mock.calls.filter(([key]) => key === DAILY_KEY)).toEqual([]);
    setItem.mockRestore();
  });

  it('ends the day on a concession, and a finished day cannot be replayed', () => {
    boot(new Date(2026, 10, 2, 8, 0));
    daily.open();
    store.guess(missesOf(dayEntry(0).entry.word, 1)[0]);
    store.giveUp();
    TestBed.tick();
    expect(savedLedger()['2026-11-02'].result).toBe('lost');
    expect(daily.state()).toBe('done');
    expect(store.stats().losses).toBe(1);
    expect(daily.shareText()?.split('\n')[2]).toBe('Missed · 1 of 6 misses');

    store.backToCategories();
    daily.open();
    expect(store.phase()).toBe('home');

    reload();
    daily.open();
    expect(store.phase()).toBe('home');
    expect(daily.state()).toBe('done');
  });

  it('records a concession made before any guess', () => {
    boot(new Date(2026, 10, 2, 8, 0));
    daily.open();
    store.giveUp();
    TestBed.tick();
    expect(savedLedger()['2026-11-02']).toEqual({
      id: DAILY_SCHEDULE[0],
      guesses: '',
      hintAt: -1,
      result: 'lost',
    });
  });

  it('feeds a win into stats, the collection, and the daily streak', () => {
    boot(new Date(2026, 10, 2, 8, 0));
    const { entry, category } = dayEntry(0);
    daily.open();
    for (const letter of hitsOf(entry.word)) store.guess(letter);
    TestBed.tick();
    expect(daily.record()?.result).toBe('won');
    expect(daily.state()).toBe('done');
    expect(daily.missesUsed()).toBe(0);
    expect(store.stats()).toEqual({ wins: 1, losses: 0, streak: 1, bestStreak: 1 });
    expect(entry.id in store.collection()).toBe(true);
    expect(daily.alreadyCollected()).toBe(false);
    expect(daily.streak()).toBe(1);
    expect(daily.bestStreak()).toBe(1);

    const text = daily.shareText()!;
    expect(text.split('\n')).toEqual([
      `Hangman Encyclopedia No. 1 ${category.icon}`,
      '🟩'.repeat(hitsOf(entry.word).length),
      'Solved · 0 of 6 misses · 🔥 1 day',
      'hangman-encyclopedia.vercel.app',
    ]);
    expect(text).not.toContain(entry.word);
  });

  it('flags an entry collected before today as a warm-up', () => {
    localStorage.setItem(
      'he.collection',
      JSON.stringify({ [DAILY_SCHEDULE[0]]: '2026-10-20T10:00:00.000Z' }),
    );
    boot(new Date(2026, 10, 2, 8, 0));
    expect(daily.alreadyCollected()).toBe(true);
  });

  describe('corrupt storage', () => {
    it('falls back to an empty ledger when the JSON is broken', () => {
      localStorage.setItem(DAILY_KEY, '{"2026-11-02": {"id": ');
      boot(new Date(2026, 10, 2, 8, 0));
      expect(daily.records()).toEqual({});
      expect(daily.state()).toBe('fresh');
    });

    it('drops bad rows and keeps good ones', () => {
      const good: DailyRecord = { id: DAILY_SCHEDULE[0], guesses: 'Q', hintAt: -1, result: null };
      localStorage.setItem(
        DAILY_KEY,
        JSON.stringify({
          '2026-11-02': good,
          '2026-11-01': { ...good, result: 'won' },
          '2026-11-03': { ...good, id: 'animals:unicorn' },
          tomorrow: good,
        }),
      );
      boot(new Date(2026, 10, 2, 8, 0));
      expect(daily.records()).toEqual({ '2026-11-02': good });
      expect(daily.state()).toBe('in-progress');
    });

    it("ignores a row saved for a different entry than today's", () => {
      const stale: DailyRecord = {
        id: DAILY_SCHEDULE[5],
        guesses: 'Q',
        hintAt: -1,
        result: 'lost',
      };
      localStorage.setItem(DAILY_KEY, JSON.stringify({ '2026-11-02': stale }));
      boot(new Date(2026, 10, 2, 8, 0));
      expect(daily.record()).toBeNull();
      expect(daily.state()).toBe('fresh');
    });
  });

  describe('the clock', () => {
    it('refreshes the countdown every minute', () => {
      boot(new Date(2026, 10, 2, 10, 0));
      expect(daily.msUntilNextDay()).toBe(14 * HOUR);
      vi.advanceTimersByTime(60_000);
      expect(daily.msUntilNextDay()).toBe(14 * HOUR - 60_000);
    });

    it('rolls over to the next entry at local midnight', () => {
      boot(new Date(2026, 10, 2, 23, 59, 0));
      expect(daily.dayNumber()).toBe(1);
      expect(daily.msUntilNextDay()).toBe(60_000);
      vi.advanceTimersByTime(59_000);
      expect(daily.todayKey()).toBe('2026-11-02');
      vi.advanceTimersByTime(1_500);
      expect(daily.todayKey()).toBe('2026-11-03');
      expect(daily.dayNumber()).toBe(2);
      expect(daily.today()?.entry.id).toBe(DAILY_SCHEDULE[1]);
      expect(daily.state()).toBe('fresh');
    });

    it('keeps saving a round opened before midnight to its own day', () => {
      boot(new Date(2026, 10, 2, 23, 59, 0));
      const [m1, m2] = missesOf(dayEntry(0).entry.word, 2);
      daily.open();
      store.guess(m1);
      TestBed.tick();
      vi.advanceTimersByTime(2 * 60_000);
      expect(daily.todayKey()).toBe('2026-11-03');
      store.guess(m2);
      TestBed.tick();
      expect(savedLedger()['2026-11-02'].guesses).toBe(m1 + m2);
      expect(savedLedger()['2026-11-03']).toBeUndefined();
      expect(daily.state()).toBe('fresh');
    });

    it("numbers and shares a round finished after midnight as its own day's", () => {
      boot(new Date(2026, 10, 2, 23, 59, 0));
      const { entry, category } = dayEntry(0);
      const [miss] = missesOf(entry.word, 1);
      daily.open();
      expect(daily.activeDayNo()).toBe(1);
      expect(daily.roundShareText()).toBeNull();
      store.guess(miss);
      TestBed.tick();
      vi.advanceTimersByTime(2 * 60_000);
      for (const letter of hitsOf(entry.word)) store.guess(letter);
      TestBed.tick();

      expect(savedLedger()['2026-11-02'].result).toBe('won');
      // The home card has moved on to No. 2 ...
      expect(daily.dayNumber()).toBe(2);
      expect(daily.state()).toBe('fresh');
      expect(daily.shareText()).toBeNull();
      // ... but the round on the board is still No. 1, and can be shared.
      expect(daily.activeDayNo()).toBe(1);
      expect(daily.roundShareText()?.split('\n')).toEqual([
        `Hangman Encyclopedia No. 1 ${category.icon}`,
        '🟥' + '🟩'.repeat(hitsOf(entry.word).length),
        'Solved · 1 of 6 misses · 🔥 1 day',
        'hangman-encyclopedia.vercel.app',
      ]);

      // Back home, the round-scoped signals fall back to today.
      store.backToCategories();
      expect(daily.activeDayNo()).toBe(2);
      expect(daily.roundShareText()).toBeNull();
    });
  });

  describe('several tabs', () => {
    it('picks up a save from another tab as it happens', () => {
      boot(new Date(2026, 10, 2, 8, 0));
      const [m1, m2] = missesOf(dayEntry(0).entry.word, 2);
      otherTabSaves({
        '2026-11-02': { id: DAILY_SCHEDULE[0], guesses: m1 + m2, hintAt: -1, result: null },
      });
      expect(daily.state()).toBe('in-progress');
      expect(daily.missesUsed()).toBe(2);
    });

    it('pauses a round here once another tab finishes the day, without a loss', () => {
      boot(new Date(2026, 10, 2, 8, 0));
      daily.open();
      store.guess(missesOf(dayEntry(0).entry.word, 1)[0]);
      TestBed.tick();
      otherTabSaves({ '2026-11-02': wonRow(0) });
      expect(store.phase()).toBe('home');
      expect(store.stats().losses).toBe(0);
      expect(daily.state()).toBe('done');
      expect(savedLedger()['2026-11-02']).toEqual(wonRow(0));
    });

    it('never overwrites a day another tab finished, even unannounced', () => {
      boot(new Date(2026, 10, 2, 8, 0));
      const [m1, m2] = missesOf(dayEntry(0).entry.word, 2);
      daily.open();
      store.guess(m1);
      TestBed.tick();
      otherTabSaves({ '2026-11-02': wonRow(0) }, false);

      // The next guess here re-reads storage before saving: the win stands
      // and this tab's round pauses instead of playing a finished day.
      store.guess(m2);
      TestBed.tick();
      expect(savedLedger()['2026-11-02']).toEqual(wonRow(0));
      expect(store.phase()).toBe('home');
      expect(daily.state()).toBe('done');
    });

    it('keeps a finished day even if a stale tab concedes it', () => {
      boot(new Date(2026, 10, 2, 8, 0));
      daily.open();
      store.guess(missesOf(dayEntry(0).entry.word, 1)[0]);
      TestBed.tick();
      otherTabSaves({ '2026-11-02': wonRow(0) }, false);
      store.giveUp();
      TestBed.tick();
      expect(savedLedger()['2026-11-02']).toEqual(wonRow(0));
    });

    it('keeps the days other tabs saved when this one saves', () => {
      boot(new Date(2026, 10, 3, 8, 0));
      daily.open();
      otherTabSaves({ '2026-11-02': wonRow(0) }, false);
      store.guess(missesOf(dayEntry(1).entry.word, 1)[0]);
      TestBed.tick();
      expect(Object.keys(savedLedger()).sort()).toEqual(['2026-11-02', '2026-11-03']);
      expect(daily.streaks()).toEqual({ current: 1, best: 1 });
    });

    it('catches up to a round another tab played further', () => {
      boot(new Date(2026, 10, 2, 8, 0));
      const { word } = dayEntry(0).entry;
      const [m1, m2] = missesOf(word, 2);
      const [hit] = hitsOf(word);
      daily.open();
      store.guess(m1);
      TestBed.tick();
      otherTabSaves({
        '2026-11-02': { id: DAILY_SCHEDULE[0], guesses: m1 + m2, hintAt: 2, result: null },
      });
      expect([...store.guessed()].join('')).toBe(m1 + m2);
      expect(store.hintAt()).toBe(2);
      expect(store.misses()).toBe(3);

      store.guess(hit);
      TestBed.tick();
      expect(savedLedger()['2026-11-02'].guesses).toBe(m1 + m2 + hit);
    });

    it("won't rewind a round another tab played further, unannounced", () => {
      boot(new Date(2026, 10, 2, 8, 0));
      const { word } = dayEntry(0).entry;
      const [m1, m2, m3] = missesOf(word, 3);
      daily.open();
      store.guess(m1);
      TestBed.tick();
      otherTabSaves(
        { '2026-11-02': { id: DAILY_SCHEDULE[0], guesses: m1 + m2, hintAt: -1, result: null } },
        false,
      );
      store.guess(m3);
      TestBed.tick();
      // The other tab's m2 is the real attempt; this tab's board catches up to it.
      expect(savedLedger()['2026-11-02'].guesses).toBe(m1 + m2);
      expect([...store.guessed()].join('')).toBe(m1 + m2);
    });

    it('re-reads storage on the minute tick', () => {
      boot(new Date(2026, 10, 2, 8, 0));
      otherTabSaves({ '2026-11-02': wonRow(0) }, false);
      expect(daily.state()).toBe('fresh');
      vi.advanceTimersByTime(60_000);
      expect(daily.state()).toBe('done');
    });

    it('re-reads storage in open(), so a stale tab cannot replay a finished day', () => {
      boot(new Date(2026, 10, 2, 8, 0));
      otherTabSaves({ '2026-11-02': wonRow(0) }, false);
      daily.open();
      expect(store.phase()).toBe('home');
      expect(daily.state()).toBe('done');
    });
  });

  describe('saved rows must match real play', () => {
    it("drops rows saved for a different day's entry, so they can't build a streak", () => {
      const ledger: Record<string, DailyRecord> = {};
      for (let n = 0; n < 7; n++) ledger[`2026-11-0${2 + n}`] = { ...wonRow(0) };
      localStorage.setItem(DAILY_KEY, JSON.stringify(ledger));
      boot(new Date(2026, 10, 8, 9, 0));
      expect(Object.keys(daily.records())).toEqual(['2026-11-02']);
      expect(daily.streaks()).toEqual({ current: 0, best: 1 });
    });

    it('does not resume a saved round that already solves the word', () => {
      const solved = { ...wonRow(0), result: null };
      localStorage.setItem(DAILY_KEY, JSON.stringify({ '2026-11-02': solved }));
      boot(new Date(2026, 10, 2, 8, 0));
      expect(daily.state()).toBe('fresh');
      daily.open();
      expect(store.phase()).toBe('playing');
      expect(store.guessed().size).toBe(0);
      expect(store.stats()).toEqual({ wins: 0, losses: 0, streak: 0, bestStreak: 0 });
    });
  });

  describe('streaks and calendars', () => {
    /**
     * Seed the ledger with day n (0-based) → result, using each day's real
     * entry: a win solves it without a miss, anything else has no guesses yet.
     */
    function seed(results: Record<number, DailyRecord['result']>): void {
      const ledger: Record<string, DailyRecord> = {};
      for (const [n, result] of Object.entries(results)) {
        const key = `2026-11-${String(2 + Number(n)).padStart(2, '0')}`;
        const { word } = dayEntry(Number(n)).entry;
        const guesses = result === 'won' ? hitsOf(word).join('') : '';
        ledger[key] = { id: DAILY_SCHEDULE[Number(n)], guesses, hintAt: -1, result };
      }
      localStorage.setItem(DAILY_KEY, JSON.stringify(ledger));
    }

    it('derives the daily streak from consecutive won days', () => {
      // Mon–Wed won, Thu lost, Fri–Sat won; Sunday (today) still open.
      seed({ 0: 'won', 1: 'won', 2: 'won', 3: 'lost', 4: 'won', 5: 'won' });
      boot(new Date(2026, 10, 8, 9, 0));
      expect(daily.streak()).toBe(2);
      expect(daily.bestStreak()).toBe(3);
      expect(daily.streaks()).toEqual({ current: 2, best: 3 });
    });

    it('drops the streak once a day is skipped', () => {
      seed({ 0: 'won', 1: 'won' });
      boot(new Date(2026, 10, 5, 9, 0));
      expect(daily.streak()).toBe(0);
      expect(daily.bestStreak()).toBe(2);
    });

    it("lays out this week's strip, Monday first", () => {
      seed({ 0: 'won', 1: 'lost' });
      boot(new Date(2026, 10, 4, 9, 0)); // Wednesday
      expect(daily.weekStrip().map((d) => [d.weekday, d.state, d.isToday])).toEqual([
        ['Mon', 'won', false],
        ['Tue', 'lost', false],
        ['Wed', 'open', true],
        ['Thu', 'future', false],
        ['Fri', 'future', false],
        ['Sat', 'future', false],
        ['Sun', 'future', false],
      ]);
      expect(daily.weekStrip()[0].key).toBe('2026-11-02');
    });

    it('builds a Monday-first month grid for the ledger', () => {
      seed({ 0: 'won', 1: 'lost', 2: null });
      boot(new Date(2026, 10, 4, 9, 0));
      const weeks = daily.monthGrid(2026, 10);
      expect(weeks).toHaveLength(6);
      expect(weeks.every((w) => w.length === 7)).toBe(true);

      // 1 November 2026 is a Sunday: six leading pads, then a pre-launch day.
      expect(weeks[0].slice(0, 6).every((c) => c.key === null && c.state === 'before')).toBe(true);
      expect(weeks[0][6]).toEqual({
        key: '2026-11-01',
        day: 1,
        state: 'before',
        misses: null,
        isToday: false,
      });

      const [mon, tue, wed, thu] = weeks[1];
      expect(mon).toMatchObject({ key: '2026-11-02', state: 'won', misses: 0 });
      expect(tue).toMatchObject({ key: '2026-11-03', state: 'lost', misses: 0 });
      expect(wed).toMatchObject({ key: '2026-11-04', state: 'open', misses: 0, isToday: true });
      expect(thu).toMatchObject({
        key: '2026-11-05',
        state: 'future',
        misses: null,
        isToday: false,
      });

      const last = weeks[5];
      expect(last[0]).toMatchObject({ key: '2026-11-30', day: 30 });
      expect(last.slice(1).every((c) => c.key === null && c.state === 'future')).toBe(true);
    });

    it('marks every day of a pre-launch month as before', () => {
      boot(new Date(2026, 10, 4, 9, 0));
      const cells = daily
        .monthGrid(2026, 9)
        .flat()
        .filter((c) => c.key !== null);
      expect(cells).toHaveLength(31);
      expect(cells.every((c) => c.state === 'before' && c.misses === null)).toBe(true);
    });
  });
});
