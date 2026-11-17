import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  confirmProposal: vi.fn(),
  cancelProposal: vi.fn(),
}));

vi.mock("@/app/actions/assistant", () => mocks);

import { ApprovalsClient, type PendingProposal } from "@/app/approvals/approvals-client";

const ITEM: PendingProposal = {
  id: "p1",
  tool: "create_task",
  preview: "create task: buy milk",
  at: "2026-11-17T10:00:00Z",
  channel: "chat",
  needsYou: false,
  approvable: true,
};

afterEach(() => {
  cleanup();
  mocks.confirmProposal.mockReset();
  mocks.cancelProposal.mockReset();
});

describe("approvals inbox when an action throws", () => {
  test("approve that throws shows failed and can be retried", async () => {
    mocks.confirmProposal.mockRejectedValueOnce(new Error("network"));
    render(<ApprovalsClient items={[ITEM]} />);
    fireEvent.click(screen.getByRole("button", { name: "approve" }));
    await waitFor(() => expect(screen.getByText(/couldn't reach the server/)).toBeTruthy());
    const approve = screen.getByRole("button", { name: "approve" }) as HTMLButtonElement;
    expect(approve.disabled).toBe(false);

    mocks.confirmProposal.mockResolvedValueOnce({ error: null, preview: "done it" });
    fireEvent.click(approve);
    await waitFor(() => expect(screen.getByText("✓ done")).toBeTruthy());
  });

  test("reject that throws shows failed instead of sticking", async () => {
    mocks.cancelProposal.mockRejectedValueOnce(new Error("db"));
    render(<ApprovalsClient items={[ITEM]} />);
    fireEvent.click(screen.getByRole("button", { name: "reject" }));
    await waitFor(() => expect(screen.getByText(/couldn't reach the server/)).toBeTruthy());
    expect((screen.getByRole("button", { name: "reject" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
