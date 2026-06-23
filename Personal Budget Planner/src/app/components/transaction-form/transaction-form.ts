import { Component, OnInit, computed, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { categoriesFor } from '../../models/category';
import { Transaction, TransactionType } from '../../models/transaction';

interface FormState {
  type: TransactionType;
  amount: number | null;
  category: string;
  description: string;
  date: string;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Modal form for creating or editing a single transaction. */
@Component({
  selector: 'app-transaction-form',
  imports: [FormsModule],
  templateUrl: './transaction-form.html',
  styleUrl: './transaction-form.scss',
})
export class TransactionForm implements OnInit {
  /** Existing transaction to edit, or `null`/undefined to create a new one. */
  readonly editing = input<Transaction | null>(null);

  readonly save = output<Omit<Transaction, 'id'>>();
  readonly cancel = output<void>();

  protected readonly form = signal<FormState>({
    type: 'expense',
    amount: null,
    category: 'Housing',
    description: '',
    date: todayISO(),
  });

  protected readonly categoryOptions = computed(() => categoriesFor(this.form().type));

  protected readonly isEdit = computed(() => this.editing() !== null);

  protected readonly valid = computed(() => {
    const f = this.form();
    return f.amount !== null && f.amount > 0 && !!f.category && !!f.date;
  });

  ngOnInit(): void {
    const existing = this.editing();
    if (existing) {
      this.form.set({
        type: existing.type,
        amount: existing.amount,
        category: existing.category,
        description: existing.description,
        date: existing.date,
      });
    }
  }

  protected setType(type: TransactionType): void {
    this.form.update((f) => {
      const options = categoriesFor(type);
      const category = options.some((c) => c.name === f.category)
        ? f.category
        : options[0].name;
      return { ...f, type, category };
    });
  }

  protected patch<K extends keyof FormState>(key: K, value: FormState[K]): void {
    this.form.update((f) => ({ ...f, [key]: value }));
  }

  protected submit(): void {
    if (!this.valid()) return;
    const f = this.form();
    this.save.emit({
      type: f.type,
      amount: Number(f.amount),
      category: f.category,
      description: f.description.trim(),
      date: f.date,
    });
  }

  protected close(): void {
    this.cancel.emit();
  }
}
