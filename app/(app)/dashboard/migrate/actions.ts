'use server';
// Commits a parsed competitor export into the signed-in user's family.
// Family-scoped + RLS-bound (createServer), only inserts whitelisted fields,
// de-duplicates calendar events, contacts and grocery items, and records the
// import in audit_logs. Tasks and notes are NOT de-duplicated — see the list of
// which kinds are and why in lib/migrate/resolve.ts — and the review step says
// so rather than leaving the family to find out on the second import.
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
import { normalizeName } from '@/lib/groceries/normalize-name';
import { normalizeEmail, normalizePhone } from '@/lib/migrate/parse';
import { logAudit } from '@/lib/server/audit';
import {
  eventKey, resolveImportedItems,
  type ExistingContact, type ExistingGroceryItem, type ExistingMember, type ResolutionPlan,
} from '@/lib/migrate/resolve';
import { readAll } from '@/lib/supabase/read-all';

/**
 * The list an import's grocery items land on. Named once because it is now TWO
 * things: where the rows are written, and the scope the duplicate check is
 * taken over. A second spelling of it here would mean reviewing against one
 * list and writing to another.
 */
const IMPORT_GROCERY_LIST = 'Imported Groceries';

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
 * The import's grocery list and the items still to buy on it — the duplicate set
 * for grocery.
 *
 * ONE helper for both halves of the flow, deliberately: the review step and the
 * commit have to take this set over the same list under the same "unbought"
 * filter, or the review badges a row as already here and the commit inserts it
 * anyway (or the reverse, which is worse — a silent drop).
 *
 * `listId` null means the family has no live import list yet. That is the
 * ordinary first import and an EMPTY duplicate set, not a failure. A read that
 * ERRORS is a failure and says so: an empty set reads as "you have none of this
 * yet", which is precisely how a second copy of the whole file gets imported.
 */
async function loadImportGrocery(
  supabase: Awaited<ReturnType<typeof createServer>>,
  familyId: string,
): Promise<{ ok: true; listId: string | null; open: ExistingGroceryItem[] } | { ok: false }> {
  // Reuse the import list only while it is live: adopting an archived one hides
  // the whole import behind the archive the family put it in.
  const { data: list, error: listError } = await supabase
    .from('grocery_lists').select('id')
    .eq('family_id', familyId).eq('name', IMPORT_GROCERY_LIST)
    .eq('is_archived', false).is('archived_at', null).maybeSingle();
  if (listError) {
    console.error('[migrate] grocery list read failed', listError);
    return { ok: false };
  }
  const listId = list?.id ?? null;
  if (!listId) return { ok: true, listId: null, open: [] };
  // Unbought only — the rule borrowed from `addItems`. Checked items are not
  // part of the comparison, so last week's milk is addable again.
  const { rows, error } = await readAll((from, to) => supabase
    .from('grocery_items').select('name')
    .eq('family_id', familyId).eq('list_id', listId).eq('is_checked', false)
    .order('id').range(from, to), { max: 5000 });
  if (error) {
    console.error('[migrate] existing grocery read failed', error);
    return { ok: false };
  }
  return { ok: true, listId, open: (rows ?? []).map((r) => ({ name: r.name })) };
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
  const grocery = cap(payload.grocery);

  let existingEvents: { title: string; startsAt: string }[] = [];
  if (events.length) {
    const earliest = events.reduce((min, e) => (e.startsAt < min ? e.startsAt : min), events[0].startsAt);
    // This read is the DE-DUPE set: anything it fails to see gets imported a
    // second time. `.limit(5000)` was never 5,000 — PostgREST caps at
    // db-max-rows — and a household already holds 1,906 events (measured).
    const { rows: data, error } = await readAll((from, to) => supabase
      .from('calendar_events').select('title, starts_at')
      .eq('family_id', familyId).gte('starts_at', earliest)
      .order('id').range(from, to), { max: 5000 });
    if (error) {
      console.error('[migrate] existing calendar read failed', error);
      return { ok: false, error: t('migrateActions.couldNotCheckYourCalendarForDuplicates'), retryable: true };
    }
    existingEvents = (data ?? []).map((e) => ({ title: e.title, startsAt: e.starts_at }));
  }

  let existingContacts: ExistingContact[] = [];
  if (contacts.length) {
    // The de-dupe set again — a short read means duplicate contacts.
    const { rows: data, error } = await readAll((from, to) => supabase
      .from('family_contacts').select('name, email, phone, phone_alt')
      .eq('family_id', familyId).order('id').range(from, to), { max: 5000 });
    if (error) {
      console.error('[migrate] existing contacts read failed', error);
      return { ok: false, error: t('migrateActions.couldNotCheckYourContactsForDuplicates'), retryable: true };
    }
    existingContacts = (data ?? []).map((c) => ({ name: c.name, email: c.email, phone: c.phone, phoneAlt: c.phone_alt }));
  }

  let existingGrocery: ExistingGroceryItem[] = [];
  if (grocery.length) {
    // The de-dupe set again — a failed read here means duplicate groceries.
    const res = await loadImportGrocery(supabase, familyId);
    if (!res.ok) return { ok: false, error: t('migrateActions.couldNotCheckYourShoppingListForDuplicates'), retryable: true };
    existingGrocery = res.open;
  }

  const plan = resolveImportedItems({
    members: memberRes.members,
    events,
    tasks: cap(payload.tasks),
    grocery,
    contacts: contacts.map((c) => ({
      name: c.name,
      emails: c.emails ?? [],
      phones: c.phones ?? [],
      organization: c.organization ?? null,
      notes: c.notes ?? null,
    })),
    existingEvents,
    existingContacts,
    existingGrocery,
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

  // A write that fails part way through is reported with what was ALREADY
  // saved, not with the database's own sentence. `error.message` is PostgREST
  // text — "relation … does not exist", a constraint name — in English whatever
  // the family's locale, and it says nothing about the half of the import that
  // did land. The counts do, and they are what the family needs before deciding
  // whether to run the file again: events, contacts and grocery items are
  // de-duplicated on a second pass, tasks and notes are not. Not `retryable`: a
  // retry button here would offer exactly that duplication.
  const partialFailure = (label: string, error: { message: string }): ImportResult => {
    console.error(`[migrate] ${label} write failed`, error);
    return { ok: false, error: t('migrateActions.theImportStoppedPartWayThrough', counts) };
  };
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
    // The de-dupe set the IMPORT itself checks against — see above.
    const { rows: existing, error: existingErr } = await readAll((from, to) => supabase
      .from('calendar_events').select('title, starts_at')
      .eq('family_id', familyId).gte('starts_at', earliest)
      .order('id').range(from, to), { max: 5000 });
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
      if (error) return partialFailure('calendar events', error);
      counts.events += count ?? toInsert.slice(i, i + 500).length;
    }
  }

  // ── Tasks → chores (+ an assignment for each reviewed owner) ──
  const tasks = included(payload.tasks);
  if (tasks.length) {
    const rows = tasks.map((t2) => ({ family_id: familyId, title: t2.name.slice(0, 200), description: t2.extra ?? null, created_by: userId }));
    const { data: created, error } = await supabase.from('chores').insert(rows).select('id');
    if (error) return partialFailure('chores', error);
    counts.tasks = created?.length ?? rows.length;
    const assignments = (created ?? []).flatMap((row, i) => {
      const member = memberOf(tasks[i]?.memberId);
      if (!member) return [];
      assigned++;
      return [{ family_id: familyId, chore_id: row.id, member_id: member }];
    });
    if (assignments.length) {
      const { error: assignErr } = await supabase.from('chore_assignments').insert(assignments);
      if (assignErr) return partialFailure('chore assignments', assignErr);
    }
  }

  // ── Grocery → grocery_items (into an "Imported" list, de-duped by name) ──
  const grocery = included(payload.grocery);
  if (grocery.length) {
    // The de-dupe set the IMPORT itself checks against — the review step's badge
    // is a proposal, and re-deciding here is what stops a stale review, a second
    // browser tab or a direct call to this action from writing the second copy.
    // Same helper, so the two halves cannot scope it differently.
    const res = await loadImportGrocery(supabase, familyId);
    if (!res.ok) return { ok: false, error: t('migrateActions.couldNotCheckYourShoppingListForDuplicates'), retryable: true };
    const seen = new Set(res.open.map((g) => normalizeName(g.name)));
    const kept: { name: string; quantity: string | null }[] = [];
    for (const g of grocery) {
      const key = normalizeName(g.name);
      if (seen.has(key)) { skipped++; continue; }
      seen.add(key);
      kept.push({ name: g.name.slice(0, 200), quantity: g.extra ?? null });
    }
    // The list is created only once something survives the filter: a re-import of
    // a file whose every item is already there leaves no empty list behind.
    if (kept.length) {
      let listId = res.listId;
      if (!listId) {
        const { data: createdList, error } = await supabase.from('grocery_lists')
          .insert({ family_id: familyId, name: IMPORT_GROCERY_LIST, created_by: userId }).select('id').single();
        if (error) return partialFailure('grocery list', error);
        listId = createdList.id;
      }
      const targetList = listId;
      const rows = kept.map((k) => ({ family_id: familyId, list_id: targetList, name: k.name, quantity: k.quantity, created_by: userId }));
      const { error, count } = await supabase.from('grocery_items').insert(rows, { count: 'exact' });
      if (error) return partialFailure('grocery items', error);
      counts.grocery = count ?? rows.length;
    }
  }

  // ── Notes → notes ──
  const notes = included(payload.notes);
  if (notes.length) {
    const rows = notes.map((n) => ({ family_id: familyId, title: n.name.slice(0, 200), body: n.extra ?? '', created_by: userId }));
    const { error, count } = await supabase.from('notes').insert(rows, { count: 'exact' });
    if (error) return partialFailure('notes', error);
    counts.notes = count ?? rows.length;
  }

  // ── Contacts → family_contacts (de-duped by email/phone, then by name) ──
  const contacts = included(payload.contacts);
  if (contacts.length) {
    // The de-dupe set the IMPORT itself checks against — see above.
    const { rows: existing, error: existingErr } = await readAll((from, to) => supabase
      .from('family_contacts').select('name, email, phone, phone_alt')
      .eq('family_id', familyId).order('id').range(from, to), { max: 5000 });
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
      if (error) return partialFailure('contacts', error);
      counts.contacts += count ?? rows.slice(i, i + 500).length;
    }
  }

  await logAudit(supabase, {
    familyId, actorId: userId, action: 'import', resource: 'migration',
    metadata: { source: payload.source, counts, skipped, assigned },
  });
  revalidatePath('/dashboard', 'layout');
  return { ok: true, counts, skipped, assigned };
}
