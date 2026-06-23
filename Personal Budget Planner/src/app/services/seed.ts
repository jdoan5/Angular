import { CategoryBudget } from '../models/budget';
import { Transaction } from '../models/transaction';

/** ISO `yyyy-mm-dd` for the given day of the current month. */
function dayThisMonth(day: number): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), day);
  return d.toISOString().slice(0, 10);
}

let seq = 0;
function tx(t: Omit<Transaction, 'id'>): Transaction {
  return { ...t, id: `seed-${seq++}` };
}

/** Sample data shown on first run so the dashboard isn't empty. */
export function seedTransactions(): Transaction[] {
  return [
    tx({ type: 'income', amount: 4200, category: 'Salary', description: 'Monthly paycheck', date: dayThisMonth(1) }),
    tx({ type: 'income', amount: 750, category: 'Freelance', description: 'Logo design', date: dayThisMonth(12) }),
    tx({ type: 'expense', amount: 1450, category: 'Housing', description: 'Rent', date: dayThisMonth(1) }),
    tx({ type: 'expense', amount: 318.42, category: 'Food', description: 'Groceries', date: dayThisMonth(4) }),
    tx({ type: 'expense', amount: 64, category: 'Food', description: 'Dinner out', date: dayThisMonth(9) }),
    tx({ type: 'expense', amount: 88.5, category: 'Transport', description: 'Gas', date: dayThisMonth(6) }),
    tx({ type: 'expense', amount: 112, category: 'Utilities', description: 'Electricity', date: dayThisMonth(5) }),
    tx({ type: 'expense', amount: 60, category: 'Utilities', description: 'Internet', date: dayThisMonth(5) }),
    tx({ type: 'expense', amount: 15.99, category: 'Entertainment', description: 'Streaming', date: dayThisMonth(8) }),
    tx({ type: 'expense', amount: 45, category: 'Health', description: 'Gym membership', date: dayThisMonth(3) }),
    tx({ type: 'expense', amount: 129.99, category: 'Shopping', description: 'New headphones', date: dayThisMonth(11) }),
  ];
}

export function seedBudgets(): CategoryBudget[] {
  return [
    { category: 'Housing', limit: 1500 },
    { category: 'Food', limit: 500 },
    { category: 'Transport', limit: 200 },
    { category: 'Utilities', limit: 250 },
    { category: 'Entertainment', limit: 150 },
    { category: 'Health', limit: 120 },
    { category: 'Shopping', limit: 200 },
  ];
}
