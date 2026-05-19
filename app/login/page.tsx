"use client";

import { createClient } from "@/utils/supabase/client";
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
      },
    });
    if (error) {
      setLoading(false);
      console.error(error);
    }
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6">
      <div className="max-w-sm w-full space-y-8">
        <div>
          <p className="text-[#6b6b6b] text-xs tracking-widest uppercase mb-3">
            sign in
          </p>
          <h1 className="text-3xl font-bold tracking-tight text-[#f5f0e8]">
            mindboard
          </h1>
        </div>

        <button
          onClick={signInWithGoogle}
          disabled={loading}
          className="w-full bg-[#b5ff3c] text-[#0d0d0d] text-sm font-bold px-6 py-4 hover:bg-[#f5f0e8] transition-colors disabled:opacity-50"
        >
          {loading ? "redirecting..." : "continue with google →"}
        </button>

        <a
          href="/"
          className="block text-[#6b6b6b] text-xs hover:text-[#f5f0e8] transition-colors"
        >
          ← back
        </a>
      </div>
    </main>
  );
}
