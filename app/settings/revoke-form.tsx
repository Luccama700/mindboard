"use client";

import { useActionState } from "react";

import type { RevokeState } from "@/app/actions/oauth-grants";

// One revoke button for Settings → connected apps. A client island only so the
// action's result can be shown: a failed revoke used to re-render the app as
// still connected with nothing said.
export function RevokeForm({
  action,
  id,
  label,
  className,
}: {
  action: (prev: RevokeState, formData: FormData) => Promise<RevokeState>;
  id?: string;
  label: string;
  className: string;
}) {
  const [state, formAction, pending] = useActionState(action, { error: null });
  return (
    <form action={formAction}>
      {id && <input type="hidden" name="id" value={id} />}
      <button type="submit" className={className} disabled={pending}>
        {label}
      </button>
      {state.error && (
        <p role="alert" className="text-meta text-danger">
          {state.error}
        </p>
      )}
    </form>
  );
}
