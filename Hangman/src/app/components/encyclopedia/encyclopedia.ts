import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TOTAL_ENTRIES } from '../../data/word-banks';
import { WordEntry } from '../../models/word';
import { GameStore } from '../../services/game-store';

interface Shelf {
  id: string;
  name: string;
  icon: string;
  color: string;
  collected: number;
  total: number;
  entries: { entry: WordEntry; found: boolean; pattern: string }[];
}

/** The player's personal encyclopedia — every solved word becomes an entry. */
@Component({
  selector: 'app-encyclopedia',
  imports: [RouterLink],
  templateUrl: './encyclopedia.html',
  styleUrl: './encyclopedia.scss',
})
export class Encyclopedia {
  protected readonly store = inject(GameStore);
  protected readonly totalEntries = TOTAL_ENTRIES;

  protected readonly shelves = computed<Shelf[]>(() => {
    const collection = this.store.collection();
    return this.store.progressByCategory().map(({ category, collected, total }) => ({
      id: category.id,
      name: category.name,
      icon: category.icon,
      color: category.color,
      collected,
      total,
      entries: category.entries.map((entry) => ({
        entry,
        found: entry.id in collection,
        pattern: entry.word.replace(/[A-Z]/g, '•'),
      })),
    }));
  });

  protected readonly overallPercent = computed(() =>
    TOTAL_ENTRIES > 0 ? (this.store.collectedCount() / TOTAL_ENTRIES) * 100 : 0,
  );
}
