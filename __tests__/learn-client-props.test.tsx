// Regression test for the /learn false-success state: the client mirrors
// server rows in useState, so a fresh RSC payload (the episode a finished TTS
// render just wrote) has to reach the list. Before the prop-sync reset the
// list stayed stale until a hard reload — and the user paid for TTS twice.
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  AudioEpisode,
  Course,
  CourseSource,
} from "@/app/_components/learn-types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/app/actions/learn", () => ({
  archiveCourse: vi.fn(async () => ({ error: null })),
  attachSourceFile: vi.fn(async () => ({ error: null })),
  convertSource: vi.fn(async () => ({ error: null })),
  createCourse: vi.fn(async () => ({ error: null })),
  deleteEpisode: vi.fn(async () => ({ error: null })),
  deleteSource: vi.fn(async () => ({ error: null })),
  generateEpisode: vi.fn(async () => ({ error: null })),
  queueSourceConversion: vi.fn(async () => ({ error: null })),
  registerSource: vi.fn(async () => ({ error: null })),
  updateCourse: vi.fn(async () => ({ error: null })),
}));
vi.mock("@/utils/supabase/client", () => ({ createClient: vi.fn() }));

import { LearnClient } from "@/app/learn/learn-client";

const COURSE: Course = {
  id: "c1",
  name: "phil 220",
  code: null,
  term: null,
  color: "#b5ff3c",
  archived: false,
  created_at: "2026-07-28T00:00:00Z",
};

const SOURCE: CourseSource = {
  id: "s1",
  course_id: "c1",
  title: "lecture 1",
  kind: "pdf",
  status: "converted",
  storage_path: "u/s1/lecture-1.pdf",
  vault_path: "Courses/phil 220/lecture 1.md",
  page_count: 12,
  error: null,
  created_at: "2026-07-28T00:00:00Z",
};

const EPISODE: AudioEpisode = {
  id: "e1",
  course_id: "c1",
  title: "the trolley problem, revisited",
  source_ids: ["s1"],
  engine: "gemini",
  flavor: "deep-dive",
  status: "done",
  duration_sec: 780,
  storage_path: "u/e1.wav",
  error: null,
  created_at: "2026-07-28T00:10:00Z",
};

function renderLearn(props: {
  courses?: Course[];
  sources?: CourseSource[];
  episodes?: AudioEpisode[];
  audioUrls?: Record<string, string>;
}) {
  return render(
    <LearnClient
      userId="u1"
      initialCourses={props.courses ?? [COURSE]}
      initialSources={props.sources ?? [SOURCE]}
      initialEpisodes={props.episodes ?? []}
      audioUrls={props.audioUrls ?? {}}
    />,
  );
}

afterEach(cleanup);

describe("LearnClient server-data sync", () => {
  test("an episode arriving on new props surfaces without a remount", () => {
    const { rerender } = renderLearn({ episodes: [] });

    // Open the course so the episodes section is on screen.
    fireEvent.click(screen.getByText("phil 220"));
    expect(screen.queryByText(/trolley problem/)).toBeNull();

    // What router.refresh() delivers after a TTS render finishes: same course
    // and source rows, new array identities, one extra episode.
    rerender(
      <LearnClient
        userId="u1"
        initialCourses={[{ ...COURSE }]}
        initialSources={[{ ...SOURCE }]}
        initialEpisodes={[{ ...EPISODE }]}
        audioUrls={{ e1: "https://example.test/e1.wav" }}
      />,
    );

    expect(screen.getByText(/trolley problem/)).toBeTruthy();
    // 13:00 · deep-dive · gemini — the done row, not a "rendering…" placeholder.
    expect(screen.getByText(/13:00 · deep-dive · gemini/)).toBeTruthy();
  });

  test("the reset keeps ui state: the open course stays open", () => {
    const { rerender } = renderLearn({ episodes: [] });

    fireEvent.click(screen.getByText("phil 220"));
    expect(screen.getByText("audio overviews")).toBeTruthy();

    rerender(
      <LearnClient
        userId="u1"
        initialCourses={[{ ...COURSE }]}
        initialSources={[{ ...SOURCE }]}
        initialEpisodes={[{ ...EPISODE }]}
        audioUrls={{}}
      />,
    );

    expect(screen.getByText("audio overviews")).toBeTruthy();
    expect(screen.getByText(/trolley problem/)).toBeTruthy();
  });

  test("a renamed course and a converted source arrive on new props too", () => {
    const { rerender } = renderLearn({
      sources: [{ ...SOURCE, status: "converting" }],
    });

    fireEvent.click(screen.getByText("phil 220"));
    expect(screen.getByText(/converting…/)).toBeTruthy();

    rerender(
      <LearnClient
        userId="u1"
        initialCourses={[{ ...COURSE, name: "phil 220a" }]}
        initialSources={[{ ...SOURCE, status: "converted" }]}
        initialEpisodes={[]}
        audioUrls={{}}
      />,
    );

    expect(screen.getByText("phil 220a")).toBeTruthy();
    expect(screen.getByText(/in vault/)).toBeTruthy();
    expect(screen.queryByText(/converting…/)).toBeNull();
  });

  test("identical props do not reset the mirrors (no render loop)", () => {
    const courses = [COURSE];
    const sources = [SOURCE];
    const episodes: AudioEpisode[] = [];
    const { rerender } = render(
      <LearnClient
        userId="u1"
        initialCourses={courses}
        initialSources={sources}
        initialEpisodes={episodes}
        audioUrls={{}}
      />,
    );

    fireEvent.click(screen.getByText("phil 220"));
    rerender(
      <LearnClient
        userId="u1"
        initialCourses={courses}
        initialSources={sources}
        initialEpisodes={episodes}
        audioUrls={{}}
      />,
    );

    expect(screen.getByText("phil 220")).toBeTruthy();
    expect(screen.getByText("audio overviews")).toBeTruthy();
  });
});
