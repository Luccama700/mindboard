import { afterEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "u1" } as { id: string } | null,
  revokeConnectedApp: vi.fn(async () => ({ error: null as string | null })),
  revokeAllConnectedApps: vi.fn(async () => ({ error: null as string | null })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/utils/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: mocks.user } }) },
  }),
}));
vi.mock("@/app/lib/mcp/oauth-store", () => ({
  revokeConnectedApp: mocks.revokeConnectedApp,
  revokeAllConnectedApps: mocks.revokeAllConnectedApps,
}));

import { revokeAllConnections, revokeConnection } from "@/app/actions/oauth-grants";

const form = (id?: string) => {
  const f = new FormData();
  if (id) f.set("id", id);
  return f;
};

afterEach(() => {
  mocks.user = { id: "u1" };
  mocks.revokeConnectedApp.mockReset().mockResolvedValue({ error: null });
  mocks.revokeAllConnectedApps.mockReset().mockResolvedValue({ error: null });
});

describe("connected apps revoke actions", () => {
  test("a failed revoke comes back to the button instead of being dropped", async () => {
    mocks.revokeConnectedApp.mockResolvedValueOnce({ error: "could not revoke this connection" });
    expect(await revokeConnection({ error: null }, form("g1"))).toEqual({
      error: "could not revoke this connection",
    });
    expect(mocks.revokeConnectedApp).toHaveBeenCalledWith("u1", "g1");
  });

  test("a successful revoke reports no error", async () => {
    expect(await revokeConnection({ error: null }, form("g1"))).toEqual({ error: null });
  });

  test("revoke all returns its error too", async () => {
    mocks.revokeAllConnectedApps.mockResolvedValueOnce({ error: "could not revoke these connections" });
    expect(await revokeAllConnections()).toEqual({
      error: "could not revoke these connections",
    });
  });

  test("signed out or no id never reaches the store", async () => {
    expect((await revokeConnection({ error: null }, form())).error).not.toBeNull();
    mocks.user = null;
    expect((await revokeConnection({ error: null }, form("g1"))).error).not.toBeNull();
    expect(mocks.revokeConnectedApp).not.toHaveBeenCalled();
  });
});
