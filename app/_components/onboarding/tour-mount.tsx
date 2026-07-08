import { createClient } from "@/utils/supabase/server";
import { OnboardingController } from "./onboarding-controller";

// Server shell for onboarding (the dock-mount pattern): resolves the session
// and the user's completed tours. Logged-out visitors get nothing.
export async function TourMount() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from("user_settings")
    .select("completed_tours")
    .eq("user_id", user.id)
    .maybeSingle();

  const map =
    data?.completed_tours && typeof data.completed_tours === "object"
      ? (data.completed_tours as Record<string, unknown>)
      : {};

  return <OnboardingController initialCompleted={Object.keys(map)} />;
}
