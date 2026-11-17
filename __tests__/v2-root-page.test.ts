// @vitest-environment node
// /v2: the way in. It is gated as every v2 page is and it redirects to the desk,
// carrying three search keys and nothing else. The static half of the gate is
// __tests__/v2-source.test.ts, which walks this page the moment it exists.

import type { ReactElement } from "react";

import { afterEach, describe, expect, test, vi } from "vitest";

const sentHost = vi.hoisted(() => ({ value: "127.0.0.1:3111" as string | null }));
vi.mock("next/headers", () => ({
  headers: () =>
    Promise.resolve({
      get: (name: string) => (name.toLowerCase() === "host" ? sentHost.value : null),
    }),
}));

import V2RootPage, { dynamic } from "@/app/v2/page";

const NOT_FOUND_DIGEST = "NEXT_HTTP_ERROR_FALLBACK;404";

afterEach(() => {
  vi.unstubAllEnvs();
  sentHost.value = "127.0.0.1:3111";
});

function sample(env: "preview" | "production" = "preview") {
  vi.stubEnv("V2_FIXTURES", "1");
  vi.stubEnv("V2_LOCAL_SNAPSHOT", "");
  vi.stubEnv("VERCEL_ENV", env);
}

function off() {
  vi.stubEnv("V2_FIXTURES", "");
  vi.stubEnv("V2_LOCAL_SNAPSHOT", "");
  vi.stubEnv("VERCEL_ENV", "preview");
}

/** The digest of what the synchronous part, or the child, throws. */
async function digestOf(search?: Record<string, string | string[] | undefined>): Promise<string> {
  try {
    const outer = V2RootPage(
      search === undefined ? undefined : { searchParams: Promise.resolve(search) },
    ) as unknown as {
      type: (props: unknown) => Promise<ReactElement>;
      props: unknown;
    };
    await outer.type(outer.props);
  } catch (error) {
    return String((error as { digest?: unknown }).digest ?? "no digest");
  }
  return "nothing was thrown";
}

/** Where a request to /v2 with this search ends up: the redirect's target. */
async function target(search?: Record<string, string | string[] | undefined>): Promise<string> {
  const digest = await digestOf(search);
  const [kind, , url] = digest.split(";");
  expect(kind).toBe("NEXT_REDIRECT");
  return url;
}

describe("/v2 is gated as every v2 page is", () => {
  test("is not found with the flags off, from the synchronous part", () => {
    off();
    let digest = "nothing was thrown";
    try {
      V2RootPage();
    } catch (error) {
      digest = String((error as { digest?: unknown }).digest);
    }
    expect(digest).toBe(NOT_FOUND_DIGEST);
  });

  test("is not found in production, flag or no flag", () => {
    sample("production");
    expect(() => V2RootPage()).toThrow();
    let digest = "";
    try {
      V2RootPage();
    } catch (error) {
      digest = String((error as { digest?: unknown }).digest);
    }
    expect(digest).toBe(NOT_FOUND_DIGEST);
  });

  test("renders per request", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  test("refuses a snapshot request whose Host is not this machine", async () => {
    vi.stubEnv("V2_FIXTURES", "");
    vi.stubEnv("V2_LOCAL_SNAPSHOT", process.cwd());
    vi.stubEnv("VERCEL_ENV", "preview");
    sentHost.value = "192.168.1.24:3111";
    expect(await digestOf({})).toBe(NOT_FOUND_DIGEST);
  });
});

describe("/v2 goes to the desk", () => {
  test("with no search, to the bare desk", async () => {
    sample();
    expect(await target()).toBe("/v2/desk");
    expect(await target({})).toBe("/v2/desk");
  });

  test("carries date, week and layout when they are plain", async () => {
    sample();
    expect(await target({ date: "2026-04-15", week: "2026-W16", layout: "focus-1" })).toBe(
      "/v2/desk?date=2026-04-15&week=2026-W16&layout=focus-1",
    );
  });

  test("carries no other key", async () => {
    sample();
    expect(await target({ layout: "wide", next: "https://example.com", utm: "x" })).toBe(
      "/v2/desk?layout=wide",
    );
  });

  test("drops a value that is a list, too long, empty or not plain", async () => {
    sample();
    const forty = "a".repeat(40);
    expect(await target({ date: forty })).toBe(`/v2/desk?date=${forty}`);
    for (const bad of [
      "a".repeat(41),
      "",
      "two words",
      "a/b",
      "a&b=c",
      "..%2f",
      "a_b",
      "café",
      "x\n",
    ]) {
      expect(await target({ layout: bad }), JSON.stringify(bad)).toBe("/v2/desk");
    }
    expect(await target({ layout: ["wide", "focus"] })).toBe("/v2/desk");
    expect(await target({ layout: undefined, date: "2026-04-15" })).toBe(
      "/v2/desk?date=2026-04-15",
    );
  });
});
