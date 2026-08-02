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
// Scoped to code that runs on the server: app/lib, app/actions, app/api, and
// `page.tsx`/`layout.tsx` — the last two matter because route components are
// exactly where these helpers get called server-side, and an earlier version of
// this rule missed them entirely while claiming to cover "the server trees".
// (app/login/page.tsx is the one "use client" page; it touches no dates.)
// Client components stay out: there the process clock IS the device's. Bare
// `new Date()` also has many legitimate uses on both sides — durations,
// `updated_at` timestamps, `now` inputs — and every current use in these trees
// is one of those, so a broader rule would be pure noise.
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
    files: [
      "app/lib/**/*.{ts,tsx}",
      "app/actions/**/*.{ts,tsx}",
      "app/api/**/*.{ts,tsx}",
      "app/**/page.tsx",
      "app/**/layout.tsx",
    ],
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
