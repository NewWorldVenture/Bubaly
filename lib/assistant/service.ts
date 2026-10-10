// lib/assistant/service.ts
//
// The server half of the assistant bridge: resolve a capability token, read the
// small amount of data an answer needs, and record what happened.
//
// Runs through the SERVICE-ROLE client because the request is unauthenticated
// by design — the token IS the authorization, exactly as for the ICS feeds in
// 0034. Everything below is therefore scoped explicitly by the family the token
// resolved to; nothing takes a family id from the request.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { hashAssistantToken } from './link-token';
import { isAdmin } from '@/lib/constants/roles';
import {
  agendaSpeech, forgettingSpeech, nextSpeech, listSpeech,
  BUBALY_SWITCHED_OFF_SPEECH, CAPTURE_NOT_ALLOWED_SPEECH,
  type AgendaEvent, type AgendaTask, type SpokenList,
} from './answers';
import { captureSpeech, unknownSpeech, HELP_SPEECH, boundSpeech, boundText, type AssistantIntent } from './intent';
import type { VoiceRoute } from '@/lib/voice/command-router';
import { splitItems, parseGroceryItem } from '@/lib/capture/parse';
import { instantForLocalTime } from '@/lib/time/zoned';
import { readCalendarOccurrences } from '@/lib/calendar/occurrences';
import { instantCalendarBounds } from '@/lib/briefing/calendar-window';
import { compareOccurrences } from '@/lib/calendar/day';
import { loadAISettingsFor } from '@/lib/services/ai-settings';
import { wroteNoRows } from '@/lib/supabase/errors';
import { ensureDefaultGroceryListId } from '@/lib/services/groceries';
import { ensureTodoListId } from '@/lib/services/tasks';

type Client = SupabaseClient<Database>;

export type AssistantLink = {
  id: string;
  family_id: string;
  user_id: string;
  provider: string;
  scopes: string[];
  timezone: string;
};

export type AssistantOutcome = 'answered' | 'captured' | 'refused' | 'error';
export type AssistantReply = { speech: string; outcome: AssistantOutcome; intent: string };

/** Most items one spoken sentence can add, so a stuck microphone cannot fill a list. */
const MAX_SPOKEN_ITEMS = 20;

/** Longest utterance worth storing on the audit row. */
const UTTERANCE_LOG_CHARS = 240;

/**
 * What a presented token resolved to.
 *
 * `not_linked` covers every answer about the TOKEN — unknown, revoked, owner
 * gone, owner no longer a parent — and the caller must treat those
 * identically, because distinguishing them would turn this into an oracle for
 * guessing tokens. `unavailable` is not an answer about the token at all: a
 * read failed, so nothing is known either way. It is still a refusal (never
 * "assume they are still a parent"), but a caller that tells a person to
 * re-link their account on a database blip sends them to mint a new key when
 * they only needed to try again.
 */
export type AssistantLinkLookup =
  | { status: 'linked'; link: AssistantLink }
  | { status: 'not_linked' }
  | { status: 'unavailable' };

/**
 * The live link this token belongs to, or null.
 *
 * Null covers every failure, including a read that failed; a caller that needs
 * to tell an outage apart from "not linked" uses `lookupAssistantLink`.
 */
export async function resolveAssistantLink(supabase: Client, token: string): Promise<AssistantLink | null> {
  const found = await lookupAssistantLink(supabase, token);
  return found.status === 'linked' ? found.link : null;
}

export async function lookupAssistantLink(supabase: Client, token: string): Promise<AssistantLinkLookup> {
  const { data, error } = await supabase
    .from('assistant_links')
    .select('id, family_id, user_id, created_by, provider, scopes, revoked_at, families(timezone)')
    .eq('token_hash', hashAssistantToken(token))
    .is('revoked_at', null)
    .maybeSingle();
  if (error) {
    console.error('[assistant] link lookup failed', error);
    return { status: 'unavailable' };
  }
  if (!data) return { status: 'not_linked' };
  const row = data as unknown as {
    id: string; family_id: string; user_id: string; created_by: string | null; provider: string; scopes: string[] | null;
    families: { timezone: string } | { timezone: string }[] | null;
  };

  // A key is minted by a parent FOR THEMSELVES — the only minting path
  // (dashboard/assistants/actions.ts) writes user_id and created_by from the
  // same session user. A row where they differ was written some other way: a
  // parent calling /rest/v1/assistant_links directly to mint a key in a
  // co-parent's name, or re-pointing their own key's user_id at one, so that
  // it outlives their own removal (0419 and the owner check below both follow
  // user_id). That row is not a key this product issued, and it is refused.
  // The database half — withdrawing the client INSERT/UPDATE grant 0283 gave
  // `authenticated` — is a migration; this holds whether or not it exists.
  if (!row.created_by || row.created_by !== row.user_id) return { status: 'not_linked' };

  const family = Array.isArray(row.families) ? row.families[0] : row.families;
  const link: AssistantLink = {
    id: row.id,
    family_id: row.family_id,
    user_id: row.user_id,
    provider: row.provider,
    scopes: row.scopes ?? [],
    timezone: family?.timezone || 'UTC',
  };

  // A key speaks for the parent who minted it, and only while they still
  // could mint one: an ACTIVE parent of this family (dashboard/assistants,
  // `isAdmin`). Removing a member only flips family_members.is_active, and
  // demoting one only changes their role, so without this a parent who has
  // left — an estranged co-parent — kept a key that reads the family's day
  // aloud and, with `capture`, files into it (SRV-001 l12). 0419 revokes the
  // key in the database as well, once it is applied; this holds either way.
  // A read that fails is a refusal like every other failure here, never
  // "assume they are still a parent" — reported as `unavailable`, not as
  // "not linked", because nothing about the key is known.
  const { data: owner, error: ownerError } = await supabase
    .from('family_members')
    .select('role')
    .eq('family_id', link.family_id)
    .eq('user_id', link.user_id)
    .eq('is_active', true)
    .maybeSingle();
  if (ownerError) {
    console.error('[assistant] link owner lookup failed', ownerError);
    return { status: 'unavailable' };
  }
  if (!owner || !isAdmin((owner as { role: string }).role)) return { status: 'not_linked' };

  return { status: 'linked', link };
}

/** The local calendar day in the family's own zone, as YYYY-MM-DD. */
export function dayKey(now: Date, timezone: string): string {
  const parts: Record<string, string> = {};
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  for (const part of formatter.formatToParts(now)) parts[part.type] = part.value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Start and end instants of a local day, so "today" means the family's today. */
export function dayWindow(now: Date, timezone: string, offsetDays = 0): { from: string; to: string } {
  // The day runs from local midnight to the NEXT local midnight — not from
  // midnight plus 24 hours. A day with a DST change in it is 23 or 25 hours
  // long, so the fixed span ran an hour into tomorrow every spring (reading out
  // tomorrow's first appointment as today's) and stopped an hour short every
  // autumn (silently dropping the last hour of the evening).
  //
  // The calendar arithmetic is done on the DATE PARTS, for the same reason:
  // adding 86,400,000ms to an instant to mean "tomorrow" lands back on the same
  // local date on a 25-hour day.
  const today = dayKey(now, timezone).split('-').map(Number);
  const shifted = new Date(Date.UTC(today[0], today[1] - 1, today[2] + offsetDays));
  const next = new Date(Date.UTC(today[0], today[1] - 1, today[2] + offsetDays + 1));

  // Midnight itself does not exist in a handful of zones that change at 00:00,
  // so take the first minute that does rather than returning nothing.
  const startOf = (d: Date) => instantForLocalTime(
    d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 0, timezone,
  );
  const from = startOf(shifted);
  const to = startOf(next);
  if (!from || !to) {
    // Unreachable for any real zone; a bad timezone string is the only way here.
    const fallback = new Date(Date.UTC(today[0], today[1] - 1, today[2] + offsetDays));
    return { from: fallback.toISOString(), to: new Date(fallback.getTime() + 86_400_000).toISOString() };
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

/** Most occurrences one spoken answer will consider. */
const MAX_OCCURRENCES = 50;

/**
 * The events inside one window, INCLUDING the occurrences of recurring series.
 *
 * This used to be a single `starts_at BETWEEN` query, which is the right query
 * for a calendar that stores every occurrence as a row and the wrong one for
 * this schema. `calendar_events.recurrence` holds a rule and the app expands it
 * at read time — so a weekly soccer practice matched exactly once, on the
 * afternoon it was created, and never again. What a speaker is asked about all
 * week (the school run, practice, bin day) was precisely what it could not see.
 *
 * It is the shared read (lib/calendar/occurrences.ts), as every other calendar
 * surface's is: one-offs and series both scoped to the family and checked
 * against their exact counts, timed rows between the family's midnights and
 * all-day rows by their own date, series stepped on the family's clock. The
 * speaker's own two queries capped the series at 200 rows and read an all-day
 * row by the family's day of its UTC instant — the day before, west of
 * Greenwich. All-day rows head the day.
 */
async function readEvents(
  supabase: Client, familyId: string, window: { from: string; to: string }, timezone: string,
): Promise<AgendaEvent[]> {
  const toInclusive = new Date(Date.parse(window.to) - 1).toISOString();
  const res = await readCalendarOccurrences(supabase, familyId, instantCalendarBounds(window.from, toInclusive, timezone), timezone, {
    columns: ['id', 'title', 'starts_at', 'ends_at', 'all_day'],
    limit: MAX_OCCURRENCES,
  });
  if (res.error) throw res.error;
  return [...res.data]
    .sort((a, b) => compareOccurrences(a, b, timezone))
    .map(({ title, starts_at, all_day }) => ({ title, starts_at, all_day }));
}

/**
 * The lists a family still looks at.
 *
 * Every read below is scoped to these. A list the family archived is a list
 * they have decided is done with, and counting its items as overdue — or
 * reading them back in a shop — is the same defect as writing into it, which
 * `ensureList` had. `grocery_lists` carries two archive columns and only
 * `archived_at` is ever written (see lib/services/groceries); both are asked.
 */
async function liveListIds(
  supabase: Client, familyId: string, table: 'todo_lists' | 'grocery_lists',
): Promise<string[]> {
  const { data, error } = table === 'todo_lists'
    ? await supabase.from('todo_lists').select('id').eq('family_id', familyId).is('archived_at', null)
    : await supabase.from('grocery_lists').select('id').eq('family_id', familyId)
      .eq('is_archived', false).is('archived_at', null);
  if (error) throw error;
  return (data ?? []).map((row) => row.id);
}

async function readOpenTasks(supabase: Client, familyId: string): Promise<AgendaTask[]> {
  const lists = await liveListIds(supabase, familyId, 'todo_lists');
  if (lists.length === 0) return [];
  const { data, error } = await supabase
    .from('todo_items')
    .select('title, due_date')
    .eq('family_id', familyId)
    .in('list_id', lists)
    .eq('is_done', false)
    .not('due_date', 'is', null)
    .order('due_date')
    .limit(100);
  if (error) throw error;
  return (data ?? []) as unknown as AgendaTask[];
}

/** Most items read back before the count carries the rest. */
const MAX_LIST_READ = 40;

/**
 * The shopping list, as it stands.
 *
 * Only from lists the family has NOT archived, for the same reason the writes
 * avoid them: reading back a list nobody looks at is worse than saying nothing,
 * because it sounds authoritative.
 */
async function readShoppingList(supabase: Client, familyId: string): Promise<SpokenList> {
  const ids = await liveListIds(supabase, familyId, 'grocery_lists');
  if (ids.length === 0) return { names: [], total: 0 };

  const { data, error } = await supabase
    .from('grocery_items')
    .select('name, quantity')
    .eq('family_id', familyId)
    .in('list_id', ids)
    .eq('is_checked', false)
    .order('created_at')
    .limit(MAX_LIST_READ);
  if (error) throw error;
  const rows = (data ?? []) as unknown as { name: string; quantity: string | null }[];
  // The quantity belongs in the sentence: "two pints of milk" is the useful
  // answer and "milk" is the one that sends somebody back to the shop.
  const names = rows.map((row) => (row.quantity ? `${row.quantity} ${row.name}` : row.name));
  return { names, total: names.length };
}

/** The open to-do items, oldest first, so the oldest is the one that gets said. */
async function readTaskList(supabase: Client, familyId: string): Promise<SpokenList> {
  const lists = await liveListIds(supabase, familyId, 'todo_lists');
  if (lists.length === 0) return { names: [], total: 0 };
  const { data, error } = await supabase
    .from('todo_items')
    .select('title')
    .eq('family_id', familyId)
    .in('list_id', lists)
    .eq('is_done', false)
    .order('created_at')
    .limit(MAX_LIST_READ);
  if (error) throw error;
  const names = ((data ?? []) as unknown as { title: string }[]).map((row) => row.title);
  return { names, total: names.length };
}

/** Record what the speaker did. Never throws: an audit gap must not eat a reply. */
export async function recordAssistantEvent(
  supabase: Client, link: AssistantLink, intent: string, utterance: string, outcome: AssistantOutcome,
): Promise<void> {
  const { error } = await supabase.from('assistant_link_events').insert({
    link_id: link.id, family_id: link.family_id, intent,
    utterance: utterance.slice(0, UTTERANCE_LOG_CHARS) || null,
    outcome,
  });
  if (error) console.error('[assistant] event insert failed', error);
  // Logged on zero rows too — "last used" is what a parent reads to decide
  // whether a key is live. Never raised. Audit C1-S9-69.
  const { data: touched, error: touchError } = await supabase
    .from('assistant_links')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', link.id)
    .select('id');
  if (touchError || wroteNoRows(touched)) console.error('[assistant] last-used update failed', touchError ?? { linkId: link.id, error: 'no rows updated' });
}

/**
 * Execute one intent and produce the sentence to speak.
 *
 * Capture goes through the same tables the app's own capture pipeline writes,
 * scoped to the link's family. The scope check comes first: a link created
 * read-only for a speaker in a shared room must not be able to add anything,
 * and must SAY so rather than failing quietly.
 */
export async function answerAssistant(
  supabase: Client, link: AssistantLink, intent: AssistantIntent, now: Date = new Date(),
): Promise<AssistantReply> {
  switch (intent.kind) {
    case 'help':
      return { speech: HELP_SPEECH, outcome: 'answered', intent: 'help' };

    case 'unknown':
      return { speech: unknownSpeech(intent.utterance), outcome: 'answered', intent: 'unknown' };

    case 'agenda': {
      const window = dayWindow(now, link.timezone, intent.day === 'tomorrow' ? 1 : 0);
      const events = await readEvents(supabase, link.family_id, window, link.timezone);
      return { speech: agendaSpeech(events, intent.day, link.timezone), outcome: 'answered', intent: 'agenda' };
    }

    case 'next': {
      // "What's next" must be able to cross midnight. Looking only at today
      // meant every evening answered "nothing", at exactly the hour a family is
      // most likely to ask what the morning holds.
      const today = dayWindow(now, link.timezone);
      const tomorrow = dayWindow(now, link.timezone, 1);
      const events = await readEvents(supabase, link.family_id, { from: today.from, to: tomorrow.to }, link.timezone);
      const upcoming = events.filter((e) => e.all_day || new Date(e.starts_at).getTime() >= now.getTime());
      return { speech: nextSpeech(upcoming, link.timezone), outcome: 'answered', intent: 'next' };
    }

    case 'forgetting': {
      const tasks = await readOpenTasks(supabase, link.family_id);
      return {
        speech: forgettingSpeech(tasks, dayKey(now, link.timezone)),
        outcome: 'answered', intent: 'forgetting',
      };
    }

    case 'list': {
      // Bubaly could be told to put milk ON the shopping list and had no way to
      // say what was on it. Half a feature, and the missing half is the one you
      // want while standing in a shop.
      const items = intent.list === 'shopping'
        ? await readShoppingList(supabase, link.family_id)
        : await readTaskList(supabase, link.family_id);
      return { speech: listSpeech(intent.list, items), outcome: 'answered', intent: `list:${intent.list}` };
    }

    case 'capture': {
      if (!link.scopes.includes('capture')) {
        return { speech: CAPTURE_NOT_ALLOWED_SPEECH, outcome: 'refused', intent: 'capture' };
      }
      // Settings → Bubaly AI says, in these words: "Bubaly is switched off: it
      // will still answer questions, but it will not change anything for your
      // family." A speaker is Bubaly. Every branch above this one is the
      // answering half and keeps working; this is the half the switch governs,
      // and until now a kitchen speaker went on creating events, notes, tasks
      // and shopping items for a family that had switched Bubaly off.
      //
      // After the link's own scope, not before: the scope is a property of this
      // link and costs no query, and a read-only link deserves the more
      // specific sentence about what IT may do.
      //
      // Read STRICTLY: a settings read that failed used to answer the defaults
      // ("Bubaly on"), so a timeout let a switched-off family's speaker write
      // anyway (SEC-009). A failure throws, and the route answers with its
      // "something went wrong on my side, so I have not changed anything" —
      // true, and not a claim that the family switched anything off.
      const settings = await loadAISettingsFor(supabase, link.family_id);
      if (!settings.ok) throw new Error(`capture refused: Bubaly settings could not be read (${settings.error})`);
      if (!settings.data.enabled) {
        return { speech: BUBALY_SWITCHED_OFF_SPEECH, outcome: 'refused', intent: 'capture' };
      }
      const saved = await saveAssistantCapture(supabase, link, intent.route, now);
      if (!saved) throw new Error('capture write failed');
      return { speech: captureSpeech(intent.route, link.timezone, now), outcome: 'captured', intent: `capture:${intent.route.kind}` };
    }

    default:
      return { speech: HELP_SPEECH, outcome: 'answered', intent: 'help' };
  }
}

/**
 * Write the captured item.
 *
 * Tasks and shopping items need a list to live in, and a family reached through
 * a speaker may never have opened that module — so the list is found or created
 * rather than assumed, which is the difference between this working on day one
 * and failing for exactly the households who would most use it.
 */
async function saveAssistantCapture(
  supabase: Client, link: AssistantLink, route: VoiceRoute, now: Date,
): Promise<boolean> {
  const { kind } = route;
  // boundText, not boundSpeech: what is stored is the family's words, not a
  // version rewritten for a speaker.
  const title = boundText(route.text, 200);
  if (!title) return false;

  if (kind === 'event') {
    // The time the person actually said. `route.startsAt` is null only when no
    // date or time was in the utterance, and `now` is the honest reading of
    // "schedule a parent teacher conference" with nothing else given.
    //
    // This used to be `starts_at: now` unconditionally, with the parsed date
    // thrown away a layer earlier — so "add soccer practice on Friday at 4pm"
    // put soccer practice in the calendar at the moment you said it.
    const startsAt = route.startsAt ?? now;
    const { error } = await supabase.from('calendar_events').insert({
      family_id: link.family_id, title, starts_at: startsAt.toISOString(),
      all_day: route.allDay, category: 'general', created_by: link.user_id,
    } as never);
    if (error) { console.error('[assistant] event insert failed', error); return false; }
    return true;
  }

  if (kind === 'note') {
    // `body`, not `content`. The column audit caught that one; reading the
    // schema to fix it is what turned up the grocery list_id below, which it
    // could not have caught — it checks that columns exist, not that a NOT NULL
    // one was supplied.
    const { error } = await supabase.from('notes').insert({
      family_id: link.family_id, title, body: title, created_by: link.user_id,
    } as never);
    if (error) { console.error('[assistant] note insert failed', error); return false; }
    return true;
  }

  if (kind === 'shopping') {
    const list = await ensureList(supabase, link, 'grocery_lists', 'Groceries');
    if (!list) return false;
    const listId = list.id;

    // People do not dictate one item at a time. "Add milk, eggs and bread to
    // the shopping list" was becoming a single line reading "Milk, eggs and
    // bread", which is not a shopping list — you cannot tick off the eggs.
    //
    // splitItems only breaks on "and" when a comma is already present, so
    // "macaroni and cheese" survives as one thing; parseGroceryItem pulls a
    // count out of "2 pints of milk" and leaves "2% milk" alone. Both have been
    // in lib/capture/parse.ts all along, used by the typed capture box and not
    // by the speaker.
    const items = splitItems(title)
      .slice(0, MAX_SPOKEN_ITEMS)
      .map((raw) => parseGroceryItem(raw))
      .filter((item) => item.name.trim().length > 0);
    if (items.length === 0) { await discardEmptyList(supabase, link, 'grocery_lists', list); return false; }

    const { error } = await supabase.from('grocery_items').insert(items.map((item) => ({
      family_id: link.family_id, list_id: listId,
      name: boundText(item.name, 200), quantity: item.quantity, created_by: link.user_id,
    })) as never);
    if (error) {
      console.error('[assistant] grocery insert failed', error);
      await discardEmptyList(supabase, link, 'grocery_lists', list);
      return false;
    }
    return true;
  }

  const list = await ensureList(supabase, link, 'todo_lists', 'To do');
  if (!list) return false;
  const listId = list.id;
  // "Remind me to renew the passports on Friday" is a task that is due on
  // Friday. Dropping the day made it a task due whenever someone noticed it,
  // which is the thing the person was asking not to have to do.
  const { error } = await supabase.from('todo_items').insert({
    family_id: link.family_id, list_id: listId, title,
    ...(route.dueDate ? { due_date: route.dueDate } : {}),
  } as never);
  if (error) {
    console.error('[assistant] task insert failed', error);
    await discardEmptyList(supabase, link, 'todo_lists', list);
    return false;
  }
  return true;
}

/** A list to file into, and whether this request had to create it. */
type EnsuredList = { id: string; created: boolean };

/**
 * The family's first list of this kind, created if there is not one.
 *
 * Both `todo_items.list_id` and `grocery_items.list_id` are NOT NULL, so an
 * item has nowhere to go until a list exists — and a household reached through
 * a speaker may never have opened either module in the app. Assuming a list is
 * how this would work for the developer and fail for exactly the people the
 * feature is for.
 */
async function ensureList(
  supabase: Client, link: AssistantLink, table: 'todo_lists' | 'grocery_lists', name: string,
): Promise<EnsuredList | null> {
  // ARCHIVED lists are skipped. This took the family's OLDEST list, which is
  // precisely the one most likely to have been archived and replaced — so a
  // family who tidied up their first Groceries list had every spoken item
  // dropped into it, where nobody looks, while the speaker said "added to your
  // list" each time.
  //
  // Three column names across two tables, which is why one builder over a union
  // of table names checked none of them: `todo_lists.archived_at`, and
  // `grocery_lists` carrying BOTH `is_archived` (0002) and `archived_at`
  // (0014). Only `archived_at` is ever written — the shopping module stamps it
  // — so an `is_archived`-only reader calls an archived list open, which
  // lib/services/groceries documents at length. Both are asked here for the
  // same reason it asks both.
  const { data: existing, error } = table === 'todo_lists'
    ? await supabase.from('todo_lists').select('id').eq('family_id', link.family_id)
      .is('archived_at', null).order('created_at').limit(1).maybeSingle()
    : await supabase.from('grocery_lists').select('id').eq('family_id', link.family_id)
      .eq('is_archived', false).is('archived_at', null).order('created_at').limit(1).maybeSingle();
  if (error) { console.error(`[assistant] ${table} lookup failed`, error); return null; }
  if (existing?.id) return { id: existing.id, created: false };

  // None yet, so this request may be the one that creates it — through the
  // same serialised get-or-create the rest of the product uses (0443,
  // DATA-007). The read-then-insert this did itself had nothing between the
  // two, so two captures a moment apart (two speakers, or Alexa re-sending
  // after the person repeats themselves) each saw no list and each made one,
  // and the family had two "Groceries" lists with the items split across them.
  // The function holds a per-family lock across its own read and insert; the
  // second caller waits and gets the first caller's list.
  //
  // `created_by`: grocery_lists names an auth user (0002), todo_lists a family
  // member (0015), which a link does not carry — so null there, as before.
  const made = table === 'todo_lists'
    ? await ensureTodoListId(supabase, link.family_id, null, name, false)
    : await ensureDefaultGroceryListId(supabase, link.family_id, link.user_id, name);
  if (!made.id) { console.error(`[assistant] ${table} create failed`, made.error); return null; }
  return { id: made.id, created: true };
}

/**
 * Undo a list this capture created, when the item it was created for was not
 * written — so a failure the person is told about ("I have not changed
 * anything") leaves nothing behind.
 *
 * Only a list this request found missing and then had to make, and only while
 * it is still EMPTY: under the get-or-create above a concurrent capture may
 * have been handed the same list, and the item foreign keys cascade, so
 * deleting a list that holds someone else's item would delete the item. Best
 * effort, never thrown — the reply is already an error.
 */
async function discardEmptyList(
  supabase: Client, link: AssistantLink, table: 'todo_lists' | 'grocery_lists', list: EnsuredList,
): Promise<void> {
  if (!list.created) return;
  try {
    const itemTable = table === 'todo_lists' ? 'todo_items' : 'grocery_items';
    const { data: items, error: itemsError } = await supabase
      .from(itemTable).select('id').eq('family_id', link.family_id).eq('list_id', list.id).limit(1);
    if (itemsError || (items ?? []).length > 0) return;
    // Read back, so a delete that matched nothing (a list already gone, or a
    // policy that filtered it) is logged rather than taken for a cleanup.
    const { data: removed, error } = await supabase.from(table).delete().eq('id', list.id).eq('family_id', link.family_id).select('id');
    if (error) console.error(`[assistant] ${table} cleanup failed`, error);
    else if (wroteNoRows(removed)) console.error(`[assistant] ${table} cleanup removed nothing`, { listId: list.id });
  } catch (err) {
    console.error(`[assistant] ${table} cleanup failed`, err);
  }
}
