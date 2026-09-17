import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { revealSecret, sealSecret } from "@/app/lib/assistant/crypto";
import { CALENDAR_SCOPES } from "@/utils/google/scopes";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";

  if (code) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error && data.session) {
      const session = data.session;
      const providerToken = session.provider_token;
      let refreshToken = session.provider_refresh_token ?? null;

      if (providerToken) {
        if (!refreshToken) {
          const { data: existing } = await supabase
            .from("google_tokens")
            .select("refresh_token")
            .eq("user_id", session.user.id)
            .maybeSingle();
          // Stored form may be encrypted (or legacy plaintext) — reveal to
          // plaintext here so the seal below never double-encrypts.
          refreshToken = existing?.refresh_token
            ? revealSecret(existing.refresh_token as string)
            : null;
        }

        if (refreshToken) {
          const expiresAt = new Date(
            (session.expires_at ??
              Math.floor(Date.now() / 1000) + session.expires_in) * 1000,
          ).toISOString();

          await supabase.from("google_tokens").upsert(
            {
              user_id: session.user.id,
              access_token: sealSecret(providerToken),
              refresh_token: sealSecret(refreshToken),
              expires_at: expiresAt,
              scopes: CALENDAR_SCOPES,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "user_id" },
          );
        }
      }

      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth`);
}
