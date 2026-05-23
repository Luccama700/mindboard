"use client";

import { createClient } from "@/utils/supabase/client";
import { CALENDAR_SCOPES } from "@/utils/google/scopes";
import Link from "next/link";
import { useState } from "react";

export default function LoginPage() {
  const [loading, setLoading] = useState(false);

  async function signInWithGoogle() {
    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
        scopes: CALENDAR_SCOPES,
        queryParams: {
          access_type: "offline",
          prompt: "consent",
        },
      },
    });
    if (error) {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6">
      <div className="max-w-sm w-full space-y-8">
        <div>
          <p className="text-muted text-xs tracking-widest uppercase mb-3">
            sign in
          </p>
          <h1 className="text-3xl font-bold tracking-tight text-fg">
            mindboard
          </h1>
        </div>

        <button
          onClick={signInWithGoogle}
          disabled={loading}
          className="w-full bg-accent text-accent-fg text-sm font-bold px-6 py-4 hover:opacity-90 transition-colors disabled:opacity-50"
        >
          {loading ? "redirecting..." : "continue with google →"}
        </button>

        <Link
          href="/"
          className="block text-muted text-xs hover:text-fg transition-colors"
        >
          ← back
        </Link>
      </div>
    </main>
  );
}
