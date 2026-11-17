import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  recordBalanceChange: vi.fn<(input: Record<string, unknown>) => Promise<{ error: null }>>(
    async () => ({ error: null }),
  ),
}));

vi.mock("@/app/actions/daily-log", () => ({ saveDailyLog: vi.fn() }));
vi.mock("@/app/actions/finance", () => ({ recordBalanceChange: mocks.recordBalanceChange }));

import { SpendSheet } from "@/app/_components/stream-sheets";

afterEach(cleanup);

describe("bill log sheet", () => {
  test("sends what was spent, never a balance worked out from its own copy", async () => {
    const onLogged = vi.fn();
    render(
      <SpendSheet
        billName="phone"
        amount={50}
        accounts={[{ id: "a1", name: "chequing", balance: 1000, currency: "CAD" }]}
        categories={[]}
        onClose={() => {}}
        onLogged={onLogged}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^log/ }));
    await waitFor(() => expect(onLogged).toHaveBeenCalled());
    const sent = mocks.recordBalanceChange.mock.calls[0][0];
    expect(sent).toMatchObject({ accountId: "a1", spent: 50 });
    expect(sent).not.toHaveProperty("newBalance");
  });
});
