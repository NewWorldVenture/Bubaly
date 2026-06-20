'use server';
// Commits a parsed competitor export into the signed-in user's family.
// Family-scoped + RLS-bound (createServer), only inserts whitelisted fields,
// de-duplicates calendar events, and records the import in audit_logs.
import { revalidatePath } from 'next/cache';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';

export type ImportPayload = {
  source: string; // competitor key
  events?: { title: string; startsAt: string; endsAt: string | null; allDay: boolean; location: string | null; description: string | null }[];
  tasks?: { name: string; extra?: string | null }[];
  grocery?: { name: string; extra?: string | null }[];
  notes?: { name: string; extra?: string | null }[];
};

export type ImportResult =
  | { ok: true; counts: { events: number; tasks: number; grocery: number; notes: number }; skipped: number }
  | { ok: false; error: string };

const cap = <T,>(arr: T[] | undefined, n = 2000): T[] => (arr ?? []).slice(0, n);

export async function commitImport(payload: ImportPayload): Promise<ImportResult> {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const userId = ctx.user.id;
  const supabase = await createServer();

  const counts = { events: 0, tasks: 0, grocery: 0, notes: 0 };
  let skipped = 0;

  // ── Events → calendar_events (de-duped by title + start) ──
  const events = cap(payload.events);
  if (events.length) {
    const earliest = events.reduce((min, e) => (e.startsAt < min ? e.startsAt : min), events[0].startsAt);
    const { data: existing } = await supabase
      .from('calendar_events').select('title, starts_at')
      .eq('family_id', familyId).gte('starts_at', earliest);
    const seen = new Set((existing ?? []).map((e) => `${e.title}|${e.starts_at}`));
    const toInsert = events.filter((e) => {
      const key = `${e.title}|${e.startsAt}`;
      if (seen.has(key)) { skipped++; return false; }
      seen.add(key); return true;
    }).map((e) => ({
      family_id: familyId, title: e.title.slice(0, 300), description: e.description,
      location: e.location, category: 'general' as const,
      starts_at: e.startsAt, ends_at: e.endsAt, all_day: e.allDay, created_by: userId,
    }));
    for (let i = 0; i < toInsert.length; i += 500) {
      const { error, count } = await supabase.from('calendar_events').insert(toInsert.slice(i, i + 500), { count: 'exact' });
      if (error) return { ok: false, error: `Events: ${error.message}` };
      counts.events += count ?? toInsert.slice(i, i + 500).length;
    }
  }

  // ── Tasks → chores ──
  const tasks = cap(payload.tasks);
  if (tasks.length) {
    const rows = tasks.map((t) => ({ family_id: familyId, title: t.name.slice(0, 200), description: t.extra ?? null, created_by: userId }));
    const { error, count } = await supabase.from('chores').insert(rows, { count: 'exact' });
    if (error) return { ok: false, error: `Tasks: ${error.message}` };
    counts.tasks = count ?? rows.length;
  }

  // ── Grocery → grocery_items (into an "Imported" list) ──
  const grocery = cap(payload.grocery);
  if (grocery.length) {
    const listName = 'Imported Groceries';
    let listId: string | null = null;
    const { data: list } = await supabase.from('grocery_lists').select('id').eq('family_id', familyId).eq('name', listName).maybeSingle();
    listId = list?.id ?? null;
    if (!listId) {
      const { data: created, error } = await supabase.from('grocery_lists').insert({ family_id: familyId, name: listName, created_by: userId }).select('id').single();
      if (error) return { ok: false, error: `Grocery list: ${error.message}` };
      listId = created.id;
    }
    const rows = grocery.map((g) => ({ family_id: familyId, list_id: listId!, name: g.name.slice(0, 200), quantity: g.extra ?? null, created_by: userId }));
    const { error, count } = await supabase.from('grocery_items').insert(rows, { count: 'exact' });
    if (error) return { ok: false, error: `Grocery: ${error.message}` };
    counts.grocery = count ?? rows.length;
  }

  // ── Notes → notes ──
  const notes = cap(payload.notes);
  if (notes.length) {
    const rows = notes.map((n) => ({ family_id: familyId, title: n.name.slice(0, 200), body: n.extra ?? '', created_by: userId }));
    const { error, count } = await supabase.from('notes').insert(rows, { count: 'exact' });
    if (error) return { ok: false, error: `Notes: ${error.message}` };
    counts.notes = count ?? rows.length;
  }

  await supabase.from('audit_logs').insert({
    family_id: familyId, actor_id: userId, action: 'import', resource: 'migration',
    metadata: { source: payload.source, counts, skipped },
  });
  revalidatePath('/dashboard', 'layout');
  return { ok: true, counts, skipped };
}
