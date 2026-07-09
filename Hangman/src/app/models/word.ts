export type Difficulty = 'easy' | 'medium' | 'hard';

/** One playable word plus the encyclopedia entry it unlocks. */
export interface WordEntry {
  /** Stable id (`category:word-slug`) — the collection persists against this. */
  id: string;
  /** UPPERCASE; letters A–Z, spaces, and hyphens only. */
  word: string;
  /** Short clue that never contains the word itself. */
  hint: string;
  /** The "did you know" fact revealed when the round ends. */
  fact: string;
  difficulty: Difficulty;
}

/** Entry as authored in the data files, before an id is assigned. */
export type RawEntry = Omit<WordEntry, 'id'>;

export interface WordCategory {
  id: string;
  name: string;
  icon: string;
  color: string;
  tagline: string;
  entries: WordEntry[];
}
