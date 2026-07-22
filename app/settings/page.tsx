import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { createClient } from "@/utils/supabase/server";
import { signOut } from "@/app/actions/auth";
import {
  ConnectionShell,
  KeyConnectionCard,
} from "@/app/_components/connection-card";
import { LegacyImageKeyMigration } from "@/app/_components/legacy-image-key-migration";
import { ReplayToursButton } from "@/app/_components/onboarding/replay-tours-button";
import { SettingsSections } from "@/app/_components/settings-panel";
import { SectionRuler } from "@/app/_components/ui";
import { VaultSettingsForm } from "@/app/brain/_components/vault-settings-form";
import { decryptSecret } from "@/app/lib/assistant/crypto";
import { KEY_COLUMNS, keyHint } from "@/app/lib/connections/keys";
import type { KeyProvider } from "@/app/lib/connections/types";
import { getUserPreferences } from "@/app/lib/data/settings";
import { getVaultSettings } from "@/app/lib/brain/vault";
import { McpConnectionCard } from "./mcp-connection-card";
import { AgentModelsForm } from "./agent-models-form";
import { PreferencesForm } from "./preferences-form";

// Key saves make one live verification call to the provider.
export const maxDuration = 30;

function hintFor(encrypted: string | null | undefined): string | null {
  if (!encrypted) return null;
  try {
    return keyHint(decryptSecret(encrypted));
  } catch {
    return null;
  }
}

export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [prefs, vault, settingsRow, workerRow, jobCounts] = await Promise.all([
    getUserPreferences(user.id),
    getVaultSettings(user.id),
    supabase
      .from("user_settings")
      .select(
        "anthropic_api_key, google_ai_api_key, openai_api_key, mcp_token_hash, mcp_token_hint, mcp_token_created_at, agent_plan_model, agent_build_model",
      )
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase
      .from("worker_status")
      .select("last_seen_at")
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .in("status", ["queued", "processing"]),
  ]);

  const lastSeen = workerRow.data?.last_seen_at
    ? new Date(workerRow.data.last_seen_at as string)
    : null;
  // Server component: one clock read per request, not per client render, so
  // the purity rule's re-render concern doesn't apply.
  const nowMs = Date.now(); // eslint-disable-line react-hooks/purity
  const workerOnline =
    lastSeen !== null && nowMs - lastSeen.getTime() < 2 * 60 * 1000;
  const pendingJobs = jobCounts.count ?? 0;
  const row = settingsRow.data as
    | Record<string, string | null>
    | null
    | undefined;

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const proto = h.get("x-forwarded-proto") ?? "https";
  const mcpUrl = host ? `${proto}://${host}/api/mcp/mcp` : "/api/mcp/mcp";

  const keyCards: {
    provider: KeyProvider;
    title: string;
    powers: string;
    placeholder: string;
  }[] = [
    {
      provider: "anthropic",
      title: "anthropic",
      powers:
        "planning copilot · pdf → vault conversion · podcast scripts · inventory capture parsing.",
      placeholder: "paste anthropic api key (sk-ant-…)",
    },
    {
      provider: "google",
      title: "google ai",
      powers: "podcast voices (gemini tts) · icon generation.",
      placeholder: "paste google ai api key (AIza…)",
    },
    {
      provider: "openai",
      title: "openai",
      powers: "icon generation.",
      placeholder: "paste openai api key (sk-…)",
    },
  ];

  return (
    <main className="min-h-screen px-5 pt-6 pb-64 max-w-2xl mx-auto space-y-10">
      <LegacyImageKeyMigration
        openaiConnected={Boolean(row?.[KEY_COLUMNS.openai])}
        googleConnected={Boolean(row?.[KEY_COLUMNS.google])}
      />
      <header>
        <h1 className="text-label uppercase text-muted">settings</h1>
      </header>

      <section className="space-y-4">
        <SectionRuler label="appearance" />
        <SettingsSections />
      </section>

      <section className="space-y-4">
        <SectionRuler label="preferences" />
        <PreferencesForm
          initialTimezone={prefs.timezone}
          initialWakeStart={prefs.wake_start_hour}
          initialWakeEnd={prefs.wake_end_hour}
          initialStreamMaxTasks={prefs.stream_max_tasks}
        />
      </section>

      <section className="space-y-4">
        <SectionRuler label="overnight agent" />
        <AgentModelsForm
          initialPlanModel={
            (settingsRow.data?.agent_plan_model as string | null) ?? null
          }
          initialBuildModel={
            (settingsRow.data?.agent_build_model as string | null) ?? null
          }
        />
      </section>

      <section className="space-y-3">
        <SectionRuler label="connections" />
        <p className="text-meta text-muted leading-relaxed">
          every key and credential the app can use, in one place. each card
          says what the connection powers.
        </p>

        {keyCards.map((card) => (
          <KeyConnectionCard
            key={card.provider}
            provider={card.provider}
            title={card.title}
            powers={card.powers}
            placeholder={card.placeholder}
            connected={Boolean(row?.[KEY_COLUMNS[card.provider]])}
            hint={hintFor(row?.[KEY_COLUMNS[card.provider]])}
          />
        ))}

        <McpConnectionCard
          mcpUrl={mcpUrl}
          connected={Boolean(row?.mcp_token_hash)}
          hint={row?.mcp_token_hint ?? null}
          createdAt={row?.mcp_token_created_at ?? null}
        />

        <ConnectionShell
          title="brain vault"
          status={vault ? "connected" : "not set"}
          hint={vault ? vault.repo : null}
          powers="brain notes (/brain) · conversation captures · course notes."
          storageNote="github fine-grained pat, stored per user, used server-side only."
        >
          <VaultSettingsForm
            initialRepo={vault?.repo ?? ""}
            initialBranch={vault?.branch ?? "main"}
            connected={Boolean(vault)}
          />
        </ConnectionShell>

        <ConnectionShell
          title="home worker"
          status={workerOnline ? "connected" : "offline"}
          hint={
            workerOnline
              ? pendingJobs > 0
                ? `${pendingJobs} job${pendingJobs === 1 ? "" : "s"} pending`
                : "idle"
              : lastSeen
                ? `last seen ${lastSeen.toISOString().slice(0, 16).replace("T", " ")} utc`
                : null
          }
          powers="free pdf conversion (mineru) · free podcast voices (vibevoice)."
          storageNote={
            workerOnline
              ? "the pc polls /api/worker with a bearer token — no database key leaves the server."
              : pendingJobs > 0
                ? `${pendingJobs} job${pendingJobs === 1 ? "" : "s"} waiting — jobs run when the pc comes online. setup: worker/README.md.`
                : "the always-on pc pulls jobs from a queue — no key is stored here. setup: worker/README.md."
          }
        />
      </section>

      <section className="space-y-4">
        <SectionRuler label="help" />
        <ReplayToursButton />
      </section>

      <section className="space-y-4">
        <SectionRuler label="account" />
        <form action={signOut}>
          <button
            type="submit"
            className="min-h-11 px-3 text-action lowercase border rounded-full border-hairline text-danger hover:border-danger transition-colors"
          >
            sign out
          </button>
        </form>
      </section>
    </main>
  );
}
