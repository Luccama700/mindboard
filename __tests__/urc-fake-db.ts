// A tiny in-memory PostgREST, shared by the URC server/device suites. Same
// idea as the fake in mcp-dispatch.test.ts (kept separate so that suite stays
// untouched), with the extras URC needs: insert, gte, not-is-null, descending
// order, and rpc.
//
// Running the real code against a fake table means the guards under test are
// the ordering, the per-user scoping and the status transitions themselves,
// rather than a sequence of asserted mock calls.

export type Row = Record<string, unknown>;

export type FakeDb = {
  tables: Record<string, Row[]>;
  // Simulate a constraint violation (e.g. the urc_jobs_audit_unique index) on
  // the next insert into a table. Cleared once it fires.
  insertError: { table: string; error: { code?: string; message: string } } | null;
  rpcImpl: Record<
    string,
    (args: Record<string, unknown>, db: FakeDb) => { data: unknown; error: null }
  >;
  from: (table: string) => FakeQuery;
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
};

type Outcome = { data: Row[]; error: { code?: string; message: string } | null };

export type FakeQuery = {
  select: (columns?: string) => FakeQuery;
  insert: (payload: Row | Row[]) => FakeQuery;
  update: (patch: Row) => FakeQuery;
  eq: (column: string, value: unknown) => FakeQuery;
  in: (column: string, values: unknown[]) => FakeQuery;
  gte: (column: string, value: string) => FakeQuery;
  lt: (column: string, value: string) => FakeQuery;
  is: (column: string, value: unknown) => FakeQuery;
  not: (column: string, operator: string, value: unknown) => FakeQuery;
  order: (column: string, options?: { ascending?: boolean }) => FakeQuery;
  limit: (count: number) => FakeQuery;
  maybeSingle: () => Promise<{ data: Row | null; error: null }>;
  single: () => Promise<{ data: Row | null; error: { message: string } | null }>;
  then: (resolve: (value: Outcome) => unknown) => Promise<unknown>;
};

let sequence = 0;

export function fakeId(): string {
  sequence += 1;
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

export function makeDb(tables: Record<string, Row[]>): FakeDb {
  const db: FakeDb = {
    tables,
    insertError: null,
    rpcImpl: {},
    rpc: async (name, args) => {
      const impl = db.rpcImpl[name];
      if (!impl) return { data: null, error: { message: `no rpc ${name}` } };
      return impl(args, db);
    },
    from: (table: string) => {
      const filters: ((row: Row) => boolean)[] = [];
      let mode: "select" | "insert" | "update" = "select";
      let patch: Row = {};
      let pending: Row[] = [];
      let orderKey: string | null = null;
      let ascending = true;
      let limitCount: number | null = null;

      const rows = () => (tables[table] ??= []);
      const matched = () => rows().filter((row) => filters.every((f) => f(row)));

      function run(): Outcome {
        if (mode === "insert") {
          if (db.insertError && db.insertError.table === table) {
            const { error } = db.insertError;
            db.insertError = null;
            return { data: [], error };
          }
          const created: Row[] = [];
          for (const row of pending) {
            const next: Row = {
              id: fakeId(),
              created_at: new Date().toISOString(),
              ...row,
            };
            rows().push(next);
            created.push({ ...next });
          }
          return { data: created, error: null };
        }
        if (mode === "update") {
          const hit = matched();
          for (const row of hit) Object.assign(row, patch);
          return { data: hit.map((row) => ({ ...row })), error: null };
        }
        let out = matched().map((row) => ({ ...row }));
        if (orderKey) {
          const key = orderKey;
          out = out.sort((a, b) => {
            const left = String(a[key] ?? "");
            const right = String(b[key] ?? "");
            return ascending ? left.localeCompare(right) : right.localeCompare(left);
          });
        }
        if (limitCount !== null) out = out.slice(0, limitCount);
        return { data: out, error: null };
      }

      const query: FakeQuery = {
        select: () => query,
        insert: (payload) => {
          mode = "insert";
          pending = Array.isArray(payload) ? payload : [payload];
          return query;
        },
        update: (next) => {
          mode = "update";
          patch = next;
          return query;
        },
        eq: (column, value) => {
          filters.push((row) => row[column] === value);
          return query;
        },
        in: (column, values) => {
          filters.push((row) => values.includes(row[column]));
          return query;
        },
        gte: (column, value) => {
          filters.push((row) => String(row[column] ?? "") >= value);
          return query;
        },
        lt: (column, value) => {
          filters.push((row) => row[column] != null && String(row[column]) < value);
          return query;
        },
        is: (column, value) => {
          if (value === null) {
            filters.push((row) => row[column] === null || row[column] === undefined);
          } else {
            filters.push((row) => row[column] === value);
          }
          return query;
        },
        not: (column, operator, value) => {
          if (operator === "is" && value === null) {
            filters.push((row) => row[column] !== null && row[column] !== undefined);
          }
          return query;
        },
        order: (column, options) => {
          orderKey = column;
          ascending = options?.ascending !== false;
          return query;
        },
        limit: (count) => {
          limitCount = count;
          return query;
        },
        maybeSingle: async () => ({ data: run().data[0] ?? null, error: null }),
        single: async () => {
          const { data, error } = run();
          if (error) return { data: null, error };
          return data.length === 1
            ? { data: data[0], error: null }
            : { data: null, error: { message: "no rows" } };
        },
        then: (resolve) => Promise.resolve(run()).then(resolve),
      };
      return query;
    },
  };
  return db;
}
