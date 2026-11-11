// PLAN-DESK Task 9: the desk's page. The gate and what it reads (behaviour 1),
// one page for every layout (2), the first client render being the server's
// HTML (6), the one live region and the notes (12), and the local source (13).
// The workspace, the frames, the rail and the bars are in
// v2-desk-workspace.test.ts.
//
// The bodies here are the real ones: a press on the day's line is a real press
// and has to survive a change of layout.
//
// JSX would need a .tsx file, hence createElement, as in the other v2 tests.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createElement, type ReactElement } from "react";
import type { Root } from "react-dom/client";

import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// There is no request in a test, and the snapshot branch reads one header.
const request = vi.hoisted(() => ({ host: "127.0.0.1:3111" }));
vi.mock("next/headers", () => ({
  headers: () =>
    Promise.resolve({
      get: (name: string) => (name.toLowerCase() === "host" ? request.host : null),
    }),
}));

import { sampleDesk } from "@/app/lib/v2/fixtures/sample-desk";
import { sampleWeek } from "@/app/lib/v2/fixtures/sample-week";
import { EMPTY_TILE_SET, setCurrent, type TileSet } from "@/app/lib/v2/tiles";
import type { DeskScreenData } from "@/app/lib/v2/view/desk-data";
import { TODAY_COPY } from "@/app/lib/v2/view/today";
import { SnapshotError } from "@/app/v2/_components/snapshot-error";
import { DESK_PROPERTY_RULES, DeskClient } from "@/app/v2/_desk/desk-client";
import { deskHref } from "@/app/v2/_desk/use-tiles";
import DeskPage, { dynamic, metadata } from "@/app/v2/desk/page";

/** What `notFound()` throws, as Next spells it (http-access-fallback.js). */
const NOT_FOUND_DIGEST = "NEXT_HTTP_ERROR_FALLBACK;404";

const made: string[] = [];

/** jsdom has no matchMedia: this one answers `(min-width: Npx)` against a set width. */
function stubMedia(width: number, onRead?: () => void) {
  const matchMedia = (query: string): MediaQueryList => {
    onRead?.();
    const min = Number(/min-width:\s*(\d+)px/.exec(query)?.[1] ?? Number.NaN);
    return {
      media: query,
      matches: width >= min,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
    } as unknown as MediaQueryList;
  };
  Object.defineProperty(window, "matchMedia", { value: matchMedia, configurable: true, writable: true });
}

beforeEach(() => {
  request.host = "127.0.0.1:3111";
  window.history.replaceState(null, "", "/v2/desk");
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "matchMedia");
});

afterAll(async () => {
  await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true })));
});

function sample() {
  vi.stubEnv("V2_FIXTURES", "1");
  vi.stubEnv("V2_LOCAL_SNAPSHOT", "");
  vi.stubEnv("VERCEL_ENV", "preview");
}

/** A whole snapshot folder, small and invented, that the desk can read. */
const SNAPSHOT_FOLDER: Record<string, string> = {
  "snapshot.json": JSON.stringify({
    userId: "77777777-7777-4777-8777-777777777777",
    timeZone: "America/Phoenix",
    takenAt: "2026-04-15T09:05:00-07:00",
  }),
  "rules.json": JSON.stringify({
    planner: {
      timeZone: "America/Phoenix",
      wakeByWeekday: ["07:30", "07:30", "07:30", "07:30", "07:30", "07:30", "07:30"],
      lightsOut: "23:30",
      noFocusBefore: "08:30",
    },
    lanes: [],
    feedLabels: {},
  }),
  "tasks.json": "[]",
  "groups.json": "[]",
  "income_sources.json": "[]",
};

async function local(files: Record<string, string>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "v2-desk-page-"));
  made.push(dir);
  for (const [name, body] of Object.entries(files)) {
    await writeFile(path.join(dir, name), body, "utf8");
  }
  vi.stubEnv("V2_FIXTURES", "");
  vi.stubEnv("V2_LOCAL_SNAPSHOT", dir);
  vi.stubEnv("VERCEL_ENV", "preview");
}

const digestOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return String((error as { digest?: unknown }).digest ?? "no digest");
  }
  return "nothing was thrown";
};

interface DeskProps {
  data: DeskScreenData;
  initial: TileSet;
  date: string | null;
}

/** The page, one level deep: what its guarded child returns. */
async function page(search: Record<string, string | string[]> = {}) {
  const outer = DeskPage({ searchParams: Promise.resolve(search) }) as unknown as {
    type: (props: unknown) => Promise<ReactElement<DeskProps>>;
    props: unknown;
  };
  return outer.type(outer.props);
}

const PLANNED = sampleDesk(null).today.input.date;

const layoutOn = (container: HTMLElement) =>
  (container.querySelector(".v2-desk") as HTMLElement).dataset.layout;

const railLink = (container: HTMLElement, title: string) =>
  within(container.querySelector(".v2-desk-rail") as HTMLElement).getByRole("link", { name: title });

const spoken = (container: HTMLElement) =>
  container.querySelector('[role="status"]')?.textContent ?? "";

// ---------------------------------------------------------------- behaviour 1

describe("the gate", () => {
  test("is not found with the flag off and no snapshot folder, or in production", () => {
    vi.stubEnv("V2_FIXTURES", "");
    vi.stubEnv("V2_LOCAL_SNAPSHOT", "");
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(digestOf(() => DeskPage())).toBe(NOT_FOUND_DIGEST);

    vi.stubEnv("V2_FIXTURES", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    expect(digestOf(() => DeskPage())).toBe(NOT_FOUND_DIGEST);
  });

  test("asks to be rendered per request, under the desk's own name", () => {
    expect(dynamic).toBe("force-dynamic");
    expect(metadata.title).toBe("Desk");
  });

  test("refuses a request that is not from this machine before it reads the folder", async () => {
    await local(SNAPSHOT_FOLDER);
    request.host = "desk.example.com";
    await expect(page({ layout: "week" })).rejects.toThrow();
  });

  test("opens on the layout the address names, and on the desk's own for anything else", async () => {
    sample();
    for (const id of ["today", "week", "quests", "money"]) {
      const inner = await page({ layout: id });
      expect(inner.type).toBe(DeskClient);
      expect(inner.props.initial).toEqual(setCurrent(EMPTY_TILE_SET, id));
    }
    expect((await page({})).props.initial).toBe(EMPTY_TILE_SET);
    expect((await page({ layout: "nowhere" })).props.initial).toBe(EMPTY_TILE_SET);
    expect((await page({ layout: "__proto__" })).props.initial).toBe(EMPTY_TILE_SET);
    expect((await page({ layout: ["week", "money"] })).props.initial).toBe(EMPTY_TILE_SET);
  });

  test("loads the whole sample desk for the week asked, and keeps only the planned date", async () => {
    sample();
    const plain = await page({ layout: "week" });
    expect(plain.props.data).toEqual(sampleDesk(null));
    expect(plain.props.date).toBeNull();

    const week = await page({ week: "2026-04-20", date: PLANNED });
    expect(week.props.data.today.calendar).toEqual(sampleWeek("2026-04-20"));
    expect(week.props.date).toBe(PLANNED);

    expect((await page({ date: "2001-01-01" })).props.date).toBeNull();
  });
});

// ---------------------------------------------------------------- behaviour 2

describe("one page, every layout", () => {
  test("links each layout to its own address, carrying the planned date", async () => {
    sample();
    stubMedia(2000);
    const { container } = render(await page({ layout: "quests", date: PLANNED }));
    expect(layoutOn(container)).toBe("quests");
    for (const [id, title] of [
      ["today", "Today"],
      ["week", "Week"],
      ["quests", "Quests"],
      ["money", "Money"],
    ]) {
      expect(railLink(container, title).getAttribute("href")).toBe(deskHref(id, PLANNED));
    }
  });

  test("opens a layout in the browser: the reducer, then pushState, and no request", async () => {
    sample();
    stubMedia(2000);
    window.history.replaceState(null, "", deskHref("today", null));
    const pushed = vi.spyOn(window.history, "pushState");
    const fetched = vi.spyOn(globalThis, "fetch");
    const { container } = render(await page({}));

    await act(async () => {
      fireEvent.click(railLink(container, "Money"));
    });
    expect(layoutOn(container)).toBe("money");
    expect(pushed).toHaveBeenCalledTimes(1);
    expect(pushed.mock.calls[0][2]).toBe(deskHref("money", null));
    expect(window.location.pathname + window.location.search).toBe(deskHref("money", null));
    expect(railLink(container, "Money").getAttribute("aria-current")).toBe("page");
    expect(fetched).not.toHaveBeenCalled();

    // The layout already on screen pushes nothing.
    await act(async () => {
      fireEvent.click(railLink(container, "Money"));
    });
    expect(pushed).toHaveBeenCalledTimes(1);
  });

  test("keeps a press on the day through a change of layout", async () => {
    sample();
    stubMedia(2000);
    const { container } = render(await page({}));
    const today = container.querySelector('section[data-pane="today"]') as HTMLElement;
    await act(async () => {
      fireEvent.click(within(today).getByRole("button", { name: TODAY_COPY.notToday }));
    });
    const lit = today.querySelector("[data-lit-heading]")?.textContent;
    await act(async () => {
      fireEvent.click(railLink(container, "Week"));
    });
    await act(async () => {
      fireEvent.click(railLink(container, "Today"));
    });
    expect(today.isConnected).toBe(true);
    expect(today.querySelector("[data-lit-heading]")?.textContent).toBe(lit);
    expect(spoken(container)).toContain(TODAY_COPY.acted.skipped);
  });

  test("follows Back and Forward", async () => {
    sample();
    stubMedia(2000);
    window.history.replaceState(null, "", deskHref("today", null));
    const { container } = render(await page({ layout: "today" }));
    await act(async () => {
      fireEvent.click(railLink(container, "Quests"));
    });
    expect(layoutOn(container)).toBe("quests");

    const traverse = async (step: () => void) => {
      await act(async () => {
        const popped = new Promise<void>((resolve) => {
          window.addEventListener("popstate", () => resolve(), { once: true });
        });
        step();
        await popped;
      });
    };
    await traverse(() => window.history.back());
    expect(window.location.search).toBe("?layout=today");
    expect(layoutOn(container)).toBe("today");
    await traverse(() => window.history.forward());
    expect(layoutOn(container)).toBe("quests");
  });

  test("reads an address with no usable layout as the one the server drew for it", async () => {
    sample();
    stubMedia(2000);
    window.history.replaceState(null, "", "/v2/desk?layout=nowhere");
    const { container } = render(await page({ layout: "nowhere" }));
    expect(layoutOn(container)).toBe("today");
    await act(async () => {
      fireEvent.click(railLink(container, "Week"));
    });
    await act(async () => {
      const popped = new Promise<void>((resolve) => {
        window.addEventListener("popstate", () => resolve(), { once: true });
      });
      window.history.back();
      await popped;
    });
    expect(layoutOn(container)).toBe("today");
  });

  test("leaves a click with a modifier to the anchor, which loads the address from the server", async () => {
    sample();
    stubMedia(2000);
    const pushed = vi.spyOn(window.history, "pushState");
    const { container } = render(await page({}));
    // jsdom does not navigate; what is checked is that the desk let the anchor
    // keep its own default.
    let prevented: boolean | null = null;
    const watch = (event: Event) => {
      prevented = event.defaultPrevented;
      event.preventDefault();
    };
    document.addEventListener("click", watch);
    try {
      fireEvent.click(railLink(container, "Week"), { ctrlKey: true });
    } finally {
      document.removeEventListener("click", watch);
    }
    expect(prevented).toBe(false);
    expect(pushed).not.toHaveBeenCalled();
    expect(layoutOn(container)).toBe("today");
  });

  test("hands every link on the desk the layout on screen, not the one it was loaded on", async () => {
    sample();
    stubMedia(2000);
    const { container } = render(await page({ date: PLANNED }));
    const weekLinks = () =>
      Array.from(container.querySelectorAll<HTMLAnchorElement>("a.v2-cal-link")).map(
        (link) => link.getAttribute("href") ?? "",
      );
    expect(weekLinks().length).toBeGreaterThan(0);
    for (const href of weekLinks()) {
      expect(href).toMatch(new RegExp(`^/v2/desk\\?week=\\d{4}-\\d{2}-\\d{2}&layout=today&date=${PLANNED}$`));
    }
    await act(async () => {
      fireEvent.click(railLink(container, "Week"));
    });
    for (const href of weekLinks()) expect(href).toContain("&layout=week&");
  });
});

// ---------------------------------------------------------------- behaviour 6

describe("the first client render", () => {
  /**
   * Hydration, for real, as in v2-fixtures: the markup comes from
   * `renderToString`, which is what the server sends, and the browser is a
   * different width. The class is read from matchMedia in an effect, so the
   * markup at the moment of that read is the markup the server sent.
   */
  test("is the server's HTML: no mismatch, and nothing changes until the effects run", async () => {
    const { renderToString } = await import("react-dom/server");
    const { hydrateRoot } = await import("react-dom/client");
    const element = createElement(DeskClient, {
      data: sampleDesk(null),
      initial: EMPTY_TILE_SET,
      date: null,
    });
    const html = renderToString(element);

    // The registration is in the server's markup, as CSS rather than escaped text, once.
    expect(html).toContain('syntax: "<length>"');
    expect(html).not.toContain("&lt;length&gt;");
    expect(html.split("@property --v2-regular-w ")).toHaveLength(2);
    expect(html.split("<style")).toHaveLength(2);
    expect(html).toContain(DESK_PROPERTY_RULES.split("\n")[0]);
    // The server cannot know the class, so nothing is inert yet.
    expect(html).not.toContain("inert");

    const host = document.createElement("div");
    document.body.appendChild(host);
    host.innerHTML = html;
    const served = host.innerHTML;

    let atFirstRead: string | null = null;
    stubMedia(2000, () => {
      atFirstRead ??= host.innerHTML;
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const recoverable: unknown[] = [];
    let root: Root | null = null;
    await act(async () => {
      root = hydrateRoot(host, element, {
        onRecoverableError: (error) => {
          recoverable.push(error);
        },
      });
    });

    expect(atFirstRead).toBe(served);
    expect(errors).not.toHaveBeenCalled();
    expect(recoverable).toEqual([]);
    // After the effects: wide, so what wide does not show is inert.
    const frame = (pane: string) => host.querySelector(`section[data-pane="${pane}"]`) as HTMLElement;
    expect(frame("status").hasAttribute("inert")).toBe(false);
    expect(frame("lanes").hasAttribute("inert")).toBe(true);
    expect(host.innerHTML).not.toBe(served);

    act(() => {
      (root as unknown as Root).unmount();
    });
    host.remove();
  });
});

// --------------------------------------------------------------- behaviour 12

describe("one live region, and the notes once", () => {
  test("has one role=status on the page, outside every pane, and it speaks a press", async () => {
    sample();
    stubMedia(2000);
    const { container } = render(await page({}));
    const regions = () => container.querySelectorAll('[role="status"]');
    expect(regions()).toHaveLength(1);
    expect(regions()[0].closest(".v2-frame, .v2-desk-work")).toBeNull();
    const today = container.querySelector('section[data-pane="today"]') as HTMLElement;
    await act(async () => {
      fireEvent.click(within(today).getByRole("button", { name: TODAY_COPY.notToday }));
    });
    expect(regions()).toHaveLength(1);
    expect(regions()[0].textContent).toContain(TODAY_COPY.acted.skipped);
  });

  test("shows the day's notice and the source's notes on the rail and under the top bar, not in a pane", () => {
    stubMedia(2000);
    const desk = sampleDesk(null);
    const data: DeskScreenData = { ...desk, notes: ["money.json could not be read."] };
    const { container } = render(createElement(DeskClient, { data, initial: EMPTY_TILE_SET, date: null }));
    const notice = desk.today.notice as string;
    expect(notice.length).toBeGreaterThan(0);
    for (const where of ["rail", "compact"]) {
      const block = container.querySelector(`.v2-desk-notes-${where}`) as HTMLElement;
      expect(Array.from(block.querySelectorAll("p")).map((p) => p.textContent)).toEqual([
        notice,
        "money.json could not be read.",
      ]);
      expect(block.closest(".v2-frame")).toBeNull();
    }
    expect(container.querySelector(".v2-desk-rail .v2-desk-notes-rail")).not.toBeNull();
    expect(container.querySelectorAll(".v2-desk-notes")).toHaveLength(2);
  });

  test("draws no notes block when there is nothing to say", () => {
    stubMedia(2000);
    const desk = sampleDesk(null);
    const data: DeskScreenData = { ...desk, today: { ...desk.today, notice: null }, notes: [] };
    const { container } = render(createElement(DeskClient, { data, initial: EMPTY_TILE_SET, date: null }));
    expect(container.querySelectorAll(".v2-desk-notes")).toHaveLength(0);
  });
});

// --------------------------------------------------------------- behaviour 13

describe("the local source", () => {
  test("loads the whole desk from a folder, its unreadable parts as notes, and keeps only the date it planned", async () => {
    await local({ ...SNAPSHOT_FOLDER, "money.json": "{ not json" });
    const first = await page({ layout: "money" });
    expect(first.type).toBe(DeskClient);
    expect(first.props.initial.current).toBe("money");
    expect(first.props.data.money).toBeNull();
    expect(first.props.data.notes).toHaveLength(1);
    expect(first.props.date).toBeNull();
    const planned = first.props.data.today.input.date;

    const asked = await page({ layout: "money", date: planned });
    expect(asked.props.date).toBe(planned);

    stubMedia(2000);
    const { container } = render(asked);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(container.querySelector(".v2-desk-notes-rail")?.textContent).toContain(first.props.data.notes[0]);
  });

  test("shows the snapshot error when the folder's day cannot be read", async () => {
    await local({});
    const inner = await page({ layout: "week" });
    expect(inner.type).toBe(SnapshotError);
  });

  test("keys the day on the planned day: the same day keeps a press, another starts again, the layout stays", async () => {
    stubMedia(2000);
    const desk = sampleDesk(null);
    const draw = (data: DeskScreenData) => createElement(DeskClient, { data, initial: EMPTY_TILE_SET, date: null });
    const { container, rerender } = render(draw(desk));
    const today = () => container.querySelector('section[data-pane="today"]') as HTMLElement;
    await act(async () => {
      fireEvent.click(within(today()).getByRole("button", { name: TODAY_COPY.notToday }));
    });
    await act(async () => {
      fireEvent.click(railLink(container, "Week"));
    });
    expect(spoken(container)).toContain(TODAY_COPY.acted.skipped);

    rerender(draw(sampleDesk("2026-04-20")));
    expect(spoken(container)).toContain(TODAY_COPY.acted.skipped);

    const thursday: DeskScreenData = {
      ...desk,
      today: { ...desk.today, input: { ...desk.today.input, date: "2026-04-16" } },
    };
    rerender(draw(thursday));
    expect(spoken(container)).not.toContain(TODAY_COPY.acted.skipped);
    expect(layoutOn(container)).toBe("week");
  });
});
