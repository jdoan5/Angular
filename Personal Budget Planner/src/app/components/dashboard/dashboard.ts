import { CurrencyPipe, DatePipe, DecimalPipe } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { categoryIcon } from '../../models/category';
import { BudgetStore } from '../../services/budget-store';
import { DonutChart, DonutDatum } from '../donut-chart/donut-chart';

@Component({
  selector: 'app-dashboard',
  imports: [CurrencyPipe, DatePipe, DecimalPipe, RouterLink, DonutChart],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
})
export class Dashboard {
  protected readonly store = inject(BudgetStore);
  protected readonly categoryIcon = categoryIcon;

  protected readonly monthLabel = computed(() => {
    const [y, m] = this.store.selectedMonth().split('-').map(Number);
    return new Date(y, m - 1, 1);
  });

  protected readonly donutData = computed<DonutDatum[]>(() =>
    this.store
      .spendingByCategory()
      .map((s) => ({ label: s.category, value: s.amount, color: s.color })),
  );

  /** Category breakdown with each slice's share of the month's spending. */
  protected readonly legend = computed(() => {
    const total = this.store.monthExpense();
    return this.store.spendingByCategory().map((s) => ({
      ...s,
      percent: total > 0 ? (s.amount / total) * 100 : 0,
    }));
  });

  protected readonly topBudgets = computed(() => this.store.budgetProgress().slice(0, 4));

  protected readonly recent = computed(() => this.store.transactions().slice(0, 6));

  protected readonly savingsRate = computed(() => {
    const income = this.store.monthIncome();
    return income > 0 ? (this.store.monthNet() / income) * 100 : 0;
  });
}
