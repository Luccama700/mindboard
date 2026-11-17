# Mindboard — Liquid Glass Redesign Plan

Branch: `liquid-glass`. Visual-only redesign: behavior, data flow, server logic,
DOM semantics, and test-observable structure must not change.

## 1. The call: hand-rolled glass, no library

`rdev/liquid-glass-react` was studied as the aesthetic reference. Its effect is
built from five layers: refraction/displacement (mouse-tracked warp), backdrop
blur + saturation, specular edge light, chromatic aberration, and elastic
motion. Its README admits **the displacement layer does not render in
Safari/Firefox** — and Mindboard's primary surface is an installed PWA on
iPhone Safari. Installing it would mean:

- the signature effect silently missing on the primary device,
- one mouse-tracking React component per surface (we have hundreds of surfaces),
- a WebGL/"shader" mode the README itself calls unstable.

**Decision: do not install it.** We hand-roll the four layers that *do* work
everywhere, tuned for Safari:

| Reference layer | Our implementation |
|---|---|
| Backdrop blur + saturation | `backdrop-filter: blur() saturate()` (+ `-webkit-` prefix), budgeted to chrome surfaces only |
| Refraction / displacement | Approximated statically: an ambient aura background that translucent surfaces visibly tint/shift, plus curved specular edges (inset gradient highlights) that read as light bending at the rim |
| Specular edge light | 1px inner top highlight (`inset 0 1px 0 rgba(255,255,255,…)`) + gradient hairline border, brighter on top/left like a lit rim |
| Depth from stacked translucency | Three-tier elevation scale (panel → chrome → popover), each tier more opaque + more blurred + larger shadow |
| Elasticity | Transform/opacity-only spring-feel entrances (`cubic-bezier(0.16,1,0.3,1)`), press scale `0.97`, never animating filters |

## 2. Glass design language

### Ambient backdrop (what the glass refracts)

Glass over a flat `#0d0d0d` page is invisible. A fixed, non-scrolling ambient
layer (`body::before`, `position: fixed`, `z-index: -1` — **not**
`background-attachment: fixed`, which iOS Safari doesn't composite) carries
2–3 large radial auras derived from the live theme tokens via `color-mix`
(accent + a cool counter-hue over a vertical base gradient). It is static —
zero scroll cost — and recolors automatically with theme flips and palette
overrides because it only references vars.

### Token architecture (globals.css — derived, never hard-coded)

The 14-key `Palette` contract in `themes.ts`, the 6 themes, the localStorage
override mechanism, and the settings color editor are **unchanged**. All glass
tokens derive from existing palette vars so user overrides keep working:

```css
--glass-panel:  color-mix(in srgb, var(--bg-card) 72%, transparent);
--glass-chrome: color-mix(in srgb, var(--bg-popover) 78%, transparent);
--glass-pop:    color-mix(in srgb, var(--bg-popover) 86%, transparent);
--glass-border: color-mix(in srgb, var(--fg) 14%, transparent);
--glass-specular: rgba(255,255,255,.10);   /* light themes: .55 */
--glass-shadow: rgba(0,0,0,.45);           /* light themes: .18 */
--aura-a / --aura-b: color-mix auras from --accent / counter-hue;
```

`--glass-specular`/`--glass-shadow`/aura hues get per-theme overrides inside
the existing `html.theme-*` blocks (CSS-only; the `Palette` type is untouched).

### Elevation / blur scale (the Safari budget)

| Tier | Class | backdrop-filter | Fill | Use |
|---|---|---|---|---|
| 0 — page | — | none | ambient backdrop | page background |
| 1 — panel | `.glass-panel` | **none** | `--glass-panel` + specular edge | cards, sections, list rows-groups |
| 2 — chrome | `.glass` | `blur(20px) saturate(160%)` | `--glass-chrome` | dock, sticky asides, bottom sheets, onboarding cluster |
| 3 — popover | `.glass-pop` | `blur(24px) saturate(180%)` | `--glass-pop` | dropdowns, anchored popovers, tour cards |
| scrim | `.glass-scrim` | `blur(6px)` | `rgba(0,0,0,.35)` | sheet/modal backdrops |

**Why tier 1 skips backdrop-filter:** in-flow cards never have content
scrolling beneath them — only the static ambient gradient — so a translucent
fill composites to the identical pixels for free. Blur is reserved for
surfaces that float over scrolling content. Live blur budget on any screen:
dock (1) + at most one open popover/sheet (1–2) + onboarding cluster (1) ≈ 3–4
regions, no nesting of tier-2/3 inside tier-2 (dock popovers render glass, but
they're transient). Never animate `backdrop-filter` — entrances animate
transform/opacity only.

### Shape

The single biggest visible shift from Terminal Calm's square terminal look:

- Cards/panels: `rounded-2xl` (16px) — `--radius-panel`
- Chips/buttons: capsule `rounded-full` — the Apple pill
- Inputs: `rounded-xl`
- Popovers: `rounded-2xl`; bottom sheets: `rounded-t-[28px]`
- Dock: floating capsule `rounded-[26px]`, lifted off the edges

### Typography & color voice

Geist Mono stays — it is Mindboard's brand voice and the type scale
(`text-display/title/body/action/meta/label`) is already tokenized and tuned.
Glass changes the surfaces, not the voice. Accent stays per-theme. User-data
colors (group/calendar/category, inline `style`) keep reading through glass:
swatch dots and event blocks stay fully opaque so hues aren't washed out.

### Motion

Keep `--ease-signal` + `--dur-*`. Add `--ease-glass: cubic-bezier(0.16,1,0.3,1)`
for entrances: popovers/sheets scale-fade in from `0.97/translateY(8px)`;
pressables get `active:scale-[.98]`. The existing global
`prefers-reduced-motion` freeze already covers all of it.

## 3. Component kit

Small CSS-class kit in `globals.css` (+ helpers in `ui.tsx`), replacing the
copy-pasted recipes found in the inventory:

- `.glass-panel`, `.glass`, `.glass-pop`, `.glass-scrim` — elevation tiers
- `.glass-chip` — capsule chip base (the ~10× copy-pasted chip recipe); active
  state stays `bg-accent text-accent-fg`, now with a soft accent glow
- `ui.tsx`: `Button` variants re-skinned (capsule, glass outline, accent gets
  subtle top specular), `INPUT_CLASS` → rounded glass well with focus ring
- `Sheet` (stream-sheets.tsx) → tier-2 glass with grab handle; the one shared
  sheet primitive all sheets already use
- Popover recipe (`border-line bg-popover shadow-[0_0_28px…]`) → `.glass-pop`
  everywhere it was inlined (dock, stream, onboarding, whats-new)

Accessibility invariants baked into the kit:

- Text sits only on ≥72%-opacity fills; muted-on-glass checked ≥4.5:1 per theme
- `@supports not (backdrop-filter…)` → tiers 2/3 fall back to opaque `--bg-popover`
- `@media (prefers-reduced-transparency: reduce)` → all glass goes opaque, auras off
- `@media (prefers-reduced-motion)` — already globally handled
- Focus visible: 2px accent ring offset from glass surfaces
- 44px touch targets everywhere (already `min-h-11` convention — preserved)

## 4. Per-page migration order

Each milestone ends with `npm run lint && npm run test && npm run build`,
commit, push (Vercel preview). 756 tests stay green — class-level changes
only; DOM structure, text, roles, and handlers untouched.

1. **Foundation** — globals.css glass tokens + ambient backdrop + kit classes,
   `ui.tsx` re-skin, radius tokens. (Whole app inherits a first pass of glass
   via the token indirection.)
2. **Dock** (`dock.tsx`, `dock-mount.tsx`) — floating glass capsule, glass
   popovers (more-nav, groups sheet, repeat editor, group picker), capsule
   chips. Speed/reachability sacred: same geometry, same collapse behavior,
   44px targets.
3. **Dashboard** — `page.tsx` skeletons, `stream-client.tsx` (rows, steppers,
   dropdowns), `stream-sheets.tsx`, `task-row.tsx`, section rulers.
4. **Tasks + Week** — `tasks/page.tsx` chips + disclosures, `tasks-client`,
   `groups-client`, `recurring-client`, `week/page`, `dashboard-calendar.tsx`,
   `week-view.tsx` (glass grid chrome; event blocks stay opaque user-color),
   `event-edit-panel.tsx`.
5. **Finance** — `finance-client`, `accounts-section` (ledger, history),
   `finance-calendar`, income/recurring/limits/categories sections, setup flow.
6. **Inventory** — `inventory-client` (shelf grid, detail panel, shopping
   aside, selection toolbar), `inventory-calendar`, `unit-picker`.
7. **Learn** — `learn-client` course cards, `[id]/chat` (bubbles + composer),
   `[id]/study` (flashcards).
8. **Brain + Plan** — folder listing, note view, graph chrome, `plan-client`
   copilot + `proposal-card` (glass ghost w/ dashed inner edge).
9. **Settings + Login + Landing + Onboarding** — settings cards,
   `connection-card`, theme picker (add glass-aware swatch preview), login,
   landing scenes (keep CRT identity, glass the CTA/cards), `tour-overlay`,
   `intro-carousel`, `whats-new-panel`, `onboarding-controller`.
10. **Audit** — `web-design-guidelines` skill pass, contrast verification per
    theme, straggler sweep (`rg` for old recipes), whats-new entry + tour copy
    per AGENTS.md, final gates.

## 5. Safari performance strategy (recap)

- Ambient layer: one fixed element, static gradients, no repaint on scroll.
- backdrop-filter only on tiers 2/3 (~3–4 live regions max); tier-1 cards are
  plain alpha fills (free).
- `-webkit-backdrop-filter` alongside every unprefixed use.
- No nested blur regions; no `filter` animations; transform/opacity motion only.
- No `background-attachment: fixed`; no full-page `overflow` wrappers that
  break iOS momentum scroll or `sticky`.
- Shadows: two soft box-shadows max per surface; no layered drop-shadow filters.
- `will-change` only on the dock (persistent) — transient popovers don't need it.

## 6. Risks / invariants

- **Palette editor contract**: only derived vars added; `Palette` type, VAR_MAP,
  PALETTE_GROUPS untouched.
- **Tests (756)**: no text/role/structure changes. Wrapper divs avoided where
  tests traverse children (task-row, brain note view).
- **`pb-64` dock clearance** and dock geometry preserved exactly.
- **Landing CRT scenes**: kept (they're brand), only re-surfaced.
- **Out of scope**: `overnight/`, `worker/`, `supabase/migrations/`, `.claude/`.
