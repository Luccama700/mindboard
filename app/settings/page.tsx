import { redirect } from "next/navigation";

import { createClient } from "@/utils/supabase/server";
import { signOut } from "@/app/actions/auth";
import { AssistantKeyForm } from "@/app/_components/assistant-key-form";
import { SettingsSections } from "@/app/_components/settings-panel";
import { SectionRuler } from "@/app/_components/ui";
import { VaultSettingsForm } from "@/app/brain/_components/vault-settings-form";
import { getUserPreferences } from "@/app/lib/data/settings";
import { getVaultSettings } from "@/app/lib/brain/vault";
import { PreferencesForm } from "./preferences-form";

export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [prefs, vault, settingsRow] = await Promise.all([
    getUserPreferences(user.id),
    getVaultSettings(user.id),
    supabase
      .from("user_settings")
      .select("anthropic_api_key")
      .eq("user_id", user.id)
      .maybeSingle(),
  ]);
  const hasAssistantKey = Boolean(settingsRow.data?.anthropic_api_key);

  return (
    <main className="min-h-screen px-5 pt-6 pb-64 max-w-2xl mx-auto space-y-10">
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
        />
      </section>

      <section className="space-y-4">
        <SectionRuler label="copilot" />
        <AssistantKeyForm connected={hasAssistantKey} />
      </section>

      <section className="space-y-4">
        <SectionRuler label="brain vault" />
        <VaultSettingsForm
          initialRepo={vault?.repo ?? ""}
          initialBranch={vault?.branch ?? "main"}
          connected={Boolean(vault)}
        />
      </section>

      <section className="space-y-4">
        <SectionRuler label="account" />
        <form action={signOut}>
          <button
            type="submit"
            className="min-h-11 px-3 text-action lowercase border border-hairline text-danger hover:border-danger transition-colors"
          >
            sign out
          </button>
        </form>
      </section>
    </main>
  );
}
