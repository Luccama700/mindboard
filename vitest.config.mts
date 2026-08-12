import path from "node:path";
import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

// Pin the host zone so date behaviour is identical on a dev box and in CI.
// UTC on purpose: it is the process clock the Vercel deployment actually runs
// on, so "the process clock disagrees with the user's zone" — the whole
// timezone defect class — is reproduced rather than masked. Without this, tests
// that assert a device-vs-server day split silently pass on any host at
// >= UTC+1, because both sides land on the same date. Must be set before any
// module reads the clock, hence here rather than in a setup file.
process.env.TZ = "UTC";

export default defineConfig({
  plugins: [react()],
  resolve: {
    tsconfigPaths: true,
    alias: {
      // Next.js provides this marker package at build time; tests import
      // server modules directly, so resolve it to an empty stub.
      "server-only": path.resolve(__dirname, "test/server-only-stub.ts"),
    },
  },
  test: {
    environment: "jsdom",
    globals: false,
    // Same rationale as eslint.config.mjs: agent worktrees under
    // .claude/worktrees duplicate the whole suite.
    exclude: [...configDefaults.exclude, ".claude/worktrees/**"],
  },
});
