import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  ACCOUNT_DELETE_PHRASE,
  USER_STORAGE_BUCKETS,
  chunk,
  collectObjectPaths,
  isDeploymentOwner,
  matchesDeletePhrase,
  type StorageEntry,
} from "../app/lib/account/delete";

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

describe("matchesDeletePhrase", () => {
  test("accepts the exact phrase", () => {
    expect(matchesDeletePhrase(ACCOUNT_DELETE_PHRASE)).toBe(true);
  });

  test("tolerates the iphone keyboard: capitalisation and stray spaces", () => {
    expect(matchesDeletePhrase("  Delete my account ")).toBe(true);
    expect(matchesDeletePhrase("delete  my   account")).toBe(true);
  });

  test("rejects anything else", () => {
    for (const bad of ["", "delete", "delete my acount", "delete my accounts"]) {
      expect(matchesDeletePhrase(bad)).toBe(false);
    }
  });
});

describe("isDeploymentOwner", () => {
  const owner = "11111111-1111-1111-1111-111111111111";
  const urcOwner = "22222222-2222-2222-2222-222222222222";
  const other = "33333333-3333-3333-3333-333333333333";

  test("refuses whichever owner env is set", () => {
    expect(isDeploymentOwner(owner, { MINDBOARD_OWNER_USER_ID: owner })).toBe(true);
    expect(isDeploymentOwner(urcOwner, { URC_OWNER_USER_ID: urcOwner })).toBe(true);
    expect(
      isDeploymentOwner(urcOwner, {
        MINDBOARD_OWNER_USER_ID: owner,
        URC_OWNER_USER_ID: urcOwner,
      }),
    ).toBe(true);
  });

  test("lets every other tenant through", () => {
    expect(
      isDeploymentOwner(other, {
        MINDBOARD_OWNER_USER_ID: owner,
        URC_OWNER_USER_ID: urcOwner,
      }),
    ).toBe(false);
  });

  test("unset or blank env never matches a blank id", () => {
    expect(isDeploymentOwner("", {})).toBe(false);
    expect(isDeploymentOwner("", { MINDBOARD_OWNER_USER_ID: "   " })).toBe(false);
  });

  test("ignores surrounding whitespace in the env value", () => {
    expect(isDeploymentOwner(owner, { MINDBOARD_OWNER_USER_ID: ` ${owner}\n` })).toBe(
      true,
    );
  });
});

function fakeStore(tree: Record<string, StorageEntry[]>) {
  const calls: { prefix: string; offset: number }[] = [];
  const listPage = async (prefix: string, offset: number, limit: number) => {
    calls.push({ prefix, offset });
    return (tree[prefix] ?? []).slice(offset, offset + limit);
  };
  return { listPage, calls };
}

const file = (name: string): StorageEntry => ({ name, id: `id-${name}` });
const folder = (name: string): StorageEntry => ({ name, id: null });

describe("collectObjectPaths", () => {
  test("recurses into the {user}/{source}/file layout", async () => {
    const { listPage } = fakeStore({
      u1: [folder("src-a"), file("loose.png")],
      "u1/src-a": [file("one.pdf"), file("two.pdf")],
    });
    const paths = await collectObjectPaths(listPage, "u1");
    expect(paths.sort()).toEqual([
      "u1/loose.png",
      "u1/src-a/one.pdf",
      "u1/src-a/two.pdf",
    ]);
  });

  test("pages until a short page ends the folder", async () => {
    const names = Array.from({ length: 7 }, (_, i) => file(`f${i}.png`));
    const { listPage, calls } = fakeStore({ u1: names });
    const paths = await collectObjectPaths(listPage, "u1", { pageSize: 3 });
    expect(paths).toHaveLength(7);
    expect(calls.map((c) => c.offset)).toEqual([0, 3, 6]);
  });

  test("a folder that is exactly one full page still terminates", async () => {
    const { listPage } = fakeStore({ u1: [file("a"), file("b")] });
    const paths = await collectObjectPaths(listPage, "u1", { pageSize: 2 });
    expect(paths).toEqual(["u1/a", "u1/b"]);
  });

  test("never walks another user's prefix", async () => {
    const { listPage, calls } = fakeStore({
      u1: [folder("src")],
      "u1/src": [file("mine.pdf")],
      u2: [file("theirs.pdf")],
    });
    const paths = await collectObjectPaths(listPage, "u1");
    expect(paths).toEqual(["u1/src/mine.pdf"]);
    expect(calls.every((c) => c.prefix.startsWith("u1"))).toBe(true);
  });

  test("stops descending at maxDepth", async () => {
    const { listPage } = fakeStore({
      u1: [folder("a")],
      "u1/a": [folder("b")],
      "u1/a/b": [file("deep.png")],
    });
    expect(await collectObjectPaths(listPage, "u1", { maxDepth: 1 })).toEqual([]);
    expect(await collectObjectPaths(listPage, "u1", { maxDepth: 2 })).toEqual([
      "u1/a/b/deep.png",
    ]);
  });

  test("throws rather than silently under-deleting past the cap", async () => {
    const names = Array.from({ length: 10 }, (_, i) => file(`f${i}`));
    const { listPage } = fakeStore({ u1: names });
    await expect(
      collectObjectPaths(listPage, "u1", { pageSize: 10, maxObjects: 5 }),
    ).rejects.toThrow(/more than 5/);
  });

  test("an empty prefix collects nothing", async () => {
    const { listPage } = fakeStore({});
    expect(await collectObjectPaths(listPage, "u1")).toEqual([]);
  });
});

describe("chunk", () => {
  test("splits into batches and never emits an empty one", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
    expect(chunk([1, 2], 10)).toEqual([[1, 2]]);
  });
});

describe("storage bucket coverage", () => {
  test("every bucket the migrations create is purged on delete", () => {
    const buckets = new Set<string>();
    for (const name of readdirSync(MIGRATIONS)) {
      if (!name.endsWith(".sql")) continue;
      const sql = readFileSync(join(MIGRATIONS, name), "utf8");
      for (const match of sql.matchAll(
        /insert\s+into\s+storage\.buckets[^;]*?values\s*\(\s*'([a-z0-9-]+)'/gi,
      )) {
        buckets.add(match[1]);
      }
    }
    expect(buckets.size).toBeGreaterThan(0);
    expect([...buckets].sort()).toEqual([...USER_STORAGE_BUCKETS].sort());
  });
});
