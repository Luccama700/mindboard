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
  archived: boolean;
  archived_at: string | null;
  last_restocked_at: string | null;
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
