/** A monthly spending limit for a single expense category. */
export interface CategoryBudget {
  category: string;
  /** Monthly limit in the account currency. */
  limit: number;
}
