"use client";

import { useState, useTransition } from "react";

import { generateMcpToken, revokeMcpToken } from "@/app/actions/mcp-token";
import { ConnectionShell } from "@/app/_components/connection-card";
import { Button } from "@/app/_components/ui";

// Settings → connections card for the user's personal MCP connection: the
// shared server URL plus a per-user access token. The token is displayed once
// right after generation and never again (only its hash is stored).

function CopyRow({ value, mono = true }: { value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-stretch gap-px">
      <input
        readOnly
        value={value}
        onFocus={(e) => e.currentTarget.select()}
        className={`flex-1 min-w-0 bg-glass-well rounded-field border border-line-strong text-fg text-body px-3 py-2 focus:outline-none ${mono ? "font-mono" : ""}`}
      />
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="px-2 border border-l-0 border-line-strong text-label uppercase text-muted hover:text-fg transition-colors"
      >
        {copied ? "copied" : "copy"}
      </button>
    </div>
  );
}

export function McpConnectionCard({
  mcpUrl,
  connected,
  hint,
  createdAt,
}: {
  mcpUrl: string;
  connected: boolean;
  hint: string | null;
  createdAt: string | null;
}) {
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const generate = () => {
    setError(null);
    startTransition(async () => {
      const result = await generateMcpToken();
      if (result.error) setError(result.error);
      else setFreshToken(result.token ?? null);
    });
  };

  const revoke = () => {
    setError(null);
    startTransition(async () => {
      const result = await revokeMcpToken();
      if (result.error) setError(result.error);
      else setFreshToken(null);
    });
  };

  return (
    <ConnectionShell
      title="mcp connection"
      status={connected || freshToken ? "connected" : "not set"}
      hint={
        freshToken
          ? `…${freshToken.slice(-4)}`
          : hint
            ? `…${hint}${createdAt ? ` · ${createdAt.slice(0, 10)}` : ""}`
            : null
      }
      powers="claude.ai / chatgpt / claude desktop read & write your mindboard data over mcp."
      storageNote="the token is shown once and stored only as a hash. claude.ai connectors can skip the token entirely — add the url and sign in with google when prompted."
    >
      <div className="space-y-2">
        <p className="text-meta text-muted">server url</p>
        <CopyRow value={mcpUrl} />

        {error && <p className="text-action text-danger">{error}</p>}

        {freshToken && (
          <div className="space-y-1">
            <p className="text-meta text-accent">
              your access token — copy it now, it won&apos;t be shown again.
            </p>
            <CopyRow value={freshToken} />
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button onClick={generate} disabled={pending}>
            {pending
              ? "working…"
              : connected || freshToken
                ? "regenerate token"
                : "generate token"}
          </Button>
          {(connected || freshToken) && (
            <Button variant="danger" disabled={pending} onClick={revoke}>
              revoke
            </Button>
          )}
        </div>
        <p className="text-meta text-muted leading-relaxed">
          non-oauth clients send it as{" "}
          <span className="font-mono">authorization: bearer &lt;token&gt;</span>.
          regenerating invalidates the previous token.
        </p>
      </div>
    </ConnectionShell>
  );
}
