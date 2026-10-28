# Mission: Mindboard — Liquid Glass

You are running a **full visual redesign** of Mindboard on the `liquid-glass`
branch (this worktree). The owner wants the app reimagined in the **Apple
Liquid Glass** aesthetic — translucent, refractive, layered glass surfaces
with specular highlights — as a newer, sleeker version of the product.

Read `AGENTS.md` first for the product and engineering context. Everything
there holds EXCEPT where this brief explicitly overrides it.

## The look

Reference: https://github.com/rdev/liquid-glass-react — study its README,
props, and visuals until you can articulate what makes the effect work
(refraction/displacement, blur layering, elasticity, specular edge light,
depth from stacked translucency). That library is the *aesthetic reference*;
whether you actually install it is your call, with one hard fact dominating
the decision:

> **Mindboard's primary surface is an installed PWA on iPhone Safari.**
> liquid-glass-react's README admits the displacement effect doesn't fully
> render in Safari/Firefox. A redesign whose signature effect is invisible on
> the primary device is a failure. Hand-rolled glass (backdrop-filter blur +
> saturation, layered translucent surfaces, gradient specular edges, subtle
> SVG noise/displacement where supported, graceful degradation) tuned for
> Safari is very likely the right implementation; use the library only where
> it genuinely works on target devices.

Design the glass system in both a dark and a light variant (the app has a
theme system — you may replace Terminal Calm's flat tokens with glass tokens
on this branch, keeping the CSS-variable architecture in `globals.css` +
`themes.ts`). User-data colors (group colors, calendar colors) remain inline
styles and must read well through glass.

## Skills at your disposal

The owner installed design/UI skills for you — use them deliberately:
`ui-ux-pro-max` (styles/palettes/font pairings/UX guidelines),
`design-system` (token architecture), `ui-styling`, `design`,
`web-design-guidelines` (accessibility/quality audit). Run the audit skill
against your work before calling a page done.

## Scope — every page

Inventory to redesign (visual only — behavior, data flow, and server logic
must NOT change): `/` (stream + week pane + vitals), the Dock (capture bar +
nav rail — the single most important surface; it must stay fast, reachable,
and 44px-target compliant), `/tasks` (+ groups/recurring sections),
`/week`, `/finance` (all sections + forecast calendar), `/inventory`
(+ shopping panel + item detail), `/learn` (+ `[id]/chat` + `[id]/study`),
`/brain` (+ graph + note views), `/plan`, `/settings` (all cards),
`/login` + the get-started screen, and the onboarding chrome (tours,
what's-new panel, proposal cards).

## Process — plan first, thoroughly

1. Study the reference repo and the current app (run `npm ci`, then
   `npm run dev`; browse the code per page).
2. Write `REDESIGN_PLAN.md` at the repo root: the glass design language
   (tokens, elevation/blur scale, motion), the component kit you'll build
   (e.g. GlassSurface, GlassChip, GlassSheet), a per-page migration list in
   order, Safari performance strategy (backdrop-filter is expensive — budget
   it), and accessibility strategy (contrast through translucency; respect
   prefers-reduced-motion and prefers-reduced-transparency).
3. Build the kit, then migrate page by page. Commit and push after each
   coherent milestone — every push gets a Vercel preview build the owner
   tests on his phone.
4. Gates before every push: `npm run lint`, `npm run test`, `npm run build`.
   All 756 tests must stay green — if a test fails, your change leaked out
   of the visual layer.

## Hard rules

- Work ONLY on the `liquid-glass` branch in this worktree. Never push to
  `main`. Never force-push.
- No behavior/data/schema changes; no new server surface. Dependency rule:
  AGENTS.md's no-UI-library stance is waived *only* for the glass effect
  itself if you determine a library beats hand-rolling on Safari — justify
  the call in REDESIGN_PLAN.md either way.
- Do not touch `overnight/`, `worker/`, `supabase/migrations/`, or
  `.claude/` — they're out of a visual redesign's scope.
- Keep the capture dock's speed and reachability sacred: it is the app's
  most important UX constraint.
