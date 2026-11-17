import { beforeEach, describe, expect, test, vi } from "vitest";

// deleteMyAccount against fake storage. The point: no bucket is emptied until
// every bucket has been listed, and the message says what really happened.

const state = vi.hoisted(() => ({
  files: {} as Record<string, string[]>,
  failList: null as string | null,
  failRemove: null as string | null,
  removed: [] as { bucket: string; paths: string[] }[],
  deleted: false,
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));
vi.mock("@/utils/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "u1" } } }),
      signOut: async () => ({ error: null }),
    },
  }),
}));
vi.mock("@/utils/supabase/service", () => ({
  createServiceClient: () => ({
    storage: {
      from: (bucket: string) => ({
        list: async (prefix: string) => {
          if (state.failList === bucket) return { data: null, error: { message: "boom" } };
          // Files sit directly under the user's folder: {user}/{name}.
          if (prefix !== "u1") return { data: [], error: null };
          return {
            data: (state.files[bucket] ?? []).map((name) => ({ name, id: `id-${name}` })),
            error: null,
          };
        },
        remove: async (paths: string[]) => {
          if (state.failRemove === bucket) return { error: { message: "boom" } };
          state.removed.push({ bucket, paths });
          return { error: null };
        },
      }),
    },
    auth: {
      admin: {
        deleteUser: async () => {
          state.deleted = true;
          return { error: null };
        },
      },
    },
  }),
}));

import { deleteMyAccount } from "@/app/actions/account";
import { ACCOUNT_DELETE_PHRASE } from "@/app/lib/account/delete";

beforeEach(() => {
  state.files = { "inventory-icons": ["a.png", "b.png"], "course-files": ["c.pdf"] };
  state.failList = null;
  state.failRemove = null;
  state.removed = [];
  state.deleted = false;
});

describe("deleteMyAccount storage purge", () => {
  test("a listing failure in a later bucket removes nothing at all", async () => {
    state.failList = "course-files";
    const result = await deleteMyAccount({ phrase: ACCOUNT_DELETE_PHRASE });
    expect(result.error).toMatch(/nothing was deleted/);
    expect(state.removed).toEqual([]);
    expect(state.deleted).toBe(false);
  });

  test("a removal failure says how many files were already removed", async () => {
    state.failRemove = "course-files";
    const result = await deleteMyAccount({ phrase: ACCOUNT_DELETE_PHRASE });
    expect(result.error).toMatch(/2 of your files were already removed/);
    expect(result.error).toMatch(/NOT deleted/);
    expect(state.deleted).toBe(false);
  });

  test("a removal failure in the first bucket says no files were removed", async () => {
    state.failRemove = "inventory-icons";
    const result = await deleteMyAccount({ phrase: ACCOUNT_DELETE_PHRASE });
    expect(result.error).toMatch(/no files were removed/);
  });

  test("the happy path empties every bucket and then deletes the account", async () => {
    await expect(deleteMyAccount({ phrase: ACCOUNT_DELETE_PHRASE })).rejects.toThrow("NEXT_REDIRECT");
    expect(state.removed.map((r) => r.bucket)).toEqual(["inventory-icons", "course-files"]);
    expect(state.deleted).toBe(true);
  });
});
