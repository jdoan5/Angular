export type TransactionType = 'income' | 'expense';

export interface Transaction {
  id: string;
  type: TransactionType;
  /** Always a positive number; the `type` determines the sign in calculations. */
  amount: number;
  category: string;
  description: string;
  /** ISO date string, `yyyy-mm-dd`. */
  date: string;
}
