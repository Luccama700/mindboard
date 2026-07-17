import type { ButtonHTMLAttributes } from "react";

// SIGNAL primitives — the app's single button recipe and single input recipe.
// Every surface consumes these (or their class strings) instead of re-spelling
// Tailwind; visual drift between sections is a bug, not a style choice.

type ButtonVariant = "outline" | "accent" | "quiet" | "danger";

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-1.5 min-h-11 px-4 text-action lowercase border rounded-full transition-[color,background-color,border-color,transform,opacity] duration-150 active:scale-[.98] disabled:opacity-50 disabled:pointer-events-none";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  outline:
    "border-(--glass-border) bg-glass-panel text-fg hover:border-line-strong hover:bg-card-hover",
  accent:
    "border-accent bg-accent text-accent-fg shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] hover:opacity-90",
  quiet: "border-transparent text-muted hover:text-fg",
  danger: "border-(--glass-border) bg-glass-panel text-danger hover:border-danger",
};

export function buttonClass(variant: ButtonVariant = "outline"): string {
  return `${BUTTON_BASE} ${BUTTON_VARIANTS[variant]}`;
}

export function Button({
  variant = "outline",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      type="button"
      {...props}
      className={`${buttonClass(variant)}${className ? ` ${className}` : ""}`}
    />
  );
}

// The input recipe (the capture field's): recessed glass well, hairline
// border, accent focus ring — the app's one text-entry look.
export const INPUT_CLASS =
  "w-full min-w-0 bg-glass-well rounded-field border border-line-strong focus:border-accent text-fg placeholder-muted text-body px-3 py-2 focus:outline-none transition-colors font-mono";

export function SectionRuler({
  label,
  count,
}: {
  label: string;
  count?: number;
}) {
  return (
    <div className="flex items-center gap-2 text-label uppercase text-muted select-none">
      <span>{label}</span>
      <span className="flex-1 border-t border-hairline" aria-hidden />
      {count !== undefined && <span>{count}</span>}
    </div>
  );
}
