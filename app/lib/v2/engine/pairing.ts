// Linking one Telegram chat to one account, with a code that is a credential:
// 128 random bits, shown once, stored only as a SHA-256 hash, good for fifteen
// minutes, usable once.
//
// A chat id is untrusted input. It becomes an account id in exactly one way, and
// this is it: a code the app generated, hashed, and handed to the person. There
// is no second door, which is why the hash never leaves the store (see
// ChannelsStore.redeemPairing) and why nothing here logs a code.

import { createHash, randomBytes } from "node:crypto";

import type { Instant } from "../types";
import type { Stores } from "../store/types";

/** The entropy a code carries. 128 bits is the whole security argument. */
export const PAIRING_CODE_BITS = 128;
export const PAIRING_TTL_MINUTES = 15;

// Crockford's base32: no I, L, O or U, so nothing in a code can be read as
// something else when it is retyped from a phone screen.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const BITS_PER_CHAR = 5;
const CODE_LENGTH = Math.ceil(PAIRING_CODE_BITS / BITS_PER_CHAR);

/**
 * Upper case, with the separators a person might type stripped, so the code
 * hashes to the same digest whether it was pasted or retyped. Both sides of the
 * exchange normalise, or the hashes cannot meet.
 */
export function normalizePairingCode(code: string): string {
  return code.replace(/[\s-]+/g, "").toUpperCase();
}

/** The digest that is stored. The code itself is never written anywhere. */
export function hashPairingCode(code: string): string {
  return createHash("sha256").update(normalizePairingCode(code)).digest("hex");
}

/** A fresh code with PAIRING_CODE_BITS of randomness behind it. */
export function randomPairingCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = "";
  for (const byte of bytes) code += ALPHABET[byte % ALPHABET.length];
  return code;
}

/**
 * Stores the hash of a one-time code and returns the code to show once.
 *
 * `random` is the generator, injected so a test is deterministic;
 * `randomPairingCode` is the production one and is what carries the 128 bits.
 */
export async function createPairingCode(
  stores: Stores,
  userId: string,
  now: Instant,
  random: () => string,
): Promise<string> {
  const code = normalizePairingCode(random());
  if (code.length === 0) throw new Error("the pairing code generator returned nothing");
  const expiresAt = new Date(Date.parse(now) + PAIRING_TTL_MINUTES * 60_000).toISOString();
  await stores.channels.setPairing(userId, hashPairingCode(code), expiresAt);
  return code;
}

/**
 * Links `chatId` to whichever account holds this code's unexpired hash, and
 * clears the hash in the same statement. Returns that account's id, or null for
 * an unknown code, an expired one, a code already used, or a chat that belongs
 * to someone else.
 */
export async function redeemPairingCode(
  stores: Stores,
  code: string,
  chatId: string,
  now: Instant,
): Promise<string | null> {
  const normalized = normalizePairingCode(code);
  if (normalized.length === 0) return null;
  return stores.channels.redeemPairing(hashPairingCode(normalized), chatId, now);
}
