import { describe, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";

// @supabase/ssr hands setAll a second argument: cache headers that must ride on
// any response setting auth cookies. Drive setAll the way the library does on a
// token refresh and check the proxy's response carries them.
vi.mock("@supabase/ssr", () => ({
  createServerClient: (
    _url: string,
    _key: string,
    opts: {
      cookies: {
        setAll(c: { name: string; value: string; options: object }[], h: Record<string, string>): void;
      };
    },
  ) => ({
    auth: {
      getUser: async () => {
        opts.cookies.setAll([{ name: "sb-token", value: "new", options: { path: "/" } }], {
          "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0",
          Expires: "0",
          Pragma: "no-cache",
        });
        return { data: { user: null } };
      },
    },
  }),
}));

import { updateSession } from "@/utils/supabase/middleware";

describe("updateSession", () => {
  test("passes the refresh's no-store headers and cookies through to the response", async () => {
    const res = await updateSession(new NextRequest("https://example.test/"));
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    expect(res.headers.get("pragma")).toBe("no-cache");
    expect(res.cookies.get("sb-token")?.value).toBe("new");
  });
});
