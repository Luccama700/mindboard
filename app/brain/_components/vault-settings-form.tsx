"use client";

import { useState, useTransition } from "react";

import { disconnectVault, saveVaultSettings } from "@/app/actions/brain";

export function VaultSettingsForm({
  initialRepo,
  initialBranch,
  connected,
}: {
  initialRepo: string;
  initialBranch: string;
  connected: boolean;
}) {
  const [repo, setRepo] = useState(initialRepo);
  const [branch, setBranch] = useState(initialBranch);
  const [token, setToken] = useState("");
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const submit = () => {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await saveVaultSettings({ repo, branch, token });
      if (result.error) {
        setError(result.error);
        return;
      }
      setToken("");
      setSaved(true);
    });
  };

  const disconnect = () => {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await disconnectVault();
      if (result.error) setError(result.error);
    });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="glass-panel px-4 py-4 space-y-4"
    >
      <div>
        <p className="text-[10px] tracking-widest uppercase text-muted mb-1.5">
          github repo
        </p>
        <input
          type="text"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          placeholder="owner/name"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          className="w-full bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg placeholder-muted text-xs px-2 py-2 focus:outline-none transition-colors font-mono"
        />
      </div>

      <div>
        <p className="text-[10px] tracking-widest uppercase text-muted mb-1.5">
          branch
        </p>
        <input
          type="text"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          placeholder="main"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          className="w-full bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg placeholder-muted text-xs px-2 py-2 focus:outline-none transition-colors font-mono"
        />
      </div>

      <div>
        <p className="text-[10px] tracking-widest uppercase text-muted mb-1.5">
          github token
        </p>
        <div className="flex items-stretch gap-px">
          <input
            type={reveal ? "text" : "password"}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={
              connected
                ? "leave blank to keep current token"
                : "paste fine-grained PAT…"
            }
            autoComplete="off"
            spellCheck={false}
            className="flex-1 min-w-0 bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg placeholder-muted text-xs px-2 py-2 focus:outline-none transition-colors font-mono"
          />
          <button
            type="button"
            onClick={() => setReveal((v) => !v)}
            className="px-2 border border-l-0 border-line-strong text-[10px] tracking-widest uppercase text-muted hover:text-fg transition-colors"
          >
            {reveal ? "hide" : "show"}
          </button>
        </div>
        <p className="text-[10px] text-muted mt-1.5 leading-relaxed">
          use a fine-grained personal access token with read-only Contents
          permission, scoped to just the vault repo. it is stored server-side
          and never shown again.
        </p>
      </div>

      {error && <p className="text-xs text-danger">{error}</p>}
      {saved && !error && <p className="text-xs text-accent">connected ✓</p>}

      <div className="flex items-center justify-between gap-3">
        <button
          type="submit"
          disabled={pending}
          className="min-h-11 px-4 text-xs tracking-widest uppercase border border-fg text-fg hover:bg-fg hover:text-page transition-colors disabled:opacity-50"
        >
          {pending ? "checking…" : connected ? "save" : "connect"}
        </button>
        {connected && (
          <button
            type="button"
            onClick={disconnect}
            disabled={pending}
            className="min-h-11 px-4 text-xs tracking-widest uppercase border rounded-full border-line text-danger hover:border-danger transition-colors disabled:opacity-50"
          >
            disconnect
          </button>
        )}
      </div>
    </form>
  );
}
