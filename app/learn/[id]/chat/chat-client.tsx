"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

import type { Course, CourseSource } from "@/app/_components/learn-types";
import { Button, INPUT_CLASS } from "@/app/_components/ui";

type Citation = { n: number; title: string; href: string; cited_text: string };

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
};

export function CourseChatClient({
  course,
  sources,
  hasKey,
}: {
  course: Course;
  sources: CourseSource[];
  hasKey: boolean;
}) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(sources.map((s) => s.id)),
  );
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  if (sources.length === 0) {
    return (
      <p className="text-meta text-muted leading-relaxed">
        no converted sources yet — add a pdf in{" "}
        <Link href="/learn" className="text-accent hover:underline">
          /learn
        </Link>{" "}
        and convert it first.
      </p>
    );
  }
  if (!hasKey) {
    return (
      <p className="text-meta text-muted leading-relaxed">
        course chat runs on your anthropic key — add it in{" "}
        <Link href="/settings" className="text-accent hover:underline">
          settings → connections
        </Link>
        .
      </p>
    );
  }

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        if (next.size > 1) next.delete(id);
      } else next.add(id);
      return next;
    });
  };

  const send = async () => {
    const question = input.trim();
    if (!question || busy) return;
    setError(null);
    setInput("");
    setBusy(true);

    const history = [...messages, { role: "user" as const, content: question }];
    setMessages([...history, { role: "assistant", content: "" }]);

    try {
      const response = await fetch("/api/course-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          courseId: course.id,
          sourceIds: [...selected],
          messages: history.map(({ role, content }) => ({ role, content })),
        }),
      });
      if (!response.ok || !response.body) {
        const detail = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(detail?.error ?? `request failed (${response.status})`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamError: string | null = null;

      const apply = (event: {
        type: string;
        text?: string;
        items?: Citation[];
        error?: string;
      }) => {
        if (event.type === "text" && event.text) {
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            next[next.length - 1] = {
              ...last,
              content: last.content + event.text,
            };
            return next;
          });
        } else if (event.type === "citations" && event.items) {
          const items = event.items;
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            next[next.length - 1] = { ...last, citations: items };
            return next;
          });
        } else if (event.type === "error") {
          streamError = event.error ?? "chat failed";
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const chunk of events) {
          const line = chunk.trim();
          if (!line.startsWith("data: ")) continue;
          try {
            apply(JSON.parse(line.slice(6)));
          } catch {
            // Skip malformed frames.
          }
        }
      }
      if (streamError) throw new Error(streamError);
    } catch (e) {
      setError(e instanceof Error ? e.message : "chat failed");
      // Drop the empty assistant placeholder on failure.
      setMessages((prev) =>
        prev[prev.length - 1]?.role === "assistant" &&
        !prev[prev.length - 1].content
          ? prev.slice(0, -1)
          : prev,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1">
        {sources.map((source) => {
          const on = selected.has(source.id);
          return (
            <button
              key={source.id}
              type="button"
              onClick={() => toggle(source.id)}
              aria-pressed={on}
              className={`inline-flex items-center min-h-11 px-2 text-meta lowercase border transition-colors ${
                on
                  ? "border-accent-ink text-fg bg-accent-wash"
                  : "border-hairline text-muted hover:text-fg"
              }`}
            >
              {source.title}
            </button>
          );
        })}
      </div>

      <div className="space-y-4">
        {messages.length === 0 && (
          <p className="text-meta text-muted leading-relaxed">
            answers come only from the selected sources, with citations back to
            the exact passage. ask anything from the material.
          </p>
        )}
        {messages.map((message, index) => (
          <div key={index} className="space-y-1">
            {message.role === "user" ? (
              <p className="text-body text-fg">
                <span className="text-accent">› </span>
                {message.content}
              </p>
            ) : (
              <div className="text-body text-fg/90 whitespace-pre-wrap leading-relaxed">
                {message.content}
                {busy && index === messages.length - 1 && (
                  <span className="text-accent">▮</span>
                )}
              </div>
            )}
            {message.citations && message.citations.length > 0 && (
              <div className="space-y-1 pt-1">
                {message.citations.map((citation) => (
                  <details key={citation.n} className="text-meta text-muted">
                    <summary className="cursor-pointer list-none min-h-6">
                      <span className="text-accent">[{citation.n}]</span>{" "}
                      {citation.href ? (
                        <Link
                          href={citation.href}
                          className="hover:text-fg hover:underline"
                        >
                          {citation.title} →
                        </Link>
                      ) : (
                        citation.title
                      )}
                    </summary>
                    <blockquote className="border-l-2 border-hairline pl-2 mt-1 leading-relaxed">
                      {citation.cited_text}
                    </blockquote>
                  </details>
                ))}
              </div>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {error && <p className="text-action text-danger">{error}</p>}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        className="flex items-stretch gap-1"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={`ask about ${course.name.toLowerCase()}…`}
          className={INPUT_CLASS}
          disabled={busy}
        />
        <Button type="submit" variant="accent" disabled={busy || !input.trim()}>
          {busy ? "…" : "ask"}
        </Button>
      </form>
    </div>
  );
}
