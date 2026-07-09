export type AccountType =
  | "checking"
  | "savings"
  | "cash"
  | "credit"
  | "investment"
  | "other";

export type SpendingCategory = {
  id: string;
  name: string;
  color: string;
  archived: boolean;
  created_at: string;
};

export type Account = {
  id: string;
  name: string;
  type: AccountType;
  color: string;
  balance: number;
  currency: string;
  archived: boolean;
  created_at: string;
  updated_at: string;
};

export type ChangeSource = "manual" | "import" | "assistant";

export type BalanceChange = {
  id: string;
  account_id: string;
  category_id: string | null;
  direction: "in" | "out";
  amount: number;
  note: string | null;
  occurred_at: string;
  created_at: string;
  source: ChangeSource;
  is_transfer: boolean;
};

export type RecurringFrequency = "monthly" | "weekly" | "daily" | "custom";

export type RecurringExpense = {
  id: string;
  name: string;
  amount: number;
  category_id: string | null;
  frequency: RecurringFrequency;
  day_of_month: number | null;
  weekday: number | null;
  interval_days: number | null;
  start_date: string | null;
  archived: boolean;
  created_at: string;
};

export type SpendLimitScope = "overall" | "category";
export type SpendLimitPeriod = "daily" | "weekly" | "monthly";

// A user-set budget cap the app tracks actual spend against. scope 'overall'
// caps all discretionary spend (category_id null); scope 'category' caps one
// category. Distinct from the forecast's daily_spend_estimate, which predicts
// future spend rather than capping it.
export type SpendLimit = {
  id: string;
  scope: SpendLimitScope;
  category_id: string | null;
  period: SpendLimitPeriod;
  amount: number;
  archived: boolean;
  created_at: string;
};

export type PayFrequency = "weekly" | "biweekly" | "monthly";

export type IncomeSource = {
  id: string;
  name: string;
  hourly_wage: number;
  tax_rate: number;
  calendar_id: string | null;
  color: string;
  pay_frequency: PayFrequency | null;
  anchor_payday: string | null;
  period_start: string | null;
  period_end: string | null;
  // Both set = fixed monthly income (a set amount landing on fixed_day each
  // month, clamped to short months); both null = hourly wage job. The hourly
  // fields are preserved while fixed so unchecking restores them.
  fixed_amount: number | null;
  fixed_day: number | null;
  archived: boolean;
  created_at: string;
};
