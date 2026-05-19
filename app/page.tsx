import { createClient } from "@/utils/supabase/server";
import { signOut } from "./actions/auth";

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6">
      <div className="max-w-sm w-full space-y-8">
        <div>
          <p className="text-[#6b6b6b] text-xs tracking-widest uppercase mb-3">
            personal dashboard
          </p>
          <h1 className="text-4xl font-bold tracking-tight text-[#f5f0e8]">
            mindboard
          </h1>
        </div>

        {user ? (
          <>
            <div className="space-y-2 border-l-2 border-[#b5ff3c] pl-3">
              <p className="text-[#6b6b6b] text-xs tracking-widest uppercase">
                signed in
              </p>
              <p className="text-[#f5f0e8] text-sm break-all">{user.email}</p>
            </div>

            <div className="pt-4">
              <a
                href="/groups"
                className="inline-block bg-[#b5ff3c] text-[#0d0d0d] text-sm font-bold px-6 py-3 hover:bg-[#f5f0e8] transition-colors"
              >
                groups →
              </a>
            </div>

            <form action={signOut}>
              <button
                type="submit"
                className="text-[#6b6b6b] text-xs hover:text-[#f5f0e8] transition-colors"
              >
                sign out →
              </button>
            </form>
          </>
        ) : (
          <>
            <p className="text-[#6b6b6b] text-sm leading-relaxed">
              Track what matters. Ship what ships.
            </p>
            <div className="pt-4">
              <a
                href="/login"
                className="inline-block bg-[#b5ff3c] text-[#0d0d0d] text-sm font-bold px-6 py-3 hover:bg-[#f5f0e8] transition-colors"
              >
                get started →
              </a>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
