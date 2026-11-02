import { Difficulty } from '../models/word';
import { DAILY_EPOCH, scheduleHash, weekdayIndex } from '../services/daily-math';
import { DAILY_SCHEDULE, DAILY_SCHEDULE_LOCK } from './daily-schedule';
import { ENTRY_INDEX, TOTAL_ENTRIES, WORD_BANKS } from './word-banks';

/**
 * The order published on launch day. Players compare days with each other,
 * so this must never change; `--append` only ever adds weeks after it.
 */
const LAUNCH = { length: 434, hash: 'ef5f90e4' };
const PRIMARY: Difficulty[] = ['easy', 'easy', 'medium', 'medium', 'medium', 'hard', 'hard'];
const SUNDAY = 6;

const volumeOf = (id: string) => ENTRY_INDEX.get(id)?.category.id;
const tierOf = (id: string) => ENTRY_INDEX.get(id)?.entry.difficulty;

describe('DAILY_SCHEDULE', () => {
  it('schedules every entry exactly once', () => {
    const bank = WORD_BANKS.flatMap((c) => c.entries.map((e) => e.id)).sort();
    expect([...DAILY_SCHEDULE].sort()).toEqual(bank);
    expect(DAILY_SCHEDULE.length).toBe(TOTAL_ENTRIES);
  });

  it('lists only known ids', () => {
    expect(DAILY_SCHEDULE.filter((id) => !ENTRY_INDEX.has(id))).toEqual([]);
  });

  it('fills whole weeks that start on a Monday', () => {
    expect(DAILY_SCHEDULE.length % 7).toBe(0);
    expect(weekdayIndex(DAILY_EPOCH)).toBe(0);
  });

  it('never gives the same volume two days running, wrap-around included', () => {
    const clashes = DAILY_SCHEDULE.flatMap((id, i) => {
      const next = DAILY_SCHEDULE[(i + 1) % DAILY_SCHEDULE.length];
      return volumeOf(id) === volumeOf(next) ? [`No. ${i + 1}: ${id} → ${next}`] : [];
    });
    expect(clashes).toEqual([]);
  });

  it('matches its lock', () => {
    expect(DAILY_SCHEDULE_LOCK.length).toBe(DAILY_SCHEDULE.length);
    expect(DAILY_SCHEDULE_LOCK.hash).toBe(scheduleHash(DAILY_SCHEDULE));
  });

  it('keeps the launch order exactly as published', () => {
    expect(scheduleHash(DAILY_SCHEDULE.slice(0, LAUNCH.length))).toBe(LAUNCH.hash);
  });

  describe('difficulty by weekday (launch weeks)', () => {
    const launch = DAILY_SCHEDULE.slice(0, LAUNCH.length);
    const borrowed = launch.flatMap((id, i) => {
      const weekday = i % 7;
      const tier = tierOf(id);
      const leftoverSunday = weekday === SUNDAY && tier === 'easy';
      return tier === PRIMARY[weekday] || leftoverSunday ? [] : [{ i, wanted: PRIMARY[weekday] }];
    });

    it('is Mon–Tue easy, Wed–Fri medium, Sat hard, Sun hard, bar a few borrowed days', () => {
      expect(borrowed.length).toBeLessThanOrEqual(3);
    });

    it('borrows only once the wanted tier has run out', () => {
      for (const { i, wanted } of borrowed) {
        const later = launch.slice(i + 1).filter((id) => tierOf(id) === wanted);
        expect(later, `No. ${i + 1} borrowed while ${wanted} words remained`).toEqual([]);
      }
    });

    it('spreads the leftover-easy Sundays out instead of bunching them', () => {
      const sundays = launch.filter((_, i) => i % 7 === SUNDAY).map(tierOf);
      // Only as many easy Sundays as hard runs short by, never two weeks running.
      const hard = launch.filter((id) => tierOf(id) === 'hard').length;
      const saturdays = launch.length / 7;
      expect(sundays.filter((t) => t === 'easy').length).toBe(sundays.length - (hard - saturdays));
      expect(sundays.join(' ')).not.toMatch(/easy easy/);
    });

    it('keeps every Saturday hard', () => {
      expect(launch.filter((_, i) => i % 7 === 5).every((id) => tierOf(id) === 'hard')).toBe(true);
    });
  });
});
