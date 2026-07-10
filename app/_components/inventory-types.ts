export type InventoryGroup = {
  id: string;
  name: string;
  color: string;
  created_at: string;
};

export type InventoryItem = {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  notes: string | null;
  image_url: string | null;
  inventory_group_id: string | null;
  reorder_threshold: number | null;
  priority: "low" | "med" | "high";
  archived: boolean;
  archived_at: string | null;
  last_restocked_at: string | null;
  shopping_pinned: boolean;
  buy_amount: number | null;
  est_price: number | null;
  price_source: "ai" | "manual" | null;
  price_checked_at: string | null;
  created_at: string;
};

export type InventoryUsage = {
  id: string;
  inventory_item_id: string;
  amount: number;
  period: "day" | "week" | "custom";
  interval_days: number | null;
  created_at: string;
};
