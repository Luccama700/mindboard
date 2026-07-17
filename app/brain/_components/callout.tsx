import type { ReactNode } from "react";

const KIND_STYLES: Record<string, string> = {
  warning: "border-danger text-danger",
  danger: "border-danger text-danger",
  error: "border-danger text-danger",
  bug: "border-danger text-danger",
  tip: "border-accent",
  success: "border-accent",
  note: "border-line-strong",
  info: "border-line-strong",
  quote: "border-line-strong",
};

export function Callout({
  kind,
  title,
  children,
}: {
  kind: string;
  title: string;
  children: ReactNode;
}) {
  const style = KIND_STYLES[kind] ?? "border-line-strong";
  return (
    <aside className={`border-l-4 ${style} bg-card rounded-r-xl px-4 py-3 my-4`}>
      <p className="text-xs tracking-widest uppercase mb-1">
        {kind}
        {title ? ` · ${title}` : ""}
      </p>
      <div className="text-fg text-sm space-y-2">{children}</div>
    </aside>
  );
}
