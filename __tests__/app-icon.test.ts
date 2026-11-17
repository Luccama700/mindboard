import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

// Without an app icon Next emits no <link rel="icon">, so every browser asks
// for /favicon.ico and logs a 404 on every page.
describe("app icon", () => {
  test("app/icon.svg exists and is an svg", () => {
    const svg = readFileSync(path.join(__dirname, "..", "app", "icon.svg"), "utf8");
    expect(svg.trimStart().startsWith("<svg")).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });
});
