// The what's-new feed: hand-written, user-facing patch notes in the board's
// voice (lowercase, first person). Pure data — the ※ button and panel in the
// onboarding controller render it. Newest first; ids must stay unique because
// the unread dot compares localStorage[NEWS_SEEN_KEY] against NEWS[0].id.

export const NEWS_SEEN_KEY = "mb-news-seen";

export type NewsEntry = {
  id: string;
  date: string;
  title: string;
  items: string[];
};

export const NEWS: NewsEntry[] = [
  {
    id: "2026-07-17-liquid-glass",
    date: "2026-07-17",
    title: "the board turned to glass",
    items: [
      "a full liquid-glass redesign: translucent layered surfaces, specular edges, and a whisper of grain behind everything — every page, both dark and light themes.",
      "the dock floats as a frosted capsule now; chips, buttons, and pickers are pills; sheets and popovers blur what's behind them.",
      "your themes and custom palettes carry over untouched — the glass tints itself from whatever colors you've set.",
      "if your device prefers reduced transparency or motion, everything falls back to calm solid surfaces automatically.",
      "the background grain is yours to tune — settings → appearance has a texture slider, 0% to fully gritty.",
    ],
  },
  {
    id: "2026-07-17-life-agent",
    date: "2026-07-17",
    title: "the agent works your whole board now",
    items: [
      "every task — not just app ideas — gets looked at: if i can research, plan, draft, or prep it, i write my approach into the notes and the row shows ✦ plan ready.",
      "approve it and i do the work web-only: findings land in the notes, the full write-up in your brain vault. i never submit, buy, or send anything — everything's a draft for you.",
      "impatient? tap ✦ run agent now on the tasks page and the pc picks it up within minutes — no waiting for 4am.",
      "pick which models plan and build for you in settings → overnight agent — fable 5 plans and gpt-5.6-sol implements by default, opus 4.8 one tap away.",
    ],
  },
  {
    id: "2026-07-16-overnight-agent",
    date: "2026-07-16",
    title: "i build the board while you sleep",
    items: [
      "drop app ideas into the mindboard group; at 4am i read the codebase and write an implementation plan into the task notes — the row shows ✦ plan ready.",
      "open the task, read the plan, tap approve build. the next night i build it on a branch, run the tests, and leave a preview link in the notes.",
      "i never touch the live app — you review the preview and merge when it's right.",
    ],
  },
  {
    id: "2026-07-14-share-capture",
    date: "2026-07-14",
    title: "share anything to your vault",
    items: [
      "the capture endpoint now takes links and files too — share from any app and it lands in your vault's inbox with a note attached.",
      "files up to ~3 mb travel as-is; a companion note embeds them so they show up in review.",
    ],
  },
  {
    id: "2026-07-14-siri-quick-note",
    date: "2026-07-14",
    title: "quick notes by voice",
    items: [
      "say \"hey siri, quick note\" and whatever you dictate lands in your vault's inbox, word for word — filed and distilled later, on your schedule.",
    ],
  },
  {
    id: "2026-07-09-shelf-shops",
    date: "2026-07-09",
    title: "the shelf learns to shop",
    items: [
      "a shopping list that writes itself — anything out, running low, or pinned gathers in one panel on inventory.",
      "tell me your store and i'll look up prices; set a planned buy amount and i price the whole trip.",
      "set your shopping day and grocery trips land on the money forecast as ≈− lines — groceries stop being a surprise.",
    ],
  },
  {
    id: "2026-07-09-dock-rework",
    date: "2026-07-09",
    title: "the dock grew up",
    items: [
      "the rail now goes everywhere: now · inbox · money · inventory · learn · brain, with ≡ more for week, plans, groups and settings.",
      "manage task groups and spending categories from any screen — they live in a sheet under ≡ more.",
      "flip the `plan` chip on the bar and everything you type goes to the copilot; pick a cheaper model right there.",
    ],
  },
  {
    id: "2026-07-09-spend-limits",
    date: "2026-07-09",
    title: "spending limits",
    items: [
      "cap a category — or all spending — by day, week, or month on the money page.",
      "the bar fills as the ledger does; go over and it turns red.",
    ],
  },
  {
    id: "2026-07-09-auto-sort",
    date: "2026-07-09",
    title: "the inbox sorts itself",
    items: [
      "one tap on ✦ auto sort and i read each inbox task and file it into the right group.",
      "i tell you exactly what moved; anything i'm unsure about stays put.",
    ],
  },
  {
    id: "2026-07-08-fixed-income",
    date: "2026-07-08",
    title: "fixed monthly income",
    items: [
      "an income source can now be a flat amount landing on a set day each month — no calendar or hourly math needed.",
    ],
  },
  {
    id: "2026-07-08-horizon-planning",
    date: "2026-07-08",
    title: "the copilot plans ahead",
    items: [
      "ask the copilot to plan your week — it reads your calendar, tasks, money forecast and shelf days out, in your timezone.",
      "the same wide view is there when you talk to me from claude or chatgpt over mcp.",
    ],
  },
  {
    id: "2026-07-08-v0-4-0",
    date: "2026-07-08",
    title: "v0.4.0 — the board introduces itself",
    items: [
      "a proper landing page, a first-run intro, and per-screen tours — the ? up top replays any of them.",
    ],
  },
  {
    id: "2026-07-08-v0-3-0",
    date: "2026-07-08",
    title: "v0.3.0 — learn",
    items: [
      "courses turn lecture pdfs into clean notes, grounded chat with citations, flashcards, and two-host podcast episodes.",
    ],
  },
];
