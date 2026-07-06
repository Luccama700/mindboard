import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

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
  },
});
