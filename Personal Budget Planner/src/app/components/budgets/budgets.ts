import { CurrencyPipe, DecimalPipe } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { EXPENSE_CATEGORIES } from '../../models/category';
import { BudgetStore } from '../../services/budget-store';

interface BudgetRow {
  name: string;
  color: string;
  icon: string;
  limit: number;
  spent: number;
  ratio: number;
  percent: number;
  over: boolean;
}

@Component({
  selector: 'app-budgets',
  imports: [CurrencyPipe, DecimalPipe, FormsModule],
  templateUrl: './budgets.html',
  styleUrl: './budgets.scss',
})
export class Budgets {
  protected readonly store = inject(BudgetStore);

  protected readonly rows = computed<BudgetRow[]>(() => {
    const spent = new Map(this.store.spendingByCategory().map((s) => [s.category, s.amount]));
    return EXPENSE_CATEGORIES.map((c) => {
      const limit = this.store.budgetFor(c.name);
      const used = spent.get(c.name) ?? 0;
      return {
        name: c.name,
        color: c.color,
        icon: c.icon,
        limit,
        spent: used,
        ratio: limit > 0 ? Math.min(used / limit, 1) : 0,
        percent: limit > 0 ? (used / limit) * 100 : 0,
        over: limit > 0 && used > limit,
      };
    });
  });

  protected readonly totalSpent = this.store.monthExpense;
  protected readonly totalBudget = this.store.totalBudget;
  protected readonly remaining = computed(() => this.totalBudget() - this.totalSpent());
  protected readonly usedRatio = computed(() =>
    this.totalBudget() > 0 ? Math.min(this.totalSpent() / this.totalBudget(), 1) : 0,
  );

  protected setLimit(category: string, value: number | null): void {
    this.store.setBudget(category, Math.max(0, value ?? 0));
  }
}
