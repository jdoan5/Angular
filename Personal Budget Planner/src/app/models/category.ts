import { TransactionType } from './transaction';

export interface Category {
  name: string;
  type: TransactionType;
  /** Hex colour used in charts and badges. */
  color: string;
  /** Emoji shown alongside the name. */
  icon: string;
}

export const EXPENSE_CATEGORIES: Category[] = [
  { name: 'Housing', type: 'expense', color: '#6366f1', icon: '🏠' },
  { name: 'Food', type: 'expense', color: '#f59e0b', icon: '🍽️' },
  { name: 'Transport', type: 'expense', color: '#10b981', icon: '🚗' },
  { name: 'Utilities', type: 'expense', color: '#3b82f6', icon: '💡' },
  { name: 'Entertainment', type: 'expense', color: '#ec4899', icon: '🎬' },
  { name: 'Health', type: 'expense', color: '#ef4444', icon: '🩺' },
  { name: 'Shopping', type: 'expense', color: '#8b5cf6', icon: '🛍️' },
  { name: 'Other', type: 'expense', color: '#64748b', icon: '📦' },
];

export const INCOME_CATEGORIES: Category[] = [
  { name: 'Salary', type: 'income', color: '#22c55e', icon: '💼' },
  { name: 'Freelance', type: 'income', color: '#14b8a6', icon: '💻' },
  { name: 'Investment', type: 'income', color: '#0ea5e9', icon: '📈' },
  { name: 'Gift', type: 'income', color: '#a855f7', icon: '🎁' },
  { name: 'Other', type: 'income', color: '#64748b', icon: '💰' },
];

export const ALL_CATEGORIES: Category[] = [...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES];

export function categoriesFor(type: TransactionType): Category[] {
  return type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
}

export function findCategory(name: string, type?: TransactionType): Category | undefined {
  return ALL_CATEGORIES.find((c) => c.name === name && (type ? c.type === type : true));
}

export function categoryColor(name: string): string {
  return findCategory(name)?.color ?? '#64748b';
}

export function categoryIcon(name: string): string {
  return findCategory(name)?.icon ?? '📦';
}
