// One control, two different writes (audit 2026-07-28, tranche 3). Typing a
// number is a RECOUNT — the user asserting ground truth about the shelf — and
// commits absolutely. The −/+ buttons are a STEP and send a delta the server
// applies to the live row, because this view can be minutes stale behind a
// phone or an MCP agent.
//
// Both failure modes are silent: a recount that gets skipped leaves the tab and
// the database disagreeing forever with no feedback, and a step that writes an
// absolute destroys whatever another surface wrote in between. Neither shows up
// as an error, so they are pinned here.
import { afterEach, describe, expect, test, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/app/actions/inventory", () => ({
  adjustInventoryQuantity: vi.fn(async () => ({ error: null })),
  createInventoryGroup: vi.fn(async () => ({ error: null })),
  createInventoryItem: vi.fn(async () => ({ error: null })),
  createInventoryUsage: vi.fn(async () => ({ error: null })),
  deleteInventoryGroup: vi.fn(async () => ({ error: null })),
  deleteInventoryItem: vi.fn(async () => ({ error: null })),
  deleteInventoryUsage: vi.fn(async () => ({ error: null })),
  setInventoryItemArchived: vi.fn(async () => ({ error: null })),
  updateInventoryGroup: vi.fn(async () => ({ error: null })),
  updateInventoryItem: vi.fn(async () => ({ error: null })),
  updateInventoryUsage: vi.fn(async () => ({ error: null })),
}));
vi.mock("@/app/actions/inventory-icon", () => ({
  generateItemIcon: vi.fn(async () => ({ error: null })),
}));
vi.mock("@/app/actions/shopping", () => ({
  lookupItemPrices: vi.fn(async () => ({ error: null })),
}));
vi.mock("@/app/actions/settings", () => ({
  saveShoppingSettings: vi.fn(async () => ({ error: null })),
}));
vi.mock("@/app/actions/stock-capture", () => ({
  proposeStockFromText: vi.fn(async () => ({ error: null })),
  proposeStockOps: vi.fn(async () => ({ error: null })),
}));
vi.mock("@/app/actions/assistant", () => ({
  cancelProposal: vi.fn(async () => ({ error: null })),
  confirmProposal: vi.fn(async () => ({ error: null })),
}));
vi.mock("@/utils/supabase/client", () => ({ createClient: vi.fn() }));

import { QuantityField } from "@/app/inventory/inventory-client";

afterEach(cleanup);

type Recorder = { commits: number[]; steps: number[] };

function recorder(): Recorder {
  return { commits: [], steps: [] };
}

// Mirrors how ItemDetail wires the field: `value` is the row's quantity coming
// back down from the parent's optimistic state, and a step moves it the way the
// server would — clamped at zero, which is the case where `value` does NOT move
// and the field gets no correcting sync.
function Harness({
  initial,
  rec,
  bound = true,
}: {
  initial: number;
  rec: Recorder;
  bound?: boolean;
}) {
  const [value, setValue] = useState(initial);
  return (
    <QuantityField
      value={value}
      onCommit={(n) => {
        rec.commits.push(n);
        setValue(n);
      }}
      onStep={
        bound
          ? (delta) => {
              rec.steps.push(delta);
              setValue((v) => Math.max(0, Math.round((v + delta) * 1000) / 1000));
            }
          : undefined
      }
    />
  );
}

const field = () => screen.getByLabelText("quantity") as HTMLInputElement;
const minus = () => screen.getByLabelText("decrease quantity");
const plus = () => screen.getByLabelText("increase quantity");

// Real typing is a keydown followed by an input event. Both are dispatched
// because React drops the change event when the resulting value is identical to
// what is already in the box — so a field driven by change alone would never
// see someone select-all-and-retype the same number.
function type(text: string, key = text.slice(-1) || "Backspace") {
  const el = field();
  fireEvent.keyDown(el, { key });
  fireEvent.change(el, { target: { value: text } });
}

function press(key: string) {
  fireEvent.keyDown(field(), { key });
}

function blur() {
  fireEvent.blur(field());
}

describe("QuantityField recount", () => {
  // The stale-overwrite in the "write too much" direction: the field is
  // populated from `value`, so a bare focus is not an assertion about anything.
  test("blurring an untouched field writes nothing", () => {
    const rec = recorder();
    render(<Harness initial={2} rec={rec} />);
    field().focus();
    blur();
    expect(rec.commits).toEqual([]);
  });

  // The mirror-image bug this tranche fixed, and the hardest case: the tab
  // shows 2 while an agent has pushed the row to 5; the user counts the shelf,
  // sees 2, selects all and types 2. The resulting DOM value is identical, so
  // React fires no change event at all — a `rounded !== value` guard and a
  // change-only "did they type" flag both skip the write, nothing revalidates,
  // and the divergence survives with no feedback. This is the only test that
  // catches either regression.
  test("a recount equal to the number on screen still writes", () => {
    const rec = recorder();
    render(<Harness initial={2} rec={rec} />);
    type("2");
    blur();
    expect(rec.commits).toEqual([2]);
    expect(rec.steps).toEqual([]);
  });

  test("tabbing or arrowing through the field is not an assertion", () => {
    const rec = recorder();
    render(<Harness initial={2} rec={rec} />);
    for (const key of ["Tab", "ArrowLeft", "ArrowRight", "Home", "End"]) {
      press(key);
    }
    blur();
    expect(rec.commits).toEqual([]);
  });

  test("a different number writes as an absolute recount", () => {
    const rec = recorder();
    render(<Harness initial={2} rec={rec} />);
    type("5");
    blur();
    expect(rec.commits).toEqual([5]);
    expect(rec.steps).toEqual([]);
  });

  // Number("") is 0, so without the blank guard clearing the box and tapping
  // away silently zeroes real stock.
  test("an emptied field reverts instead of committing zero", () => {
    const rec = recorder();
    render(<Harness initial={4} rec={rec} />);
    type("");
    blur();
    expect(rec.commits).toEqual([]);
    expect(field().value).toBe("4");
  });
});

describe("QuantityField steppers", () => {
  test("send a delta, never an absolute", () => {
    const rec = recorder();
    render(<Harness initial={2} rec={rec} />);
    fireEvent.click(plus());
    fireEvent.click(minus());
    expect(rec.steps).toEqual([1, -1]);
    expect(rec.commits).toEqual([]);
  });

  // The containment for the stranded draft. Safari does not blur an input when
  // a <button> is clicked, so an uncommitted "7" is still in the box; the write
  // is clamped (0 − 1 → 0) so `value` never changes and the field never gets a
  // correcting sync. Synthesizing a draft here left "6" — a number nobody typed
  // — sitting in the box for the next blur to commit as a recount. The absence
  // of that synthesis is what this pins.
  test("a step does not invent a draft for the next blur to commit", () => {
    const rec = recorder();
    render(<Harness initial={0} rec={rec} />);
    type("7");
    fireEvent.click(minus());

    expect(rec.steps).toEqual([-1]);
    expect(rec.commits).toEqual([]);
    expect(field().value).toBe("7");
    expect(field().value).not.toBe("6");

    // Accepted residual, asserted so it stays a decision: the value that
    // survives to the blur is the one the user actually typed. An invented 6
    // reaching this line is the regression.
    blur();
    expect(rec.commits).toEqual([7]);
  });

  // A step that does move the row syncs the field from the server's number and
  // clears the assertion with it, so the discarded typing cannot be committed
  // on a later blur.
  test("a value arriving from the parent resets the field and the assertion", () => {
    const rec = recorder();
    render(<Harness initial={2} rec={rec} />);
    type("9");
    fireEvent.click(plus());

    expect(rec.steps).toEqual([1]);
    expect(field().value).toBe("3");

    blur();
    expect(rec.commits).toEqual([]);
  });

  // The add form has no row to apply a delta to, so there the local draft is
  // the only truth and the buttons commit absolutely.
  test("without onStep the buttons commit an absolute", () => {
    const rec = recorder();
    render(<Harness initial={2} rec={rec} bound={false} />);
    fireEvent.click(plus());
    expect(rec.commits).toEqual([3]);
    expect(rec.steps).toEqual([]);
  });
});
