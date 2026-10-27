import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { calendar_v3 } from "googleapis";
import { calendarFor, fanOut, resolve, resolveOne } from "../accounts.js";
import { audit } from "../db.js";
import { config } from "../config.js";
import { toUtc } from "../time.js";
import { accountArg, accountOrAllArg, emailList, ok, safe } from "./util.js";

const RO = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

const sendUpdates = z.enum(["none", "all", "externalOnly"]).default("none").describe("Whether Google emails attendees about the change");
const windowTime = z
  .string()
  .describe(`Date-time with offset (2026-11-03T09:00:00Z), local date-time (2026-11-03T09:00) or date; times without an offset are read in ${config.defaultTimeZone}`);
const when = z
  .string()
  .describe(`Date-time (2026-11-03T14:00, read in time_zone or ${config.defaultTimeZone}; or with an offset) or a date (2026-11-03) for all-day`);

function toTime(v: string, tz?: string): calendar_v3.Schema$EventDateTime {
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { date: v };
  const zone = tz ?? config.defaultTimeZone;
  // Normalise to a full RFC 3339 instant: Google rejects e.g. "2026-11-03T09:00" (no seconds).
  return { dateTime: toUtc(v, zone), timeZone: zone };
}

const JOIN_RE = /https:\/\/[^\s"<>]*(?:zoom\.us\/j\/|teams\.microsoft\.com\/(?:meet|l\/meetup-join)\/|meet\.google\.com\/)[^\s"<>]*/i;
// Lines from which conferencing boilerplate (dial-ins, passcodes, help links) starts.
const BOILERPLATE_RE = /^(?:_{5,}|─{5,}|.*is inviting you to a scheduled Zoom meeting|Join Zoom Meeting|Microsoft Teams meeting|Join:\s*https|-::~)/im;
const MAX_LIST_ATTENDEES = 8;

export function cleanDescription(desc: string | null | undefined, max: number) {
  if (!desc) return undefined;
  const text = desc.replace(/<br\s*\/?>|<\/(?:div|p)>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ");
  const cut = text.search(BOILERPLATE_RE);
  const body = (cut >= 0 ? text.slice(0, cut) : text).replace(/\n{3,}/g, "\n\n").trim();
  if (!body) return undefined;
  return body.length > max ? `${body.slice(0, max)}…` : body;
}

/** Compact event for lists: join link extracted, dial-in boilerplate dropped, long guest lists summarised. */
const slim = (e: calendar_v3.Schema$Event) => {
  const attendees = e.attendees ?? [];
  const me = attendees.find((a) => a.self);
  return {
    id: e.id,
    summary: e.summary,
    start: e.start?.dateTime ?? e.start?.date,
    end: e.end?.dateTime ?? e.end?.date,
    location: e.location && !JOIN_RE.test(e.location) ? e.location : undefined,
    joinUrl: e.hangoutLink || e.location?.match(JOIN_RE)?.[0] || e.description?.match(JOIN_RE)?.[0] || undefined,
    status: e.status !== "confirmed" ? e.status : undefined,
    organizer: e.organizer?.email,
    myResponse: me?.responseStatus,
    attendeeCount: attendees.length || undefined,
    attendees: attendees.length
      ? attendees.slice(0, MAX_LIST_ATTENDEES).filter((a) => !a.self).map((a) => `${a.email} (${a.responseStatus})`)
      : undefined,
    description: cleanDescription(e.description, 300),
  };
};

/** Full event for single lookups. */
const full = (e: calendar_v3.Schema$Event) => ({
  ...slim(e),
  attendees: e.attendees?.map((a) => ({ email: a.email, response: a.responseStatus, self: a.self || undefined })),
  htmlLink: e.htmlLink,
  description: e.description ?? undefined,
});

export function registerCalendarTools(server: McpServer) {
  server.registerTool(
    "calendar_list_calendars",
    { title: "List calendars", description: 'List calendars. account="all" for every mailbox.', inputSchema: { account: accountOrAllArg }, annotations: RO },
    safe(async ({ account }) => {
      const res = await fanOut(await resolve(account, true), async (a) => {
        const items = (await (await calendarFor(a.label)).calendarList.list()).data.items ?? [];
        return items.map((c) => ({ id: c.id, summary: c.summary, primary: c.primary || undefined, accessRole: c.accessRole, timeZone: c.timeZone }));
      });
      return ok(res);
    }),
  );

  server.registerTool(
    "calendar_list_events",
    {
      title: "List calendar events",
      description: 'List events in a time window, expanded and ordered by start. account="all" merges every mailbox\'s primary calendar.',
      inputSchema: {
        account: accountOrAllArg,
        calendar_id: z.string().default("primary"),
        time_min: windowTime,
        time_max: windowTime,
        query: z.string().optional().describe("Free-text filter"),
        max_results: z.number().int().min(1).max(250).default(50),
      },
      annotations: RO,
    },
    safe(async ({ account, calendar_id, time_min, time_max, query, max_results }) => {
      const res = await fanOut(await resolve(account, true), async (a) => {
        const items = (await (await calendarFor(a.label)).events.list({
          calendarId: calendar_id, timeMin: toUtc(time_min, config.defaultTimeZone), timeMax: toUtc(time_max, config.defaultTimeZone), q: query,
          singleEvents: true, orderBy: "startTime", maxResults: max_results,
        })).data.items ?? [];
        return items.map(slim);
      });
      if (res.length === 1) return ok({ account: res[0].account, events: res[0].result, error: res[0].error });
      const merged = res.flatMap((r) => (r.result ?? []).map((e) => ({ account: r.account, ...e })));
      merged.sort((x, y) => String(x.start).localeCompare(String(y.start)));
      return ok({ events: merged, errors: res.filter((r) => r.error).map((r) => ({ account: r.account, error: r.error })) });
    }),
  );

  server.registerTool(
    "calendar_get_event",
    { title: "Get calendar event", description: "Get one event.", inputSchema: { account: accountArg, calendar_id: z.string().default("primary"), event_id: z.string() }, annotations: RO },
    safe(async ({ account, calendar_id, event_id }) => {
      const a = await resolveOne(account);
      const e = (await (await calendarFor(a.label)).events.get({ calendarId: calendar_id, eventId: event_id })).data;
      return ok({ account: a.label, ...full(e) });
    }),
  );

  const eventFields = {
    summary: z.string(),
    start: when,
    end: when,
    time_zone: z.string().optional().describe(`IANA zone; default ${config.defaultTimeZone}`),
    description: z.string().optional(),
    location: z.string().optional(),
    attendees: emailList.optional(),
    add_google_meet: z.boolean().optional(),
  };

  server.registerTool(
    "calendar_create_event",
    {
      title: "Create calendar event",
      description: "Create an event. Attendees are only emailed if send_updates is set.",
      inputSchema: { account: accountArg, calendar_id: z.string().default("primary"), ...eventFields, send_updates: sendUpdates },
      annotations: WRITE,
    },
    safe(async (args) => {
      const a = await resolveOne(args.account);
      const e = (await (await calendarFor(a.label)).events.insert({
        calendarId: args.calendar_id,
        sendUpdates: args.send_updates,
        conferenceDataVersion: args.add_google_meet ? 1 : undefined,
        requestBody: {
          summary: args.summary,
          description: args.description,
          location: args.location,
          start: toTime(args.start, args.time_zone),
          end: toTime(args.end, args.time_zone),
          attendees: args.attendees?.map((email) => ({ email })),
          conferenceData: args.add_google_meet ? { createRequest: { requestId: `${Date.now()}`, conferenceSolutionKey: { type: "hangoutsMeet" } } } : undefined,
        },
      })).data;
      await audit("calendar_create_event", a.label, { id: e.id, summary: e.summary, attendees: args.attendees, send_updates: args.send_updates });
      return ok({ account: a.label, ...slim(e) });
    }),
  );

  server.registerTool(
    "calendar_update_event",
    {
      title: "Update calendar event",
      description: "Patch an event; only fields given are changed. add_attendees/remove_attendees edit the guest list.",
      inputSchema: {
        account: accountArg,
        calendar_id: z.string().default("primary"),
        event_id: z.string(),
        summary: z.string().optional(),
        start: when.optional(),
        end: when.optional(),
        time_zone: z.string().optional(),
        description: z.string().optional(),
        location: z.string().optional(),
        add_attendees: emailList.optional(),
        remove_attendees: emailList.optional(),
        send_updates: sendUpdates,
      },
      annotations: WRITE,
    },
    safe(async (args) => {
      const a = await resolveOne(args.account);
      const cal = await calendarFor(a.label);
      const patch: calendar_v3.Schema$Event = {};
      if (args.summary !== undefined) patch.summary = args.summary;
      if (args.description !== undefined) patch.description = args.description;
      if (args.location !== undefined) patch.location = args.location;
      if (args.start) patch.start = toTime(args.start, args.time_zone);
      if (args.end) patch.end = toTime(args.end, args.time_zone);
      if (args.add_attendees?.length || args.remove_attendees?.length) {
        const cur = (await cal.events.get({ calendarId: args.calendar_id, eventId: args.event_id })).data.attendees ?? [];
        const rm = new Set((args.remove_attendees ?? []).map((x) => x.toLowerCase()));
        const kept = cur.filter((x) => !rm.has((x.email ?? "").toLowerCase()));
        const have = new Set(kept.map((x) => (x.email ?? "").toLowerCase()));
        patch.attendees = [...kept, ...(args.add_attendees ?? []).filter((x) => !have.has(x.toLowerCase())).map((email) => ({ email }))];
      }
      const e = (await cal.events.patch({ calendarId: args.calendar_id, eventId: args.event_id, sendUpdates: args.send_updates, requestBody: patch })).data;
      await audit("calendar_update_event", a.label, { id: e.id, patch, send_updates: args.send_updates });
      return ok({ account: a.label, ...slim(e) });
    }),
  );

  server.registerTool(
    "calendar_delete_event",
    {
      title: "Delete calendar event",
      description: "Delete or cancel an event.",
      inputSchema: { account: accountArg, calendar_id: z.string().default("primary"), event_id: z.string(), send_updates: sendUpdates },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    safe(async ({ account, calendar_id, event_id, send_updates }) => {
      const a = await resolveOne(account);
      await (await calendarFor(a.label)).events.delete({ calendarId: calendar_id, eventId: event_id, sendUpdates: send_updates });
      await audit("calendar_delete_event", a.label, { event_id, send_updates });
      return ok({ account: a.label, deleted: event_id });
    }),
  );

  server.registerTool(
    "calendar_respond",
    {
      title: "Respond to invitation",
      description: "Accept, decline or tentatively accept an event you are invited to. Notifies the organiser.",
      inputSchema: {
        account: accountArg,
        calendar_id: z.string().default("primary"),
        event_id: z.string(),
        response: z.enum(["accepted", "declined", "tentative"]),
      },
      annotations: WRITE,
    },
    safe(async ({ account, calendar_id, event_id, response }) => {
      const a = await resolveOne(account);
      const cal = await calendarFor(a.label);
      const ev = (await cal.events.get({ calendarId: calendar_id, eventId: event_id })).data;
      const attendees = ev.attendees ?? [];
      const me = attendees.find((x) => x.self || x.email?.toLowerCase() === a.email);
      if (!me) throw new Error(`${a.email} is not an attendee of this event`);
      me.responseStatus = response;
      const e = (await cal.events.patch({ calendarId: calendar_id, eventId: event_id, sendUpdates: "all", requestBody: { attendees } })).data;
      await audit("calendar_respond", a.label, { event_id, response });
      return ok({ account: a.label, ...slim(e) });
    }),
  );

  server.registerTool(
    "calendar_free_busy",
    {
      title: "Free/busy across accounts",
      description: 'Busy blocks for a window. account="all" (default) combines every connected mailbox, useful for finding a free slot across all your calendars.',
      inputSchema: { account: accountOrAllArg, time_min: windowTime, time_max: windowTime, time_zone: z.string().optional().describe(`IANA zone for times without an offset; default ${config.defaultTimeZone}`) },
      annotations: RO,
    },
    safe(async ({ account, time_min, time_max, time_zone }) => {
      const tz = time_zone ?? config.defaultTimeZone;
      const res = await fanOut(await resolve(account ?? "all", true), async (a) => {
        const r = (await (await calendarFor(a.label)).freebusy.query({
          requestBody: { timeMin: toUtc(time_min, tz), timeMax: toUtc(time_max, tz), timeZone: tz, items: [{ id: "primary" }] },
        })).data;
        return r.calendars?.primary?.busy ?? [];
      });
      const blocks = res.flatMap((r) => (r.result ?? []).map((b) => ({ account: r.account, start: b.start, end: b.end })));
      blocks.sort((x, y) => String(x.start).localeCompare(String(y.start)));
      return ok({ timeZone: tz, busy: blocks, errors: res.filter((r) => r.error).map((r) => ({ account: r.account, error: r.error })) });
    }),
  );
}
