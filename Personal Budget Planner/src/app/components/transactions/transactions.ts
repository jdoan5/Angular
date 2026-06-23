import { CurrencyPipe, DatePipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { categoryIcon } from '../../models/category';
import { Transaction } from '../../models/transaction';
import { BudgetStore } from '../../services/budget-store';
import { TransactionForm } from '../transaction-form/transaction-form';

type Filter = 'all' | 'income' | 'expense';

@Component({
  selector: 'app-transactions',
  imports: [CurrencyPipe, DatePipe, FormsModule, TransactionForm],
  templateUrl: './transactions.html',
  styleUrl: './transactions.scss',
})
export class Transactions {
  protected readonly store = inject(BudgetStore);
  protected readonly categoryIcon = categoryIcon;

  protected readonly filter = signal<Filter>('all');
  protected readonly search = signal('');
  protected readonly formOpen = signal(false);
  protected readonly editing = signal<Transaction | null>(null);

  protected readonly filtered = computed(() => {
    const type = this.filter();
    const query = this.search().trim().toLowerCase();
    return this.store.transactions().filter((t) => {
      if (type !== 'all' && t.type !== type) return false;
      if (query && !`${t.description} ${t.category}`.toLowerCase().includes(query)) return false;
      return true;
    });
  });

  protected readonly filteredTotal = computed(() =>
    this.filtered().reduce((sum, t) => sum + (t.type === 'income' ? t.amount : -t.amount), 0),
  );

  constructor(route: ActivatedRoute) {
    if (route.snapshot.queryParamMap.has('add')) {
      this.openAdd();
    }
  }

  protected setFilter(f: Filter): void {
    this.filter.set(f);
  }

  protected openAdd(): void {
    this.editing.set(null);
    this.formOpen.set(true);
  }

  protected openEdit(t: Transaction): void {
    this.editing.set(t);
    this.formOpen.set(true);
  }

  protected closeForm(): void {
    this.formOpen.set(false);
    this.editing.set(null);
  }

  protected onSave(data: Omit<Transaction, 'id'>): void {
    const current = this.editing();
    if (current) {
      this.store.updateTransaction(current.id, data);
    } else {
      this.store.addTransaction(data);
    }
    this.closeForm();
  }

  protected remove(t: Transaction): void {
    if (confirm(`Delete "${t.description || t.category}"?`)) {
      this.store.deleteTransaction(t.id);
    }
  }
}
