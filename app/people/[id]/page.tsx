import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { createClient } from "@/utils/supabase/server";
import { getUserPreferences } from "@/app/lib/data/settings";
import { safeTimeZone, todayISO } from "@/app/_components/date-utils";
import {
  getCandidates,
  getPeople,
  getPeopleGroups,
  getPerson,
  getPersonInteractions,
} from "@/app/lib/data/people";
import {
  findNote,
  getVaultCorpus,
  VaultConnectionError,
  VaultNotConfiguredError,
  type VaultCorpus,
  type VaultNote,
} from "@/app/lib/brain/vault";
import { extractIntro, extractSectionBullets, noteHref } from "@/app/lib/brain/parse";
import { NoteView } from "@/app/brain/_components/note-view";
import { SectionRuler } from "@/app/_components/ui";
import {
  daysBetweenKeys,
  formatOccurred,
  looseBand,
  mentionBand,
  recencyBand,
} from "@/app/_components/people-recency";
import { CadenceControl } from "./cadence-control";
import { IdentityControl } from "./identity-control";
import { LogControl } from "./log-control";
import { MentionReview } from "./mention-review";

// The dossier (docs/people-plan.md §6): a server-rendered route, not a sheet
// — <NoteView> needs the corpus, whose resolver cannot cross the RSC
// boundary. Only the interactive pieces are client children.
export default async function PersonPage(props: {
  params: Promise<{ id: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { id } = await props.params;
  const person = await getPerson(user.id, id);
  if (!person) notFound();

  const timeZone = safeTimeZone((await getUserPreferences(user.id)).timezone);
  const today = todayISO(timeZone);

  const interactions = await getPersonInteractions(user.id, id);
  const candidates = await getCandidates(user.id, id);

  // A corpus miss and vault_path-is-null are ONE case (§5): the person
  // renders without a note block either way.
  let corpus: VaultCorpus | null = null;
  try {
    corpus = await getVaultCorpus(user.id);
  } catch (error) {
    if (
      !(error instanceof VaultNotConfiguredError) &&
      !(error instanceof VaultConnectionError)
    ) {
      throw error;
    }
  }
  // findNote is case-insensitive — a case-only vault rename must not hide
  // the note here while MCP still resolves it (review finding 10).
  const note: VaultNote | null =
    person.vault_path !== null && corpus
      ? findNote(corpus, person.vault_path)
      : null;

  const intro = note ? extractIntro(note.body) : null;
  const openLoops = note ? extractSectionBullets(note.body, "Open questions") : [];

  const lastTalked = interactions[0] ?? null;
  const daysSince = lastTalked
    ? daysBetweenKeys(lastTalked.occurred_at, today)
    : null;
  const band =
    daysSince === null
      ? null
      : person.checkin_days !== null
        ? recencyBand(daysSince, person.checkin_days)
        : looseBand(daysSince);

  const noteUpdated = note ? ((note.frontmatter.updated as string) ?? null) : null;

  // Connected people link to their dossiers when a row exists, else into
  // the brain note.
  const people = await getPeople(user.id);
  const byPath = new Map(
    people
      .filter((p) => p.vault_path !== null)
      .map((p) => [p.vault_path as string, p.id]),
  );
  const connected = note
    ? [...new Set([...note.backlinks, ...note.outgoing])]
        .filter((path) => path !== note.path && path.startsWith("People/"))
        .map((path) => ({
          path,
          personId: byPath.get(path) ?? null,
          title: corpus?.notes.get(path)?.title ?? null,
        }))
        .filter((c) => c.title !== null)
    : [];

  return (
    <main className="min-h-screen px-5 pt-8 pb-64 max-w-2xl mx-auto">
      <header className="flex items-center justify-between mb-10 pr-10 lg:pr-0">
        <Link
          href="/people"
          className="text-muted text-xs tracking-widest uppercase hover:text-fg transition-colors"
        >
          ← people
        </Link>
        <h1 className="text-xs tracking-widest uppercase text-muted truncate max-w-[50vw]">
          {person.name.toLowerCase()}
        </h1>
      </header>

      <section className="mb-8">
        <p className="text-xl text-fg lowercase">{person.name}</p>
        {intro && <p className="text-body text-muted mt-1">{intro}</p>}
        {band && <p className="text-meta text-muted mt-2">· {band}</p>}
      </section>

      <section className="glass-panel rounded-pop px-4 py-3 mb-8 space-y-2">
        <SignalLine
          label="talked"
          value={
            lastTalked
              ? `${formatOccurred(lastTalked, today)}${
                  lastTalked.summary ? ` · "${lastTalked.summary}"` : ""
                } (${lastTalked.source === "logged" ? "you logged it" : "you confirmed it"})`
              : "nothing logged yet"
          }
        />
        <SignalLine
          label="noted"
          value={noteUpdated ? `note updated ${noteUpdated}` : "no vault note"}
        />
        {(() => {
          // Band, never a tally (§3.1): count feeds the phrasing, not the page.
          const recent = candidates.filter(
            (c) => daysBetweenKeys(c.occurred_at, today) <= 30,
          ).length;
          const band = mentionBand(recent);
          return band ? <SignalLine label="on your mind" value={band} /> : null;
        })()}
        <MentionReview candidates={candidates} today={today} />
      </section>

      {openLoops.length > 0 && (
        <section className="mb-8">
          <SectionRuler label="open loops" />
          <ul className="mt-1 space-y-1">
            {openLoops.map((loop) => (
              <li key={loop} className="text-body text-fg leading-relaxed">
                · {loop}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mb-8" data-tour="person-log">
        <LogControl
          personId={person.id}
          interactions={interactions}
          today={today}
        />
      </section>

      <section className="mb-8 space-y-4">
        <CadenceControl
          personId={person.id}
          checkinDays={person.checkin_days}
          hasInteractions={interactions.length > 0}
          today={today}
        />
        <IdentityControl
          personId={person.id}
          name={person.name}
          aliases={person.aliases}
          snoozedUntil={person.attention_snoozed_until}
          today={today}
          groups={await getPeopleGroups(user.id)}
          groupId={person.group_id}
        />
      </section>

      {note && corpus && (
        <section className="mb-8">
          <SectionRuler label="the note" />
          <div className="mt-3">
            <NoteView note={note} corpus={corpus} />
          </div>
        </section>
      )}

      {connected.length > 0 && (
        <section className="mb-8">
          <SectionRuler label="connected" />
          <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {connected.map((c) =>
              c.personId ? (
                <Link
                  key={c.path}
                  href={`/people/${c.personId}`}
                  className="text-body lowercase text-fg hover:text-accent transition-colors min-h-11 inline-flex items-center"
                >
                  {c.title}
                </Link>
              ) : (
                <Link
                  key={c.path}
                  href={noteHref(c.path)}
                  className="text-body lowercase text-muted hover:text-fg transition-colors min-h-11 inline-flex items-center"
                >
                  {c.title}
                </Link>
              ),
            )}
          </p>
        </section>
      )}
    </main>
  );
}

function SignalLine({ label, value }: { label: string; value: string }) {
  return (
    <p className="flex gap-3 text-body">
      <span className="text-label uppercase text-muted w-24 shrink-0 pt-0.5">
        {label}
      </span>
      <span className="text-fg min-w-0">{value}</span>
    </p>
  );
}
