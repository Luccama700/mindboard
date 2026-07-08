"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { saveProviderKey } from "@/app/actions/connections";

const STORAGE_KEY = "image-gen-settings";

// One-time migration: image-gen API keys used to live in plaintext
// localStorage (image-gen-settings.openaiKey / .googleKey). They now belong
// in the encrypted user_settings provider columns (settings → connections).
// On mount, each legacy key is saved to its provider column — unless that
// provider is already connected — and then stripped from localStorage. A key
// is kept only when the provider was unreachable, so a transient failure
// retries on the next settings visit.
let ran = false;

export function LegacyImageKeyMigration({
  openaiConnected,
  googleConnected,
}: {
  openaiConnected: boolean;
  googleConnected: boolean;
}) {
  const router = useRouter();

  useEffect(() => {
    if (ran) return;
    ran = true;

    let parsed: Record<string, unknown>;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;

    const legacy: {
      provider: "openai" | "google";
      field: string;
      connected: boolean;
    }[] = [
      { provider: "openai", field: "openaiKey", connected: openaiConnected },
      { provider: "google", field: "googleKey", connected: googleConnected },
    ];

    void (async () => {
      let changed = false;
      let migrated = false;

      for (const { provider, field, connected } of legacy) {
        if (!(field in parsed)) continue;
        const key = parsed[field];

        if (typeof key === "string" && key.trim() !== "" && !connected) {
          const result = await saveProviderKey({ provider, key: key.trim() });
          if (result.error?.startsWith("could not reach")) continue;
          if (!result.error) migrated = true;
        }

        delete parsed[field];
        changed = true;
      }

      if (changed) {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
      }
      if (migrated) router.refresh();
    })();
  }, [openaiConnected, googleConnected, router]);

  return null;
}
