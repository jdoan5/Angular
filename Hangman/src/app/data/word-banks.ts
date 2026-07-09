import { RawEntry, WordCategory, WordEntry } from '../models/word';
import { ANIMALS } from './banks/animals';
import { ARTS } from './banks/arts';
import { FOOD } from './banks/food';
import { GEOGRAPHY } from './banks/geography';
import { HISTORY } from './banks/history';
import { SCIENCE } from './banks/science';
import { SPACE } from './banks/space';
import { SPORTS } from './banks/sports';

function slug(word: string): string {
  return word.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
}

function withIds(categoryId: string, entries: RawEntry[]): WordEntry[] {
  return entries.map((e) => ({ ...e, id: `${categoryId}:${slug(e.word)}` }));
}

function category(
  id: string,
  name: string,
  icon: string,
  color: string,
  tagline: string,
  entries: RawEntry[],
): WordCategory {
  return { id, name, icon, color, tagline, entries: withIds(id, entries) };
}

/** Every playable category. Entry ids are stable — the collection persists against them. */
export const WORD_BANKS: WordCategory[] = [
  category('animals', 'Animals', '🦁', '#b45309', 'Creatures of land, sea, and air', ANIMALS),
  category('geography', 'Geography', '🌍', '#1d4ed8', 'Places, peaks, and rivers', GEOGRAPHY),
  category('science', 'Science', '🔬', '#0f766e', 'Elements, forces, and life', SCIENCE),
  category('history', 'History', '🏛️', '#a16207', 'Empires, eras, and events', HISTORY),
  category('space', 'Space', '🪐', '#6d28d9', 'Planets, missions, and stars', SPACE),
  category('arts', 'Arts & Literature', '🎭', '#be123c', 'Masterpieces and their makers', ARTS),
  category('food', 'Food & Drink', '🍜', '#c2410c', 'Dishes and flavours of the world', FOOD),
  category('sports', 'Sports & Games', '⚽', '#15803d', 'Contests of skill and speed', SPORTS),
];

export function findCategoryById(id: string): WordCategory | undefined {
  return WORD_BANKS.find((c) => c.id === id);
}

/** Total number of collectible entries across all categories. */
export const TOTAL_ENTRIES = WORD_BANKS.reduce((sum, c) => sum + c.entries.length, 0);
