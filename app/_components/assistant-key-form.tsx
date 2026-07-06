"use client";

import { useState, useTransition } from "react";
import { clearAssistantKey, saveAssistantKey } from "@/app/actions/assistant";
import { Button } from "./ui";

export function AssistantKeyForm({ connected }: { connected: boolean }) {
  const [key, setKey] = useState("");
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const submit = () => {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await saveAssistantKey({ key });
      if (result.error) setError(result.error);
      else {
        setKey("");
        setSaved(true);
      }
    });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="space-y-3"
    >
      <div className="flex items-stretch gap-px">
        <input
          type={reveal ? "text" : "password"}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={
            connected ? "replace stored key…" : "paste anthropic api key (sk-ant-…)"
          }
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
      <p className="text-meta text-muted leading-relaxed">
        your key, stored encrypted, used server-side only, never sent to the
        browser. it powers the planning copilot on your own anthropic account.
      </p>
      {error && <p className="text-action text-danger">{error}</p>}
      {saved && !error && <p className="text-action text-accent">saved ✓</p>}
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={pending || !key.trim()}>
          {pending ? "saving…" : connected ? "replace key" : "save key"}
        </Button>
        {connected && (
          <Button
            variant="danger"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                setError(null);
                const result = await clearAssistantKey();
                if (result.error) setError(result.error);
              })
            }
          >
            remove
          </Button>
        )}
      </div>
    </form>
  );
}
