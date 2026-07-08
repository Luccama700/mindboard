import Link from "next/link";
import { redirect } from "next/navigation";

import { createClient } from "@/utils/supabase/server";
import { PlanClient, type InitialMessage } from "./plan-client";

function first(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.trim() ? raw.trim() : null;
}

export default async function PlanPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string | string[] | undefined;
    c?: string | string[] | undefined;
  }>;
}) {
  const query = await searchParams;
  const q = first(query.q);
  const requestedConversation = first(query.c);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [settingsResult, conversationsResult, goalsResult] = await Promise.all([
    supabase
      .from("user_settings")
      .select("anthropic_api_key")
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase
      .from("ai_conversations")
      .select("id, title, updated_at")
      .order("updated_at", { ascending: false })
      .limit(10),
    supabase
      .from("goals")
      .select("id, title, horizon, target_date")
      .eq("status", "active")
      .order("created_at", { ascending: false }),
  ]);

  const hasKey = Boolean(settingsResult.data?.anthropic_api_key);
  const conversations = (conversationsResult.data ?? []) as {
    id: string;
    title: string | null;
    updated_at: string;
  }[];

  let initialMessages: InitialMessage[] = [];
  let conversationId: string | null = null;
  if (requestedConversation) {
    const { data: messages } = await supabase
      .from("ai_messages")
      .select("role, content, conversation_id")
      .eq("conversation_id", requestedConversation)
      .order("created_at", { ascending: true })
      .limit(60);
    if (messages && messages.length > 0) {
      conversationId = requestedConversation;
      initialMessages = (messages as InitialMessage[]).map((m) => ({
        role: m.role,
        content: m.content,
      }));
    }
  }

  return (
    <main className="min-h-screen px-5 pt-6 pb-64 max-w-2xl mx-auto">
      <header className="flex items-center justify-between mb-6 pr-10 lg:pr-0">
        <h1 className="text-label uppercase text-muted">plan</h1>
        {conversationId && (
          <Link
            href="/plan"
            className="text-meta text-muted hover:text-fg transition-colors min-h-11 inline-flex items-center"
          >
            new conversation +
          </Link>
        )}
      </header>

      <PlanClient
        key={conversationId ?? "new"}
        hasKey={hasKey}
        initialQuery={q}
        conversationId={conversationId}
        initialMessages={initialMessages}
        goals={goalsResult.data ?? []}
      />

      {hasKey && conversations.length > 0 && (
        <details className="mt-10 border-t border-hairline pt-4">
          <summary className="text-label uppercase text-muted cursor-pointer min-h-11 flex items-center hover:text-fg transition-colors">
            past conversations
          </summary>
          <ul className="mt-2">
            {conversations.map((conversation) => (
              <li key={conversation.id}>
                <Link
                  href={`/plan?c=${conversation.id}`}
                  className="flex items-center justify-between gap-3 min-h-11 border-b border-hairline text-body text-fg hover:text-accent transition-colors"
                >
                  <span className="truncate">
                    {conversation.title ?? "(untitled)"}
                  </span>
                  <span className="text-meta text-muted shrink-0">
                    {conversation.updated_at.slice(0, 10)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </details>
      )}
    </main>
  );
}
