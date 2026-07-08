"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/utils/supabase/server";
import { changeFingerprint } from "@/app/lib/finance/derive";
import { recomputeAccountBalance } from "@/app/lib/finance/recompute";

const ACCOUNT_COLUMNS =
  "id, name, type, color, balance, currency, archived, created_at, updated_at";
const CATEGORY_COLUMNS = "id, name, color, archived, created_at";
const CHANGE_COLUMNS =
  "id, account_id, category_id, direction, amount, note, occurred_at, created_at, source, is_transfer";

const ACCOUNT_TYPES = [
  "checking",
  "savings",
  "cash",
  "credit",
  "investment",
  "other",
] as const;
type AccountType = (typeof ACCOUNT_TYPES)[number];

const HEX = /^#[0-9a-fA-F]{6}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Round to cents so float drift never leaves a phantom non-zero delta.
function toCents(value: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

function todayKey(): string {
  const d = new Date();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

function normalizeOccurredAt(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return todayKey();
  if (!ISO_DATE.test(value)) return null;
  return value;
}

// ---------- spending categories ----------

export async function createCategory(input: { name: string; color: string }) {
  const name = input.name?.trim();
  if (!name) return { error: "name required" };
  if (!input.color || !HEX.test(input.color)) {
    return { error: "invalid color" };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { data, error } = await supabase
    .from("spending_categories")
    .insert({ user_id: user.id, name, color: input.color })
    .select(CATEGORY_COLUMNS)
    .single();

  if (error) return { error: error.message };

  revalidatePath("/finance");
  return { error: null, category: data };
}

export async function updateCategory(input: {
  id: string;
  name?: string;
  color?: string;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const updates: Record<string, unknown> = {};

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) return { error: "name required" };
    updates.name = name;
  }
  if (input.color !== undefined) {
    if (!HEX.test(input.color)) return { error: "invalid color" };
    updates.color = input.color;
  }

  if (Object.keys(updates).length === 0) return { error: null };

  const { error } = await supabase
    .from("spending_categories")
    .update(updates)
    .eq("id", input.id);

  if (error) return { error: error.message };

  revalidatePath("/finance");
  revalidatePath("/", "layout");
  return { error: null };
}

export async function archiveCategory(id: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { error } = await supabase
    .from("spending_categories")
    .update({ archived: true })
    .eq("id", id);

  if (error) return { error: error.message };

  revalidatePath("/finance");
  return { error: null };
}

// ---------- accounts ----------

export async function createAccount(input: {
  name: string;
  type: string;
  color: string;
  currency?: string;
  balance: number;
}) {
  const name = input.name?.trim();
  if (!name) return { error: "name required" };
  if (!ACCOUNT_TYPES.includes(input.type as AccountType)) {
    return { error: "invalid type" };
  }
  if (!input.color || !HEX.test(input.color)) {
    return { error: "invalid color" };
  }
  const balance = toCents(input.balance);
  if (balance === null) return { error: "invalid balance" };
  const currency = input.currency?.trim() || "USD";

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { data: account, error } = await supabase
    .from("accounts")
    .insert({
      user_id: user.id,
      name,
      type: input.type,
      color: input.color,
      currency,
      balance,
    })
    .select(ACCOUNT_COLUMNS)
    .single();

  if (error) return { error: error.message };

  // Seed an opening "in" change so the ledger starts coherent.
  if (balance > 0) {
    await supabase.from("balance_changes").insert({
      user_id: user.id,
      account_id: account.id,
      direction: "in",
      amount: balance,
      note: "opening balance",
      occurred_at: todayKey(),
      source: "manual",
      fingerprint: changeFingerprint(todayKey(), "in", balance),
    });
  }

  // Anchor the derived balance at the opening state (inserted after the
  // opening row so that row sits inside the anchor — see app/lib/finance/derive.ts).
  await supabase.from("account_reconciliations").insert({
    user_id: user.id,
    account_id: account.id,
    balance,
    as_of: todayKey(),
    source: "manual",
    note: "opening balance",
  });

  revalidatePath("/finance");
  revalidatePath("/", "layout");
  return { error: null, account };
}

export async function updateAccount(input: {
  id: string;
  name?: string;
  type?: string;
  color?: string;
  archived?: boolean;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const updates: Record<string, unknown> = {};

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) return { error: "name required" };
    updates.name = name;
  }
  if (input.type !== undefined) {
    if (!ACCOUNT_TYPES.includes(input.type as AccountType)) {
      return { error: "invalid type" };
    }
    updates.type = input.type;
  }
  if (input.color !== undefined) {
    if (!HEX.test(input.color)) return { error: "invalid color" };
    updates.color = input.color;
  }
  if (input.archived !== undefined) {
    updates.archived = input.archived;
  }

  if (Object.keys(updates).length === 0) return { error: null };
  updates.updated_at = new Date().toISOString();

  const { error } = await supabase
    .from("accounts")
    .update(updates)
    .eq("id", input.id);

  if (error) return { error: error.message };

  revalidatePath("/finance");
  revalidatePath("/", "layout");
  return { error: null };
}

export async function archiveAccount(id: string) {
  return updateAccount({ id, archived: true });
}

// ---------- balance changes ----------

// The core action: the user sets a new balance for an account. We diff it
// against the stored balance, record the delta as dated transaction rows, and
// stamp a reconciliation anchor at the new balance (the anchor — not the rows —
// is what pins the derived balance; any drift is absorbed by it). A decrease
// ('out') carries a spending category; an increase ('in') is recorded silently.
export async function recordBalanceChange(input: {
  accountId: string;
  newBalance: number;
  occurredAt?: string | null;
  categoryId?: string | null;
  // For a decrease, the spent amount may be split across several categories
  // (e.g. multiple purchases before one balance update). Each split becomes its
  // own 'out' ledger row; the amounts must sum to the total decrease. When
  // omitted, the single `categoryId` path is used.
  allocations?: { categoryId: string | null; amount: number }[];
  note?: string | null;
}) {
  const newBalance = toCents(input.newBalance);
  if (newBalance === null) return { error: "invalid balance" };

  const occurredAt = normalizeOccurredAt(input.occurredAt);
  if (occurredAt === null) return { error: "invalid date" };

  const note = input.note?.trim() || null;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { data: account, error: loadError } = await supabase
    .from("accounts")
    .select("id, balance")
    .eq("id", input.accountId)
    .single();

  if (loadError) return { error: loadError.message };
  if (!account) return { error: "account not found" };

  const current = toCents(Number(account.balance)) ?? 0;
  const delta = toCents(newBalance - current) ?? 0;
  if (delta === 0)
    return { error: null, change: null, changes: [], newBalance };

  const direction = delta < 0 ? "out" : "in";
  const amount = Math.abs(delta);

  const userId = user.id;

  // Anchor + cached balance, written after the transaction rows so those rows
  // sit inside the anchor (see app/lib/finance/derive.ts).
  async function anchorAt(balance: number): Promise<string | null> {
    const { error: anchorError } = await supabase
      .from("account_reconciliations")
      .insert({
        user_id: userId,
        account_id: input.accountId,
        balance,
        as_of: todayKey(),
        source: "manual",
        note,
      });
    if (anchorError) return anchorError.message;
    const { error: updateError } = await supabase
      .from("accounts")
      .update({ balance, updated_at: new Date().toISOString() })
      .eq("id", input.accountId);
    return updateError?.message ?? null;
  }

  // ---- split path: a categorized decrease spread across multiple categories ----
  if (direction === "out" && input.allocations && input.allocations.length > 0) {
    const rows: {
      user_id: string;
      account_id: string;
      category_id: string | null;
      direction: "out";
      amount: number;
      note: string | null;
      occurred_at: string;
      source: "manual";
      fingerprint: string;
    }[] = [];
    let allocated = 0;

    for (const alloc of input.allocations) {
      const amt = toCents(alloc.amount);
      if (amt === null || amt <= 0) return { error: "invalid split amount" };
      const allocCategoryId = alloc.categoryId ?? null;
      if (allocCategoryId !== null && typeof allocCategoryId !== "string") {
        return { error: "invalid category" };
      }
      allocated = toCents(allocated + amt) ?? allocated;
      rows.push({
        user_id: user.id,
        account_id: input.accountId,
        category_id: allocCategoryId,
        direction: "out",
        amount: amt,
        note,
        occurred_at: occurredAt,
        source: "manual",
        fingerprint: changeFingerprint(occurredAt, "out", amt),
      });
    }

    if (allocated !== amount) {
      return { error: "splits must sum to the amount spent" };
    }

    const { data: inserted, error: insertError } = await supabase
      .from("balance_changes")
      .insert(rows)
      .select(CHANGE_COLUMNS);

    if (insertError) return { error: insertError.message };

    const anchorError = await anchorAt(newBalance);
    if (anchorError) return { error: anchorError };

    revalidatePath("/finance");
    revalidatePath("/", "layout");
    return { error: null, changes: inserted ?? [], newBalance };
  }

  // ---- single-row path ----
  const categoryId = direction === "out" ? (input.categoryId ?? null) : null;

  const { data: change, error: insertError } = await supabase
    .from("balance_changes")
    .insert({
      user_id: user.id,
      account_id: input.accountId,
      category_id: categoryId,
      direction,
      amount,
      note,
      occurred_at: occurredAt,
      source: "manual",
      fingerprint: changeFingerprint(occurredAt, direction, amount),
    })
    .select(CHANGE_COLUMNS)
    .single();

  if (insertError) return { error: insertError.message };

  const anchorError = await anchorAt(newBalance);
  if (anchorError) return { error: anchorError };

  revalidatePath("/finance");
  revalidatePath("/", "layout");
  return { error: null, change, changes: [change], newBalance };
}

// Edit an existing transaction (re-categorize / fix the amount / date / note).
// Amount and date edits are legal in the transactions-first model: the cached
// account balance is re-derived afterwards. Rows dated at or before the
// account's latest reconciliation anchor change history but not the balance.
export async function updateBalanceChange(input: {
  id: string;
  categoryId?: string | null;
  note?: string | null;
  occurredAt?: string;
  amount?: number;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { data: existing, error: loadError } = await supabase
    .from("balance_changes")
    .select("id, account_id, direction, amount, occurred_at")
    .eq("id", input.id)
    .maybeSingle();
  if (loadError) return { error: loadError.message };
  if (!existing) return { error: "change not found" };
  const row = existing as {
    account_id: string;
    direction: "in" | "out";
    amount: number;
    occurred_at: string;
  };

  const updates: Record<string, unknown> = {};

  if (input.categoryId !== undefined) updates.category_id = input.categoryId;
  if (input.note !== undefined) updates.note = input.note?.trim() || null;
  if (input.occurredAt !== undefined) {
    if (!ISO_DATE.test(input.occurredAt)) return { error: "invalid date" };
    updates.occurred_at = input.occurredAt;
  }
  if (input.amount !== undefined) {
    const amount = toCents(input.amount);
    if (amount === null || amount <= 0) return { error: "invalid amount" };
    updates.amount = amount;
  }

  if (Object.keys(updates).length === 0) return { error: null };

  if (input.amount !== undefined || input.occurredAt !== undefined) {
    updates.fingerprint = changeFingerprint(
      (updates.occurred_at as string | undefined) ?? row.occurred_at,
      row.direction,
      (updates.amount as number | undefined) ?? Number(row.amount),
    );
  }

  const { error } = await supabase
    .from("balance_changes")
    .update(updates)
    .eq("id", input.id);

  if (error) return { error: error.message };

  if (input.amount !== undefined || input.occurredAt !== undefined) {
    const recomputed = await recomputeAccountBalance(
      supabase,
      user.id,
      row.account_id,
    );
    if (recomputed.error) return { error: recomputed.error };
  }

  revalidatePath("/finance");
  revalidatePath("/", "layout");
  return { error: null };
}

// Delete a transaction outright (the correction path for import mistakes). The
// cached balance is re-derived from the anchor + remaining rows.
export async function deleteBalanceChange(id: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { data: existing, error: loadError } = await supabase
    .from("balance_changes")
    .select("id, account_id")
    .eq("id", id)
    .maybeSingle();
  if (loadError) return { error: loadError.message };
  if (!existing) return { error: "change not found" };

  const { error } = await supabase.from("balance_changes").delete().eq("id", id);
  if (error) return { error: error.message };

  const recomputed = await recomputeAccountBalance(
    supabase,
    user.id,
    (existing as { account_id: string }).account_id,
  );
  if (recomputed.error) return { error: recomputed.error };

  revalidatePath("/finance");
  revalidatePath("/", "layout");
  return { error: null };
}

// ---------- everyday-spend overrides ----------

// Pin the expected discretionary spend for one future day (the selected-day
// slider). amount null clears the override; 0 means "no spend expected".
export async function setSpendOverride(input: {
  date: string;
  amount: number | null;
}) {
  if (!ISO_DATE.test(input.date)) return { error: "invalid date" };
  if (input.date <= todayKey()) return { error: "only future days" };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  if (input.amount === null) {
    const { error } = await supabase
      .from("spend_overrides")
      .delete()
      .eq("user_id", user.id)
      .eq("date", input.date);
    if (error) return { error: error.message };
  } else {
    const amount = toCents(input.amount);
    if (amount === null || amount < 0 || amount > 100000) {
      return { error: "invalid amount" };
    }
    const { error } = await supabase.from("spend_overrides").upsert(
      {
        user_id: user.id,
        date: input.date,
        amount,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,date" },
    );
    if (error) return { error: error.message };
  }

  revalidatePath("/finance");
  return { error: null };
}

// ---------- recurring expenses ----------

const RECURRING_COLUMNS =
  "id, name, amount, category_id, frequency, day_of_month, weekday, interval_days, start_date, archived, created_at";
const FREQUENCIES = ["monthly", "weekly", "daily", "custom"] as const;
type Frequency = (typeof FREQUENCIES)[number];

function clampDayOfMonth(value: number): number | null {
  if (!Number.isInteger(value) || value < 1 || value > 31) return null;
  return value;
}

function clampWeekday(value: number): number | null {
  if (!Number.isInteger(value) || value < 0 || value > 6) return null;
  return value;
}

function normalizeInterval(value: number): number | null {
  if (!Number.isInteger(value) || value < 1 || value > 366) return null;
  return value;
}

export async function createRecurringExpense(input: {
  name: string;
  amount: number;
  categoryId?: string | null;
  frequency: string;
  dayOfMonth?: number | null;
  weekday?: number | null;
  intervalDays?: number | null;
  startDate?: string | null;
}) {
  const name = input.name?.trim();
  if (!name) return { error: "name required" };
  const amount = toCents(input.amount);
  if (amount === null || amount <= 0) return { error: "invalid amount" };
  if (!FREQUENCIES.includes(input.frequency as Frequency)) {
    return { error: "invalid frequency" };
  }

  let dayOfMonth: number | null = null;
  let weekday: number | null = null;
  let intervalDays: number | null = null;
  let startDate: string | null = null;

  if (input.frequency === "monthly") {
    dayOfMonth = clampDayOfMonth(Number(input.dayOfMonth));
    if (dayOfMonth === null) return { error: "invalid day of month" };
  } else if (input.frequency === "weekly") {
    weekday = clampWeekday(Number(input.weekday));
    if (weekday === null) return { error: "invalid weekday" };
  } else if (input.frequency === "custom") {
    intervalDays = normalizeInterval(Number(input.intervalDays));
    if (intervalDays === null) return { error: "invalid interval" };
    if (!input.startDate || !ISO_DATE.test(input.startDate)) {
      return { error: "invalid start date" };
    }
    startDate = input.startDate;
  }
  // daily: no extra params.

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { data, error } = await supabase
    .from("recurring_expenses")
    .insert({
      user_id: user.id,
      name,
      amount,
      category_id: input.categoryId ?? null,
      frequency: input.frequency,
      day_of_month: dayOfMonth,
      weekday,
      interval_days: intervalDays,
      start_date: startDate,
    })
    .select(RECURRING_COLUMNS)
    .single();

  if (error) return { error: error.message };

  revalidatePath("/finance");
  return { error: null, expense: data };
}

export async function updateRecurringExpense(input: {
  id: string;
  name?: string;
  amount?: number;
  categoryId?: string | null;
  frequency?: string;
  dayOfMonth?: number | null;
  weekday?: number | null;
  intervalDays?: number | null;
  startDate?: string | null;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const updates: Record<string, unknown> = {};

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) return { error: "name required" };
    updates.name = name;
  }
  if (input.amount !== undefined) {
    const amount = toCents(input.amount);
    if (amount === null || amount <= 0) return { error: "invalid amount" };
    updates.amount = amount;
  }
  if (input.categoryId !== undefined) updates.category_id = input.categoryId;
  if (input.frequency !== undefined) {
    if (!FREQUENCIES.includes(input.frequency as Frequency)) {
      return { error: "invalid frequency" };
    }
    updates.frequency = input.frequency;
  }
  if (input.dayOfMonth !== undefined) {
    updates.day_of_month =
      input.dayOfMonth === null ? null : clampDayOfMonth(Number(input.dayOfMonth));
    if (input.dayOfMonth !== null && updates.day_of_month === null) {
      return { error: "invalid day of month" };
    }
  }
  if (input.weekday !== undefined) {
    updates.weekday =
      input.weekday === null ? null : clampWeekday(Number(input.weekday));
    if (input.weekday !== null && updates.weekday === null) {
      return { error: "invalid weekday" };
    }
  }
  if (input.intervalDays !== undefined) {
    updates.interval_days =
      input.intervalDays === null
        ? null
        : normalizeInterval(Number(input.intervalDays));
    if (input.intervalDays !== null && updates.interval_days === null) {
      return { error: "invalid interval" };
    }
  }
  if (input.startDate !== undefined) {
    if (input.startDate !== null && !ISO_DATE.test(input.startDate)) {
      return { error: "invalid start date" };
    }
    updates.start_date = input.startDate;
  }

  if (Object.keys(updates).length === 0) return { error: null };

  const { error } = await supabase
    .from("recurring_expenses")
    .update(updates)
    .eq("id", input.id);

  if (error) return { error: error.message };

  revalidatePath("/finance");
  return { error: null };
}

export async function archiveRecurringExpense(id: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { error } = await supabase
    .from("recurring_expenses")
    .update({ archived: true })
    .eq("id", id);

  if (error) return { error: error.message };

  revalidatePath("/finance");
  return { error: null };
}

// ---------- income sources ----------

const INCOME_COLUMNS =
  "id, name, hourly_wage, tax_rate, calendar_id, color, pay_frequency, anchor_payday, period_start, period_end, fixed_amount, fixed_day, archived, created_at";

const PAY_FREQUENCIES = ["weekly", "biweekly", "monthly"] as const;
type PayFrequency = (typeof PAY_FREQUENCIES)[number];

function normalizeRate(value: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0 || value > max) return null;
  return Math.round(value * 100) / 100;
}

export async function createIncomeSource(input: {
  name: string;
  hourlyWage: number;
  taxRate: number;
  calendarId?: string | null;
  color: string;
  payFrequency?: string | null;
  anchorPayday?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  fixedAmount?: number | null;
  fixedDay?: number | null;
}) {
  const name = input.name?.trim();
  if (!name) return { error: "name required" };
  const wage = toCents(input.hourlyWage);
  if (wage === null || wage < 0) return { error: "invalid wage" };
  const tax = normalizeRate(input.taxRate, 100);
  if (tax === null) return { error: "invalid tax rate" };
  if (!input.color || !HEX.test(input.color)) return { error: "invalid color" };
  const calendarId = input.calendarId ?? null;
  if (calendarId !== null && (typeof calendarId !== "string" || calendarId.length > 256)) {
    return { error: "invalid calendar" };
  }

  const schedule = normalizeSchedule(input);
  if ("error" in schedule) return { error: schedule.error };

  const fixed = normalizeFixed(input);
  if ("error" in fixed) return { error: fixed.error };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { data, error } = await supabase
    .from("income_sources")
    .insert({
      user_id: user.id,
      name,
      hourly_wage: wage,
      tax_rate: tax,
      calendar_id: calendarId,
      color: input.color,
      pay_frequency: schedule.pay_frequency,
      anchor_payday: schedule.anchor_payday,
      period_start: schedule.period_start,
      period_end: schedule.period_end,
      fixed_amount: fixed.fixed_amount,
      fixed_day: fixed.fixed_day,
    })
    .select(INCOME_COLUMNS)
    .single();

  if (error) return { error: error.message };

  revalidatePath("/finance");
  return { error: null, source: data };
}

// Fixed monthly mode is either fully set (amount + day) or fully off.
function normalizeFixed(input: {
  fixedAmount?: number | null;
  fixedDay?: number | null;
}):
  | { fixed_amount: number | null; fixed_day: number | null }
  | { error: string } {
  const amount = input.fixedAmount ?? null;
  const day = input.fixedDay ?? null;
  if (amount === null && day === null) {
    return { fixed_amount: null, fixed_day: null };
  }
  const cents = amount === null ? null : toCents(amount);
  if (cents === null || cents < 0) return { error: "invalid fixed amount" };
  if (day === null || !Number.isInteger(day) || day < 1 || day > 31) {
    return { error: "invalid fixed day" };
  }
  return { fixed_amount: cents, fixed_day: day };
}

// A schedule is either fully set (frequency + the three dates) or fully off.
function normalizeSchedule(input: {
  payFrequency?: string | null;
  anchorPayday?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
}):
  | {
      pay_frequency: PayFrequency | null;
      anchor_payday: string | null;
      period_start: string | null;
      period_end: string | null;
    }
  | { error: string } {
  if (!input.payFrequency) {
    return {
      pay_frequency: null,
      anchor_payday: null,
      period_start: null,
      period_end: null,
    };
  }
  if (!PAY_FREQUENCIES.includes(input.payFrequency as PayFrequency)) {
    return { error: "invalid pay frequency" };
  }
  for (const value of [input.anchorPayday, input.periodStart, input.periodEnd]) {
    if (!value || !ISO_DATE.test(value)) return { error: "invalid pay schedule dates" };
  }
  return {
    pay_frequency: input.payFrequency as PayFrequency,
    anchor_payday: input.anchorPayday as string,
    period_start: input.periodStart as string,
    period_end: input.periodEnd as string,
  };
}

export async function updateIncomeSource(input: {
  id: string;
  name?: string;
  hourlyWage?: number;
  taxRate?: number;
  calendarId?: string | null;
  color?: string;
  payFrequency?: string | null;
  anchorPayday?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  fixedAmount?: number | null;
  fixedDay?: number | null;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const updates: Record<string, unknown> = {};

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) return { error: "name required" };
    updates.name = name;
  }
  if (input.hourlyWage !== undefined) {
    const wage = toCents(input.hourlyWage);
    if (wage === null || wage < 0) return { error: "invalid wage" };
    updates.hourly_wage = wage;
  }
  if (input.taxRate !== undefined) {
    const tax = normalizeRate(input.taxRate, 100);
    if (tax === null) return { error: "invalid tax rate" };
    updates.tax_rate = tax;
  }
  if (input.calendarId !== undefined) {
    if (
      input.calendarId !== null &&
      (typeof input.calendarId !== "string" || input.calendarId.length > 256)
    ) {
      return { error: "invalid calendar" };
    }
    updates.calendar_id = input.calendarId;
  }
  if (input.color !== undefined) {
    if (!HEX.test(input.color)) return { error: "invalid color" };
    updates.color = input.color;
  }
  // The schedule is set as a unit when any of its fields is provided.
  if (
    input.payFrequency !== undefined ||
    input.anchorPayday !== undefined ||
    input.periodStart !== undefined ||
    input.periodEnd !== undefined
  ) {
    const schedule = normalizeSchedule(input);
    if ("error" in schedule) return { error: schedule.error };
    updates.pay_frequency = schedule.pay_frequency;
    updates.anchor_payday = schedule.anchor_payday;
    updates.period_start = schedule.period_start;
    updates.period_end = schedule.period_end;
  }
  // Fixed monthly mode is also set as a unit.
  if (input.fixedAmount !== undefined || input.fixedDay !== undefined) {
    const fixed = normalizeFixed(input);
    if ("error" in fixed) return { error: fixed.error };
    updates.fixed_amount = fixed.fixed_amount;
    updates.fixed_day = fixed.fixed_day;
  }

  if (Object.keys(updates).length === 0) return { error: null };

  const { error } = await supabase
    .from("income_sources")
    .update(updates)
    .eq("id", input.id);

  if (error) return { error: error.message };

  revalidatePath("/finance");
  return { error: null };
}

export async function archiveIncomeSource(id: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  const { error } = await supabase
    .from("income_sources")
    .update({ archived: true })
    .eq("id", id);

  if (error) return { error: error.message };

  revalidatePath("/finance");
  return { error: null };
}
