import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  search: new URLSearchParams(),
  signInWithOAuth: vi.fn(async () => ({ error: null as { message: string } | null })),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => mocks.search,
}));

vi.mock("@/utils/supabase/client", () => ({
  createClient: () => ({ auth: { signInWithOAuth: mocks.signInWithOAuth } }),
}));

import LoginPage from "@/app/login/page";

afterEach(() => {
  cleanup();
  mocks.search = new URLSearchParams();
  mocks.signInWithOAuth.mockReset();
});

describe("login page errors", () => {
  test("says nothing went wrong on a plain visit", () => {
    render(<LoginPage />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("shows a message when the callback sent back ?error=auth", () => {
    mocks.search = new URLSearchParams("error=auth");
    render(<LoginPage />);
    expect(screen.getByRole("alert").textContent).toMatch(/didn't go through/);
  });

  test("shows a message and re-enables the button when signInWithOAuth fails", async () => {
    mocks.signInWithOAuth.mockResolvedValueOnce({ error: { message: "boom" } });
    render(<LoginPage />);
    const button = screen.getByRole("button");
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/couldn't reach/));
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
});
