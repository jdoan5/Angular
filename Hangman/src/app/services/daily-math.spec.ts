import {
  addDays,
  DAILY_EPOCH,
  dailyStreaks,
  DailyRecord,
  dayNumber,
  formatCountdown,
  isPlausibleRecord,
  LedgerRules,
  localDayKey,
  msUntilNextDay,
  replayOutcome,
  sanitizeLedger,
  scheduledIdFor,
  scheduleHash,
  shareGlyphs,
  shareText,
  weekdayIndex,
} from './daily-math';

const HOUR = 3_600_000;

/**
 * Run `fn` with the process in another time zone. Node re-reads TZ whenever
 * it is assigned, so the DST cases below are real 23- and 25-hour days.
 */
function inTimeZone(zone: string, fn: () => void): void {
  const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process!
    .env;
  const before = env['TZ'];
  env['TZ'] = zone;
  try {
    fn();
  } finally {
    if (before === undefined) delete env['TZ'];
    else env['TZ'] = before;
  }
}

describe('daily day numbers', () => {
  it('builds the key from local calendar parts', () => {
    expect(localDayKey(new Date(2026, 10, 2, 0, 0))).toBe('2026-11-02');
    expect(localDayKey(new Date(2026, 10, 2, 23, 59, 59))).toBe('2026-11-02');
    expect(localDayKey(new Date(2027, 0, 9, 12))).toBe('2027-01-09');
  });

  it('counts whole days from the epoch, negative before it', () => {
    expect(DAILY_EPOCH).toBe('2026-11-02');
    expect(weekdayIndex(DAILY_EPOCH)).toBe(0); // a Monday
    expect(dayNumber('2026-11-02')).toBe(0);
    expect(dayNumber('2026-11-03')).toBe(1);
    expect(dayNumber('2026-11-01')).toBe(-1);
    expect(dayNumber('2027-11-02')).toBe(365);
    expect(dayNumber('2028-11-02')).toBe(731); // through 29 Feb 2028
  });

  it('steps day keys across month, year, and leap-day boundaries', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-11-02', -1)).toBe('2026-11-01');
  });

  for (const [zone, springForward, fallBack] of [
    ['America/New_York', [2027, 2, 14], [2027, 10, 7]],
    ['Europe/London', [2027, 2, 28], [2027, 9, 31]],
  ] as const) {
    it(`is DST-safe in ${zone} across a 23-hour and a 25-hour day`, () => {
      inTimeZone(zone, () => {
        const [sy, sm, sd] = springForward;
        const [fy, fm, fd] = fallBack;
        // Prove the zone switch took: these really are short and long days.
        expect(msUntilNextDay(new Date(sy, sm, sd))).toBe(23 * HOUR);
        expect(msUntilNextDay(new Date(fy, fm, fd))).toBe(25 * HOUR);

        for (const [y, m, d] of [springForward, fallBack]) {
          const key = localDayKey(new Date(y, m, d, 12));
          // Last minute of the day and first minute of the next are one day apart.
          expect(dayNumber(localDayKey(new Date(y, m, d, 23, 59)))).toBe(dayNumber(key));
          expect(dayNumber(localDayKey(new Date(y, m, d + 1, 0, 1)))).toBe(dayNumber(key) + 1);

          // Hour by hour through the DST day, the number only ever steps by one.
          let previous = dayNumber(localDayKey(new Date(y, m, d - 1, 12)));
          const start = new Date(y, m, d - 1, 12).getTime();
          for (let t = start; t <= start + 48 * HOUR; t += HOUR) {
            const n = dayNumber(localDayKey(new Date(t)));
            expect(n - previous === 0 || n - previous === 1).toBe(true);
            previous = n;
          }
          expect(previous).toBe(dayNumber(key) + 1);
        }
      });
    });
  }
});

describe('scheduledIdFor', () => {
  const schedule = ['a', 'b', 'c'];

  it('has no daily before the epoch', () => {
    expect(scheduledIdFor(-1, schedule)).toBeNull();
    expect(scheduledIdFor(0, [])).toBeNull();
  });

  it('loops the schedule once it runs out', () => {
    expect(scheduledIdFor(0, schedule)).toBe('a');
    expect(scheduledIdFor(2, schedule)).toBe('c');
    expect(scheduledIdFor(4, schedule)).toBe('b');
  });
});

describe('countdown', () => {
  it('measures to the next local midnight', () => {
    expect(msUntilNextDay(new Date(2026, 10, 2, 23, 59, 30))).toBe(30_000);
    expect(msUntilNextDay(new Date(2026, 10, 2, 18, 0))).toBe(6 * HOUR);
  });

  it('formats hours and minutes, rounding up to the minute', () => {
    expect(formatCountdown(6 * HOUR)).toBe('6h 0m');
    expect(formatCountdown(HOUR + 61_000)).toBe('1h 2m');
    expect(formatCountdown(30_000)).toBe('0h 1m');
    expect(formatCountdown(0)).toBe('0h 0m');
    expect(formatCountdown(-5_000)).toBe('0h 0m');
    expect(formatCountdown(24 * HOUR)).toBe('24h 0m');
  });
});

describe('share text', () => {
  const base = { dailyNo: 7, icon: '🦁', maxMisses: 6, streak: 3 } as const;

  it('draws one glyph per guess in order, with 💡 where the hint was bought', () => {
    expect(shareGlyphs('EQT', 'TIGER', -1)).toBe('🟩🟥🟩');
    expect(shareGlyphs('EQT', 'TIGER', 0)).toBe('💡🟩🟥🟩');
    expect(shareGlyphs('EQT', 'TIGER', 2)).toBe('🟩🟥💡🟩');
    expect(shareGlyphs('EQT', 'TIGER', 3)).toBe('🟩🟥🟩💡');
    expect(shareGlyphs('', 'TIGER', 0)).toBe('💡');
  });

  it('writes four lines for a solved day', () => {
    const text = shareText({ ...base, word: 'TIGER', guesses: 'TQIGER', hintAt: 1, result: 'won' });
    expect(text.split('\n')).toEqual([
      'Hangman Encyclopedia No. 7 🦁',
      '🟩💡🟥🟩🟩🟩🟩',
      'Solved · 2 of 6 misses · 🔥 3 days',
      'hangman-encyclopedia.vercel.app',
    ]);
  });

  it('says "day" for a one-day streak and reports a miss without a streak', () => {
    const won = shareText({
      ...base,
      streak: 1,
      word: 'CAT',
      guesses: 'CAT',
      hintAt: -1,
      result: 'won',
    });
    expect(won.split('\n')[2]).toBe('Solved · 0 of 6 misses · 🔥 1 day');
    const lost = shareText({ ...base, word: 'CAT', guesses: 'QWXYZJ', hintAt: -1, result: 'lost' });
    expect(lost.split('\n').slice(1, 3)).toEqual(['🟥🟥🟥🟥🟥🟥', 'Missed · 6 of 6 misses']);
  });

  it('gives a day conceded before any guess a visible glyph line', () => {
    const text = shareText({ ...base, word: 'CAT', guesses: '', hintAt: -1, result: 'lost' });
    expect(text.split('\n')).toHaveLength(4);
    expect(text.split('\n')[1]).toBe('—');
  });

  it('is spoiler-free: same hits and misses, same text, whatever the word', () => {
    const a = shareText({ ...base, word: 'TIGER', guesses: 'TQIGER', hintAt: 1, result: 'won' });
    const b = shareText({ ...base, word: 'LUNAR', guesses: 'LQUNAR', hintAt: 1, result: 'won' });
    expect(a).toBe(b);
    expect(a).not.toContain('TIGER');
    // Nothing but glyphs and counts: no guessed letter survives.
    const [, glyphs, tally] = a.split('\n');
    expect(glyphs).toMatch(/^(?:🟩|🟥|💡)+$/u);
    expect(tally).toMatch(/^Solved · \d of 6 misses · 🔥 \d+ days?$/u);
  });
});

describe('replayOutcome', () => {
  it('plays saved guesses back under the game rules', () => {
    expect(replayOutcome('', 'TIGER', -1, 6)).toBeNull();
    expect(replayOutcome('TQ', 'TIGER', 1, 6)).toBeNull();
    expect(replayOutcome('TIGER', 'TIGER', -1, 6)).toBe('won');
    expect(replayOutcome('ABCDFH', 'TIGER', -1, 6)).toBe('lost');
    // The hint is a miss too: five wrong letters after it lose the round.
    expect(replayOutcome('ABCDF', 'TIGER', 0, 6)).toBe('lost');
    // Spaces and hyphens never need guessing.
    expect(replayOutcome('ICEAG', 'ICE AGE', -1, 6)).toBe('won');
  });

  it('calls out boards real play could not reach', () => {
    expect(replayOutcome('TIGERA', 'TIGER', -1, 6)).toBe('impossible'); // a guess after the win
    expect(replayOutcome('ABCDFHJ', 'TIGER', -1, 6)).toBe('impossible'); // a guess after the loss
    expect(replayOutcome('ABCDF', 'TIGER', 5, 6)).toBe('impossible'); // a hint on the last miss
    expect(replayOutcome('TIGER', 'TIGER', 5, 6)).toBe('impossible'); // a hint after the win
  });
});

describe('isPlausibleRecord', () => {
  const row = (guesses: string, result: DailyRecord['result'], hintAt = -1): DailyRecord => ({
    id: 'animals:tiger',
    guesses,
    hintAt,
    result,
  });

  it('accepts what real play saves', () => {
    expect(isPlausibleRecord(row('TQ', null), 'TIGER', 6)).toBe(true);
    expect(isPlausibleRecord(row('TIGER', 'won', 2), 'TIGER', 6)).toBe(true);
    expect(isPlausibleRecord(row('ABCDFH', 'lost'), 'TIGER', 6)).toBe(true);
    // A concession can end the day at any point, even before a guess.
    expect(isPlausibleRecord(row('TQ', 'lost'), 'TIGER', 6)).toBe(true);
    expect(isPlausibleRecord(row('', 'lost'), 'TIGER', 6)).toBe(true);
  });

  it('rejects rows that disagree with their own guesses', () => {
    expect(isPlausibleRecord(row('TIGER', null), 'TIGER', 6)).toBe(false); // solved, yet open
    expect(isPlausibleRecord(row('ABCDFH', null), 'TIGER', 6)).toBe(false); // six misses, yet open
    expect(isPlausibleRecord(row('TQ', 'won'), 'TIGER', 6)).toBe(false); // won without solving
    expect(isPlausibleRecord(row('', 'won'), 'TIGER', 6)).toBe(false);
    expect(isPlausibleRecord(row('TIGER', 'lost'), 'TIGER', 6)).toBe(false); // lost a solved board
  });
});

describe('sanitizeLedger', () => {
  const good: DailyRecord = { id: 'animals:tiger', guesses: 'TQ', hintAt: 1, result: null };
  /** Tiger every day, except a lion on 3 November. */
  const rules: LedgerRules = {
    scheduledFor: (key) =>
      key === '2026-11-03'
        ? { id: 'animals:lion', word: 'LION' }
        : { id: 'animals:tiger', word: 'TIGER' },
    maxMisses: 6,
  };

  it('keeps well-formed rows', () => {
    expect(sanitizeLedger({ '2026-11-02': good }, rules)).toEqual({ '2026-11-02': good });
  });

  it('returns an empty ledger for anything that is not an object', () => {
    for (const raw of [null, undefined, 'x', 42, [], [good]]) {
      expect(sanitizeLedger(raw, rules)).toEqual({});
    }
  });

  it('drops bad rows and keeps the rest', () => {
    const raw = {
      '2026-11-02': good,
      '2026-11-04': { ...good, guesses: 'tq' }, // lowercase
      '2026-11-05': { ...good, guesses: 'TT' }, // repeated letter
      '2026-11-06': { ...good, hintAt: 3 }, // hint after more guesses than exist
      '2026-11-07': { ...good, hintAt: 0.5 },
      '2026-11-08': { ...good, result: 'draw' },
      '2026-11-09': { ...good, id: 42 },
      '2026-11-10': 'won',
      '2026-02-30': good, // not a real date
      '2026-11-1': good,
      '2026-10-31': good, // before the epoch
    };
    expect(sanitizeLedger(raw, rules)).toEqual({ '2026-11-02': good });
  });

  it("drops a row saved for some other day's entry", () => {
    const raw = {
      '2026-11-03': good, // the tiger, on the lion's day
      '2026-11-04': { ...good, id: 'animals:unicorn' }, // not in the banks at all
      '2026-11-05': good,
    };
    expect(sanitizeLedger(raw, rules)).toEqual({ '2026-11-05': good });
    expect(sanitizeLedger(raw, { ...rules, scheduledFor: () => undefined })).toEqual({});
  });

  it('drops rows real play could not have saved', () => {
    const raw = {
      '2026-11-02': { ...good, guesses: 'TIGER', hintAt: -1 }, // solved but still open
      '2026-11-04': { ...good, guesses: 'ABCDFH', hintAt: -1 }, // six misses but still open
      '2026-11-05': { ...good, result: 'won' }, // won without solving
      '2026-11-06': { ...good, guesses: 'ABCDF', hintAt: 5 }, // hint bought on the last miss
      '2026-11-07': { ...good, result: 'lost' }, // a concession: fine
    };
    expect(sanitizeLedger(raw, rules)).toEqual({ '2026-11-07': { ...good, result: 'lost' } });
  });

  it('ignores a "__proto__" key from parsed JSON', () => {
    const clean = sanitizeLedger(JSON.parse(`{"__proto__": ${JSON.stringify(good)}}`), rules);
    expect(clean).toEqual({});
    expect(Object.getPrototypeOf(clean)).toBe(Object.prototype);
  });

  it('copies only the known fields', () => {
    const clean = sanitizeLedger({ '2026-11-02': { ...good, extra: 'x' } }, rules);
    expect(Object.keys(clean['2026-11-02']).sort()).toEqual(['guesses', 'hintAt', 'id', 'result']);
  });
});

describe('dailyStreaks', () => {
  const day = (result: DailyRecord['result']): DailyRecord => ({
    id: 'x',
    guesses: '',
    hintAt: -1,
    result,
  });

  it('counts back from today, or from yesterday while today is open', () => {
    const records = { '2026-11-02': day('won'), '2026-11-03': day('won') };
    expect(dailyStreaks(records, '2026-11-03')).toEqual({ current: 2, best: 2 });
    expect(dailyStreaks(records, '2026-11-04')).toEqual({ current: 2, best: 2 });
    expect(dailyStreaks({ ...records, '2026-11-04': day(null) }, '2026-11-04').current).toBe(2);
  });

  it('breaks on a loss or a skipped day, but remembers the best run', () => {
    const records = {
      '2026-11-02': day('won'),
      '2026-11-03': day('won'),
      '2026-11-04': day('won'),
      '2026-11-05': day('lost'),
      '2026-11-06': day('won'),
      '2026-11-08': day('won'),
    };
    expect(dailyStreaks(records, '2026-11-08')).toEqual({ current: 1, best: 3 });
    expect(dailyStreaks(records, '2026-11-10')).toEqual({ current: 0, best: 3 });
    expect(dailyStreaks({ ...records, '2026-11-09': day('lost') }, '2026-11-09').current).toBe(0);
  });
});

describe('scheduleHash', () => {
  it('is 32-bit FNV-1a over the newline-joined ids', () => {
    expect(scheduleHash([])).toBe('811c9dc5');
    expect(scheduleHash(['a'])).toBe('e40c292c');
    expect(scheduleHash(['a', 'b'])).not.toBe(scheduleHash(['b', 'a']));
  });
});
