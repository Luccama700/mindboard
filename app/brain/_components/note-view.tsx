import Link from "next/link";
import { Children, cloneElement, isValidElement } from "react";
import type { ReactNode } from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Element, ElementContent } from "hast";

import {
  CALLOUT_MARKER_STRIP_RE,
  noteHref,
  parseCalloutMarker,
  rewriteWikilinks,
  type CalloutMarker,
} from "@/app/lib/brain/parse";
import type { VaultCorpus, VaultNote } from "@/app/lib/brain/vault";
import { Callout } from "./callout";

const FRONTMATTER_KEYS = ["type", "created", "updated", "status"];

function firstTextOfBlockquote(node: Element | undefined): string | null {
  if (!node) return null;
  const paragraph = node.children.find(
    (child): child is Element =>
      child.type === "element" && child.tagName === "p",
  );
  if (!paragraph) return null;
  const text = paragraph.children.find(
    (child: ElementContent) => child.type === "text",
  );
  return text && text.type === "text" ? text.value : null;
}

function stripCalloutMarker(children: ReactNode): ReactNode {
  let stripped = false;
  return Children.map(children, (child) => {
    if (stripped || !isValidElement(child)) return child;
    const inner = (child.props as { children?: ReactNode }).children;
    const parts = Children.toArray(inner);
    const first = parts[0];
    if (typeof first !== "string" || !CALLOUT_MARKER_STRIP_RE.test(first)) {
      return child;
    }
    stripped = true;
    const replaced = first.replace(CALLOUT_MARKER_STRIP_RE, "");
    const nextParts = replaced ? [replaced, ...parts.slice(1)] : parts.slice(1);
    if (nextParts.length === 0) return null;
    return cloneElement(child, undefined, ...nextParts);
  });
}

function MarkdownLink({
  href,
  children,
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & ExtraProps) {
  if (href === "#unresolved") {
    return <span className="text-muted">{children}</span>;
  }
  if (href?.startsWith("/")) {
    return (
      <Link href={href} className="text-accent underline underline-offset-4">
        {children}
      </Link>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-accent underline underline-offset-4"
    >
      {children}
    </a>
  );
}

function MarkdownBlockquote({
  children,
  ...rest
}: React.BlockquoteHTMLAttributes<HTMLQuoteElement> & ExtraProps) {
  const { node } = rest;
  const text = firstTextOfBlockquote(node);
  const marker: CalloutMarker | null = text ? parseCalloutMarker(text) : null;
  if (marker) {
    return (
      <Callout kind={marker.kind} title={marker.title}>
        {stripCalloutMarker(children)}
      </Callout>
    );
  }
  return (
    <blockquote className="border-l-2 border-line-strong pl-4 my-4 text-muted">
      {children}
    </blockquote>
  );
}

const markdownComponents: Components = {
  a: MarkdownLink,
  blockquote: MarkdownBlockquote,
  h1: ({ children }) => (
    <h1 className="text-lg font-semibold mt-8 mb-4 first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-xs tracking-widest uppercase text-muted mt-8 mb-3">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-sm font-semibold mt-6 mb-2">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="text-sm font-semibold text-muted mt-4 mb-2">{children}</h4>
  ),
  p: ({ children }) => <p className="text-sm leading-relaxed my-3">{children}</p>,
  ul: ({ children }) => (
    <ul className="list-disc pl-5 my-3 space-y-1.5 text-sm leading-relaxed">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal pl-5 my-3 space-y-1.5 text-sm leading-relaxed">
      {children}
    </ol>
  ),
  hr: () => <hr className="border-line my-6" />,
  code: ({ children, className }) => (
    <code className={`bg-card rounded-md px-1 py-0.5 text-[0.85em] ${className ?? ""}`}>
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="glass-panel rounded-xl p-3 my-4 overflow-x-auto text-xs leading-relaxed">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto my-4">
      <table className="text-sm border-collapse w-full">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-line px-2 py-1 text-left text-xs tracking-widest uppercase text-muted">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-line px-2 py-1 align-top">{children}</td>
  ),
};

export function NoteView({
  note,
  corpus,
}: {
  note: VaultNote;
  corpus: VaultCorpus;
}) {
  const markdown = rewriteWikilinks(note.body, corpus.resolve);
  const metaEntries = [
    ...FRONTMATTER_KEYS.filter((key) => note.frontmatter[key]).map(
      (key) => [key, note.frontmatter[key]] as const,
    ),
    ...Object.entries(note.frontmatter).filter(
      ([key]) => !FRONTMATTER_KEYS.includes(key),
    ),
  ];

  return (
    <article>
      {metaEntries.length > 0 && (
        <dl className="flex flex-wrap gap-x-5 gap-y-1 mb-6 glass-panel px-4 py-3">
          {metaEntries.map(([key, value]) => (
            <div key={key} className="flex items-baseline gap-2">
              <dt className="text-[10px] tracking-widest uppercase text-muted">
                {key}
              </dt>
              <dd className="text-xs">{value}</dd>
            </div>
          ))}
        </dl>
      )}

      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={markdownComponents}
      >
        {markdown}
      </ReactMarkdown>

      {note.backlinks.length > 0 && (
        <section className="mt-10 border-t border-line pt-4">
          <h2 className="text-xs tracking-widest uppercase text-muted mb-3">
            backlinks
          </h2>
          <ul className="space-y-1">
            {note.backlinks.map((path) => {
              const source = corpus.notes.get(path);
              return (
                <li key={path}>
                  <Link
                    href={noteHref(path)}
                    className="flex items-center gap-2 min-h-11 text-sm text-accent hover:underline underline-offset-4"
                  >
                    <span className="text-muted">←</span>
                    {source?.title ?? path}
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </article>
  );
}
