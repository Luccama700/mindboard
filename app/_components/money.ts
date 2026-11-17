export function formatMoney(amount: number, currency = "USD"): string {
  const value = Number.isFinite(amount) ? amount : 0;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).format(value);
  } catch {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(value);
  }
}

// A figure for a space too narrow for a currency string: a day cell of the
// cashflow calendar on a phone is about 34px of text, and "CA$6,166.08" is
// more than twice that. No symbol (the panel around it states the currency),
// no cents, thousands as k: 318 → "318", 6166.08 → "6.2k", 12500 → "13k".
// The exact figure is always one tap away in the selected-day panel.
export function formatMoneyCompact(amount: number): string {
  const value = Number.isFinite(amount) ? amount : 0;
  const sign = value < 0 ? "−" : "";
  const abs = Math.abs(value);
  const withUnit = (scaled: number, unit: string) => {
    // One decimal below ten of the unit ("6.2k"), none above ("13k"), and
    // never a trailing ".0".
    const text =
      scaled < 9.95 ? scaled.toFixed(1).replace(/\.0$/, "") : String(Math.round(scaled));
    return `${sign}${text}${unit}`;
  };
  if (abs >= 999_500) return withUnit(abs / 1_000_000, "m");
  if (abs >= 999.5) return withUnit(abs / 1_000, "k");
  return `${sign}${Math.round(abs)}`;
}

// Signed magnitude for ledger rows: "−$80.00" / "+$1,200.00".
export function formatSignedChange(
  amount: number,
  direction: "in" | "out",
  currency = "USD",
): string {
  const sign = direction === "out" ? "−" : "+";
  return `${sign}${formatMoney(Math.abs(amount), currency)}`;
}

// Sum of money values, rounded to the cent so float drift never leaves a
// phantom remainder.
export function sumMoney(values: number[]): number {
  return Math.round(values.reduce((sum, v) => sum + v, 0) * 100) / 100;
}

// Split a money total into `parts` amounts that sum back to it exactly (to the
// cent). Leftover pennies are handed to the earliest parts, so splitting 100
// three ways gives [33.34, 33.33, 33.33]. Used to seed an even split that the
// user can then adjust.
export function splitEvenly(total: number, parts: number): number[] {
  if (parts <= 0) return [];
  const totalCents = Math.round(total * 100);
  const sign = totalCents < 0 ? -1 : 1;
  const abs = Math.abs(totalCents);
  const base = Math.floor(abs / parts);
  let remainder = abs - base * parts;
  return Array.from({ length: parts }, () => {
    const cents = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder--;
    return (sign * cents) / 100;
  });
}
