import { TOTAL_ENTRIES, WORD_BANKS } from './word-banks';

/**
 * Content guard-rails: every entry must be playable, uniquely addressable
 * (the saved collection persists against ids), and must not give its answer away.
 */
describe('WORD_BANKS', () => {
  const all = WORD_BANKS.flatMap((category) => category.entries.map((entry) => ({ category, entry })));
  const STOP_WORDS = new Set(['THE', 'OF', 'AND']);

  it('uses only A–Z with single spaces or hyphens between words', () => {
    const bad = all.filter(({ entry }) => !/^[A-Z]+(?:[ -][A-Z]+)*$/.test(entry.word));
    expect(bad.map(({ entry }) => entry.word)).toEqual([]);
  });

  it('gives every entry a unique id', () => {
    const ids = all.map(({ entry }) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never repeats a word across volumes', () => {
    const seen = new Map<string, string>();
    const repeats: string[] = [];
    for (const { category, entry } of all) {
      const first = seen.get(entry.word);
      if (first) repeats.push(`${entry.word} (${first} + ${category.id})`);
      seen.set(entry.word, category.id);
    }
    expect(repeats).toEqual([]);
  });

  it('keeps hints free of the answer, its plurals, and its stems', () => {
    const leaks = all.filter(({ entry }) => {
      const answer = entry.word.split(/[ -]/).filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
      const hintWords = entry.hint.toUpperCase().split(/[^A-Z]+/).filter(Boolean);
      return hintWords.some((w) =>
        answer.some(
          (t) =>
            w === t ||
            w === `${t}S` ||
            w === `${t}ES` ||
            (t.length >= 4 && w.startsWith(t)) ||
            (w.length >= 5 && t.startsWith(w)),
        ),
      );
    });
    expect(leaks.map(({ entry }) => `${entry.word}: ${entry.hint}`)).toEqual([]);
  });

  it('has well-formed hints, facts, and difficulties', () => {
    const bad = all.filter(
      ({ entry }) =>
        !entry.hint.trim() ||
        entry.hint.length > 90 ||
        entry.fact.length < 90 ||
        entry.fact.length > 280 ||
        !['easy', 'medium', 'hard'].includes(entry.difficulty),
    );
    expect(bad.map(({ entry }) => entry.id)).toEqual([]);
  });

  it('offers every difficulty in every volume', () => {
    for (const category of WORD_BANKS) {
      const levels = new Set(category.entries.map((e) => e.difficulty));
      expect([category.id, [...levels].sort()]).toEqual([category.id, ['easy', 'hard', 'medium']]);
    }
  });

  it('counts every entry in TOTAL_ENTRIES', () => {
    expect(TOTAL_ENTRIES).toBe(all.length);
  });
});
