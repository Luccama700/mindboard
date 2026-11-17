"use client";

import type { CSSProperties } from "react";

import { identityTokens } from "@/app/lib/v2/view/appearance";
import type { Titled } from "@/app/lib/v2/view/today";
import { useAppearance } from "./appearance-root";

/**
 * One row of a side list: what did not fit today, or what is past its date.
 *
 * STACKED, NOT A TABLE. Side by side in a 340px column the title got about
 * 110px and wrapped into fifteen lines, so the title owns the full width and one
 * quiet line sits under it: what it belongs to at the left, when or why at the
 * right. Opposite ends of the line separate them; there is no dot or dash
 * between, because a separator glyph is a decoration pretending to be grammar.
 *
 * The title is clamped to two lines and the detail to two, with the whole
 * original string on both as a `title` attribute, so clamping hides nothing a
 * hover cannot recover.
 */
export function ListRow({
  entry,
  identity,
  meta,
}: {
  entry: Titled;
  /** The group or lane this belongs to, or null when it has none. */
  identity: { label: string; color: string } | null;
  /** The right hand end of the quiet line: a date, or a reason. */
  meta: string;
}) {
  const { tokens } = useAppearance();

  return (
    <div
      className="v2-row"
      style={identityTokens(identity?.color ?? null, tokens) as CSSProperties}
    >
      <b className="v2-row-title" title={entry.full}>
        {entry.title}
      </b>
      {entry.detail !== null && (
        <p className="v2-detail" title={entry.full}>
          {entry.detail}
        </p>
      )}
      <p className="v2-row-meta">
        {identity !== null && <span className="v2-row-ident">{identity.label}</span>}
        <span className="v2-row-reason">{meta}</span>
      </p>
    </div>
  );
}
