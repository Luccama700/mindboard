"use server";

import { updateTag } from "next/cache";
import { createClient } from "@/utils/supabase/server";
import { isVaultOwner } from "@/app/lib/brain/access";

export async function refreshVault() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isVaultOwner(user.id)) return;
  updateTag("vault");
}
