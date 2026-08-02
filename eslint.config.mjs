import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Server-side calendar facts must come from the user's timezone, never the
// process clock — which is UTC on Vercel. Two blessed resolvers exist:
// todayKey(supabase, userId) (app/lib/mcp/config.ts) and
// todayISO(safeTimeZone(tz)) (app/_components/date-utils.ts).
//
// SCOPE — read this before trusting the rule. It is a BACKSTOP for two textual
// idioms, not coverage of the defect class. The enforcement mechanism is
// required-argument signatures (todayISO, currentMonth, normalizeMonth,
// recomputeAccountBalance, occurrenceBusyEvents, slotBusyEvents,
// getSpendHistory, getSpendOverrides), because the compiler is the only thing
// that can enumerate call sites. ESLint selectors cannot follow dataflow, so
// the shape that shipped the /week month-window bug —
//   const d = new Date(); `${d.getFullYear()}-${d.getMonth() + 1}`
// — is NOT catchable here once the Date is bound to a variable. If you are
// adding a helper that returns a date key or a month key, give it a required
// `timeZone: string | null` instead of relying on this rule.
//
// Scoped to the server trees only: in a client component the process clock is
// the device's, and bare `new Date()` has many legitimate uses there and here
// (durations, `updated_at` timestamps, `now` inputs) — all 58 current uses in
// these trees are exactly that, so a broader rule would be pure noise.
const PROCESS_CLOCK_DATE_KEY = [
  {
    // Catches the idiom that had two live instances at audit time
    // (recompute.ts, price-lookup.ts). Note it also matches the CORRECT
    // `new Date(zonedWallTimeToUtcMs(...)).toISOString().slice(0, 10)`; if that
    // ever fires, disable it on the line with a reason rather than widening.
    selector:
      "CallExpression[callee.property.name='slice'][callee.object.callee.property.name='toISOString'][arguments.0.value=0][arguments.1.value=10]",
    message:
      "Date key from .toISOString().slice(0, 10) uses the UTC process clock. Use todayKey(supabase, userId) or todayISO(safeTimeZone(tz)).",
  },
  {
    // Local calendar fields read straight off a fresh Date. Zero instances
    // today by design — this one is a tripwire on a general idiom, replacing an
    // earlier `toDateKey(new Date())` selector that could only ever match one
    // spelling in one file and was therefore a no-op dressed as coverage.
    selector:
      "MemberExpression[object.type='NewExpression'][object.callee.name='Date'][object.arguments.length=0]" +
      ":matches([property.name='getFullYear'], [property.name='getMonth'], [property.name='getDate'], [property.name='getDay'], [property.name='getHours'], [property.name='getMinutes'])",
    message:
      "Local calendar fields off a bare new Date() use the UTC process clock on Vercel. Use todayKey/todayISO for date keys, or the zoned-time helpers (zonedDateKey, zonedClockMinutes) for wall-clock facts.",
  },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["app/lib/**/*.{ts,tsx}", "app/actions/**/*.{ts,tsx}", "app/api/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": ["error", ...PROCESS_CLOCK_DATE_KEY],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
