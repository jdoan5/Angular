import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { CategoryBudget } from '../models/budget';
import { categoryColor, EXPENSE_CATEGORIES } from '../models/category';
import { Transaction } from '../models/transaction';
import { seedBudgets, seedTransactions } from './seed';
import { StorageService } from './storage';

const TX_KEY = 'pbp.transactions';
const BUDGET_KEY = 'pbp.budgets';

export interface CategorySlice {
  category: string;
  amount: number;
  color: string;
}

export interface BudgetProgress {
  category: string;
  color: string;
  limit: number;
  spent: number;
  /** Spent / limit, clamped to [0, 1] for the bar width. */
  ratio: number;
  /** Raw percentage (can exceed 100). */
  percent: number;
  remaining: number;
  over: boolean;
}

/** `yyyy-mm` for a date string, used to group by month. */
function monthOf(date: string): string {
  return date.slice(0, 7);
}

function currentMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Single source of truth for budget data. Holds transactions and budgets as
 * signals, exposes derived totals via `computed`, and persists every change to
 * `localStorage` through an `effect`.
 */
@Injectable({ providedIn: 'root' })
export class BudgetStore {
  private readonly storage = inject(StorageService);

  private readonly transactionsSig = signal<Transaction[]>(
    this.storage.get(TX_KEY, seedTransactions()),
  );
  private readonly budgetsSig = signal<CategoryBudget[]>(
    this.storage.get(BUDGET_KEY, seedBudgets()),
  );

  /** The month the dashboard / budgets reflect. Defaults to the real month. */
  readonly selectedMonth = signal<string>(currentMonthKey());

  /** All transactions, newest first. */
  readonly transactions = computed(() =>
    [...this.transactionsSig()].sort((a, b) => b.date.localeCompare(a.date)),
  );

  readonly budgets = this.budgetsSig.asReadonly();

  /** Transactions that fall inside the selected month. */
  readonly monthTransactions = computed(() =>
    this.transactions().filter((t) => monthOf(t.date) === this.selectedMonth()),
  );

  readonly monthIncome = computed(() => sumByType(this.monthTransactions(), 'income'));
  readonly monthExpense = computed(() => sumByType(this.monthTransactions(), 'expense'));
  readonly monthNet = computed(() => this.monthIncome() - this.monthExpense());

  /** All-time balance across every transaction (total money saved). */
  readonly totalBalance = computed(
    () => sumByType(this.transactionsSig(), 'income') - sumByType(this.transactionsSig(), 'expense'),
  );

  /** Expense breakdown for the selected month, largest first. */
  readonly spendingByCategory = computed<CategorySlice[]>(() => {
    const totals = new Map<string, number>();
    for (const t of this.monthTransactions()) {
      if (t.type !== 'expense') continue;
      totals.set(t.category, (totals.get(t.category) ?? 0) + t.amount);
    }
    return [...totals.entries()]
      .map(([category, amount]) => ({ category, amount, color: categoryColor(category) }))
      .sort((a, b) => b.amount - a.amount);
  });

  /** Budget vs. actual for every category with a configured limit. */
  readonly budgetProgress = computed<BudgetProgress[]>(() => {
    const spentByCat = new Map<string, number>();
    for (const t of this.monthTransactions()) {
      if (t.type !== 'expense') continue;
      spentByCat.set(t.category, (spentByCat.get(t.category) ?? 0) + t.amount);
    }
    return this.budgetsSig()
      .filter((b) => b.limit > 0)
      .map((b) => {
        const spent = spentByCat.get(b.category) ?? 0;
        const percent = b.limit > 0 ? (spent / b.limit) * 100 : 0;
        return {
          category: b.category,
          color: categoryColor(b.category),
          limit: b.limit,
          spent,
          ratio: Math.min(spent / b.limit, 1),
          percent,
          remaining: b.limit - spent,
          over: spent > b.limit,
        };
      })
      .sort((a, b) => b.percent - a.percent);
  });

  readonly totalBudget = computed(() =>
    this.budgetsSig().reduce((sum, b) => sum + b.limit, 0),
  );

  constructor() {
    effect(() => this.storage.set(TX_KEY, this.transactionsSig()));
    effect(() => this.storage.set(BUDGET_KEY, this.budgetsSig()));
  }

  addTransaction(data: Omit<Transaction, 'id'>): void {
    const tx: Transaction = { ...data, id: crypto.randomUUID() };
    this.transactionsSig.update((list) => [tx, ...list]);
  }

  updateTransaction(id: string, data: Omit<Transaction, 'id'>): void {
    this.transactionsSig.update((list) =>
      list.map((t) => (t.id === id ? { ...data, id } : t)),
    );
  }

  deleteTransaction(id: string): void {
    this.transactionsSig.update((list) => list.filter((t) => t.id !== id));
  }

  /** Sets (or clears, when `limit` is 0) the monthly limit for a category. */
  setBudget(category: string, limit: number): void {
    this.budgetsSig.update((list) => {
      const existing = list.find((b) => b.category === category);
      if (existing) {
        return list.map((b) => (b.category === category ? { ...b, limit } : b));
      }
      return [...list, { category, limit }];
    });
  }

  budgetFor(category: string): number {
    return this.budgetsSig().find((b) => b.category === category)?.limit ?? 0;
  }

  /** Categories available for budgeting (all expense categories). */
  readonly expenseCategories = EXPENSE_CATEGORIES;

  clearAll(): void {
    this.transactionsSig.set([]);
  }
}

function sumByType(list: Transaction[], type: Transaction['type']): number {
  return list.reduce((sum, t) => (t.type === type ? sum + t.amount : sum), 0);
}
