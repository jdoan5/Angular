import { Component, computed, inject, linkedSignal } from '@angular/core';
import { DAILY_EPOCH, DailyService, MonthCell } from '../../services/daily';

/** A ledger cell as drawn: the service's cell plus its stamp and spoken label. */
interface Cell {
  /** Track key; padding cells get a synthetic one. */
  id: string;
  day: number | null;
  /** 'none' = a past day never played; 'open' = started but not finished. */
  stamp: 'won' | 'lost' | 'open' | 'none';
  dim: boolean;
  today: boolean;
  label: string;
}

interface Month {
  year: number;
  /** 0–11, like Date#getMonth. */
  month: number;
}

/** Shape and words for each stamp, so state never rests on colour alone. */
export const STAMP: Record<'won' | 'lost' | 'open', { glyph: string; word: string }> = {
  won: { glyph: '◉', word: 'solved' },
  lost: { glyph: '✕', word: 'missed' },
  open: { glyph: '◐', word: 'in progress' },
};

export const WEEKDAYS = [
  { short: 'Mon', long: 'Monday' },
  { short: 'Tue', long: 'Tuesday' },
  { short: 'Wed', long: 'Wednesday' },
  { short: 'Thu', long: 'Thursday' },
  { short: 'Fri', long: 'Friday' },
  { short: 'Sat', long: 'Saturday' },
  { short: 'Sun', long: 'Sunday' },
];

/** Adds the stamp and a spoken label, e.g. 'Tuesday 3 November: solved, 2 misses'. */
function toCell(cell: MonthCell, index: number): Cell {
  if (cell.key === null) {
    return { id: `pad-${index}`, day: null, stamp: 'none', dim: false, today: false, label: '' };
  }
  const played = cell.misses !== null;
  const stamp = cell.state === 'won' || cell.state === 'lost' ? cell.state : cell.state === 'open' && played ? 'open' : 'none';
  const misses = `${cell.misses} ${cell.misses === 1 ? 'miss' : 'misses'}`;
  const status =
    cell.state === 'before'
      ? 'before the first daily'
      : cell.state === 'future'
        ? 'still to come'
        : stamp === 'none'
          ? 'not played'
          : stamp === 'open'
            ? `${STAMP.open.word}, ${misses}`
            : `${STAMP[stamp].word}, ${misses}`;
  return {
    id: cell.key,
    day: cell.day,
    stamp,
    dim: cell.state === 'before' || cell.state === 'future',
    today: cell.isToday,
    label: `${DAY_LABEL.format(dateFromKey(cell.key))}${cell.isToday ? ', today' : ''}: ${status}`,
  };
}

function dateFromKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function monthOf(key: string): Month {
  const [year, month] = key.split('-').map(Number);
  return { year, month: month - 1 };
}

const CAPTION = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' });
const DAY_LABEL = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

/**
 * The daily ledger in My Encyclopedia: a Monday-first month of stamps, from
 * the launch month up to this one, with the daily streak above it.
 */
@Component({
  selector: 'app-daily-ledger',
  templateUrl: './daily-ledger.html',
  styleUrl: './daily-ledger.scss',
})
export class DailyLedger {
  protected readonly daily = inject(DailyService);
  protected readonly weekdays = WEEKDAYS;
  protected readonly stamp = STAMP;

  private readonly first = monthOf(DAILY_EPOCH);
  private readonly current = computed(() => monthOf(this.daily.todayKey()));
  /** The month on show; snaps back to the current month when the day rolls into a new one. */
  protected readonly shown = linkedSignal(() => this.current());

  protected readonly canPrev = computed(() => index(this.shown()) > index(this.first));
  protected readonly canNext = computed(() => index(this.shown()) < index(this.current()));

  protected readonly caption = computed(() => {
    const { year, month } = this.shown();
    return CAPTION.format(new Date(year, month, 1));
  });

  protected readonly weeks = computed<Cell[][]>(() => {
    const { year, month } = this.shown();
    return this.daily.monthGrid(year, month).map((week, w) => week.map((cell, d) => toCell(cell, w * 7 + d)));
  });

  protected step(delta: -1 | 1): void {
    const { year, month } = this.shown();
    const next = new Date(year, month + delta, 1);
    const target = { year: next.getFullYear(), month: next.getMonth() };
    // Clamped: never before the launch month, never past this one.
    if (index(target) < index(this.first) || index(target) > index(this.current())) return;
    this.shown.set(target);
  }
}

function index({ year, month }: Month): number {
  return year * 12 + month;
}
