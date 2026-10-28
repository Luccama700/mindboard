import { revokeAllConnections, revokeConnection } from "@/app/actions/oauth-grants";
import { buttonClass } from "@/app/_components/ui";
import { listConnectedApps } from "@/app/lib/mcp/oauth-store";

// Every app that holds a live OAuth grant on this account, and the way to cut
// one off. Server component with plain <form action> submits — no client JS,
// the same shape as the sign-out button further down the page.
//
// The redirect host leads because it is the only part a registration cannot
// lie about: it had to pass the host allow-list, and the authorization code
// was delivered there. client_name is whatever the client typed at
// registration, which is unauthenticated — hence "calls itself", second and
// muted.

export async function ConnectedApps({ userId }: { userId: string }) {
  const apps = await listConnectedApps(userId);

  if (apps.length === 0) {
    return (
      <p className="text-meta text-muted leading-relaxed">
        nothing connected. apps you sign into mindboard from — claude.ai and
        the like — show up here.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-meta text-muted leading-relaxed">
        apps holding a live connection to your mindboard. revoking stops new
        access immediately; a token already in flight stops working within an
        hour.
      </p>

      {apps.map((app) => (
        <div key={app.id} className="glass-panel p-3 space-y-2">
          <div className="flex items-center gap-2">
            <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-accent" />
            <span className="flex-1 min-w-0 text-body text-fg lowercase break-words">
              {app.host}
            </span>
            <span className="text-meta text-muted shrink-0">
              {app.createdAt.slice(0, 10)}
            </span>
          </div>

          {app.clientName && (
            <p className="text-meta text-muted leading-relaxed break-words">
              calls itself &ldquo;{app.clientName}&rdquo;
            </p>
          )}

          <div className="flex items-center gap-2">
            <span className="flex-1 text-meta text-muted">
              {app.lastUsedAt
                ? `last active ${app.lastUsedAt.slice(0, 10)}`
                : "not used yet"}
            </span>
            <form action={revokeConnection}>
              <input type="hidden" name="id" value={app.id} />
              <button type="submit" className={buttonClass("danger")}>
                revoke
              </button>
            </form>
          </div>
        </div>
      ))}

      {apps.length > 1 && (
        <form action={revokeAllConnections}>
          <button type="submit" className={buttonClass("quiet")}>
            revoke all
          </button>
        </form>
      )}
    </div>
  );
}
