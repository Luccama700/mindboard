import { describe, expect, test } from "vitest";
import {
  CARD_EST,
  cardPlacement,
  clampStep,
  isVisibleRect,
  mobilePlacement,
  spotlightRect,
} from "@/app/_components/onboarding/tour-geometry";
import { isTourKey, routeTourKey, TOURS } from "@/app/_components/onboarding/tours";

const viewport = { width: 1000, height: 800 };

describe("spotlightRect", () => {
  test("pads the anchor on all sides", () => {
    const rect = spotlightRect(
      { top: 100, left: 200, width: 300, height: 50 },
      viewport,
    );
    expect(rect).toEqual({ top: 92, left: 192, width: 316, height: 66 });
  });

  test("clamps to the viewport edges", () => {
    const rect = spotlightRect(
      { top: 2, left: 2, width: 996, height: 300 },
      viewport,
    );
    expect(rect.top).toBe(0);
    expect(rect.left).toBe(0);
    expect(rect.width).toBe(1000);
  });

  test("caps whole-page anchors so a dim ring and card room remain", () => {
    const rect = spotlightRect(
      { top: 0, left: 0, width: 1000, height: 2400 },
      viewport,
    );
    expect(rect.height).toBe(800 * 0.72);
  });

  test("zero-size anchors are not visible", () => {
    expect(isVisibleRect({ top: 0, left: 0, width: 0, height: 0 })).toBe(false);
    expect(isVisibleRect({ top: 5, left: 5, width: 10, height: 10 })).toBe(true);
  });
});

describe("cardPlacement", () => {
  test("goes below an anchor in the upper half", () => {
    const pos = cardPlacement(
      { top: 50, left: 400, width: 100, height: 40 },
      viewport,
      352,
    );
    expect(pos.kind).toBe("below");
    if (pos.kind === "below") expect(pos.top).toBe(102);
  });

  test("goes above when there is no room below", () => {
    const pos = cardPlacement(
      { top: 700, left: 400, width: 100, height: 60 },
      viewport,
      352,
    );
    expect(pos.kind).toBe("above");
    if (pos.kind === "above") expect(pos.bottom).toBe(800 - 700 + 12);
  });

  test("pins to the viewport bottom when the spotlight fills the screen", () => {
    // The finance-calendar case: a huge spotlight starting near the top —
    // no room above, no room below. The card must stay reachable.
    const pos = cardPlacement(
      { top: 20, left: 0, width: 1000, height: 760 },
      viewport,
      352,
    );
    expect(pos.kind).toBe("pinned");
    if (pos.kind === "pinned") expect(pos.bottom).toBe(16);
  });

  test("honors a forced top placement when it fits", () => {
    const pos = cardPlacement(
      { top: 700, left: 400, width: 200, height: 60 },
      viewport,
      352,
      "top",
    );
    expect(pos.kind).toBe("above");
  });

  test("ignores a forced placement that would push the card off-screen", () => {
    const pos = cardPlacement(
      { top: 40, left: 400, width: 200, height: 60 },
      viewport,
      352,
      "top",
    );
    expect(pos.kind).toBe("below");
  });

  test("clamps horizontally to the viewport margins", () => {
    const pos = cardPlacement(
      { top: 100, left: 900, width: 100, height: 40 },
      viewport,
      352,
    );
    expect(pos.left).toBe(1000 - 352 - 16);
  });

  test("fit checks reserve the estimated card footprint", () => {
    const justFits = cardPlacement(
      {
        top: 100,
        left: 0,
        width: 100,
        height: 800 - 100 - 12 - CARD_EST - 16,
      },
      viewport,
      352,
    );
    expect(justFits.kind).toBe("below");
  });
});

describe("mobilePlacement", () => {
  test("sheet goes top when the spotlight is in the lower half", () => {
    expect(
      mobilePlacement({ top: 700, left: 0, width: 100, height: 60 }, viewport),
    ).toBe("top");
  });

  test("sheet goes bottom when the spotlight is in the upper half", () => {
    expect(
      mobilePlacement({ top: 40, left: 0, width: 100, height: 60 }, viewport),
    ).toBe("bottom");
  });

  test("forced placement wins", () => {
    expect(
      mobilePlacement(
        { top: 40, left: 0, width: 100, height: 60 },
        viewport,
        "top",
      ),
    ).toBe("top");
  });
});

describe("clampStep", () => {
  test("keeps the step inside the tour", () => {
    expect(clampStep(-1, 5)).toBe(0);
    expect(clampStep(2, 5)).toBe(2);
    expect(clampStep(9, 5)).toBe(4);
    expect(clampStep(0, 0)).toBe(0);
  });
});

describe("routeTourKey", () => {
  test("maps every touring route to its key", () => {
    expect(routeTourKey("/")).toBe("now");
    expect(routeTourKey("/week")).toBe("week");
    expect(routeTourKey("/plan")).toBe("plan");
    expect(routeTourKey("/finance")).toBe("money");
    expect(routeTourKey("/finance/setup")).toBe("money");
    expect(routeTourKey("/inventory")).toBe("stock");
    expect(routeTourKey("/tasks")).toBe("tasks");
    expect(routeTourKey("/brain")).toBe("brain");
    expect(routeTourKey("/brain/graph")).toBe("brain");
    expect(routeTourKey("/brain/note/Inbox/idea")).toBe("brain");
    expect(routeTourKey("/learn")).toBe("learn");
  });

  test("non-touring routes get none", () => {
    expect(routeTourKey("/settings")).toBeNull();
    expect(routeTourKey("/login")).toBeNull();
    expect(routeTourKey("/weekend")).toBeNull();
  });
});

describe("tour catalog", () => {
  test("every catalog key is a valid tour key and has steps", () => {
    for (const [key, steps] of Object.entries(TOURS)) {
      expect(isTourKey(key)).toBe(true);
      expect(steps.length).toBeGreaterThan(0);
      for (const step of steps) {
        expect(step.title.length).toBeGreaterThan(0);
        expect(step.body.length).toBeGreaterThan(0);
      }
    }
  });

  test("intro is not a coach-mark tour", () => {
    expect("intro" in TOURS).toBe(false);
    expect(isTourKey("intro")).toBe(true);
  });
});
