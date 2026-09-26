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
// WHICH KINDS ARE DE-DUPLICATED, and why it is not all five. A kind is
// de-duplicated here only where something in the repo has already decided what
// its identity is:
//
//   * events    — title + start instant (`eventKey`).
//   * contacts  — normalised email/phone, falling back to an exact name.
//   * grocery   — normalised name against the UNBOUGHT items of the list the
//                 import writes to. Not a new rule: it is the one
//                 `lib/services/groceries/index.ts addItems` already applies to
//                 a typed add, borrowed verbatim so the two cannot disagree.
//   * tasks     — NOT de-duplicated. `chores` has no done-ness column at all
//                 (it lives on `chore_assignments.status`), so "the same chore,
//                 still open" is a join and a scope nobody has chosen yet.
//   * notes     — NOT de-duplicated, by decision recorded in
//                 `lib/services/notes/index.ts`: "two identical notes are two
//                 rows, which is the honest outcome."
//
// The two that are not de-duplicated are SAID SO in the review step rather than
// shown as a bare count, because a keyless list legitimately repeats — a family
// really does take the bins out more than once — and a silent "same name, so
// dropped" would fail closed against what they meant.
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
  contacts: ResolvedContact[];
  /** Counts the review step shows without re-walking the lists. */
  duplicateEvents: number;
  duplicateContacts: number;
  duplicateGrocery: number;
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
  contacts?: ImportedContact[];
  existingEvents?: ExistingEvent[];
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

  const tasks: ResolvedTask[] = (input.tasks ?? []).map((t, index) => {
    const match = matchMember(`${t.name} ${t.extra ?? ''}`, members);
    return { index, name: t.name, memberId: match?.id ?? null, memberName: match?.displayName ?? null };
  });

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
    contacts,
    duplicateEvents: events.filter((e) => e.duplicate).length,
    duplicateContacts: contacts.filter((c) => c.duplicate).length,
    duplicateGrocery: grocery.filter((g) => g.duplicate).length,
    assignedEvents: events.filter((e) => e.memberId).length,
    assignedTasks: tasks.filter((t) => t.memberId).length,
    assignedContacts: contacts.filter((c) => c.memberId).length,
  };
}

/** Re-export the identity helpers the commit path needs, so it imports one module. */
export { normalizeEmail, normalizePhone };
