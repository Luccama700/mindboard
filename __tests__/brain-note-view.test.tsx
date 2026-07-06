import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { NoteView } from "@/app/brain/_components/note-view";
import { buildResolver } from "@/app/lib/brain/parse";
import type { VaultCorpus, VaultNote } from "@/app/lib/brain/vault";

function makeCorpus(notes: VaultNote[]): VaultCorpus {
  return {
    notes: new Map(notes.map((note) => [note.path, note])),
    folders: new Map(),
    resolve: buildResolver(notes.map((note) => note.path)),
  };
}

function makeNote(overrides: Partial<VaultNote> & { path: string }): VaultNote {
  return {
    folder: "",
    title: overrides.path.split("/").pop()!.replace(/\.md$/, ""),
    frontmatter: {},
    body: "",
    outgoing: [],
    backlinks: [],
    ...overrides,
  };
}

describe("NoteView", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders markdown with resolved and unresolved wikilinks", () => {
    const home = makeNote({
      path: "Home.md",
      frontmatter: { type: "home", created: "2026-07-01" },
      body: "# Home\n\nSee [[CLAUDE]] and [[Missing note]].",
    });
    const claude = makeNote({ path: "CLAUDE.md" });
    render(<NoteView note={home} corpus={makeCorpus([home, claude])} />);

    const link = screen.getByRole("link", { name: "CLAUDE" });
    expect(link.getAttribute("href")).toBe("/brain/note/CLAUDE");

    const unresolved = screen.getByText("Missing note");
    expect(unresolved.tagName).toBe("SPAN");
    expect(unresolved.className).toContain("text-muted");

    expect(screen.getByText("home")).toBeDefined();
    expect(screen.getByText("2026-07-01")).toBeDefined();
  });

  test("encodes wikilink targets containing spaces", () => {
    const journal = makeNote({
      path: "Journal/2026-07-01 Setup and first interview.md",
    });
    const home = makeNote({
      path: "Home.md",
      body: "- [[2026-07-01 Setup and first interview]]",
    });
    render(<NoteView note={home} corpus={makeCorpus([home, journal])} />);

    const link = screen.getByRole("link", {
      name: "2026-07-01 Setup and first interview",
    });
    expect(link.getAttribute("href")).toBe(
      "/brain/note/Journal/2026-07-01%20Setup%20and%20first%20interview",
    );
  });

  test("renders callout blockquotes with the marker stripped", () => {
    const note = makeNote({
      path: "Home.md",
      body: "> [!warning] Careful\n> This is the body.",
    });
    render(<NoteView note={note} corpus={makeCorpus([note])} />);

    expect(screen.getByText("warning · Careful")).toBeDefined();
    expect(screen.getByText("This is the body.")).toBeDefined();
    expect(screen.queryByText(/\[!warning\]/)).toBeNull();
  });

  test("keeps plain blockquotes as blockquotes", () => {
    const note = makeNote({
      path: "Home.md",
      body: "> just a quote",
    });
    const { container } = render(
      <NoteView note={note} corpus={makeCorpus([note])} />,
    );
    expect(container.querySelector("blockquote")).not.toBeNull();
    expect(screen.getByText("just a quote")).toBeDefined();
  });

  test("does not rewrite wikilinks inside code", () => {
    const note = makeNote({
      path: "Home.md",
      body: "Use `[[CLAUDE]]` syntax.",
    });
    const claude = makeNote({ path: "CLAUDE.md" });
    render(<NoteView note={note} corpus={makeCorpus([note, claude])} />);

    expect(screen.queryByRole("link", { name: "CLAUDE" })).toBeNull();
    expect(screen.getByText("[[CLAUDE]]").tagName).toBe("CODE");
  });

  test("lists backlinks with links to their sources", () => {
    const claude = makeNote({
      path: "CLAUDE.md",
      backlinks: ["Home.md", "Journal/A day.md"],
    });
    const home = makeNote({ path: "Home.md" });
    const day = makeNote({ path: "Journal/A day.md", folder: "Journal" });
    render(
      <NoteView note={claude} corpus={makeCorpus([claude, home, day])} />,
    );

    expect(screen.getByText("backlinks")).toBeDefined();
    expect(
      screen.getByRole("link", { name: /Home/ }).getAttribute("href"),
    ).toBe("/brain/note/Home");
    expect(
      screen.getByRole("link", { name: /A day/ }).getAttribute("href"),
    ).toBe("/brain/note/Journal/A%20day");
  });
});
