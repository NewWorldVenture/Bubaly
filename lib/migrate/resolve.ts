// lib/migrate/resolve.ts — entity resolution for the competitor importer.
//
// The importer used to go straight from "we parsed 240 rows" to "we wrote 240
// rows". Two things a family notices went missing in that jump:
//
//   * WHO each item belongs to. "Emma — dentist" is Emma's appointment, and an
//     import that drops the person turns a shared calendar into a wall of
//     unattributed text the family has to re-assign by hand.
//   * WHAT they already have. Re-importing an export after fixing one row (or
//     switching apps twice) duplicated everything except events, which were the
//     only kind the commit de-duplicated.
//
// So resolution happens BEFORE the write, as a proposal a person reviews: every
// item carries the member it looks like it belongs to and whether the family
// already holds it. Pure and DOM-free — the wizard renders the proposal, the
// server action reads the same functions to build the rows, and both are tested
// without a database.
//
// HOW EACH KIND IS DE-DUPLICATED — all five are, each on the identity it has:
//
//   * events    — title + start instant (`eventKey`).
//   * contacts  — normalised email/phone, falling back to an exact name.
//   * grocery   — normalised name against the UNBOUGHT items of the list the
//                 import writes to. Not a new rule: it is the one
//                 `lib/services/groceries/index.ts addItems` already applies to
//                 a typed add, borrowed verbatim so the two cannot disagree.
//   * tasks and — the WHOLE imported row (`itemKey(name, extra)`: title and
//     notes       details) against every `chores` / `notes` row in the family.
//
// Tasks and notes carry no natural key, and a keyless list legitimately
// repeats, which is why the key is the whole row and not the name. It does not
// guess at that repetition, it only recognises the row an import itself wrote:
//
//   * A `chores` row is a chore's DEFINITION. Doing it again is a new
//     `chore_assignments` row (and `recurrence`), never a second chore, so
//     "the bins go out every week" is one row however often it is done, and
//     done-ness (`chore_assignments.status`) has no part in its identity.
//   * A note matches only when its title AND its whole body match. Two notes
//     that say exactly the same thing are the second copy of an export, not a
//     second thought. A typed note (`lib/services/notes`) is untouched:
//     writing the same reminder twice by hand still writes it twice.
//
// Every kind is proposed in the review (badge + Skip box) AND re-decided by
// the commit, so a stale review or a direct call cannot write the second copy.
//
// Deliberately conservative. A proposal that is wrong costs the reviewer a
// click; a proposal that is confidently wrong and auto-applied costs them trust.
// So a member is proposed only on a WHOLE-token name match, an ambiguous text
// takes the name that appears first, and nothing is ever assigned to a member
// the caller did not list.

import type { EventCategory } from '@/lib/database.types';
import { normalizeName } from '@/lib/groceries/normalize-name';
import {
  contactKeys, normalizeEmail, normalizePhone,
  type ImportedContact, type ImportedEvent, type ImportedItem,
} from './parse';

/** A `family_members` row, reduced to what matching needs. */
export type ExistingMember = { id: string; displayName: string };
/** A `calendar_events` row already in the family (the duplicate guard). */
export type ExistingEvent = { title: string; startsAt: string };
/** A `family_contacts` row already in the family (the duplicate guard). */
export type ExistingContact = { name: string; email: string | null; phone: string | null; phoneAlt?: string | null };
/**
 * A `grocery_items` row the import has to compare against: an item still to buy
 * on the list the import writes to. The caller decides which rows qualify — see
 * `resolveImportedItems` for why "still to buy" is the whole of the rule, and
 * why passing a checked item here would be a bug rather than extra safety.
 */
export type ExistingGroceryItem = { name: string };
/**
 * A `chores` (title, description) or `notes` (title, body) row already in the
 * family, in the shape the importer writes it from: `name` + `extra`.
 */
export type ExistingItem = { name: string | null; extra: string | null };

export type MemberProposal = { memberId: string | null; memberName: string | null };

export type ResolvedEvent = MemberProposal & {
  index: number;
  title: string;
  startsAt: string;
  category: EventCategory;
  duplicate: boolean;
};

export type ResolvedTask = MemberProposal & {
  index: number;
  name: string;
  duplicate: boolean;
};

/** No `MemberProposal`, for the grocery reason: `notes` has no member column. */
export type ResolvedNote = {
  index: number;
  name: string;
  duplicate: boolean;
};

export type ResolvedContact = MemberProposal & {
  index: number;
  name: string;
  duplicate: boolean;
};

/**
 * No `MemberProposal`: the importer's grocery insert has no member column to
 * put one in, and proposing an owner the commit would silently drop is exactly
 * the confidently-wrong proposal this module's header refuses to make.
 */
export type ResolvedGroceryItem = {
  index: number;
  name: string;
  duplicate: boolean;
};

export type ResolutionPlan = {
  events: ResolvedEvent[];
  tasks: ResolvedTask[];
  grocery: ResolvedGroceryItem[];
  notes: ResolvedNote[];
  contacts: ResolvedContact[];
  /** Counts the review step shows without re-walking the lists. */
  duplicateEvents: number;
  duplicateTasks: number;
  duplicateContacts: number;
  duplicateGrocery: number;
  duplicateNotes: number;
  assignedEvents: number;
  assignedTasks: number;
  assignedContacts: number;
};

/**
 * Lower-case word tokens with accents folded, so "Zoë" matches "Zoe" and
 * "Emma's" yields "emma". Punctuation is a separator rather than part of a
 * word, which is what makes possessives and "Emma/Liam" work at all.
 */
export function nameTokens(text: string | null | undefined): string[] {
  return (text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

/**
 * The member a piece of text is about, or null.
 *
 * Matching is on WHOLE tokens of the member's display name — a substring match
 * assigns "Marathon" to Mara and "Class" to Cass, which is the kind of wrong
 * that makes a family stop trusting the whole review. When several members
 * appear ("Emma and Liam to the dentist") the one named FIRST wins, because
 * that is the reading a person gives the same sentence.
 */
export function matchMember(text: string, members: ExistingMember[]): ExistingMember | null {
  const tokens = nameTokens(text);
  if (tokens.length === 0 || members.length === 0) return null;
  let best: { member: ExistingMember; at: number } | null = null;
  for (const member of members) {
    const memberTokens = nameTokens(member.displayName);
    if (memberTokens.length === 0) continue;
    for (const mt of memberTokens) {
      const at = tokens.indexOf(mt);
      if (at === -1) continue;
      if (!best || at < best.at) best = { member, at };
      break;
    }
  }
  return best?.member ?? null;
}

/** Keyword → category. Ordered: the first list that hits wins. */
const CATEGORY_KEYWORDS: [EventCategory, string[]][] = [
  ['birthday', ['birthday', 'bday', 'anniversary']],
  ['medication', ['medication', 'meds', 'prescription', 'refill']],
  ['appointment', ['doctor', 'dr', 'dentist', 'orthodontist', 'appointment', 'checkup', 'clinic', 'therapy', 'vet', 'pediatrician', 'optician']],
  ['school', ['school', 'class', 'homework', 'parent', 'teacher', 'pta', 'assembly', 'term', 'exam', 'lesson']],
  ['sports', ['practice', 'game', 'match', 'training', 'soccer', 'football', 'basketball', 'baseball', 'hockey', 'swim', 'swimming', 'tennis', 'gym', 'karate', 'dance', 'ballet', 'tournament']],
  ['maintenance', ['plumber', 'electrician', 'service', 'repair', 'inspection', 'mot', 'boiler']],
  ['holiday', ['holiday', 'vacation', 'break', 'trip']],
];

/**
 * A category guessed from the title's words. `general` when nothing matches —
 * the importer's previous behaviour for every event, kept as the honest floor
 * rather than forcing a guess.
 */
export function inferEventCategory(title: string): EventCategory {
  const tokens = new Set(nameTokens(title));
  for (const [category, words] of CATEGORY_KEYWORDS) {
    if (words.some((w) => tokens.has(w))) return category;
  }
  return 'general';
}

/**
 * The identity of a calendar event for duplicate detection: its title and the
 * instant it starts. Both sides are normalised (case, whitespace, ISO form) so
 * "Soccer Practice" at `2024-05-14T17:30:00+00:00` in the database matches
 * "soccer practice" at `2024-05-14T17:30:00.000Z` in the export — the same
 * event, written two ways by two systems.
 */
export function eventKey(title: string, startsAt: string): string {
  const when = Date.parse(startsAt);
  const stamp = Number.isFinite(when) ? new Date(when).toISOString() : startsAt.trim();
  return `${title.trim().toLowerCase()}|${stamp}`;
}

/**
 * The identity of an imported task or note: its name and its details, in the
 * form the commit stores them (the name is cut to 200 characters on insert, so
 * it is cut here too, or a long title would never match its own earlier copy).
 * Case and runs of whitespace are not differences; wording is.
 */
export function itemKey(name: string | null | undefined, extra: string | null | undefined): string {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  return `${norm((name ?? '').slice(0, 200))}|${norm(extra ?? '')}`;
}

/**
 * Flag each item whose `itemKey` is already held, or appeared earlier in the
 * same file — the shape `events` and `grocery` use, shared by tasks and notes.
 */
function flagItems(items: ImportedItem[], existing: ExistingItem[]): boolean[] {
  const seen = new Set(existing.map((e) => itemKey(e.name, e.extra)));
  return items.map((item) => {
    const key = itemKey(item.name, item.extra);
    const duplicate = seen.has(key);
    seen.add(key);
    return duplicate;
  });
}

/** Identity keys an existing contact row occupies. */
function existingContactKeys(row: ExistingContact): string[] {
  return contactKeys({
    emails: [row.email ?? ''].filter(Boolean),
    phones: [row.phone ?? '', row.phoneAlt ?? ''].filter(Boolean),
  });
}

export type ResolveInput = {
  members: ExistingMember[];
  events?: ImportedEvent[];
  tasks?: ImportedItem[];
  grocery?: ImportedItem[];
  notes?: ImportedItem[];
  contacts?: ImportedContact[];
  existingEvents?: ExistingEvent[];
  existingTasks?: ExistingItem[];
  existingNotes?: ExistingItem[];
  existingContacts?: ExistingContact[];
  /** Items still to buy on the list the import writes to — nothing else. */
  existingGrocery?: ExistingGroceryItem[];
};

/**
 * Propose, for every parsed item, the member it belongs to and whether the
 * family already has it. Nothing here writes: the result is what the review
 * step renders and what the commit turns into rows once a person has agreed.
 *
 * Duplicates WITHIN one import are flagged too, not just against the database —
 * two exports of the same shared calendar are the ordinary case when a family
 * is leaving an app, and flagging only against existing rows would let the
 * second copy through.
 */
export function resolveImportedItems(input: ResolveInput): ResolutionPlan {
  const members = input.members.filter((m) => m.displayName?.trim());

  const seenEvents = new Set((input.existingEvents ?? []).map((e) => eventKey(e.title, e.startsAt)));
  const events: ResolvedEvent[] = (input.events ?? []).map((e, index) => {
    const key = eventKey(e.title, e.startsAt);
    const duplicate = seenEvents.has(key);
    seenEvents.add(key);
    const match = matchMember(`${e.title} ${e.description ?? ''}`, members);
    return {
      index,
      title: e.title,
      startsAt: e.startsAt,
      category: inferEventCategory(e.title),
      duplicate,
      memberId: match?.id ?? null,
      memberName: match?.displayName ?? null,
    };
  });

  const taskDuplicates = flagItems(input.tasks ?? [], input.existingTasks ?? []);
  const tasks: ResolvedTask[] = (input.tasks ?? []).map((t, index) => {
    const match = matchMember(`${t.name} ${t.extra ?? ''}`, members);
    return {
      index, name: t.name, duplicate: taskDuplicates[index],
      memberId: match?.id ?? null, memberName: match?.displayName ?? null,
    };
  });

  const noteDuplicates = flagItems(input.notes ?? [], input.existingNotes ?? []);
  const notes: ResolvedNote[] = (input.notes ?? []).map((n, index) => (
    { index, name: n.name, duplicate: noteDuplicates[index] }
  ));

  // Grocery items have no key of their own — the only identity an
  // `ImportedItem` carries is its free-text name — so the rule is BORROWED
  // whole from the one the shopping module already applies to a typed add
  // (`lib/services/groceries/index.ts`, `addItems`): "deduplication is on the
  // normalised name against OPEN items only: 'milk' added a week ago and
  // already bought should be addable again, but adding it twice before the shop
  // should not produce two lines."
  //
  // That is why `existingGrocery` must be the unbought items of the list the
  // import writes to and nothing else. Widening it to every grocery row the
  // family ever had would drop the weekly milk — failing closed against the
  // family's intent, which is worse than the duplicate it prevents. Narrowing
  // it, or letting a failed read arrive here as an empty array, imports a
  // second copy of the whole file; the caller fails closed instead.
  const seenGrocery = new Set((input.existingGrocery ?? []).map((g) => normalizeName(g.name)));
  const grocery: ResolvedGroceryItem[] = (input.grocery ?? []).map((g, index) => {
    const key = normalizeName(g.name);
    const duplicate = seenGrocery.has(key);
    seenGrocery.add(key);
    return { index, name: g.name, duplicate };
  });

  const seenContacts = new Set<string>();
  const seenContactNames = new Set<string>();
  for (const row of input.existingContacts ?? []) {
    for (const k of existingContactKeys(row)) seenContacts.add(k);
    if (row.name?.trim()) seenContactNames.add(row.name.trim().toLowerCase());
  }
  const contacts: ResolvedContact[] = (input.contacts ?? []).map((c, index) => {
    const keys = contactKeys(c);
    const duplicate = keys.length > 0
      ? keys.some((k) => seenContacts.has(k))
      : seenContactNames.has(c.name.trim().toLowerCase());
    for (const k of keys) seenContacts.add(k);
    seenContactNames.add(c.name.trim().toLowerCase());
    const match = matchMember(c.name, members);
    return { index, name: c.name, duplicate, memberId: match?.id ?? null, memberName: match?.displayName ?? null };
  });

  return {
    events,
    tasks,
    grocery,
    notes,
    contacts,
    duplicateEvents: events.filter((e) => e.duplicate).length,
    duplicateTasks: tasks.filter((t) => t.duplicate).length,
    duplicateContacts: contacts.filter((c) => c.duplicate).length,
    duplicateGrocery: grocery.filter((g) => g.duplicate).length,
    duplicateNotes: notes.filter((n) => n.duplicate).length,
    assignedEvents: events.filter((e) => e.memberId).length,
    assignedTasks: tasks.filter((t) => t.memberId).length,
    assignedContacts: contacts.filter((c) => c.memberId).length,
  };
}

/** Re-export the identity helpers the commit path needs, so it imports one module. */
export { normalizeEmail, normalizePhone };
