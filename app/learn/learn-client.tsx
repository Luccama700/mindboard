"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  archiveCourse,
  attachSourceFile,
  convertSource,
  createCourse,
  deleteEpisode,
  deleteSource,
  generateEpisode,
  queueSourceConversion,
  registerSource,
  updateCourse,
} from "@/app/actions/learn";
import { ColorPicker } from "@/app/_components/color-picker";
import {
  sourceStatusLabel,
  type AudioEpisode,
  type Course,
  type CourseSource,
} from "@/app/_components/learn-types";
import { Button, INPUT_CLASS, SectionRuler } from "@/app/_components/ui";
import { createClient } from "@/utils/supabase/client";

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

function sanitizeFilename(name: string): string {
  return name.replace(/[^\w.\- ]+/g, "_").slice(-120) || "file.pdf";
}

export function LearnClient({
  userId,
  initialCourses,
  initialSources,
  initialEpisodes,
  audioUrls,
}: {
  userId: string;
  initialCourses: Course[];
  initialSources: CourseSource[];
  initialEpisodes: AudioEpisode[];
  audioUrls: Record<string, string>;
}) {
  const router = useRouter();
  const [courses, setCourses] = useState(initialCourses);
  const [sources, setSources] = useState(initialSources);
  const [episodes, setEpisodes] = useState(initialEpisodes);
  const [openCourseId, setOpenCourseId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // These three are mirrors of server data, so a fresh RSC payload has to win:
  // without this reset the episode a finished TTS render just wrote never
  // reaches the list, and the user pays to generate it again. Server data is
  // safely authoritative because every mutation below awaits its action (which
  // commits, then revalidates /learn) before patching local state — so any
  // payload that lands is at least as new as the patch. React's "adjust state
  // during render" idiom; only the mirrors reset, not open/editing/draft state.
  const [serverData, setServerData] = useState({
    courses: initialCourses,
    sources: initialSources,
    episodes: initialEpisodes,
  });
  if (
    serverData.courses !== initialCourses ||
    serverData.sources !== initialSources ||
    serverData.episodes !== initialEpisodes
  ) {
    setServerData({
      courses: initialCourses,
      sources: initialSources,
      episodes: initialEpisodes,
    });
    setCourses(initialCourses);
    setSources(initialSources);
    setEpisodes(initialEpisodes);
  }

  const active = courses.filter((c) => !c.archived);
  const archived = courses.filter((c) => c.archived);

  const refresh = () => router.refresh();

  return (
    <div className="space-y-8">
      {error && <p className="text-action text-danger">{error}</p>}

      <section className="space-y-3">
        <SectionRuler label="courses" count={active.length} />

        {active.length === 0 && !creating && (
          <p className="text-meta text-muted leading-relaxed">
            a course is a container for lecture files and notes. add one, drop
            its pdfs in, and they become vault notes, podcasts, and study
            material.
          </p>
        )}

        <div className="divide-y divide-hairline border-y border-hairline">
          {active.map((course) => (
            <CourseRow
              key={course.id}
              course={course}
              sources={sources.filter((s) => s.course_id === course.id)}
              episodes={episodes.filter((e) => e.course_id === course.id)}
              audioUrls={audioUrls}
              open={openCourseId === course.id}
              userId={userId}
              onToggle={() =>
                setOpenCourseId((v) => (v === course.id ? null : course.id))
              }
              onCourseChange={(patch) =>
                setCourses((prev) =>
                  prev.map((c) =>
                    c.id === course.id ? { ...c, ...patch } : c,
                  ),
                )
              }
              onSourcesChange={setSources}
              onEpisodesChange={setEpisodes}
              onError={setError}
              onRefresh={refresh}
            />
          ))}
        </div>

        {creating ? (
          <CreateCourseForm
            onDone={(course) => {
              setCreating(false);
              if (course) {
                // The action revalidated /learn, so the row may already have
                // arrived on new props — insert by id, never blindly.
                setCourses((prev) =>
                  prev.some((c) => c.id === course.id)
                    ? prev
                    : [course, ...prev],
                );
                setOpenCourseId(course.id);
              }
            }}
            onError={setError}
          />
        ) : (
          <Button onClick={() => setCreating(true)} className="w-full">
            + add course
          </Button>
        )}
      </section>

      {archived.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer list-none text-label uppercase text-muted min-h-11 flex items-center gap-2">
            <span className="group-open:rotate-90 transition-transform">▸</span>
            archived · {archived.length}
          </summary>
          <div className="divide-y divide-hairline border-y border-hairline mt-2">
            {archived.map((course) => (
              <div
                key={course.id}
                className="flex items-center justify-between gap-3 py-2"
              >
                <span className="text-body text-muted truncate">
                  {course.name}
                </span>
                <Button
                  variant="quiet"
                  onClick={async () => {
                    const result = await archiveCourse({
                      id: course.id,
                      archived: false,
                    });
                    if (result.error) setError(result.error);
                    else
                      setCourses((prev) =>
                        prev.map((c) =>
                          c.id === course.id ? { ...c, archived: false } : c,
                        ),
                      );
                  }}
                >
                  restore
                </Button>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function CreateCourseForm({
  onDone,
  onError,
}: {
  onDone: (course: Course | null) => void;
  onError: (message: string | null) => void;
}) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [term, setTerm] = useState("");
  const [color, setColor] = useState("#b5ff3c");
  const [pending, startTransition] = useTransition();

  const submit = () => {
    onError(null);
    startTransition(async () => {
      const result = await createCourse({ name, code, term, color });
      if (result.error) onError(result.error);
      else onDone(result.course ?? null);
    });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="space-y-3 glass-panel p-3"
    >
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="course name…"
        className={INPUT_CLASS}
      />
      <div className="flex gap-2">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="code (MATH 221)"
          className={INPUT_CLASS}
        />
        <input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="term (2026W1)"
          className={INPUT_CLASS}
        />
      </div>
      <ColorPicker value={color} onChange={setColor} />
      <div className="flex items-center gap-2">
        <Button type="submit" variant="accent" disabled={pending || !name.trim()}>
          {pending ? "adding…" : "add course"}
        </Button>
        <Button variant="quiet" onClick={() => onDone(null)}>
          cancel
        </Button>
      </div>
    </form>
  );
}

function CourseRow({
  course,
  sources,
  episodes,
  audioUrls,
  open,
  userId,
  onToggle,
  onCourseChange,
  onSourcesChange,
  onEpisodesChange,
  onError,
  onRefresh,
}: {
  course: Course;
  sources: CourseSource[];
  episodes: AudioEpisode[];
  audioUrls: Record<string, string>;
  open: boolean;
  userId: string;
  onToggle: () => void;
  onCourseChange: (patch: Partial<Course>) => void;
  onSourcesChange: (update: (prev: CourseSource[]) => CourseSource[]) => void;
  onEpisodesChange: (update: (prev: AudioEpisode[]) => AudioEpisode[]) => void;
  onError: (message: string | null) => void;
  onRefresh: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const meta = [course.code, course.term].filter(Boolean).join(" · ");

  return (
    <div className="py-1">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full min-h-11 items-center gap-3 text-left"
      >
        <span
          aria-hidden
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: course.color }}
        />
        <span className="flex-1 truncate text-body text-fg">{course.name}</span>
        {meta && <span className="text-meta text-muted">{meta}</span>}
        <span className="text-meta text-muted">
          {sources.length > 0 ? sources.length : "—"}
        </span>
      </button>

      {open && (
        <div className="space-y-4 pb-3 pl-5">
          <SourceList
            course={course}
            sources={sources}
            userId={userId}
            onSourcesChange={onSourcesChange}
            onError={onError}
            onRefresh={onRefresh}
          />

          <EpisodesSection
            course={course}
            episodes={episodes}
            audioUrls={audioUrls}
            hasConvertedSources={sources.some((s) => s.status === "converted")}
            onEpisodesChange={onEpisodesChange}
            onError={onError}
            onRefresh={onRefresh}
          />

          {editing ? (
            <EditCoursePanel
              course={course}
              onChange={onCourseChange}
              onClose={() => setEditing(false)}
              onError={onError}
            />
          ) : (
            <div className="flex items-center gap-2">
              {sources.some((s) => s.status === "converted") && (
                <>
                  <Link
                    href={`/learn/${course.id}/chat`}
                    className="inline-flex items-center min-h-11 px-3 rounded-full text-action lowercase border border-hairline text-fg hover:border-line-strong transition-colors"
                  >
                    chat →
                  </Link>
                  <Link
                    href={`/learn/${course.id}/study`}
                    className="inline-flex items-center min-h-11 px-3 rounded-full text-action lowercase border border-hairline text-fg hover:border-line-strong transition-colors"
                  >
                    study →
                  </Link>
                </>
              )}
              <Button variant="quiet" onClick={() => setEditing(true)}>
                ···
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function EditCoursePanel({
  course,
  onChange,
  onClose,
  onError,
}: {
  course: Course;
  onChange: (patch: Partial<Course>) => void;
  onClose: () => void;
  onError: (message: string | null) => void;
}) {
  const [name, setName] = useState(course.name);
  const [code, setCode] = useState(course.code ?? "");
  const [term, setTerm] = useState(course.term ?? "");
  const [color, setColor] = useState(course.color);
  const [pending, startTransition] = useTransition();

  const save = () => {
    onError(null);
    startTransition(async () => {
      const result = await updateCourse({
        id: course.id,
        name,
        code,
        term,
        color,
      });
      if (result.error) onError(result.error);
      else {
        onChange({
          name: name.trim(),
          code: code.trim() || null,
          term: term.trim() || null,
          color,
        });
        onClose();
      }
    });
  };

  return (
    <div className="space-y-3 glass-panel p-3">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        className={INPUT_CLASS}
        aria-label="course name"
      />
      <div className="flex gap-2">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="code"
          className={INPUT_CLASS}
        />
        <input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="term"
          className={INPUT_CLASS}
        />
      </div>
      <ColorPicker value={color} onChange={setColor} />
      <div className="flex items-center gap-2">
        <Button variant="accent" disabled={pending || !name.trim()} onClick={save}>
          {pending ? "saving…" : "save"}
        </Button>
        <Button variant="quiet" onClick={onClose}>
          cancel
        </Button>
        <span className="flex-1" />
        <Button
          variant="danger"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await archiveCourse({
                id: course.id,
                archived: true,
              });
              if (result.error) onError(result.error);
              else onChange({ archived: true });
            })
          }
        >
          archive
        </Button>
      </div>
    </div>
  );
}

function SourceList({
  course,
  sources,
  userId,
  onSourcesChange,
  onError,
  onRefresh,
}: {
  course: Course;
  sources: CourseSource[];
  userId: string;
  onSourcesChange: (update: (prev: CourseSource[]) => CourseSource[]) => void;
  onError: (message: string | null) => void;
  onRefresh: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const upload = async (file: File) => {
    onError(null);
    if (file.type !== "application/pdf") {
      onError("only pdf files for now — markdown arrives via the assistant");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      onError("file is over 100 mb");
      return;
    }

    setUploading(true);
    try {
      const title = file.name.replace(/\.pdf$/i, "");
      const registered = await registerSource({
        courseId: course.id,
        title,
        kind: "pdf",
      });
      if (registered.error || !registered.source) {
        onError(registered.error ?? "could not register the source");
        return;
      }
      const source = registered.source;
      onSourcesChange((prev) =>
        prev.some((s) => s.id === source.id) ? prev : [source, ...prev],
      );

      // Direct-to-storage: the file never passes through a route handler
      // (Vercel's 4.5 MB body limit). RLS confines writes to the own folder.
      const path = `${userId}/${source.id}/${sanitizeFilename(file.name)}`;
      const supabase = createClient();
      const { error: uploadError } = await supabase.storage
        .from("course-files")
        .upload(path, file, { contentType: "application/pdf", upsert: false });
      if (uploadError) {
        onError(`upload failed — ${uploadError.message}`);
        return;
      }

      const attached = await attachSourceFile({
        sourceId: source.id,
        storagePath: path,
      });
      if (attached.error) {
        onError(attached.error);
        return;
      }
      onSourcesChange((prev) =>
        prev.map((s) =>
          s.id === source.id
            ? { ...s, storage_path: path, status: "uploaded" as const }
            : s,
        ),
      );
      onRefresh();
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <div className="space-y-2">
      {sources.length > 0 && (
        <ul className="divide-y divide-hairline border-y border-hairline">
          {sources.map((source) => (
            <SourceRowItem
              key={source.id}
              source={source}
              onSourcesChange={onSourcesChange}
              onError={onError}
            />
          ))}
        </ul>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
        }}
      />
      <Button
        onClick={() => fileInputRef.current?.click()}
        disabled={uploading}
        className="w-full"
      >
        {uploading ? "uploading…" : "+ add pdf"}
      </Button>
    </div>
  );
}

const FLAVOR_OPTIONS = [
  { value: "deep-dive", label: "deep dive (~13 min)" },
  { value: "brief", label: "brief (~5 min)" },
  { value: "debate", label: "debate (~11 min)" },
  { value: "solo", label: "solo lecture (~10 min)" },
];

function formatDuration(seconds: number | null): string {
  if (!seconds) return "";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function EpisodesSection({
  course,
  episodes,
  audioUrls,
  hasConvertedSources,
  onEpisodesChange,
  onError,
  onRefresh,
}: {
  course: Course;
  episodes: AudioEpisode[];
  audioUrls: Record<string, string>;
  hasConvertedSources: boolean;
  onEpisodesChange: (update: (prev: AudioEpisode[]) => AudioEpisode[]) => void;
  onError: (message: string | null) => void;
  onRefresh: () => void;
}) {
  const [flavor, setFlavor] = useState("deep-dive");
  const [engine, setEngine] = useState("gemini");
  const [generating, setGenerating] = useState(false);

  const generate = async () => {
    onError(null);
    setGenerating(true);
    try {
      const result = await generateEpisode({
        courseId: course.id,
        flavor,
        engine,
      });
      if (result.error) {
        onError(result.error);
        return;
      }
      onRefresh();
    } finally {
      setGenerating(false);
    }
  };

  if (!hasConvertedSources && episodes.length === 0) return null;

  return (
    <div className="space-y-2">
      <p className="text-label uppercase text-muted">audio overviews</p>

      {episodes.length > 0 && (
        <ul className="divide-y divide-hairline border-y border-hairline">
          {episodes.map((episode) => (
            <li key={episode.id} className="py-2 space-y-2">
              <div className="flex min-h-6 items-center gap-2">
                <span className="flex-1 min-w-0">
                  <span className="block truncate text-body text-fg">
                    ♫ {episode.title}
                  </span>
                  <span
                    className={`block text-meta ${
                      episode.status === "failed" ? "text-danger" : "text-muted"
                    }`}
                  >
                    {episode.status === "done"
                      ? `${formatDuration(episode.duration_sec)} · ${episode.flavor} · ${episode.engine}`
                      : episode.status === "failed"
                        ? (episode.error ?? "failed")
                        : `${episode.status}…`}
                  </span>
                </span>
                <Button
                  variant="quiet"
                  aria-label={`delete episode ${episode.title}`}
                  onClick={async () => {
                    const result = await deleteEpisode({ episodeId: episode.id });
                    if (result.error) onError(result.error);
                    else
                      onEpisodesChange((prev) =>
                        prev.filter((e) => e.id !== episode.id),
                      );
                  }}
                >
                  ✕
                </Button>
              </div>
              {episode.status === "done" && audioUrls[episode.id] && (
                <audio
                  controls
                  preload="none"
                  src={audioUrls[episode.id]}
                  className="w-full h-10"
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {hasConvertedSources && (
        <div className="flex flex-wrap items-center gap-1">
          <select
            value={flavor}
            onChange={(e) => setFlavor(e.target.value)}
            aria-label="episode flavor"
            className="bg-glass-well rounded-field border border-line-strong text-meta text-muted px-1 py-2 min-w-0 min-h-11 focus:outline-none focus:border-accent font-mono"
          >
            {FLAVOR_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <select
            value={engine}
            onChange={(e) => setEngine(e.target.value)}
            aria-label="voice engine"
            className="bg-glass-well rounded-field border border-line-strong text-meta text-muted px-1 py-2 min-w-0 min-h-11 focus:outline-none focus:border-accent font-mono"
          >
            <option value="gemini">gemini (instant)</option>
            <option value="vibevoice">home pc (free)</option>
          </select>
          <Button onClick={() => void generate()} disabled={generating}>
            {generating
              ? engine === "gemini"
                ? "generating… (~2 min)"
                : "scripting…"
              : "♫ generate"}
          </Button>
        </div>
      )}
    </div>
  );
}

const CONVERT_MODEL_OPTIONS = [
  { value: "sonnet", label: "sonnet" },
  { value: "haiku", label: "haiku (cheap)" },
  { value: "opus", label: "opus" },
  { value: "worker", label: "home pc (free)" },
];

function SourceRowItem({
  source,
  onSourcesChange,
  onError,
}: {
  source: CourseSource;
  onSourcesChange: (update: (prev: CourseSource[]) => CourseSource[]) => void;
  onError: (message: string | null) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [model, setModel] = useState("sonnet");
  const [converting, setConverting] = useState(false);
  const [pending, startTransition] = useTransition();

  const convertible =
    source.kind === "pdf" &&
    (source.status === "uploaded" || source.status === "failed");

  const runConvert = async () => {
    onError(null);

    if (model === "worker") {
      const result = await queueSourceConversion({ sourceId: source.id });
      if (result.error) onError(result.error);
      else
        onSourcesChange((prev) =>
          prev.map((s) =>
            s.id === source.id ? { ...s, status: "queued" as const } : s,
          ),
        );
      return;
    }

    setConverting(true);
    onSourcesChange((prev) =>
      prev.map((s) =>
        s.id === source.id ? { ...s, status: "converting" as const } : s,
      ),
    );
    try {
      const result = await convertSource({ sourceId: source.id, model });
      if (result.error) {
        onError(result.error);
        onSourcesChange((prev) =>
          prev.map((s) =>
            s.id === source.id
              ? { ...s, status: "failed" as const, error: result.error }
              : s,
          ),
        );
        return;
      }
      onSourcesChange((prev) =>
        prev.map((s) =>
          s.id === source.id
            ? {
                ...s,
                status: "converted" as const,
                vault_path: result.vaultPath ?? s.vault_path,
                error: null,
              }
            : s,
        ),
      );
    } finally {
      setConverting(false);
    }
  };

  return (
    <li className="flex min-h-11 items-center gap-2 py-1">
      <span className="flex-1 min-w-0">
        <span className="line-clamp-2 break-words text-body text-fg">{source.title}</span>
        <span
          className={`block text-meta ${
            source.status === "failed" ? "text-danger" : "text-muted"
          }`}
        >
          {converting ? "converting…" : sourceStatusLabel(source)}
          {source.page_count ? ` · ${source.page_count}p` : ""}
        </span>
      </span>
      {convertible && !converting && !confirming && (
        <span className="flex items-center gap-1">
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            aria-label="conversion model"
            className="bg-glass-well rounded-field border border-line-strong text-meta text-muted px-1 py-2 min-w-0 min-h-11 focus:outline-none focus:border-accent font-mono"
          >
            {CONVERT_MODEL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <Button onClick={() => void runConvert()}>
            {source.status === "failed" ? "retry" : "convert"}
          </Button>
        </span>
      )}
      {confirming ? (
        <span className="flex items-center gap-1">
          <Button
            variant="danger"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await deleteSource({ sourceId: source.id });
                if (result.error) onError(result.error);
                else
                  onSourcesChange((prev) =>
                    prev.filter((s) => s.id !== source.id),
                  );
                setConfirming(false);
              })
            }
          >
            {pending ? "…" : "delete"}
          </Button>
          <Button variant="quiet" onClick={() => setConfirming(false)}>
            keep
          </Button>
        </span>
      ) : (
        <Button
          variant="quiet"
          aria-label={`delete ${source.title}`}
          onClick={() => setConfirming(true)}
        >
          ✕
        </Button>
      )}
    </li>
  );
}
