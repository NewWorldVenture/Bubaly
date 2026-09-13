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
import {
  agendaSpeech, forgettingSpeech, nextSpeech,
  CAPTURE_NOT_ALLOWED_SPEECH, type AgendaEvent, type AgendaTask,
} from './answers';
import { captureSpeech, unknownSpeech, HELP_SPEECH, boundSpeech, type AssistantIntent } from './intent';
import type { VoiceRoute } from '@/lib/voice/command-router';

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

/** Longest utterance worth storing on the audit row. */
const UTTERANCE_LOG_CHARS = 240;

/**
 * The live link this token belongs to, or null.
 *
 * Null covers every failure the caller must treat identically — unknown token,
 * revoked link, missing family — because distinguishing them to the caller
 * would turn this into an oracle for guessing tokens.
 */
export async function resolveAssistantLink(supabase: Client, token: string): Promise<AssistantLink | null> {
  const { data, error } = await supabase
    .from('assistant_links')
    .select('id, family_id, user_id, provider, scopes, revoked_at, families(timezone)')
    .eq('token_hash', hashAssistantToken(token))
    .is('revoked_at', null)
    .maybeSingle();
  if (error) {
    console.error('[assistant] link lookup failed', error);
    return null;
  }
  if (!data) return null;
  const row = data as unknown as {
    id: string; family_id: string; user_id: string; provider: string; scopes: string[] | null;
    families: { timezone: string } | { timezone: string }[] | null;
  };
  const family = Array.isArray(row.families) ? row.families[0] : row.families;
  return {
    id: row.id,
    family_id: row.family_id,
    user_id: row.user_id,
    provider: row.provider,
    scopes: row.scopes ?? [],
    timezone: family?.timezone || 'UTC',
  };
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
  const base = new Date(now.getTime() + offsetDays * 86_400_000);
  const key = dayKey(base, timezone);
  const [year, month, day] = key.split('-').map(Number);
  // Midnight local, resolved through the zone the same way the recurring-ads
  // scheduler does: a fixed UTC offset would drift an hour across a DST change
  // and quietly show the wrong day's events twice a year.
  const guess = Date.UTC(year, month - 1, day);
  const offsetAt = (instant: number) => {
    const p: Record<string, string> = {};
    const f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    for (const part of f.formatToParts(new Date(instant))) p[part.type] = part.value;
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute)) - instant;
  };
  let start = guess - offsetAt(guess);
  start = guess - offsetAt(start);
  return { from: new Date(start).toISOString(), to: new Date(start + 86_400_000).toISOString() };
}

async function readEvents(
  supabase: Client, familyId: string, window: { from: string; to: string },
): Promise<AgendaEvent[]> {
  const { data, error } = await supabase
    .from('calendar_events')
    .select('title, starts_at, all_day')
    .eq('family_id', familyId)
    .gte('starts_at', window.from)
    .lt('starts_at', window.to)
    .order('starts_at')
    .limit(50);
  if (error) throw error;
  return (data ?? []) as unknown as AgendaEvent[];
}

async function readOpenTasks(supabase: Client, familyId: string): Promise<AgendaTask[]> {
  const { data, error } = await supabase
    .from('todo_items')
    .select('title, due_date')
    .eq('family_id', familyId)
    .eq('is_done', false)
    .not('due_date', 'is', null)
    .order('due_date')
    .limit(100);
  if (error) throw error;
  return (data ?? []) as unknown as AgendaTask[];
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
  const { error: touchError } = await supabase
    .from('assistant_links')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', link.id);
  if (touchError) console.error('[assistant] last-used update failed', touchError);
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
      const events = await readEvents(supabase, link.family_id, window);
      return { speech: agendaSpeech(events, intent.day, link.timezone), outcome: 'answered', intent: 'agenda' };
    }

    case 'next': {
      const window = dayWindow(now, link.timezone);
      const events = await readEvents(supabase, link.family_id, window);
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

    case 'capture': {
      if (!link.scopes.includes('capture')) {
        return { speech: CAPTURE_NOT_ALLOWED_SPEECH, outcome: 'refused', intent: 'capture' };
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
  const title = boundSpeech(route.text, 200);
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
    const listId = await ensureList(supabase, link, 'grocery_lists', 'Groceries');
    if (!listId) return false;
    const { error } = await supabase.from('grocery_items').insert({
      family_id: link.family_id, list_id: listId, name: title, created_by: link.user_id,
    } as never);
    if (error) { console.error('[assistant] grocery insert failed', error); return false; }
    return true;
  }

  const listId = await ensureList(supabase, link, 'todo_lists', 'To do');
  if (!listId) return false;
  // "Remind me to renew the passports on Friday" is a task that is due on
  // Friday. Dropping the day made it a task due whenever someone noticed it,
  // which is the thing the person was asking not to have to do.
  const { error } = await supabase.from('todo_items').insert({
    family_id: link.family_id, list_id: listId, title,
    ...(route.dueDate ? { due_date: route.dueDate } : {}),
  } as never);
  if (error) { console.error('[assistant] task insert failed', error); return false; }
  return true;
}

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
): Promise<string | null> {
  const { data: existing, error } = await supabase
    .from(table).select('id').eq('family_id', link.family_id)
    .order('created_at').limit(1).maybeSingle();
  if (error) { console.error(`[assistant] ${table} lookup failed`, error); return null; }
  if (existing?.id) return existing.id;

  const { data: created, error: createError } = await supabase
    .from(table)
    .insert({ family_id: link.family_id, name } as never)
    .select('id').single();
  if (createError || !created) { console.error(`[assistant] ${table} create failed`, createError); return null; }
  return created.id;
}
