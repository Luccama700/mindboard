"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  createPerson,
  restorePerson,
  deletePerson,
  getDeleteImpact,
  snoozePerson,
  proposeGroupSuggestions,
  confirmPeopleProposal,
  rejectPeopleProposal,
} from "@/app/actions/people";
import { PeopleGroupsManager } from "@/app/_components/people-groups-manager";
import { ProposalCard } from "@/app/_components/proposal-card";
import { SectionRuler, INPUT_CLASS } from "@/app/_components/ui";
import type {
  Person,
  PersonGroup,
  RosterEntry,
} from "@/app/_components/people-types";
import {
  daysBetweenKeys,
  recencyBand,
  roughSpan,
} from "@/app/_components/people-recency";
import type { PersonAttention } from "@/app/lib/snapshots/people";

const SORT_KEY = "mb-people-sort";

// The sort preference switches the roster's element tree, so a localStorage
// read in a useState initializer would be a STRUCTURAL hydration mismatch
// (unlike the dock's single-attribute readStoredModel). useSyncExternalStore
// is the sanctioned shape: hydrate from the server snapshot ("az"), flip to
// the stored value in the post-hydration render.
const sortListeners = new Set<() => void>();
function subscribeSort(listener: () => void) {
  sortListeners.add(listener);
  return () => sortListeners.delete(listener);
}
function readSort(): "az" | "group" {
  return localStorage.getItem(SORT_KEY) === "group" ? "group" : "az";
}
function writeSort(mode: "az" | "group") {
  localStorage.setItem(SORT_KEY, mode);
  for (const listener of sortListeners) listener();
}

// The roster's interactive shell only (docs/people-plan.md §8). Rows are
// plain <Link>s to /people/[id]; this component never receives a
// VaultCorpus — the dossier is server-rendered.
export function PeopleClient({
  entries,
  archived,
  vaultConnected,
  today,
  suggestion,
  quieted,
  groups,
}: {
  entries: RosterEntry[];
  archived: Person[];
  vaultConnected: boolean;
  today: string;
  suggestion: PersonAttention | null;
  quieted: { personId: string; name: string }[];
  groups: PersonGroup[];
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [deleteImpact, setDeleteImpact] = useState<number | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const sort = useSyncExternalStore(subscribeSort, readSort, () => "az");
  const [suggestBusy, setSuggestBusy] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [pendingProposal, setPendingProposal] = useState<{
    proposalId: string;
    receipt: string;
  } | null>(null);

  const groupById = useMemo(
    () => new Map(groups.map((g) => [g.id, g])),
    [groups],
  );

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      q === ""
        ? entries
        : entries.filter((entry) => entry.name.toLowerCase().includes(q)),
    [entries, q],
  );
  const exactMatch = entries.some((entry) => entry.name.toLowerCase() === q);
  const offerAdd = q.length >= 2 && !exactMatch;

  async function addPerson() {
    if (busy || q.length < 2) return;
    setBusy(true);
    setError(null);
    const result = await createPerson(query.trim());
    setBusy(false);
    if (result?.error) {
      setError(result.error);
      return;
    }
    setQuery("");
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (offerAdd) void addPerson();
        }}
        data-tour="people-search"
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search or add…"
          aria-label="search people or add a new person"
          autoComplete="off"
          maxLength={80}
          className={INPUT_CLASS}
        />
        {offerAdd && (
          <button
            type="submit"
            disabled={busy}
            className="mt-2 min-h-11 w-full border border-line-strong rounded-full px-3 text-action lowercase text-fg hover:border-accent transition-colors disabled:opacity-40"
          >
            add &quot;{query.trim().toLowerCase()}&quot;
          </button>
        )}
        {error && <p className="mt-2 text-meta text-danger">{error}</p>}
      </form>

      {suggestion && (
        <SuggestionCard suggestion={suggestion} onDismissed={() => router.refresh()} />
      )}

      {/* Suppression says so out loud (§2, §3.7): a nudge quieted by an
          unreviewed mention must never just vanish. */}
      {quieted.length > 0 && (
        <p>
          <Link
            href={`/people/${quieted[0].personId}`}
            className="text-meta text-muted hover:text-fg transition-colors min-h-11 inline-flex items-center"
          >
            quiet for now — a mention of {quieted[0].name.toLowerCase()} hasn&apos;t
            been reviewed ›
          </Link>
        </p>
      )}

      {(groups.length > 0 || entries.length > 3) && (
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2" data-tour="people-sort">
            {(["az", "group"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={sort === mode}
                onClick={() => writeSort(mode)}
                className={`min-h-11 px-3 text-[10px] tracking-widest uppercase border rounded-full transition-colors ${
                  sort === mode
                    ? "bg-accent text-accent-fg border-accent"
                    : "border-line-strong text-muted hover:border-fg hover:text-fg"
                }`}
              >
                {mode === "az" ? "a–z" : "by group"}
              </button>
            ))}
          </div>
          <button
            type="button"
            disabled={suggestBusy || pendingProposal !== null}
            onClick={() => {
              setSuggestBusy(true);
              setSuggestError(null);
              void proposeGroupSuggestions().then((result) => {
                setSuggestBusy(false);
                if (result.error || !result.proposalId || !result.receipt) {
                  setSuggestError(result.error ?? "nothing to suggest");
                  return;
                }
                setPendingProposal({
                  proposalId: result.proposalId,
                  receipt: result.receipt,
                });
              });
            }}
            className="min-h-11 px-3 text-[10px] tracking-widest uppercase border border-line-strong rounded-full text-muted hover:border-fg hover:text-fg transition-colors disabled:opacity-40"
          >
            {suggestBusy ? "reading your notes…" : "✦ suggest groups"}
          </button>
        </div>
      )}
      {suggestError && <p className="text-meta text-danger">{suggestError}</p>}

      {pendingProposal && (
        <ProposalCard
          title="suggested groups"
          confirmLabel="apply"
          pending={suggestBusy}
          error={suggestError}
          onConfirm={() => {
            setSuggestBusy(true);
            void confirmPeopleProposal(pendingProposal.proposalId).then(
              (result) => {
                setSuggestBusy(false);
                if (result.error) {
                  setSuggestError(result.error);
                  return;
                }
                setPendingProposal(null);
                router.refresh();
              },
            );
          }}
          onSkip={() => {
            setSuggestBusy(true);
            void rejectPeopleProposal(pendingProposal.proposalId).then(
              (result) => {
                setSuggestBusy(false);
                // Only forget the proposal once the audit row is resolved —
                // a fire-and-forget skip would strand it as 'proposed' and
                // permanently light the dashboard's pending badge.
                if (result.error) {
                  setSuggestError(result.error);
                  return;
                }
                setPendingProposal(null);
              },
            );
          }}
        >
          <pre className="whitespace-pre-wrap font-mono text-body text-fg">
            {pendingProposal.receipt}
          </pre>
        </ProposalCard>
      )}

      {filtered.length === 0 ? (
        <section className="space-y-1">
          <SectionRuler label="people" count={entries.length} />
          <p className="text-body text-muted py-4">
            {entries.length === 0
              ? vaultConnected
                ? "nobody yet — add someone above."
                : "nobody yet — add someone above, or connect a vault in settings to pull in your people notes."
              : "nobody matches."}
          </p>
        </section>
      ) : sort === "az" || groups.length === 0 ? (
        <section className="space-y-1">
          <SectionRuler label="people" count={entries.length} />
          <ul>
            {filtered.map((entry) => (
              <RosterRow
                key={entry.person?.id ?? entry.vaultPath ?? entry.name}
                entry={entry}
                today={today}
                group={
                  entry.person?.group_id
                    ? (groupById.get(entry.person.group_id) ?? null)
                    : null
                }
              />
            ))}
          </ul>
        </section>
      ) : (
        <GroupedSections
          entries={filtered}
          groups={groups}
          groupById={groupById}
          today={today}
        />
      )}

      {archived.length > 0 && (
        <section>
          <button
            type="button"
            onClick={() => setArchiveOpen((v) => !v)}
            aria-expanded={archiveOpen}
            className="flex min-h-11 w-full items-center justify-between text-label uppercase text-muted hover:text-fg transition-colors"
          >
            <span>not tracking · {archived.length}</span>
            <span aria-hidden>{archiveOpen ? "▾" : "›"}</span>
          </button>
          {archiveError && (
            <p className="mt-1 text-meta text-danger">{archiveError}</p>
          )}
          {archiveOpen && (
            <ul className="mt-1">
              {archived.map((person) => (
                <li
                  key={person.id}
                  className="flex min-h-11 items-center justify-between gap-3 border-b border-line"
                >
                  <span className="text-body text-muted truncate lowercase">
                    {person.name}
                  </span>
                  <span className="flex items-center gap-3 shrink-0">
                    <button
                      type="button"
                      onClick={() => {
                        setArchiveError(null);
                        void restorePerson(person.id).then((result) => {
                          if (result?.error) setArchiveError(result.error);
                          else router.refresh();
                        });
                      }}
                      className="text-label uppercase text-muted hover:text-fg transition-colors min-h-11"
                    >
                      restore
                    </button>
                    {confirmingDelete === person.id ? (
                      <button
                        type="button"
                        onClick={() => {
                          setArchiveError(null);
                          void deletePerson(person.id).then((result) => {
                            if (result?.error) {
                              setArchiveError(result.error);
                              return;
                            }
                            setConfirmingDelete(null);
                            setDeleteImpact(null);
                            router.refresh();
                          });
                        }}
                        className="text-label uppercase text-danger hover:opacity-80 transition-opacity min-h-11"
                      >
                        {/* Names what the cascade destroys (§8, review finding 4). */}
                        {deleteImpact === null
                          ? "confirm — history goes too"
                          : deleteImpact === 0
                            ? "confirm — nothing logged yet"
                            : `confirm — ${deleteImpact} logged ${
                                deleteImpact === 1 ? "conversation goes" : "conversations go"
                              } too`}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmingDelete(person.id);
                          setDeleteImpact(null);
                          void getDeleteImpact(person.id).then((impact) => {
                            if (typeof impact?.interactions === "number") {
                              setDeleteImpact(impact.interactions);
                            }
                          });
                        }}
                        className="text-label uppercase text-muted hover:text-danger transition-colors min-h-11"
                      >
                        delete forever
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section>
        <button
          type="button"
          onClick={() => setGroupsOpen((v) => !v)}
          aria-expanded={groupsOpen}
          className="flex min-h-11 w-full items-center justify-between text-label uppercase text-muted hover:text-fg transition-colors"
        >
          <span>groups{groups.length > 0 ? ` · ${groups.length}` : ""}</span>
          <span aria-hidden>{groupsOpen ? "▾" : "›"}</span>
        </button>
        {groupsOpen && (
          <div className="mt-2">
            <PeopleGroupsManager initial={groups} />
          </div>
        )}
      </section>
    </div>
  );
}

// Grouped roster: sections per group, alphabetical inside, ungrouped people
// in a plain "everyone else" — grouping is optional context, never forced.
function GroupedSections({
  entries,
  groups,
  groupById,
  today,
}: {
  entries: RosterEntry[];
  groups: PersonGroup[];
  groupById: Map<string, PersonGroup>;
  today: string;
}) {
  const byGroup = new Map<string | null, RosterEntry[]>();
  for (const entry of entries) {
    // A group_id not in `groups` (deleted between the page's two fetches)
    // folds into ungrouped rather than silently dropping the person.
    const raw = entry.person?.group_id ?? null;
    const key = raw !== null && groupById.has(raw) ? raw : null;
    const bucket = byGroup.get(key);
    if (bucket) bucket.push(entry);
    else byGroup.set(key, [entry]);
  }
  const ungrouped = byGroup.get(null) ?? [];

  return (
    <>
      {groups.map((group) => {
        const members = byGroup.get(group.id) ?? [];
        if (members.length === 0) return null;
        return (
          <section key={group.id} className="space-y-1">
            <SectionRuler label={group.name.toLowerCase()} count={members.length} />
            <ul>
              {members.map((entry) => (
                <RosterRow
                  key={entry.person?.id ?? entry.vaultPath ?? entry.name}
                  entry={entry}
                  today={today}
                  group={group}
                />
              ))}
            </ul>
          </section>
        );
      })}
      {ungrouped.length > 0 && (
        <section className="space-y-1">
          <SectionRuler label="everyone else" count={ungrouped.length} />
          <ul>
            {ungrouped.map((entry) => (
              <RosterRow
                key={entry.person?.id ?? entry.vaultPath ?? entry.name}
                entry={entry}
                today={today}
                group={
                  entry.person?.group_id
                    ? (groupById.get(entry.person.group_id) ?? null)
                    : null
                }
              />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

// At most ONE, dismissible, never red (§3.8, §8). "not now" persists via
// attention_snoozed_until so the dismissal holds across reloads and devices.
function SuggestionCard({
  suggestion,
  onDismissed,
}: {
  suggestion: PersonAttention;
  onDismissed: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loop = suggestion.openLoops[0] ?? null;

  return (
    <section
      className="glass-panel rounded-pop px-4 py-3 space-y-2"
      data-tour="people-suggestion"
    >
      <p className="text-label uppercase text-muted">✎ worth a message</p>
      <p className="text-body text-fg">
        {suggestion.name.toLowerCase()} · {roughSpan(suggestion.daysSinceTalked)}
        {loop ? ` · ${loop}` : ""}
      </p>
      <div className="flex items-center gap-2">
        <Link
          href={`/people/${suggestion.personId}`}
          className="inline-flex items-center min-h-11 px-4 text-action lowercase border rounded-full border-hairline text-fg hover:border-accent transition-colors"
        >
          open
        </Link>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            void snoozePerson(suggestion.personId).then((result) => {
              if (result?.error) {
                setError(result.error);
                setBusy(false);
                return;
              }
              onDismissed();
            });
          }}
          className="inline-flex items-center min-h-11 px-4 text-action lowercase text-muted hover:text-fg transition-colors disabled:opacity-40"
        >
          not now
        </button>
      </div>
      {error && <p className="text-meta text-danger">{error}</p>}
    </section>
  );
}

function RosterRow({
  entry,
  today,
  group,
}: {
  entry: RosterEntry;
  today: string;
  group: PersonGroup | null;
}) {
  // The recency chip appears ONLY for people with a cadence — attention is
  // opt-in on the list, everyone else is just a name (§8).
  const band =
    entry.person?.checkin_days != null && entry.lastTalked
      ? recencyBand(
          daysBetweenKeys(entry.lastTalked.occurred_at, today),
          entry.person.checkin_days,
        )
      : null;

  // Group color rides the left edge — the stream-card convention. User-data
  // colors come from inline style, never theme tokens.
  const edge = group
    ? {
        className: "border-l-2 pl-2",
        style: { borderLeftColor: group.color } as React.CSSProperties,
      }
    : { className: "", style: undefined };

  const row = (
    <>
      <span className="flex min-w-0 items-baseline gap-3">
        <span className="text-body text-fg lowercase shrink-0">{entry.name}</span>
        {entry.intro && (
          <span className="text-meta text-muted truncate">{entry.intro}</span>
        )}
      </span>
      {band && <span className="text-meta text-muted shrink-0">{band}</span>}
    </>
  );

  if (!entry.person) {
    // An eligible vault note the after() sync hasn't backfilled yet renders
    // read-only — no id, so no dossier route to link to yet (§5).
    return (
      <li
        className={`flex min-h-11 items-center justify-between gap-3 border-b border-line opacity-70 ${edge.className}`}
        style={edge.style}
        title="syncing from your vault — open again in a moment"
      >
        {row}
      </li>
    );
  }

  return (
    <li className={edge.className} style={edge.style}>
      <Link
        href={`/people/${entry.person.id}`}
        className="flex min-h-11 items-center justify-between gap-3 border-b border-line hover:text-accent transition-colors"
      >
        {row}
      </Link>
    </li>
  );
}
