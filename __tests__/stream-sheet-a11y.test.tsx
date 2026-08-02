// Modal contract for the shared Sheet primitive (audit 2026-07-28): with
// VoiceOver, opening a sheet and swiping right used to walk straight out into
// the dashboard underneath — readable and activatable, but covered by the
// scrim. These lock in aria-modal, a non-focusable scrim, the focus trap,
// Escape, and focus restore.
//
// Several cases here exist because a container-scoped handler passes the
// obvious tests and still fails in the product: the sheets disable their save
// button mid-transition (which blurs focus to <body>), and the save path
// unmounts the opener before focus can be restored to it.
import { afterEach, describe, expect, test, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/app/actions/daily-log", () => ({
  saveDailyLog: vi.fn(async () => ({ error: null })),
}));
vi.mock("@/app/actions/finance", () => ({
  recordBalanceChange: vi.fn(async () => ({ error: null })),
}));

import { Sheet } from "@/app/_components/stream-sheets";

afterEach(cleanup);

// Mounts the sheet from a real trigger so document.activeElement is the opener
// when Sheet captures it — the same shape as the dashboard's pulse buttons.
// `vanishing` reproduces the save path, where completing the check-in removes
// the card holding the opener in the same commit that closes the sheet.
function Harness({ vanishing = false }: { vanishing?: boolean }) {
  const [open, setOpen] = useState(false);
  const [openerGone, setOpenerGone] = useState(false);
  return (
    <main>
      {!openerGone && (
        <button type="button" onClick={() => setOpen(true)}>
          open
        </button>
      )}
      {open && (
        <Sheet
          title="log today"
          onClose={() => {
            if (vanishing) setOpenerGone(true);
            setOpen(false);
          }}
        >
          <input aria-label="sleep" />
          <button type="button">save</button>
        </Sheet>
      )}
    </main>
  );
}

function openSheet() {
  const opener = screen.getByRole("button", { name: "open" });
  opener.focus();
  fireEvent.click(opener);
  return opener;
}

const closeButton = () => screen.getByRole("button", { name: "close sheet" });
const saveButton = () => screen.getByRole("button", { name: "save" });

describe("Sheet modal semantics", () => {
  test("marks itself aria-modal so assistive tech cannot walk out", () => {
    render(<Harness />);
    openSheet();
    expect(screen.getByRole("dialog")).toHaveProperty("ariaModal", "true");
  });

  test("names the dialog, so focusing it announces the sheet", () => {
    render(<Harness />);
    openSheet();
    expect(screen.getByRole("dialog", { name: "log today" })).not.toBeNull();
  });

  test("the scrim is inert to focus and hidden from the a11y tree", () => {
    const { container } = render(<Harness />);
    openSheet();
    const scrim = container.querySelector(".glass-scrim") as HTMLElement;
    expect(scrim.getAttribute("aria-hidden")).toBe("true");
    expect(scrim.tagName).not.toBe("BUTTON");
    expect(scrim.matches("button, [tabindex]")).toBe(false);
  });

  test("clicking the scrim still dismisses", () => {
    const { container } = render(<Harness />);
    openSheet();
    fireEvent.click(container.querySelector(".glass-scrim") as Element);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Sheet focus management", () => {
  test("moves focus to the dialog on open", () => {
    render(<Harness />);
    openSheet();
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
  });

  test("Tab from the dialog itself enters the sheet", () => {
    render(<Harness />);
    openSheet();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(closeButton());
  });

  test("Shift+Tab from the dialog itself goes to the last control", () => {
    render(<Harness />);
    openSheet();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(saveButton());
  });

  test("Tab from the last control wraps to the first", () => {
    render(<Harness />);
    openSheet();
    saveButton().focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(closeButton());
  });

  test("Shift+Tab from the first control wraps to the last", () => {
    render(<Harness />);
    openSheet();
    closeButton().focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(saveButton());
  });

  // A disabled-while-saving button blurs to <body>. If the trap only listened
  // on the dialog, Tab from here would walk into the dashboard behind the scrim.
  test("Tab pulls focus back in after it has fallen to the body", () => {
    render(<Harness />);
    openSheet();
    (document.activeElement as HTMLElement)?.blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: "Tab" });
    expect(document.activeElement).toBe(closeButton());
  });

  test("Escape works even when focus has fallen outside the dialog", () => {
    render(<Harness />);
    openSheet();
    (document.activeElement as HTMLElement)?.blur();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("returns focus to the opener after closing", () => {
    render(<Harness />);
    const opener = openSheet();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  // The save path: the opener is already detached when cleanup runs, so a bare
  // isConnected check silently drops focus on <body>.
  test("falls back to the main landmark when the opener is gone", () => {
    render(<Harness vanishing />);
    openSheet();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "open" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });
});

describe("Sheet teardown", () => {
  test("stops listening for Escape once closed", () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <Sheet title="log today" onClose={onClose}>
        <button type="button">save</button>
      </Sheet>,
    );
    unmount();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
