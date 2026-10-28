import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import { CALENDAR_SCOPES } from "@/utils/google/scopes";
import {
  encryptGoogleToken,
  GOOGLE_TOKENS_TABLE,
  readGoogleToken,
} from "@/utils/google/tokens";
import { safeNextPath } from "./next-path";

// Where the google_tokens row is read and written. The service client when one
// is configured: migration 0058 revokes the anon/authenticated SELECT on the
// token columns, so the cookie client can no longer read back the stored
// refresh token. It bypasses RLS, hence the explicit user_id on every query.
function tokenStore(cookieClient: SupabaseClient): SupabaseClient {
  return process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createServiceClient()
    : cookieClient;
}

// Google's refresh token only comes back on the FIRST consent, so a later
// sign-in has to reuse the stored one. Tolerates a legacy plaintext row; the
// upsert below re-writes it encrypted either way.
async function storedRefreshToken(
  store: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const { data } = await store
    .from(GOOGLE_TOKENS_TABLE)
    .select("refresh_token")
    .eq("user_id", userId)
    .maybeSingle();
  const stored = (data as { refresh_token: string } | null)?.refresh_token;
  if (!stored) return null;
  try {
    return readGoogleToken(userId, "refresh_token", stored).value;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = safeNextPath(searchParams.get("next"), origin);

  if (code) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error && data.session) {
      const session = data.session;
      const providerToken = session.provider_token;
      let refreshToken = session.provider_refresh_token ?? null;

      // Persisting the provider tokens must never take sign-in down with it:
      // the session cookie is already set by the exchange above, and a user
      // without a calendar connection is a degraded app, not a locked-out one.
      try {
        if (providerToken) {
          const store = tokenStore(supabase);
          const userId = session.user.id;
          if (!refreshToken) {
            refreshToken = await storedRefreshToken(store, userId);
          }

          if (refreshToken) {
            const expiresAt = new Date(
              (session.expires_at ??
                Math.floor(Date.now() / 1000) + session.expires_in) * 1000,
            ).toISOString();

            await store.from(GOOGLE_TOKENS_TABLE).upsert(
              {
                user_id: userId,
                access_token: encryptGoogleToken(
                  userId,
                  "access_token",
                  providerToken,
                ),
                refresh_token: encryptGoogleToken(
                  userId,
                  "refresh_token",
                  refreshToken,
                ),
                expires_at: expiresAt,
                scopes: CALENDAR_SCOPES,
                updated_at: new Date().toISOString(),
              },
              { onConflict: "user_id" },
            );
          }
        }
      } catch {
        // No logging here at all: everything in scope is a provider token.
      }

      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth`);
}
