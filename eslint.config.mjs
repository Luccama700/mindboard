import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Server-side date keys must come from the user's timezone, never the process
// clock — which is UTC on Vercel. Two blessed resolvers exist:
// todayKey(supabase, userId) (app/lib/mcp/config.ts) and
// todayISO(safeTimeZone(tz)) (app/_components/date-utils.ts). This rule bans the
// two shapes that historically bypassed them, and only under the server trees:
// bare `new Date()` has plenty of legitimate uses (durations, timestamps,
// `now` inputs), and a broader rule would rot.
const PROCESS_CLOCK_DATE_KEY = [
  {
    selector:
      "CallExpression[callee.property.name='slice'][callee.object.callee.property.name='toISOString'][arguments.0.value=0][arguments.1.value=10]",
    message:
      "Date key from .toISOString().slice(0, 10) uses the UTC process clock. Use todayKey(supabase, userId) or todayISO(safeTimeZone(tz)).",
  },
  {
    selector:
      "CallExpression[callee.name='toDateKey'][arguments.0.type='NewExpression'][arguments.0.callee.name='Date']",
    message:
      "toDateKey(new Date()) uses the UTC process clock. Use todayKey(supabase, userId) or todayISO(safeTimeZone(tz)).",
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
