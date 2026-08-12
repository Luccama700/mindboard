// The onboarding catalog: every tour, every step, all copy. Pure data — the
// engine (onboarding-controller / tour-overlay) renders it. Voice: lowercase,
// first person, the board speaking as the part of your mind that doesn't
// forget. Steps anchor to chrome via [data-tour] stamps, never to data rows;
// a missing/hidden anchor degrades to a centered card.

// localStorage render-guard mirror for completed tours. The version suffix is
// bumped (paired with a completed_tours reset migration) when the tours are
// reworked and everyone should see them again — stale v1 mirrors are ignored.
export const TOURS_MIRROR_KEY = "mb-completed-tours-v2";

export const TOUR_KEYS = [
  "intro",
  "now",
  "week",
  "plan",
  "money",
  "stock",
  "tasks",
  "brain",
  "learn",
  "people",
] as const;

export type TourKey = (typeof TOUR_KEYS)[number];

export function isTourKey(value: unknown): value is TourKey {
  return typeof value === "string" && TOUR_KEYS.includes(value as TourKey);
}

export type TourStep = {
  anchor?: string;
  title: string;
  body: string;
  /** Force the card to the top of the screen (for steps that spotlight the Dock). */
  placement?: "top" | "bottom";
  /** Leave the page interactive so the user can try the highlighted thing. */
  interactive?: boolean;
};

export type IntroCard = {
  glyph: string;
  title: string;
  body: string;
};

// Route -> tour key. Longest-prefix match; /finance/setup and /brain/* fold
// into their section's tour.
const ROUTE_TOURS: [string, TourKey][] = [
  ["/week", "week"],
  ["/plan", "plan"],
  ["/finance", "money"],
  ["/inventory", "stock"],
  ["/tasks", "tasks"],
  ["/brain", "brain"],
  ["/learn", "learn"],
  ["/people", "people"],
];

export function routeTourKey(pathname: string): TourKey | null {
  if (pathname === "/") return "now";
  for (const [prefix, key] of ROUTE_TOURS) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return key;
  }
  return null;
}

export const INTRO_CARDS: IntroCard[] = [
  {
    glyph: "◆",
    title: "hey. i'm your board.",
    body: "i'm the part of your mind that doesn't forget. tasks, money, the stuff on your shelves, half-formed ideas — you drop it, i hold it. quick map, then you're free.",
  },
  {
    glyph: "◆",
    title: "now",
    body: "one scroll of today. due tasks, calendar, whether the money's fine. you'll start most days here.",
  },
  {
    glyph: "▦",
    title: "week",
    body: "seven days at a glance. drag things around until the week looks survivable. on your phone it's the ▦ button up top; on desktop it lives beside the stream.",
  },
  {
    glyph: "◇",
    title: "plan",
    body: "where we talk. i've read this whole board, so you can ask me about your own life. i never change anything without showing you first.",
  },
  {
    glyph: "$",
    title: "money",
    body: "your ledger and a forecast of where the balance is headed. set spending limits, teach me your bills — no bank hookup; you tell me what happened, i do the math.",
  },
  {
    glyph: "▤",
    title: "inventory",
    body: "the shelf. what you have, when you'll run out, and a shopping list that writes and prices itself. milk becomes a plan, not a crisis.",
  },
  {
    glyph: "≡",
    title: "more",
    body: "brain — a notes vault that links like thoughts do — lives right on the rail. ≡ more tucks away your tasks, groups, mindspace and settings.",
  },
  {
    glyph: "▁",
    title: "the bar",
    body: "the most important thing on every screen is the bar at the bottom. tasks, spends, questions — it speaks all three. i'll show you on the next screen.",
  },
  {
    glyph: "⛁",
    title: "i live in your other chats too",
    body: "connect me to claude or chatgpt over mcp and they can read the board, log spends, restock the shelf, file thoughts. paste a bank statement screenshot into claude — it lands in your ledger. you confirm every change.",
  },
  {
    glyph: "✓",
    title: "that's the map.",
    body: "everything else i'll show you in place, the first time you walk in. want the tour of this screen, or just poke around?",
  },
];

export const TOURS: Record<Exclude<TourKey, "intro">, TourStep[]> = {
  now: [
    {
      anchor: "vitals",
      title: "your pulse",
      body: "today's money move, what's left to clear, your free hours, the check-in dots. if something needs you today, it shows here first.",
    },
    {
      anchor: "stream",
      title: "the stream",
      body: "today, in order. tasks mix with calendar events so you see the actual day, not two separate lists.",
    },
    {
      anchor: "calendar-pane",
      title: "the wide view",
      body: "on a big screen the calendar lives here on the right. on your phone it's ▦ week under ≡ more — same thing, more room.",
    },
    {
      anchor: "capture-input",
      title: "the bar. try it.",
      body: "type `buy milk today` and hit enter — watch the chips figure out what you meant. i'll wait.",
      placement: "top",
      interactive: true,
    },
    {
      anchor: "capture-input",
      title: "one bar, three doors",
      body: "i also read `$4.50 coffee` as a spend and `? what should i do` as a question for the copilot. you type like you think; i sort it out. flip the `plan` chip and the bar stays pointed at the copilot until you flip it back.",
      placement: "top",
    },
    {
      anchor: "dock-rail",
      title: "the rail",
      body: "and this is the whole map, from anywhere — money, the shelf, brain. ≡ more holds your tasks, groups and settings. the little ? up top replays any of this.",
      placement: "top",
    },
  ],
  week: [
    {
      anchor: "week-grid",
      title: "seven days, one screen",
      body: "due things sit in the top row, timed things in the grid. the week as it actually is.",
    },
    {
      anchor: "week-grid",
      title: "drag things around",
      body: "on a desktop, grab a task, event, or routine and drop it somewhere better — timed things snap to 15 minutes. moving a routine pins that day only; its usual time is back tomorrow. on your phone, tap a day and edit from the list below.",
    },
    {
      anchor: "week-day-list",
      title: "the day, up close",
      body: "tap any day and its full list shows up here. editable events open right in place, and make event → turns a routine into a real calendar event — name it, and it lands on your google calendar.",
    },
    {
      title: "that's the week",
      body: "shuffle until it looks survivable. the ? up top brings this tour back.",
    },
  ],
  plan: [
    {
      anchor: "plan-thread",
      title: "where we talk",
      body: "ask me about your own life — i've read the whole board. what's due, what's safe to spend, what you're low on, what next week actually looks like.",
    },
    {
      anchor: "plan-input",
      title: "ask me something. try it.",
      body: "try `what does my day look like?` — or anything. i'll answer from your actual data.",
      placement: "top",
      interactive: true,
    },
    {
      anchor: "plan-input",
      title: "i propose, you confirm",
      body: "when you ask me to change something, i show you a proposal card first. nothing on this board moves without your ok.",
      placement: "top",
    },
    {
      title: "one more thing",
      body: "you can reach me from any screen — type `?` before anything in the bottom bar, or flip its `plan` chip. small question? pick a cheaper model up top.",
    },
  ],
  money: [
    {
      anchor: "accounts",
      title: "net worth & accounts",
      body: "your balances live here. update one whenever — i'll work out what happened in between and log it.",
    },
    {
      anchor: "ledger",
      title: "the ledger",
      body: "tap an account and every change is a row you can edit, recategorize, or delete. import a bank statement through the copilot and i skip the duplicates.",
    },
    {
      anchor: "spend-limits",
      title: "the guardrails",
      body: "cap a category — or all spending — by day, week, or month. the bar fills as the ledger does; go over and it turns red.",
    },
    {
      anchor: "recurring",
      title: "the repeating stuff",
      body: "rent, subscriptions, your shifts — they live behind configure. wages can follow your calendar or just land as a fixed amount each month. teach me once and i use them to see the future.",
    },
    {
      anchor: "finance-calendar",
      title: "the forecast",
      body: "each day is your projected end-of-day worth. firm numbers are real history; ~ is my floor estimate of your everyday spend; ≈− is a grocery trip i see coming from your shopping list.",
    },
    {
      anchor: "finance-calendar",
      title: "tap a day",
      body: "tap any day to see why the number is what it is. the slider pins what you expect to spend that day — zero counts.",
    },
    {
      title: "the fast way",
      body: "quickest log there is: `$12 lunch` in the bottom bar, from any screen. enter to review, enter to commit.",
    },
  ],
  stock: [
    {
      anchor: "omnibox",
      title: "the omnibox",
      body: "search and capture, one field. plain text filters the shelf; `+2 milk`, `-1 rice`, `12 eggs` change counts instantly.",
      interactive: true,
    },
    {
      anchor: "shelf",
      title: "the shelf",
      body: "everything you have, grouped. steppers for quick counts. things that run out drop to the bottom quietly — running out is an exit, not an alarm.",
    },
    {
      anchor: "shelf",
      title: "the crystal ball",
      body: "tap an item and teach me how fast you go through it. i'll forecast the run-out day and when to rebuy — milk becomes a plan, not a crisis.",
    },
    {
      anchor: "shopping",
      title: "the shopping list",
      body: "everything worth buying gathers here on its own — out, running low, or pinned. tell me your store and i'll price the list; tell me your shopping day and the money forecast plans for the trip.",
    },
    {
      title: "that's the shelf",
      body: "have-first, always. i only flag things you asked me to watch. the ? up top replays this.",
    },
  ],
  tasks: [
    {
      anchor: "task-groups",
      title: "every list, one place",
      body: "your groups of responsibility — school, work, life, whatever shape yours takes. each gets a color, and a chip up here filters to just that list. lists run soonest-due first.",
    },
    {
      anchor: "task-inbox",
      title: "the inbox",
      body: "tasks you captured without picking a group land here. sort them later — capture first is the whole philosophy.",
    },
    {
      anchor: "task-inbox",
      title: "✦ auto sort",
      body: "when the inbox piles up, one tap on ✦ auto sort and i read each task and file it where it belongs. i tell you exactly what moved; anything i'm unsure about stays put.",
    },
    {
      anchor: "task-manage",
      title: "manage groups",
      body: "rename, recolor, or link a group to one of your google calendars — its events then show up next to its tasks, same color, one timeline.",
    },
    {
      title: "capture from anywhere",
      body: "you never need this page to add a task — the bottom bar works everywhere. this is just where the lists live.",
    },
  ],
  brain: [
    {
      anchor: "brain-notes",
      title: "the vault",
      body: "notes that link to each other like thoughts do. [[double brackets]] connect them, and every note is plain markdown you own.",
    },
    {
      anchor: "brain-graph-link",
      title: "the constellation",
      body: "the graph view draws every note and every link between them. your mind, from above.",
    },
    {
      title: "drop thoughts from anywhere",
      body: "that shower idea, a quote, a link — capture it from claude or your phone and it lands in the inbox here. nothing is ever lost; this page is just where it all connects.",
    },
  ],
  learn: [
    {
      anchor: "courses",
      title: "the study corner",
      body: "each course is a notebook. feed it lecture pdfs and slides; they become clean notes in your brain vault.",
    },
    {
      anchor: "courses",
      title: "the headline act",
      body: "pick a course and i'll turn its sources into a two-host podcast episode you can listen to on a walk. seriously.",
    },
    {
      title: "grounded, always",
      body: "everything i generate cites the actual page it came from. no vibes-based studying.",
    },
  ],
  people: [
    {
      anchor: "people-search",
      title: "the people in your life",
      body: "everyone from your vault's people notes, plus anyone you add right here. type a name — search finds them, and an unknown name becomes an add button.",
      placement: "bottom",
    },
    {
      title: "tap a name for the whole story",
      body: "who they are, the open loops between you, when you last actually talked — pulled from your notes, never typed into a form.",
    },
    {
      title: "one tap when you talk",
      body: "saw them? called them? tap 'talked today' on their page and that's the whole chore. i never guess contact from your notes — only you say you talked.",
    },
    {
      title: "attention is opt-in",
      body: "give someone a check-in rhythm on their page and i'll quietly surface them when it's been too long — one at a time, with the reason, never a guilt list. no rhythm set, no noise.",
    },
  ],
};
