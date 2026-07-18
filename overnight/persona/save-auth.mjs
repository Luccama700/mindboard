#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { stdin as input, stdout as output } from "node:process";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const OVERNIGHT = resolve(HERE, "..");
const AUTH_FILE = join(HERE, "auth-state.json");

function loadDotEnv() {
  const path = join(OVERNIGHT, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}

loadDotEnv();

const url = (process.env.PERSONA_URL ?? process.env.MINDBOARD_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
// Google refuses OAuth in Playwright's bundled Chromium ("this browser or app
// may not be secure"): it detects the automation banner. Sign in through the
// real installed Chrome with that banner stripped, in a dedicated persistent
// profile kept next to the auth file (never the user's own profile). The
// captured cookies replay fine in the bundled headless engine afterwards.
const PROFILE_DIR = join(HERE, "chrome-profile");
const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: "chrome",
  headless: false,
  viewport: null,
  ignoreDefaultArgs: ["--enable-automation"],
});
const page = context.pages()[0] ?? (await context.newPage());
const prompt = createInterface({ input, output });

try {
  console.log(`Opening ${url}. Complete Google sign-in in the browser.`);
  console.log("The saved session contains account credentials and must remain local.");
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await prompt.question("Once Mindboard is fully loaded and you can see the board, press Enter here... ");

  const pathname = new URL(page.url()).pathname;
  if (pathname === "/login" || pathname.startsWith("/auth/")) {
    throw new Error("Mindboard still appears to be on the login flow; authentication state was not saved");
  }

  await context.storageState({ path: AUTH_FILE });
  console.log(`Saved Playwright auth state to ${AUTH_FILE}`);
} finally {
  prompt.close();
  await context.close();
}
