// Seed-candidate builder: the vault's entity pages (People/Projects/Areas/
// Topics) and the active task groups ARE the user's concern taxonomy — no
// inference needed. Duplicate names merge into one candidate carrying both
// provenance refs. Pure and unit-tested.

import type { TopicKind } from "@/app/lib/mindspace/types";

export type SeedNote = {
  path: string;
  folder: string;
  title: string;
  backlinkCount: number;
};

export type SeedGroup = {
  id: string;
  name: string;
  type: "course" | "project" | "work" | "personal";
  color: string;
};

export type SeedCandidate = {
  name: string;
  kind: TopicKind;
  vaultPath: string | null;
  groupId: string | null;
  color: string | null;
  defaultSelected: boolean;
};

const FOLDER_KINDS: Record<string, TopicKind> = {
  People: "person",
  Projects: "project",
  Areas: "area",
  Topics: "area",
};

const GROUP_KINDS: Record<SeedGroup["type"], TopicKind> = {
  course: "course",
  project: "project",
  work: "work",
  personal: "area",
};

export function buildSeedCandidates(
  notes: SeedNote[],
  groups: SeedGroup[],
): SeedCandidate[] {
  const byKey = new Map<string, SeedCandidate>();

  for (const note of notes) {
    const kind = FOLDER_KINDS[note.folder];
    if (!kind) continue;
    // A person page nothing links to yet is usually a stub — listed, unchecked.
    const defaultSelected = kind !== "person" || note.backlinkCount > 0;
    byKey.set(note.title.toLowerCase(), {
      name: note.title,
      kind,
      vaultPath: note.path,
      groupId: null,
      color: null,
      defaultSelected,
    });
  }

  for (const group of groups) {
    const key = group.name.toLowerCase();
    const existing = byKey.get(key);
    if (existing) {
      existing.groupId = group.id;
      existing.color = group.color;
      existing.defaultSelected = true;
      // A group's own type wins over the vault folder's guess for work/course.
      const groupKind = GROUP_KINDS[group.type];
      if (groupKind === "work" || groupKind === "course") {
        existing.kind = groupKind;
      }
    } else {
      byKey.set(key, {
        name: group.name,
        kind: GROUP_KINDS[group.type],
        vaultPath: null,
        groupId: group.id,
        color: group.color,
        defaultSelected: true,
      });
    }
  }

  const kindOrder: TopicKind[] = [
    "person",
    "project",
    "work",
    "course",
    "area",
    "emergent",
  ];
  return [...byKey.values()].sort((a, b) => {
    const ka = kindOrder.indexOf(a.kind);
    const kb = kindOrder.indexOf(b.kind);
    if (ka !== kb) return ka - kb;
    return a.name.localeCompare(b.name);
  });
}
