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
  created_at: string;
};
