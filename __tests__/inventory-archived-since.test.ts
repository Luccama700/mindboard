import { describe, expect, test, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

import { archivedSinceLabel } from "@/app/inventory/inventory-client";

describe("archivedSinceLabel", () => {
  test("prints the day in the user's zone, not the machine's", () => {
    // 05:00 UTC on 17 Nov is still the evening of 16 Nov in Vancouver. The
    // server runs in UTC, so without the zone it printed "nov 17" and the
    // browser "nov 16", and React threw a hydration error.
    expect(archivedSinceLabel("2026-11-17T05:00:00Z", "America/Vancouver")).toBe("nov 16");
    expect(archivedSinceLabel("2026-11-17T05:00:00Z", "UTC")).toBe("nov 17");
  });

  test("nothing when the item was never archived", () => {
    expect(archivedSinceLabel(null, "UTC")).toBeNull();
  });
});
