"use client";

import { useRef, useState } from "react";

import { importClaudeSessions } from "@/app/actions/mindspace-import";
import { parseClaudeExport } from "@/app/lib/mindspace/import";

const BATCH = 100;

type Phase =
  | { kind: "idle" }
  | { kind: "parsing" }
  | { kind: "uploading"; done: number; total: number }
  | { kind: "done"; imported: number; skipped: number; skippedOld: number }
  | { kind: "error"; message: string };

export function ImportClient({
  claudeAiCount,
  claudeCodeCount,
}: {
  claudeAiCount: number;
  claudeCodeCount: number;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  async function handleFile(file: File) {
    setPhase({ kind: "parsing" });
    let parsed;
    try {
      const text = await file.text();
      parsed = parseClaudeExport(JSON.parse(text), Date.now());
    } catch {
      setPhase({
        kind: "error",
        message:
          "couldn't read that file — it should be the conversations.json from inside the export zip.",
      });
      return;
    }
    if (parsed.malformed > 0 && parsed.sessions.length === 0) {
      setPhase({
        kind: "error",
        message:
          "that json doesn't look like a claude.ai export — expected a list of conversations.",
      });
      return;
    }
    if (parsed.sessions.length === 0) {
      setPhase({
        kind: "done",
        imported: 0,
        skipped: 0,
        skippedOld: parsed.skippedOld,
      });
      return;
    }

    let imported = 0;
    let skipped = 0;
    const total = parsed.sessions.length;
    for (let i = 0; i < total; i += BATCH) {
      setPhase({ kind: "uploading", done: i, total });
      const result = await importClaudeSessions(
        parsed.sessions.slice(i, i + BATCH),
      );
      if (result.error) {
        setPhase({ kind: "error", message: result.error });
        return;
      }
      imported += result.imported;
      skipped += result.skipped;
    }
    setPhase({ kind: "done", imported, skipped, skippedOld: parsed.skippedOld });
  }

  return (
    <div>
      <p className="text-sm text-muted mb-6 leading-relaxed">
        bring your claude.ai conversations into mindspace. the export file is
        parsed here in your browser — only compact session records (your own
        words, trimmed) are stored. sessions older than 60 days are skipped.
      </p>

      <ol className="text-sm text-muted mb-8 leading-relaxed list-decimal list-inside space-y-1">
        <li>
          on claude.ai: settings → privacy → export data. the zip arrives by
          email.
        </li>
        <li>unzip it and pick the conversations.json inside.</li>
      </ol>

      <input
        ref={inputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void handleFile(file);
          event.target.value = "";
        }}
      />
      <button
        type="button"
        disabled={phase.kind === "parsing" || phase.kind === "uploading"}
        onClick={() => inputRef.current?.click()}
        className="min-h-11 w-full rounded-lg bg-accent text-page text-action font-medium disabled:opacity-40 transition-opacity"
      >
        {phase.kind === "parsing"
          ? "reading export…"
          : phase.kind === "uploading"
            ? `importing ${phase.done}/${phase.total}…`
            : "choose conversations.json"}
      </button>

      {phase.kind === "error" && (
        <p className="mt-4 text-sm text-danger leading-relaxed">
          {phase.message}
        </p>
      )}
      {phase.kind === "done" && (
        <p className="mt-4 text-sm text-muted leading-relaxed">
          imported {phase.imported} sessions
          {phase.skipped > 0 && <>, {phase.skipped} skipped</>}
          {phase.skippedOld > 0 && (
            <>, {phase.skippedOld} older than 60 days left out</>
          )}
          . they&apos;ll be classified in the background on your next mindspace
          visits.
        </p>
      )}

      <div className="mt-12 border-t border-line pt-4 text-xs text-muted leading-relaxed space-y-2">
        <p>
          already here: {claudeAiCount} claude.ai sessions · {claudeCodeCount}{" "}
          claude code sessions.
        </p>
        <p>
          claude code sessions sync themselves — the overnight agent on your pc
          scans your local session transcripts each night and sends only
          per-session summaries of your own prompts. re-importing the same
          export is safe; sessions dedupe.
        </p>
      </div>
    </div>
  );
}
