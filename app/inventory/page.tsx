import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/utils/supabase/server";
import type {
  InventoryGroup,
  InventoryItem,
  InventoryUsage,
} from "@/app/_components/inventory-types";
import { InventoryClient } from "./inventory-client";

// Image generation calls an external provider; allow more than the 10s default.
export const maxDuration = 60;

export default async function InventoryPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const [groupsResult, itemsResult, usagesResult] = await Promise.all([
    supabase
      .from("inventory_groups")
      .select("id, name, color, created_at")
      .order("created_at", { ascending: false }),
    supabase
      .from("inventory_items")
      .select(
        "id, name, quantity, unit, notes, image_url, inventory_group_id, reorder_threshold, priority, archived, archived_at, last_restocked_at, created_at",
      )
      .order("created_at", { ascending: true }),
    supabase
      .from("inventory_usages")
      .select("id, inventory_item_id, amount, period, interval_days, created_at")
      .order("created_at", { ascending: true }),
  ]);

  return (
    <main className="min-h-screen px-5 pt-8 pb-64 lg:px-12">
      <header className="flex items-center justify-between mb-10 pr-10 lg:pr-0">
        <Link
          href="/"
          className="text-muted text-xs tracking-widest uppercase hover:text-fg transition-colors"
        >
          ← mindboard
        </Link>
        <h1 className="text-xs tracking-widest uppercase text-muted">
          inventory
        </h1>
      </header>

      <InventoryClient
        userId={user.id}
        initialGroups={(groupsResult.data ?? []) as InventoryGroup[]}
        initialItems={(itemsResult.data ?? []) as InventoryItem[]}
        initialUsages={(usagesResult.data ?? []) as InventoryUsage[]}
      />
    </main>
  );
}
