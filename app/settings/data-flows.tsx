// settings → where your data goes (audit finding M9: "nothing tells other
// tenants what flows to Anthropic, OpenAI, Gemini and Google").
//
// Written from the code, not from memory. Every provider call in the app
// takes the key out of YOUR user_settings row (app/lib/connections/keys.ts) —
// there is no server-wide ANTHROPIC_API_KEY — so a provider you have not
// connected is never called at all. Keep this list honest when a feature
// adds a call: rg for the SDK or the endpoint.

const FLOWS: { who: string; key: string; what: string }[] = [
  {
    who: "anthropic (claude)",
    key: "your own api key",
    what:
      "the in-app assistant · course chat · podcast scripts · pdf → vault conversion · study guides and flashcards · inventory capture parsing · shopping price lookups (these also run a web search) · people group suggestions · inbox auto-sort · mindspace observations. what leaves is the text each feature works on.",
  },
  {
    who: "google — calendar",
    key: "your own google sign-in",
    what:
      "events are read from every calendar you can see, and drag-to-reschedule writes a new start/end back. nothing else is written, and no event is ever created or deleted.",
  },
  {
    who: "google — gemini",
    key: "your own google ai api key",
    what: "podcast voices (text-to-speech on the script) · icon generation (your prompt).",
  },
  {
    who: "openai",
    key: "your own api key",
    what:
      "icon generation, and nothing else — your prompt goes to the images api. no text, finance or task data is sent to openai by the app.",
  },
  {
    who: "github",
    key: "your own fine-grained token",
    what:
      "your brain vault repo: notes, captures, course markdown and agent results are committed there. it is your repository, on your account.",
  },
  {
    who: "the deployment owner's home pc",
    key: "only if this account is allowlisted",
    what:
      "free pdf conversion, free podcast voices, shared reels, and the ✦ follow up / ✦ do it notes you send a task with. that pc runs them through claude code or a proxied model on the owner's own subscriptions. if your account is not on the worker allowlist, nothing is ever sent there — the buttons answer \"no agent pc serves this account\".",
  },
  {
    who: "whatever you connect over mcp",
    key: "your own mcp token",
    what:
      "connecting mindboard to claude.ai (or any other mcp client) lets that chat read and propose changes to your data — so it travels to whoever runs that chat, under their terms, not this app's.",
  },
];

export function DataFlows() {
  return (
    <div className="glass-panel p-3 space-y-3">
      <p className="text-meta text-muted leading-relaxed">
        mindboard holds no provider key of its own: every call below uses a
        credential you connected, and a provider you have not connected is
        never contacted.
      </p>
      <ul className="space-y-3">
        {FLOWS.map((flow) => (
          <li key={flow.who} className="space-y-1">
            <p className="text-body text-fg lowercase">
              {flow.who}{" "}
              <span className="text-meta text-muted">· {flow.key}</span>
            </p>
            <p className="text-meta text-muted leading-relaxed">{flow.what}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
