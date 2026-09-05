import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/utils/supabase/server";
import { createServiceClient } from "@/utils/supabase/service";

const TOKEN_REFRESH_MARGIN_MS = 60_000;

export type CalendarEvent = {
  id: string;
  eventId: string;
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
  startTimeZone: string | null;
  endTimeZone: string | null;
  calendarId: string;
  calendarSummary: string;
  calendarColor: string;
  writable: boolean;
  // Optional detail fields (the watch's event screen); absent on synthetic events.
  location?: string | null;
  description?: string | null;
};

export type CalendarListEntry = {
  id: string;
  summary: string;
  color: string;
  writable: boolean;
};

type TokenRow = {
  access_token: string;
  refresh_token: string;
  expires_at: string;
  scopes: string;
};

type GoogleEvent = {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  start?: {
    date?: string;
    dateTime?: string;
    timeZone?: string;
  };
  end?: {
    date?: string;
    dateTime?: string;
    timeZone?: string;
  };
};

type GoogleCalendarListEntry = {
  id: string;
  summary?: string;
  backgroundColor?: string;
  accessRole?: string;
};

function isWritableRole(role: string | undefined): boolean {
  return role === "owner" || role === "writer";
}

async function fetchCalendarEvents(
  token: string,
  calendar: GoogleCalendarListEntry,
  {
    timeMin,
    timeMax,
  }: {
    timeMin: string;
    timeMax: string;
  },
  { allowForbidden = false }: { allowForbidden?: boolean } = {},
): Promise<CalendarEvent[]> {
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
      calendar.id,
    )}/events`,
  );
  url.searchParams.set("timeMin", timeMin);
  url.searchParams.set("timeMax", timeMax);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", "250");

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (response.status === 403 && allowForbidden) return [];
  if (response.status === 401 || response.status === 403) {
    throw new GoogleCalendarConnectionError();
  }
  if (!response.ok) throw new Error("calendar request failed");

  const payload = (await response.json()) as { items?: GoogleEvent[] };

  return (payload.items ?? [])
    .filter((event) => event.status !== "cancelled")
    .map((event) => {
      const start = event.start?.dateTime ?? event.start?.date ?? "";
      const end = event.end?.dateTime ?? event.end?.date ?? start;
      return {
        id: `${calendar.id}:${event.id}`,
        eventId: event.id,
        summary: event.summary ?? "untitled event",
        start,
        end,
        allDay: Boolean(event.start?.date),
        startTimeZone: event.start?.timeZone ?? null,
        endTimeZone: event.end?.timeZone ?? null,
        calendarId: calendar.id,
        calendarSummary: calendar.summary ?? "google calendar",
        calendarColor: calendar.backgroundColor ?? "#6d8fe8",
        writable: isWritableRole(calendar.accessRole),
        location: event.location ?? null,
        description: event.description ?? null,
      };
    })
    .filter((event) => event.start);
}

export class GoogleCalendarConnectionError extends Error {
  constructor(message = "google calendar connection failed — sign out and back in to refresh permissions") {
    super(message);
  }
}

// Load the token row on the session client first (the dashboard path, RLS
// scoped). In session-less contexts (the MCP server) that read comes back
// empty, so fall back to the service client — still explicitly user-filtered,
// matching the app/lib/mcp/* scoping invariant.
async function loadTokenRow(
  userId: string,
): Promise<{ row: TokenRow; client: SupabaseClient }> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("google_tokens")
    .select("access_token, refresh_token, expires_at, scopes")
    .eq("user_id", userId)
    .maybeSingle();
  if (data) return { row: data as TokenRow, client: supabase };

  if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const service = createServiceClient();
    const { data: serviceData } = await service
      .from("google_tokens")
      .select("access_token, refresh_token, expires_at, scopes")
      .eq("user_id", userId)
      .maybeSingle();
    if (serviceData) return { row: serviceData as TokenRow, client: service };
  }

  throw new GoogleCalendarConnectionError();
}

async function getValidAccessToken(userId: string): Promise<string> {
  const { row, client: supabase } = await loadTokenRow(userId);
  const expiresAt = new Date(row.expires_at).getTime();
  if (expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
    return row.access_token;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new GoogleCalendarConnectionError();

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: row.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) throw new GoogleCalendarConnectionError();

  const refreshed = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    scope?: string;
  };

  if (!refreshed.access_token || !refreshed.expires_in) {
    throw new GoogleCalendarConnectionError();
  }

  const nextExpiresAt = new Date(
    Date.now() + refreshed.expires_in * 1000,
  ).toISOString();
  const nextRefreshToken = refreshed.refresh_token ?? row.refresh_token;
  const nextScopes = refreshed.scope ?? row.scopes;

  const { error: updateError } = await supabase
    .from("google_tokens")
    .update({
      access_token: refreshed.access_token,
      refresh_token: nextRefreshToken,
      expires_at: nextExpiresAt,
      scopes: nextScopes,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);

  if (updateError) throw new GoogleCalendarConnectionError();

  return refreshed.access_token;
}

export async function listEvents(
  userId: string,
  {
    timeMin,
    timeMax,
  }: {
    timeMin: string;
    timeMax: string;
  },
): Promise<CalendarEvent[]> {
  const token = await getValidAccessToken(userId);
  const url = new URL(
    "https://www.googleapis.com/calendar/v3/users/me/calendarList",
  );
  url.searchParams.set("showHidden", "true");
  url.searchParams.set("maxResults", "250");

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (response.status === 401 || response.status === 403) {
    return fetchCalendarEvents(
      token,
      {
        id: "primary",
        summary: "google calendar",
        backgroundColor: "#6d8fe8",
      },
      { timeMin, timeMax },
    );
  }
  if (!response.ok) throw new Error("calendar list request failed");

  const payload = (await response.json()) as {
    items?: GoogleCalendarListEntry[];
  };
  const calendars = (payload.items ?? []).filter(
    (calendar) => calendar.id && calendar.accessRole !== "freeBusyReader",
  );
  if (calendars.length === 0) {
    return fetchCalendarEvents(
      token,
      {
        id: "primary",
        summary: "google calendar",
        backgroundColor: "#6d8fe8",
      },
      { timeMin, timeMax },
    );
  }

  const events = await Promise.all(
    calendars.map((calendar) =>
      fetchCalendarEvents(
        token,
        calendar,
        { timeMin, timeMax },
        { allowForbidden: true },
      ),
    ),
  );

  return events.flat().sort((a, b) => a.start.localeCompare(b.start));
}

export async function listCalendars(
  userId: string,
): Promise<CalendarListEntry[]> {
  const token = await getValidAccessToken(userId);
  const url = new URL(
    "https://www.googleapis.com/calendar/v3/users/me/calendarList",
  );
  url.searchParams.set("showHidden", "true");
  url.searchParams.set("maxResults", "250");

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (response.status === 401 || response.status === 403) {
    throw new GoogleCalendarConnectionError();
  }
  if (!response.ok) throw new Error("calendar list request failed");

  const payload = (await response.json()) as {
    items?: GoogleCalendarListEntry[];
  };

  return (payload.items ?? [])
    .filter((c) => c.id && c.accessRole !== "freeBusyReader")
    .map((c) => ({
      id: c.id,
      summary: c.summary ?? "google calendar",
      color: c.backgroundColor ?? "#6d8fe8",
      writable: isWritableRole(c.accessRole),
    }));
}

// Insert a real Google Calendar event (used to push a time-blocked task out).
// Returns the created event's id. One-way: Mindboard writes; Google is never
// a source of task truth.
export async function createEvent(
  userId: string,
  calendarId: string,
  body: {
    summary: string;
    start: { date?: string; dateTime?: string; timeZone?: string };
    end: { date?: string; dateTime?: string; timeZone?: string };
    description?: string;
  },
): Promise<string> {
  const token = await getValidAccessToken(userId);
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
      calendarId,
    )}/events`,
  );

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (response.status === 401) {
    throw new GoogleCalendarConnectionError(
      "google rejected the access token — sign out and back in",
    );
  }
  if (response.status === 403) {
    throw new GoogleCalendarConnectionError(
      "google calendar write access not granted — sign out and back in to authorize the calendar.events scope",
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `event create failed: ${response.status} ${text || response.statusText}`,
    );
  }
  const payload = (await response.json()) as { id?: string };
  if (!payload.id) throw new Error("event create returned no id");
  return payload.id;
}

export async function updateEvent(
  userId: string,
  calendarId: string,
  eventId: string,
  patch: {
    start: { date?: string; dateTime?: string; timeZone?: string };
    end: { date?: string; dateTime?: string; timeZone?: string };
  },
): Promise<void> {
  const token = await getValidAccessToken(userId);
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
      calendarId,
    )}/events/${encodeURIComponent(eventId)}`,
  );

  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(patch),
  });

  if (response.status === 401) {
    throw new GoogleCalendarConnectionError(
      "google rejected the access token — sign out and back in",
    );
  }
  if (response.status === 403) {
    throw new GoogleCalendarConnectionError(
      "google calendar write access not granted — sign out and back in to authorize the calendar.events scope",
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`event update failed: ${response.status} ${text || response.statusText}`);
  }
}

export async function listEventsForCalendar(
  userId: string,
  calendarId: string,
  range: { timeMin: string; timeMax: string },
): Promise<CalendarEvent[]> {
  const token = await getValidAccessToken(userId);
  return fetchCalendarEvents(
    token,
    {
      id: calendarId,
      summary: "google calendar",
      backgroundColor: "#6d8fe8",
    },
    range,
    { allowForbidden: true },
  );
}
