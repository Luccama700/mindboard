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
