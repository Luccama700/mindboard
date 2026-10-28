"use server";

import { redirect } from "next/navigation";

import { createClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";
import {
  USER_STORAGE_BUCKETS,
  chunk,
  collectObjectPaths,
  isDeploymentOwner,
  matchesDeletePhrase,
} from "@/app/lib/account/delete";

// Account deletion (audit finding M9). Order matters:
//
//   1. resolve the caller from the session — never from a form field;
//   2. refuse for the deployment owner;
//   3. purge storage, which does NOT cascade (storage.objects.owner is a
//      nullable FK, so the files would outlive the auth row with nothing left
//      to name them);
//   4. delete the auth.users row — every one of the 44 public tables hangs off
//      it with `on delete cascade`, so Postgres does the rest;
//   5. clear the session cookie and leave.
//
// Storage before auth, and a hard stop if storage fails: a half-delete that
// orphans files is worse than a delete the user can retry.

const REMOVE_BATCH = 100;

export async function deleteMyAccount(input: {
  phrase: string;
}): Promise<{ error: string }> {
  if (!matchesDeletePhrase(input?.phrase ?? "")) {
    return { error: "type the confirmation phrase exactly to continue" };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "not authenticated" };

  if (isDeploymentOwner(user.id, process.env)) {
    return {
      error:
        "this is the account that runs the deployment — deleting it would break mindboard for everyone else signed in here. remove the deployment itself instead.",
    };
  }

  let service: ReturnType<typeof createServiceClient>;
  try {
    service = createServiceClient();
  } catch {
    return { error: "account deletion is not configured on this deployment" };
  }

  for (const bucket of USER_STORAGE_BUCKETS) {
    const store = service.storage.from(bucket);
    let paths: string[];
    try {
      paths = await collectObjectPaths(
        async (prefix, offset, limit) => {
          const { data, error } = await store.list(prefix, { offset, limit });
          if (error) throw new Error(error.message);
          return (data ?? []).map((entry) => ({
            name: entry.name,
            id: entry.id ?? null,
          }));
        },
        user.id,
      );
    } catch {
      return {
        error: `could not list your files in ${bucket} — nothing was deleted. try again in a minute.`,
      };
    }

    for (const batch of chunk(paths, REMOVE_BATCH)) {
      const { error } = await store.remove(batch);
      if (error) {
        return {
          error: `could not remove your files in ${bucket} — your account was NOT deleted. try again in a minute.`,
        };
      }
    }
  }

  const { error: deleteError } = await service.auth.admin.deleteUser(user.id);
  if (deleteError) {
    return {
      error:
        "your stored files were removed but the account itself could not be deleted. try again, or ask the operator.",
    };
  }

  // The auth row is gone, so a server-side sign-out has nothing to revoke —
  // clear the cookie locally and never let a failure here swallow the delete.
  try {
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    // ignore: the session is already dead server-side
  }

  redirect("/login");
}
