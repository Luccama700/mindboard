import { createClient } from "@/utils/supabase/server";
import {
  EXCLUDED_TABLES,
  EXPORT_NOTE,
  EXPORT_TABLES,
  stripSecrets,
} from "@/app/lib/account/export";

// settings → your data → "download my data" (audit finding M9).
//
// Reads on the COOKIE client, so RLS is what scopes every table to the caller
// — this handler never touches the service role and so can never reach
// another tenant's rows even if a table were missing its user_id filter.
// Credential columns are stripped by name (app/lib/account/export.ts).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PAGE = 1000;
const MAX_ROWS_PER_TABLE = 50_000;

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return Response.json({ error: "not authenticated" }, { status: 401 });
  }

  const tables: Record<string, unknown[]> = {};
  const problems: Record<string, string> = {};

  await Promise.all(
    EXPORT_TABLES.map(async ({ table, order }) => {
      const rows: unknown[] = [];
      for (let from = 0; from < MAX_ROWS_PER_TABLE; from += PAGE) {
        let query = supabase.from(table).select("*");
        for (const column of order) query = query.order(column);
        // PostgREST caps a response at 1000 rows, so a busy ledger or a long
        // assistant history has to be paged or it truncates in silence.
        const { data, error } = await query.range(from, from + PAGE - 1);
        if (error) {
          problems[table] = error.message;
          return;
        }
        const page = data ?? [];
        for (const row of page) {
          rows.push(stripSecrets(row as Record<string, unknown>));
        }
        if (page.length < PAGE) break;
      }
      tables[table] = rows;
    }),
  );

  const payload = {
    app: "mindboard",
    exported_at: new Date().toISOString(),
    user: { id: user.id, email: user.email ?? null, created_at: user.created_at },
    note: EXPORT_NOTE,
    excluded_tables: EXCLUDED_TABLES,
    ...(Object.keys(problems).length > 0 ? { could_not_read: problems } : {}),
    tables,
  };

  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": 'attachment; filename="mindboard-export.json"',
      "cache-control": "no-store",
    },
  });
}
