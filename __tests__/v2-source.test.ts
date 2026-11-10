// @vitest-environment node
// The one gate every v2 page goes through.
//
// There used to be three checks written out inside app/v2/today/page.tsx. They
// are the same three checks, in one module, because a second page is about to
// need them and two copies of a gate is how one of them comes to be wrong.
//
// WHAT IS PINNED HERE. The order of the two environment checks (the sample
// first, so a preview can always show invented data), that production opens
// neither, that the loopback speed bump guards the snapshot and NOT the sample,
// and that every page under app/v2 asks this module rather than reading the
// variables itself. Nothing here is about what a page then renders.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import {
  isLoopbackHost,
  requireLoopback,
  screenSource,
  type ScreenSource,
} from "@/app/lib/v2/source";
import { isLoopbackHost as reExported } from "@/app/lib/v2/local/snapshot";

// There is no request in a test, so the one header the gate reads is stood in
// for. `sentHost` is what the client claimed to have asked for, and `asked`
// counts the times the gate went looking at all: the sample must not look.
const sentHost = vi.hoisted(() => ({ value: null as string | null, asked: 0 }));
vi.mock("next/headers", () => ({
  headers: () => {
    sentHost.asked += 1;
    return Promise.resolve({
      get: (name: string) => (name.toLowerCase() === "host" ? sentHost.value : null),
    });
  },
}));

/** What `notFound()` throws, as Next spells it (http-access-fallback.js). */
const NOT_FOUND_DIGEST = "NEXT_HTTP_ERROR_FALLBACK;404";

const SAMPLE: ScreenSource = { kind: "sample" };
const LOCAL: ScreenSource = { kind: "local", dir: "/var/data/snapshot" };

/** The error of something that should have answered 404, or a failure. */
async function refusal(run: () => unknown): Promise<{ digest?: unknown; message: string }> {
  try {
    await run();
  } catch (error) {
    return error as { digest?: unknown; message: string };
  }
  throw new Error("it answered when it should not have");
}

describe("screenSource", () => {
  test("is the sample when the fixtures flag is exactly on", () => {
    expect(screenSource({ V2_FIXTURES: "1" })).toEqual({ kind: "sample" });
    expect(screenSource({ V2_FIXTURES: "1", VERCEL_ENV: "preview" })).toEqual({
      kind: "sample",
    });
    expect(screenSource({ V2_FIXTURES: "1", VERCEL_ENV: "development" })).toEqual({
      kind: "sample",
    });
  });

  test("takes nothing else for the flag", () => {
    for (const value of ["", " ", "0", "true", "yes", "on", "1 ", "01"]) {
      expect(screenSource({ V2_FIXTURES: value })).toBeNull();
    }
  });

  test("prefers the sample over a snapshot, as the page did", () => {
    expect(
      screenSource({ V2_FIXTURES: "1", V2_LOCAL_SNAPSHOT: "/var/data/snapshot" }),
    ).toEqual({ kind: "sample" });
  });

  test("falls to the snapshot folder when the flag is off", () => {
    expect(screenSource({ V2_LOCAL_SNAPSHOT: "/var/data/snapshot" })).toEqual({
      kind: "local",
      dir: "/var/data/snapshot",
    });
    expect(
      screenSource({ V2_FIXTURES: "", V2_LOCAL_SNAPSHOT: "C:\\data\\snapshot" }),
    ).toEqual({ kind: "local", dir: "C:\\data\\snapshot" });
    expect(
      screenSource({ V2_LOCAL_SNAPSHOT: "\\\\box\\share\\snapshot" }),
    ).toEqual({ kind: "local", dir: "\\\\box\\share\\snapshot" });
  });

  test("refuses a path that is not absolute, and no path at all", () => {
    for (const dir of ["", "   ", "snapshot", "./snapshot", "../snapshot", "data/snapshot"]) {
      expect(screenSource({ V2_LOCAL_SNAPSHOT: dir })).toBeNull();
    }
    expect(screenSource({})).toBeNull();
  });

  test("opens neither in production, whatever is set", () => {
    expect(
      screenSource({
        V2_FIXTURES: "1",
        V2_LOCAL_SNAPSHOT: "/var/data/snapshot",
        VERCEL_ENV: "production",
      }),
    ).toBeNull();
    expect(
      screenSource({ V2_LOCAL_SNAPSHOT: "C:\\data\\snapshot", VERCEL_ENV: "production" }),
    ).toBeNull();
  });

  test("is pure: the same environment always answers the same way", () => {
    const env = { V2_FIXTURES: "", V2_LOCAL_SNAPSHOT: "/var/data/snapshot" };
    expect(screenSource(env)).toEqual(screenSource(env));
  });
});

// A Host header is the client's own claim, so this is a speed bump and nothing
// more: it turns the accident (a phone on the same network opening the dev URL,
// a scanner walking the subnet) into a 404 and stops nobody who is trying. What
// keeps the folder off the network is binding the server to 127.0.0.1.
describe("requireLoopback", () => {
  test("lets the sample through to any host, and never even asks", async () => {
    for (const host of ["mindboard-git-rebuild-example.vercel.app", "192.168.1.24:3111", null]) {
      sentHost.value = host;
      sentHost.asked = 0;
      await expect(requireLoopback(SAMPLE)).resolves.toBeUndefined();
      expect(sentHost.asked).toBe(0);
    }
  });

  test("serves each spelling of the loopback address in local mode", async () => {
    for (const host of ["localhost:3111", "127.0.0.1:3111", "[::1]:3111", "localhost"]) {
      sentHost.value = host;
      await expect(requireLoopback(LOCAL)).resolves.toBeUndefined();
    }
  });

  test("sends every other host to the not-found page", async () => {
    for (const host of ["192.168.1.24:3111", "10.0.0.5", "example.com", null, ""]) {
      sentHost.value = host;
      expect((await refusal(() => requireLoopback(LOCAL))).digest).toBe(NOT_FOUND_DIGEST);
    }
  });

  test("never repeats the host it refused, in a log or in the answer", async () => {
    const forged = "Host-From-A-Stranger.example.com";
    sentHost.value = forged;
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    try {
      const error = await refusal(() => requireLoopback(LOCAL));
      expect(error.message).not.toContain(forged);
      expect(JSON.stringify(error.digest)).not.toContain(forged);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

// The function moved here from the snapshot loader, which re-exports it so the
// loader's own callers did not have to change. One function, not two.
describe("isLoopbackHost", () => {
  test("is the very same function the snapshot loader exports", () => {
    expect(reExported).toBe(isLoopbackHost);
  });

  test("knows the three spellings, with or without a port", () => {
    for (const host of [
      "localhost",
      "localhost:3111",
      "LOCALHOST:3111",
      "127.0.0.1",
      "127.0.0.1:3111",
      "[::1]",
      "[::1]:3111",
      "::1",
      " localhost:3111 ",
    ]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  test("refuses every other host, and no host at all", () => {
    for (const host of [
      null,
      undefined,
      "",
      "   ",
      "192.168.1.24:3111",
      "0.0.0.0:3111",
      "[::]:3111",
      "[fe80::1]:3111",
      "127.0.0.2:3111",
      "localhost.example.com",
      "notlocalhost",
      "127.0.0.1.example.com",
      "localhost:not-a-port",
    ]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

// One gate, and the only way to tell that a page did not quietly grow a second
// one is to read the page. Every v2 page, found by walking the tree rather than
// by a list, so a page added later cannot slip past this.
describe("every v2 page goes through the gate", () => {
  const ROOT = path.resolve(__dirname, "..");

  function pagesUnder(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const next = `${dir}/${entry.name}`;
      if (entry.isDirectory()) found.push(...pagesUnder(next));
      else if (entry.name === "page.tsx") found.push(next);
    }
    return found;
  }

  const pages = pagesUnder("app/v2");
  const codeOf = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

  test("finds the pages at all", () => {
    expect(pages).toContain("app/v2/today/page.tsx");
  });

  test("each one decides what it may show through this module", () => {
    for (const file of pages) {
      const code = codeOf(file);
      expect(code, file).toContain("screenSource(");
      expect(code, file).toContain("requireLoopback(");
    }
  });

  test("and none of them reads the environment itself", () => {
    for (const file of pages) {
      const code = codeOf(file);
      expect(code, file).not.toContain("localSnapshotDir");
      expect(code, file).not.toContain("fixturesEnabled");
    }
  });
});
