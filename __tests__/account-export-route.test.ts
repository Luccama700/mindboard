import { describe, expect, test, vi } from "vitest";

import { EXPORT_TABLES } from "@/app/lib/account/export";

// One table answers every page full, as a table with more than the cap would;
// every other table is empty.
const BIG = EXPORT_TABLES[0].table;

vi.mock("@/utils/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({
        data: { user: { id: "u1", email: null, created_at: "2026-01-01T00:00:00Z" } },
      }),
    },
    from: (table: string) => {
      const query = {
        select: () => query,
        order: () => query,
        range: async (from: number, to: number) => ({
          data:
            table === BIG
              ? Array.from({ length: to - from + 1 }, (_, i) => ({ id: String(from + i) }))
              : [],
          error: null,
        }),
      };
      return query;
    },
  }),
}));

import { GET } from "@/app/api/account/export/route";

describe("data export row cap", () => {
  test("a table cut off at the cap is reported in could_not_read, not passed off as complete", async () => {
    const body = JSON.parse(await (await GET()).text());
    expect(body.tables[BIG]).toHaveLength(50_000);
    expect(body.could_not_read?.[BIG]).toMatch(/truncated/);
    // Tables that ended on their own are not flagged.
    expect(Object.keys(body.could_not_read)).toEqual([BIG]);
  });
});
