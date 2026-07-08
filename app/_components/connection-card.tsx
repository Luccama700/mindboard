"use client";

import { useState, useTransition, type ReactNode } from "react";

import { clearProviderKey, saveProviderKey } from "@/app/actions/connections";
import type { KeyProvider } from "@/app/lib/connections/types";
import { Button } from "./ui";

// The one visual recipe for every credential in settings → connections:
// header (name · status dot · key hint), a plain-language "powers" line, a
// storage note, and an expandable edit body.

export function ConnectionShell({
  title,
  status,
  hint,
  powers,
  storageNote,
  children,
}: {
  title: string;
  status: "connected" | "not set" | "error" | "offline";
  hint?: string | null;
  powers: string;
  storageNote: string;
  children?: ReactNode;
}) {
  const dotClass =
    status === "connected"
      ? "bg-accent"
      : status === "error"
        ? "bg-danger"
        : "bg-line-strong";

  return (
    <div className="border border-hairline p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={`h-2 w-2 shrink-0 rounded-full ${dotClass}`}
        />
        <span className="flex-1 text-body text-fg lowercase">{title}</span>
        <span className="text-meta text-muted">
          {status}
          {status === "connected" && hint ? ` · ${hint}` : ""}
        </span>
      </div>
      <p className="text-meta text-muted leading-relaxed">
        <span className="text-fg/70">powers</span> {powers}
      </p>
      <p className="text-meta text-muted leading-relaxed">{storageNote}</p>
      {children}
    </div>
  );
}

export function KeyConnectionCard({
  provider,
  title,
  powers,
  placeholder,
  connected,
  hint,
}: {
  provider: KeyProvider;
  title: string;
  powers: string;
  placeholder: string;
  connected: boolean;
  hint: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const submit = () => {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await saveProviderKey({ provider, key });
      if (result.error) setError(result.error);
      else {
        setKey("");
        setSaved(true);
        setOpen(false);
      }
    });
  };

  return (
    <ConnectionShell
      title={title}
      status={connected ? "connected" : "not set"}
      hint={hint}
      powers={powers}
      storageNote="stored encrypted, used server-side only, never sent to the browser."
    >
      {error && <p className="text-action text-danger">{error}</p>}
      {saved && !error && <p className="text-action text-accent">saved ✓</p>}

      {open ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="space-y-2"
        >
          <div className="flex items-stretch gap-px">
            <input
              type={reveal ? "text" : "password"}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={placeholder}
              autoComplete="off"
              spellCheck={false}
              className="flex-1 min-w-0 bg-surface-0 border border-line-strong focus:border-accent text-fg placeholder-muted text-body px-3 py-2 focus:outline-none transition-colors font-mono"
            />
            <button
              type="button"
              onClick={() => setReveal((v) => !v)}
              className="px-2 border border-l-0 border-line-strong text-label uppercase text-muted hover:text-fg transition-colors"
            >
              {reveal ? "hide" : "show"}
            </button>
          </div>
          <p className="text-meta text-muted">
            verified with one test call before saving.
          </p>
          <div className="flex items-center gap-2">
            <Button
              type="submit"
              variant="accent"
              disabled={pending || !key.trim()}
            >
              {pending ? "verifying…" : connected ? "replace key" : "save key"}
            </Button>
            <Button variant="quiet" disabled={pending} onClick={() => setOpen(false)}>
              cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex items-center gap-2">
          <Button onClick={() => setOpen(true)}>
            {connected ? "replace key" : "add key"}
          </Button>
          {connected && (
            <Button
              variant="danger"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  setError(null);
                  setSaved(false);
                  const result = await clearProviderKey({ provider });
                  if (result.error) setError(result.error);
                })
              }
            >
              remove
            </Button>
          )}
        </div>
      )}
    </ConnectionShell>
  );
}
