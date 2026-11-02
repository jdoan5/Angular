/**
 * Pure helpers behind "Today's Entry": day keys, day numbers, the countdown,
 * the spoiler-free share text and the saved-ledger sanitiser.
 *
 * Deliberately free of Angular (and of the word banks): the schedule
 * generator in scripts/daily-schedule.mjs bundles this file with esbuild to
 * reuse `scheduleHash`, and the tests can exercise it without a TestBed.
 */

/** The first daily (No. 1) — a Monday, so schedule weeks line up Mon–Sun. */
export const DAILY_EPOCH = '2026-11-02';

export const DAY_MS = 86_400_000;

/** One saved day in the 'he.daily' ledger, keyed by its local 'YYYY-MM-DD'. */
export interface DailyRecord {
  id: string;
  /** Letters A–Z in the order they were guessed, each at most once. */
  guesses: string;
  /** How many guesses had been made when the hint was bought; -1 = no hint. */
  hintAt: number;
  result: 'won' | 'lost' | null;
}

const KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad2 = (n: number) => String(n).padStart(2, '0');

function keyFromUtc(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * Midnight UTC of a day key. Day arithmetic happens on these UTC stamps so a
 * 23- or 25-hour local day (DST) can never add or lose a day.
 */
function keyToUtc(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** True for a real calendar date written as 'YYYY-MM-DD'. */
export function isDayKey(key: string): boolean {
  const match = KEY_PATTERN.exec(key);
  return match !== null && keyFromUtc(keyToUtc(key)) === key;
}

/** The player's LOCAL calendar date as 'YYYY-MM-DD' (built from local parts). */
export function localDayKey(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** The day key for a calendar date; out-of-range parts roll over like Date's. */
export function dayKeyOf(year: number, month0: number, day: number): string {
  return keyFromUtc(Date.UTC(year, month0, day));
}

/** The day key `days` calendar days after (or before, if negative) `key`. */
export function addDays(key: string, days: number): string {
  return keyFromUtc(keyToUtc(key) + days * DAY_MS);
}

/** 0 = Monday … 6 = Sunday. */
export function weekdayIndex(key: string): number {
  return (new Date(keyToUtc(key)).getUTCDay() + 6) % 7;
}

/**
 * Whole days from the epoch to `key`: 0 on launch day, negative before it.
 * The player-facing "No." is this plus one.
 */
export function dayNumber(key: string, epoch: string = DAILY_EPOCH): number {
  return Math.round((keyToUtc(key) - keyToUtc(epoch)) / DAY_MS);
}

/**
 * The scheduled id for a 0-based day number; null before the epoch.
 * Once the schedule runs out it loops. Because the loop depends on the
 * length, `--append` is only safe before the first loop begins (the
 * generator refuses after that), or days already played would change entry.
 */
export function scheduledIdFor(dayNo: number, schedule: readonly string[]): string | null {
  if (dayNo < 0 || schedule.length === 0) return null;
  return schedule[dayNo % schedule.length];
}

/** Milliseconds until the next local midnight (23 h or 25 h away on DST days). */
export function msUntilNextDay(now: Date): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return next.getTime() - now.getTime();
}

/** 'Hh Mm', rounded up to the minute so it never reads 0m while time remains. */
export function formatCountdown(ms: number): string {
  const minutes = Math.max(0, Math.ceil(ms / 60_000));
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Misses a round has cost: wrong letters, plus one if the hint was bought. */
export function missesFor(guesses: string, word: string, hintAt: number): number {
  let wrong = 0;
  for (const letter of guesses) {
    if (!word.includes(letter)) wrong++;
  }
  return wrong + (hintAt >= 0 ? 1 : 0);
}

/**
 * One glyph per guess in the order played — 🟩 hit, 🟥 miss — with 💡 at the
 * point the hint was bought. Only hit/miss survives, never which letter.
 */
export function shareGlyphs(guesses: string, word: string, hintAt: number): string {
  let out = '';
  [...guesses].forEach((letter, i) => {
    if (i === hintAt) out += '💡';
    out += word.includes(letter) ? '🟩' : '🟥';
  });
  if (hintAt >= 0 && hintAt >= guesses.length) out += '💡';
  return out;
}

export interface ShareInput {
  /** The player-facing number (day number + 1). */
  dailyNo: number;
  /** The volume's emoji. */
  icon: string;
  word: string;
  guesses: string;
  hintAt: number;
  result: 'won' | 'lost';
  maxMisses: number;
  /** Daily streak including this day. */
  streak: number;
}

export const SHARE_URL = 'hangman-encyclopedia.vercel.app';

/** The four-line, spoiler-free result a player can paste anywhere. */
export function shareText(input: ShareInput): string {
  const misses = missesFor(input.guesses, input.word, input.hintAt);
  const tally = `${misses} of ${input.maxMisses} misses`;
  const outcome =
    input.result === 'won'
      ? `Solved · ${tally} · 🔥 ${input.streak} ${input.streak === 1 ? 'day' : 'days'}`
      : // A concession can end a day early, so this is the real count, not always 6.
        `Missed · ${tally}`;
  // A day conceded before any guess still gets a visible second line.
  const glyphs = shareGlyphs(input.guesses, input.word, input.hintAt) || '—';
  return [
    `Hangman Encyclopedia No. ${input.dailyNo} ${input.icon}`,
    glyphs,
    outcome,
    SHARE_URL,
  ].join('\n');
}

/**
 * Daily streaks, derived from the ledger rather than stored: `current` counts
 * consecutive won days ending today — or ending yesterday while today is
 * still open, so an unplayed morning doesn't read as a broken streak.
 */
export function dailyStreaks(
  records: Readonly<Record<string, DailyRecord>>,
  todayKey: string,
): { current: number; best: number } {
  const won = (key: string) => records[key]?.result === 'won';

  let current = 0;
  let key = todayKey;
  if (!won(key)) {
    if (records[key]?.result === 'lost') key = '';
    else key = addDays(todayKey, -1);
  }
  while (key && won(key)) {
    current++;
    key = addDays(key, -1);
  }

  let best = 0;
  let run = 0;
  let previous = '';
  for (const day of Object.keys(records).filter(won).sort()) {
    run = previous && addDays(previous, 1) === day ? run + 1 : 1;
    best = Math.max(best, run);
    previous = day;
  }
  return { current, best: Math.max(best, current) };
}

/**
 * Play saved guesses back under the game's rules: how the round stands
 * afterwards ('won', 'lost' on the last miss, or null while it's still open),
 * or 'impossible' when real play couldn't produce them: a guess after the
 * round ended, or a hint bought on the last miss or after the end.
 */
export function replayOutcome(
  guesses: string,
  word: string,
  hintAt: number,
  maxMisses: number,
): 'won' | 'lost' | null | 'impossible' {
  const letters = new Set(word.replace(/[^A-Z]/g, ''));
  const found = new Set<string>();
  let wrong = 0;
  let hint = 0;
  let end: 'won' | 'lost' | null = null;
  for (let i = 0; i <= guesses.length; i++) {
    if (i === hintAt) {
      // GameStore.hintAvailable: never after the end, never the losing miss.
      if (end || wrong >= maxMisses - 1) return 'impossible';
      hint = 1;
    }
    if (i === guesses.length) break;
    if (end) return 'impossible';
    const letter = guesses[i];
    if (letters.has(letter)) {
      found.add(letter);
      if (found.size === letters.size) end = 'won';
    } else if (++wrong + hint >= maxMisses) {
      end = 'lost';
    }
  }
  return end;
}

/**
 * Could real play have saved this row for `word`? A win must solve it; an
 * unfinished day must still be open; a loss may be a sixth miss or a
 * concession at any point, but never a solved board.
 */
export function isPlausibleRecord(record: DailyRecord, word: string, maxMisses: number): boolean {
  const end = replayOutcome(record.guesses, word, record.hintAt, maxMisses);
  if (end === 'impossible') return false;
  return record.result === 'lost' ? end !== 'won' : record.result === end;
}

function isRecordShape(value: unknown): value is DailyRecord {
  if (typeof value !== 'object' || value === null) return false;
  const { id, guesses, hintAt, result } = value as Record<string, unknown>;
  return (
    typeof id === 'string' &&
    typeof guesses === 'string' &&
    /^[A-Z]{0,26}$/.test(guesses) &&
    new Set(guesses).size === guesses.length &&
    typeof hintAt === 'number' &&
    Number.isInteger(hintAt) &&
    hintAt >= -1 &&
    hintAt <= guesses.length &&
    (result === 'won' || result === 'lost' || result === null)
  );
}

/** What the sanitiser checks each saved row against. */
export interface LedgerRules {
  /** The entry scheduled for a day key (undefined if none). */
  scheduledFor: (key: string) => { id: string; word: string } | undefined;
  maxMisses: number;
}

/**
 * Rebuild the saved ledger from whatever localStorage handed back, keeping
 * only well-formed rows on real days since the epoch, saved for the entry
 * scheduled that day, that real play could have produced. Anything else
 * (hand edits, old formats, another day's entry, impossible boards) is
 * dropped: it would inflate streaks, or end a round the moment it resumed.
 */
export function sanitizeLedger(raw: unknown, rules: LedgerRules): Record<string, DailyRecord> {
  const clean: Record<string, DailyRecord> = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return clean;
  for (const [key, value] of Object.entries(raw)) {
    if (!isDayKey(key) || key < DAILY_EPOCH || !isRecordShape(value)) continue;
    const scheduled = rules.scheduledFor(key);
    if (!scheduled || scheduled.id !== value.id) continue;
    if (!isPlausibleRecord(value, scheduled.word, rules.maxMisses)) continue;
    clean[key] = {
      id: value.id,
      guesses: value.guesses,
      hintAt: value.hintAt,
      result: value.result,
    };
  }
  return clean;
}

/**
 * FNV-1a (32-bit) over the ids, newline-joined, as 8 hex digits. Pins the
 * published order: the generator writes it, the schedule spec re-checks it.
 */
export function scheduleHash(ids: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const char of ids.join('\n')) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
