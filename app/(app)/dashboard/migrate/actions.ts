'use server';
// Commits a parsed competitor export into the signed-in user's family.
// Family-scoped + RLS-bound (createServer), only inserts whitelisted fields,
// de-duplicates calendar events and contacts, and records the import in
// audit_logs.
//
// M29: the import is now a THREE-step flow — parse in the browser, resolve
// against the family's own rows on the server (`prepareImport`), then commit
// what a person actually agreed to. `prepareImport` is the only place that
// reads existing members/events/contacts, and it fails closed: a read that
// errors returns a retryable failure rather than an empty proposal, because an
// empty proposal reads as "you have nothing like this yet" and would import a
// second copy of everything.
import { revalidatePath } from 'next/cache';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { getTranslations } from '@/lib/i18n/server';
import type { EventCategory } from '@/lib/database.types';
import { normalizeEmail, normalizePhone } from '@/lib/migrate/parse';
import {
  eventKey, resolveImportedItems,
  type ExistingContact, type ExistingMember, type ResolutionPlan,
} from '@/lib/migrate/resolve';

export type ImportEventInput = {
  title: string; startsAt: string; endsAt: string | null; allDay: boolean;
  location: string | null; description: string | null;
  /** `family_members.id` the reviewer assigned (or the proposal they kept). */
  memberId?: string | null;
  category?: EventCategory | null;
  /** The reviewer left this one out (a duplicate they chose not to re-import). */
  skip?: boolean;
};

export type ImportContactInput = {
  name: string; emails: string[]; phones: string[];
  organization?: string | null; notes?: string | null;
  memberId?: string | null;
  skip?: boolean;
};

export type ImportItemInput = { name: string; extra?: string | null; memberId?: string | null; skip?: boolean };

export type ImportPayload = {
  source: string; // competitor key
  events?: ImportEventInput[];
  tasks?: ImportItemInput[];
  grocery?: ImportItemInput[];
  notes?: ImportItemInput[];
  contacts?: ImportContactInput[];
};

export type ImportCounts = { events: number; tasks: number; grocery: number; notes: number; contacts: number };

export type ImportResult =
  | { ok: true; counts: ImportCounts; skipped: number; assigned: number }
  | { ok: false; error: string; retryable?: boolean };

export type PrepareResult =
  | { ok: true; plan: ResolutionPlan; members: ExistingMember[] }
  | { ok: false; error: string; retryable?: boolean };

const cap = <T,>(arr: T[] | undefined, n = 2000): T[] => (arr ?? []).slice(0, n);
const included = <T extends { skip?: boolean }>(arr: T[] | undefined, n = 2000): T[] =>
  cap(arr, n).filter((x) => !x.skip);

/** The family's members, as the matcher wants them. */
async function loadMembers(
  supabase: Awaited<ReturnType<typeof createServer>>,
  familyId: string,
): Promise<{ ok: true; members: ExistingMember[] } | { ok: false }> {
  const { data, error } = await supabase
    .from('family_members').select('id, display_name')
    .eq('family_id', familyId).eq('is_active', true);
  if (error) {
    console.error('[migrate] family members read failed', error);
    return { ok: false };
  }
  return { ok: true, members: (data ?? []).map((m) => ({ id: m.id, displayName: m.display_name ?? '' })) };
}

/**
 * Resolve a parsed export against what the family already has: who each item
 * looks like it belongs to, and what is already here. Nothing is written.
 */
export async function prepareImport(payload: ImportPayload): Promise<PrepareResult> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const memberRes = await loadMembers(supabase, familyId);
  if (!memberRes.ok) return { ok: false, error: t('migrateActions.couldNotReadYourFamilyToReview'), retryable: true };

  const events = cap(payload.events);
  const contacts = cap(payload.contacts);

  let existingEvents: { title: string; startsAt: string }[] = [];
  if (events.length) {
    const earliest = events.reduce((min, e) => (e.startsAt < min ? e.startsAt : min), events[0].startsAt);
    const { data, error } = await supabase
      .from('calendar_events').select('title, starts_at')
      .eq('family_id', familyId).gte('starts_at', earliest).limit(5000);
    if (error) {
      console.error('[migrate] existing calendar read failed', error);
      return { ok: false, error: t('migrateActions.couldNotCheckYourCalendarForDuplicates'), retryable: true };
    }
    existingEvents = (data ?? []).map((e) => ({ title: e.title, startsAt: e.starts_at }));
  }

  let existingContacts: ExistingContact[] = [];
  if (contacts.length) {
    const { data, error } = await supabase
      .from('family_contacts').select('name, email, phone, phone_alt')
      .eq('family_id', familyId).limit(5000);
    if (error) {
      console.error('[migrate] existing contacts read failed', error);
      return { ok: false, error: t('migrateActions.couldNotCheckYourContactsForDuplicates'), retryable: true };
    }
    existingContacts = (data ?? []).map((c) => ({ name: c.name, email: c.email, phone: c.phone, phoneAlt: c.phone_alt }));
  }

  const plan = resolveImportedItems({
    members: memberRes.members,
    events,
    tasks: cap(payload.tasks),
    contacts: contacts.map((c) => ({
      name: c.name,
      emails: c.emails ?? [],
      phones: c.phones ?? [],
      organization: c.organization ?? null,
      notes: c.notes ?? null,
    })),
    existingEvents,
    existingContacts,
  });
  return { ok: true, plan, members: memberRes.members };
}

export async function commitImport(payload: ImportPayload): Promise<ImportResult> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const userId = ctx.user.id;
  const supabase = await createServer();

  const counts: ImportCounts = { events: 0, tasks: 0, grocery: 0, notes: 0, contacts: 0 };
  let skipped = 0;
  let assigned = 0;

  // Member ids are caller input, so they are checked against the family before
  // any of them reaches an `assignee_id`/`linked_member_id` column.
  const memberRes = await loadMembers(supabase, familyId);
  if (!memberRes.ok) return { ok: false, error: t('migrateActions.couldNotReadYourFamilyToReview'), retryable: true };
  const memberIds = new Set(memberRes.members.map((m) => m.id));
  const memberOf = (id: string | null | undefined): string | null => (id && memberIds.has(id) ? id : null);

  // ── Events → calendar_events (de-duped by title + start) ──
  const events = included(payload.events);
  if (events.length) {
    const earliest = events.reduce((min, e) => (e.startsAt < min ? e.startsAt : min), events[0].startsAt);
    const { data: existing, error: existingErr } = await supabase
      .from('calendar_events').select('title, starts_at')
      .eq('family_id', familyId).gte('starts_at', earliest).limit(5000);
    if (existingErr) {
      console.error('[migrate] existing calendar read failed', existingErr);
      return { ok: false, error: t('migrateActions.couldNotCheckYourCalendarForDuplicates'), retryable: true };
    }
    const seen = new Set((existing ?? []).map((e) => eventKey(e.title, e.starts_at)));
    const toInsert = events.filter((e) => {
      const key = eventKey(e.title, e.startsAt);
      if (seen.has(key)) { skipped++; return false; }
      seen.add(key); return true;
    }).map((e) => {
      const assignee = memberOf(e.memberId);
      if (assignee) assigned++;
      return {
        family_id: familyId, title: e.title.slice(0, 300), description: e.description,
        location: e.location, category: (e.category ?? 'general') as EventCategory,
        starts_at: e.startsAt, ends_at: e.endsAt, all_day: e.allDay, created_by: userId,
        assignee_id: assignee,
      };
    });
    for (let i = 0; i < toInsert.length; i += 500) {
      const { error, count } = await supabase.from('calendar_events').insert(toInsert.slice(i, i + 500), { count: 'exact' });
      if (error) return { ok: false, error: `Events: ${error.message}` };
      counts.events += count ?? toInsert.slice(i, i + 500).length;
    }
  }

  // ── Tasks → chores (+ an assignment for each reviewed owner) ──
  const tasks = included(payload.tasks);
  if (tasks.length) {
    const rows = tasks.map((t2) => ({ family_id: familyId, title: t2.name.slice(0, 200), description: t2.extra ?? null, created_by: userId }));
    const { data: created, error } = await supabase.from('chores').insert(rows).select('id');
    if (error) return { ok: false, error: `Tasks: ${error.message}` };
    counts.tasks = created?.length ?? rows.length;
    const assignments = (created ?? []).flatMap((row, i) => {
      const member = memberOf(tasks[i]?.memberId);
      if (!member) return [];
      assigned++;
      return [{ family_id: familyId, chore_id: row.id, member_id: member }];
    });
    if (assignments.length) {
      const { error: assignErr } = await supabase.from('chore_assignments').insert(assignments);
      if (assignErr) return { ok: false, error: `Tasks: ${assignErr.message}` };
    }
  }

  // ── Grocery → grocery_items (into an "Imported" list) ──
  const grocery = included(payload.grocery);
  if (grocery.length) {
    const listName = 'Imported Groceries';
    let listId: string | null = null;
    const { data: list } = await supabase.from('grocery_lists').select('id').eq('family_id', familyId).eq('name', listName).maybeSingle();
    listId = list?.id ?? null;
    if (!listId) {
      const { data: createdList, error } = await supabase.from('grocery_lists').insert({ family_id: familyId, name: listName, created_by: userId }).select('id').single();
      if (error) return { ok: false, error: `Grocery list: ${error.message}` };
      listId = createdList.id;
    }
    const rows = grocery.map((g) => ({ family_id: familyId, list_id: listId!, name: g.name.slice(0, 200), quantity: g.extra ?? null, created_by: userId }));
    const { error, count } = await supabase.from('grocery_items').insert(rows, { count: 'exact' });
    if (error) return { ok: false, error: `Grocery: ${error.message}` };
    counts.grocery = count ?? rows.length;
  }

  // ── Notes → notes ──
  const notes = included(payload.notes);
  if (notes.length) {
    const rows = notes.map((n) => ({ family_id: familyId, title: n.name.slice(0, 200), body: n.extra ?? '', created_by: userId }));
    const { error, count } = await supabase.from('notes').insert(rows, { count: 'exact' });
    if (error) return { ok: false, error: `Notes: ${error.message}` };
    counts.notes = count ?? rows.length;
  }

  // ── Contacts → family_contacts (de-duped by email/phone, then by name) ──
  const contacts = included(payload.contacts);
  if (contacts.length) {
    const { data: existing, error: existingErr } = await supabase
      .from('family_contacts').select('name, email, phone, phone_alt')
      .eq('family_id', familyId).limit(5000);
    if (existingErr) {
      console.error('[migrate] existing contacts read failed', existingErr);
      return { ok: false, error: t('migrateActions.couldNotCheckYourContactsForDuplicates'), retryable: true };
    }
    const seen = new Set<string>();
    const seenNames = new Set<string>();
    for (const row of existing ?? []) {
      const email = normalizeEmail(row.email);
      if (email) seen.add(`email:${email}`);
      for (const p of [row.phone, row.phone_alt]) {
        const phone = normalizePhone(p);
        if (phone) seen.add(`phone:${phone}`);
      }
      if (row.name?.trim()) seenNames.add(row.name.trim().toLowerCase());
    }
    const rows: {
      family_id: string; name: string; email: string | null; phone: string | null;
      phone_alt: string | null; organization: string | null; notes: string | null;
      linked_member_id: string | null; created_by: string;
    }[] = [];
    for (const c of contacts) {
      const name = c.name.trim();
      if (!name) continue;
      const emails = (c.emails ?? []).map((e) => e.trim()).filter(Boolean);
      const phones = (c.phones ?? []).map((p) => p.trim()).filter(Boolean);
      const keys = [
        ...emails.map((e) => `email:${normalizeEmail(e)}`).filter((k) => k !== 'email:'),
        ...phones.map((p) => `phone:${normalizePhone(p)}`).filter((k) => k !== 'phone:'),
      ];
      const isDuplicate = keys.length > 0
        ? keys.some((k) => seen.has(k))
        : seenNames.has(name.toLowerCase());
      if (isDuplicate) { skipped++; continue; }
      for (const k of keys) seen.add(k);
      seenNames.add(name.toLowerCase());
      const member = memberOf(c.memberId);
      if (member) assigned++;
      rows.push({
        family_id: familyId,
        name: name.slice(0, 200),
        email: emails[0] ?? null,
        phone: phones[0] ?? null,
        phone_alt: phones[1] ?? null,
        organization: c.organization?.slice(0, 200) || null,
        notes: c.notes?.slice(0, 1000) || null,
        linked_member_id: member,
        created_by: userId,
      });
    }
    for (let i = 0; i < rows.length; i += 500) {
      const { error, count } = await supabase.from('family_contacts').insert(rows.slice(i, i + 500), { count: 'exact' });
      if (error) return { ok: false, error: `Contacts: ${error.message}` };
      counts.contacts += count ?? rows.slice(i, i + 500).length;
    }
  }

  await supabase.from('audit_logs').insert({
    family_id: familyId, actor_id: userId, action: 'import', resource: 'migration',
    metadata: { source: payload.source, counts, skipped, assigned },
  });
  revalidatePath('/dashboard', 'layout');
  return { ok: true, counts, skipped, assigned };
}
