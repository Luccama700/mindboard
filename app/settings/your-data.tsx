"use client";

import { useState, useTransition } from "react";

import { deleteMyAccount } from "@/app/actions/account";
import {
  ACCOUNT_DELETE_PHRASE,
  matchesDeletePhrase,
} from "@/app/lib/account/delete";
import { Button, INPUT_CLASS } from "@/app/_components/ui";

// settings → your data (audit finding M9). One panel for the two things a
// tenant can do with everything mindboard holds about them: take a copy, or
// end it. The delete arms behind a typed phrase, never a bare button.

export function YourData({ isOwner }: { isOwner: boolean }) {
  const [arming, setArming] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const ready = matchesDeletePhrase(phrase);

  return (
    <div className="glass-panel p-3 space-y-3">
      <p className="text-meta text-muted leading-relaxed">
        deleting removes every row mindboard holds for you — tasks, finance,
        inventory, people, courses, notes, assistant history — and every file
        you uploaded (icons, course pdfs, podcast audio, reel media). it cannot
        be undone.
      </p>
      <p className="text-meta text-muted leading-relaxed">
        <span className="text-fg/70">not touched:</span> your brain vault lives
        in your own github repo and stays exactly as it is — revoke the token
        mindboard used at github → settings → developer settings → fine-grained
        tokens. your google account is untouched too; remove mindboard&apos;s
        calendar access at{" "}
        <a
          href="https://myaccount.google.com/connections"
          target="_blank"
          rel="noreferrer noopener"
          className="text-accent-ink underline underline-offset-2"
        >
          myaccount.google.com/connections
        </a>
        .
      </p>

      {isOwner ? (
        <p className="text-meta text-muted leading-relaxed">
          this account runs the deployment, so it can&apos;t delete itself from
          here — removing it would break mindboard for everyone else signed in.
        </p>
      ) : !arming ? (
        <Button variant="danger" onClick={() => setArming(true)}>
          delete my account
        </Button>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!ready) return;
            setError(null);
            startTransition(async () => {
              const result = await deleteMyAccount({ phrase });
              if (result?.error) setError(result.error);
            });
          }}
          className="space-y-2"
        >
          <label
            htmlFor="delete-confirm"
            className="block text-meta text-muted leading-relaxed"
          >
            type <span className="text-danger">{ACCOUNT_DELETE_PHRASE}</span> to
            confirm.
          </label>
          <input
            id="delete-confirm"
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            placeholder={ACCOUNT_DELETE_PHRASE}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className={INPUT_CLASS}
          />
          {error && <p className="text-action text-danger">{error}</p>}
          <div className="flex items-center gap-2">
            <Button type="submit" variant="danger" disabled={pending || !ready}>
              {pending ? "deleting…" : "delete everything"}
            </Button>
            <Button
              variant="quiet"
              disabled={pending}
              onClick={() => {
                setArming(false);
                setPhrase("");
                setError(null);
              }}
            >
              cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
