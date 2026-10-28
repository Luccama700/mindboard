import { describe, expect, test, vi } from "vitest";

vi.mock("next/server", () => ({
  after: () => {
    throw new Error("outside a request scope");
  },
}));

import { backfillEncryptedColumns } from "@/app/lib/secrets/backfill";

function recordingClient() {
  const calls: { update?: Record<string, string>; eqs: [string, string][] } = { eqs: [] };
  const query = {
    eq(column: string, value: string) {
      calls.eqs.push([column, value]);
      return query;
    },
    then(resolve: (v: unknown) => void) {
      resolve({ error: null });
    },
  };
  const client = {
    from: () => ({
      update(values: Record<string, string>) {
        calls.update = values;
        return query;
      },
    }),
  };
  return { client, calls };
}

describe("backfillEncryptedColumns", () => {
  test("only overwrites the row while it still holds the values that were read", async () => {
    const { client, calls } = recordingClient();
    backfillEncryptedColumns(
      client as never,
      "google_tokens",
      "user-1",
      () => ({ access_token: "v2.cipher" }),
      { access_token: "ya29.plain", expires_at: "2026-10-27T00:00:00+00:00" },
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.update).toEqual({ access_token: "v2.cipher" });
    expect(calls.eqs).toEqual([
      ["user_id", "user-1"],
      ["access_token", "ya29.plain"],
      ["expires_at", "2026-10-27T00:00:00+00:00"],
    ]);
  });

  test("a throwing encryptor never escapes", async () => {
    const { client, calls } = recordingClient();
    expect(() =>
      backfillEncryptedColumns(client as never, "vault_settings", "user-1", () => {
        throw new Error("ASSISTANT_KEY_SECRET is not set");
      }),
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.update).toBeUndefined();
  });
});
