"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

// Type only: the page builds the desk on the server and hands the plain shape
// down, so no source and no loader reaches the browser through here.
import type { DeskScreenData } from "@/app/lib/v2/view/desk-data";

interface DeskValue {
  data: DeskScreenData;
  keep: Readonly<Record<string, string>>;
  basePath: string;
}

const DeskContext = createContext<DeskValue | null>(null);

/** One empty record, so a provider handed nothing to keep does not make a new one per render. */
const KEEP_NOTHING: Readonly<Record<string, string>> = Object.freeze({});

/** Where the desk's own links point, when whoever mounts it does not say. */
const DESK_PATH = "/v2/desk";

/**
 * The whole desk, for every pane on it: the day, the quests and the money the
 * page loaded for this request, and what every link on the desk carries back.
 *
 * Read only. Nothing a pane does writes here: the day's presses live in the
 * DayProvider below this one, and the desk's data changes only when the page
 * renders it again with new data.
 *
 * `basePath` is where the desk's links point: the desk itself by default, and
 * the gallery's own path when the gallery mounts a pane alone, so a week link
 * there redraws the same pane instead of leaving for the desk.
 */
export function DeskDataProvider({
  data,
  keep,
  basePath = DESK_PATH,
  children,
}: {
  data: DeskScreenData;
  /** Search parameters every link on the desk carries (the layout, the date). */
  keep?: Readonly<Record<string, string>>;
  basePath?: string;
  children: ReactNode;
}) {
  const kept = keep ?? KEEP_NOTHING;
  const value = useMemo<DeskValue>(() => ({ data, keep: kept, basePath }), [data, kept, basePath]);
  return <DeskContext.Provider value={value}>{children}</DeskContext.Provider>;
}

function useDesk(hook: string): DeskValue {
  const desk = useContext(DeskContext);
  if (desk === null) {
    throw new Error(
      `${hook} was called outside a DeskDataProvider: a pane has to be rendered inside one.`,
    );
  }
  return desk;
}

/** The desk the page loaded. Throws when there is no provider above it. */
export function useDeskData(): DeskScreenData {
  return useDesk("useDeskData").data;
}

/** The search parameters every link on the desk carries. Throws when there is no provider. */
export function useDeskKeep(): Readonly<Record<string, string>> {
  return useDesk("useDeskKeep").keep;
}

/** The path every link on the desk points at. Throws when there is no provider. */
export function useDeskPath(): string {
  return useDesk("useDeskPath").basePath;
}
