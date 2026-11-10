// @vitest-environment node
// Task 7, behaviour 7's mechanics: a one-time code with 128 bits of entropy,
// stored as a SHA-256 hash, valid for fifteen minutes, usable once.
//
// The raw code never reaches the store: that is the one property worth pinning
// hardest, because the column it would land in is the credential itself.

import { describe, expect, test } from "vitest";
import { createHash } from "node:crypto";

import {
  PAIRING_CODE_BITS,
  PAIRING_TTL_MINUTES,
  createPairingCode,
  hashPairingCode,
  normalizePairingCode,
  randomPairingCode,
  redeemPairingCode,
} from "@/app/lib/v2/engine/pairing";
import { createMemoryStores } from "@/app/lib/v2/store/memory";
import type { RulesDocument } from "@/app/lib/v2/store/types";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-11-09T17:00:00.000Z";
const MINUTE = 60_000;
const CODE = "MNPQRSTVWXYZ0123456789ABCD";

const RULES: RulesDocument = { planner: { timeZone: "UTC" }, lanes: [], feedLabels: {} };

function plus(instant: string, ms: number): string {
  return new Date(Date.parse(instant) + ms).toISOString();
}

async function storesWith(...userIds: string[]) {
  const stores = createMemoryStores();
  for (const userId of userIds) await stores.users.save(userId, { rules: RULES, enabled: true });
  return stores;
}

describe("randomPairingCode", () => {
  test("carries 128 bits in an alphabet with no ambiguous letters", () => {
    expect(PAIRING_CODE_BITS).toBe(128);
    const code = randomPairingCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(code).toBe(normalizePairingCode(code));
  });

  test("does not repeat itself", () => {
    const codes = new Set(Array.from({ length: 200 }, () => randomPairingCode()));
    expect(codes.size).toBe(200);
  });
});

describe("hashPairingCode", () => {
  test("is the SHA-256 hex digest of the normalised code", () => {
    expect(hashPairingCode(CODE)).toBe(createHash("sha256").update(CODE).digest("hex"));
    expect(hashPairingCode("mnpq-rstv wxyz0123456789abcd")).toBe(hashPairingCode(CODE));
  });
});

describe("createPairingCode", () => {
  test("returns the code and stores only its hash", async () => {
    const stores = await storesWith(USER);
    const code = await createPairingCode(stores, USER, NOW, () => CODE);
    expect(code).toBe(CODE);

    // The raw code is not what the store holds: only the digest redeems.
    expect(await stores.channels.redeemPairing(code, "1", NOW)).toBeNull();
    expect(await stores.channels.redeemPairing(hashPairingCode(code), "1", NOW)).toBe(USER);
  });

  test("normalises what the generator hands it", async () => {
    const stores = await storesWith(USER);
    const code = await createPairingCode(stores, USER, NOW, () => " mnpq rstv wxyz0123456789abcd ");
    expect(code).toBe(CODE);
  });

  test("refuses a generator that hands back nothing", async () => {
    const stores = await storesWith(USER);
    await expect(createPairingCode(stores, USER, NOW, () => "   ")).rejects.toThrow();
  });

  test("a new code replaces the old one", async () => {
    const stores = await storesWith(USER);
    const first = await createPairingCode(stores, USER, NOW, () => CODE);
    const second = await createPairingCode(stores, USER, NOW, () => "ABCDEFGHJKMNPQRSTVWXYZ0123");
    expect(await redeemPairingCode(stores, first, "chat-1", NOW)).toBeNull();
    expect(await redeemPairingCode(stores, second, "chat-1", NOW)).toBe(USER);
  });
});

describe("redeemPairingCode", () => {
  test("links the chat to the code's account", async () => {
    const stores = await storesWith(USER);
    const code = await createPairingCode(stores, USER, NOW, () => CODE);
    expect(await redeemPairingCode(stores, code, "chat-1", plus(NOW, MINUTE))).toBe(USER);
    expect(await stores.channels.userForChat("chat-1")).toBe(USER);
    expect((await stores.channels.get(USER))?.chatId).toBe("chat-1");
  });

  test("works once", async () => {
    const stores = await storesWith(USER);
    const code = await createPairingCode(stores, USER, NOW, () => CODE);
    expect(await redeemPairingCode(stores, code, "chat-1", NOW)).toBe(USER);
    expect(await redeemPairingCode(stores, code, "chat-2", NOW)).toBeNull();
  });

  test("is valid for fifteen minutes and not a second longer", async () => {
    expect(PAIRING_TTL_MINUTES).toBe(15);

    const inTime = await storesWith(USER);
    const a = await createPairingCode(inTime, USER, NOW, () => CODE);
    expect(
      await redeemPairingCode(inTime, a, "chat-1", plus(NOW, PAIRING_TTL_MINUTES * MINUTE - 1000)),
    ).toBe(USER);

    const tooLate = await storesWith(USER);
    const b = await createPairingCode(tooLate, USER, NOW, () => CODE);
    expect(
      await redeemPairingCode(tooLate, b, "chat-1", plus(NOW, PAIRING_TTL_MINUTES * MINUTE + 1000)),
    ).toBeNull();
  });

  test("accepts the code the way a person would retype it", async () => {
    const stores = await storesWith(USER);
    await createPairingCode(stores, USER, NOW, () => CODE);
    expect(await redeemPairingCode(stores, " mnpq-rstv-wxyz0123456789abcd ", "chat-1", NOW)).toBe(
      USER,
    );
  });

  test("an unknown code, and an empty one, link nothing", async () => {
    const stores = await storesWith(USER);
    await createPairingCode(stores, USER, NOW, () => CODE);
    expect(await redeemPairingCode(stores, "ZZZZZZZZZZZZZZZZZZZZZZZZZZ", "chat-1", NOW)).toBeNull();
    expect(await redeemPairingCode(stores, "", "chat-1", NOW)).toBeNull();
    expect(await stores.channels.userForChat("chat-1")).toBeNull();
  });

  test("a chat that already belongs to another account cannot be taken over", async () => {
    const stores = await storesWith(USER, OTHER);
    const mine = await createPairingCode(stores, USER, NOW, () => CODE);
    await redeemPairingCode(stores, mine, "chat-1", NOW);

    const theirs = await createPairingCode(stores, OTHER, NOW, () => "ABCDEFGHJKMNPQRSTVWXYZ0123");
    expect(await redeemPairingCode(stores, theirs, "chat-1", NOW)).toBeNull();
    expect(await stores.channels.userForChat("chat-1")).toBe(USER);
  });
});
