// lib/twin/completeness.ts — X7: how complete the household's graph is.
//
// Its own file, and pure. `lib/twin/project.ts` projects the household into
// entities and edges; this asks a different question — what does the twin still
// not know? — and keeping it separate means the projector can grow new node
// kinds without dragging a scoring function through every change.
//
// THE RULE THAT MATTERS: completeness is NEVER a gate. Nothing in this product
// may refuse to work because a score is 40. The score exists to offer specific,
// optional prompts ("Bubaly doesn't know where home is"), each with a link to
// the one page that fixes it. A number with no route to improving it is a
// guilt trip, so every slot carries an `href`.
//
// The input is declared here rather than imported from `project.ts` on purpose:
// completeness asks for a couple of fields the projector does not need
// (birthdays), and a local type keeps the two from having to change together.

/** Whether a slot belongs to the household as a whole or to one member. */
export type CompletenessScope = 'household' | 'member';

export type CompletenessSlot = {
  /** Stable identity, e.g. `household:home_place` or `member:<id>:birthday`. */
  key: string;
  scope: CompletenessScope;
  /** English label; the UI renders `labelKey`. */
  label: string;
  labelKey: string;
  /** The one page that fills this slot. */
  href: string;
  /** Present for member-scoped slots. */
  memberId?: string;
  memberName?: string;
  filled: boolean;
};

export type GraphCompleteness = {
  /** 0–100, whole number. `filled / expected`. */
  score: number;
  filled: number;
  expected: number;
  /** Only the unfilled slots, in the order worth asking about. */
  missing: CompletenessSlot[];
};

export type CompletenessMember = {
  id: string;
  name: string | null;
  birthday?: string | null;
};

/** A household snapshot, reduced to what completeness needs. */
export type CompletenessSnapshot = {
  members: CompletenessMember[];
  places: { id: string }[];
  accounts: { id: string }[];
  routines: { id: string; member_id: string | null }[];
  classes: { id: string; member_id: string | null }[];
  teams: { id: string; member_id: string | null }[];
  providers: { id: string; member_id: string | null }[];
  vehicles: { id: string; primary_driver?: string | null }[];
  pets: { id: string }[];
};

export const EMPTY_COMPLETENESS_SNAPSHOT: CompletenessSnapshot = {
  members: [], places: [], accounts: [], routines: [], classes: [], teams: [],
  providers: [], vehicles: [], pets: [],
};

/**
 * The household-level slots, in the order they are worth asking about.
 *
 * `pets` is deliberately absent: "this family has no pet" is a true and common
 * answer, and scoring it as a gap would push every petless household toward a
 * lower number for no reason. Only slots whose emptiness is genuinely a gap in
 * what Bubaly can know are counted.
 */
const HOUSEHOLD_SLOTS: { key: string; label: string; labelKey: string; href: string; has: (s: CompletenessSnapshot) => boolean }[] = [
  { key: 'members', label: 'Who lives here', labelKey: 'graphCompleteness.whoLivesHere', href: '/dashboard/family', has: (s) => s.members.length > 0 },
  { key: 'home_place', label: 'Where home is', labelKey: 'graphCompleteness.whereHomeIs', href: '/dashboard/locator', has: (s) => s.places.length > 0 },
  { key: 'routines', label: 'The week’s routines', labelKey: 'graphCompleteness.theWeeksRoutines', href: '/dashboard/family-coo', has: (s) => s.routines.length > 0 },
  { key: 'accounts', label: 'Where the money sits', labelKey: 'graphCompleteness.whereTheMoneySits', href: '/dashboard/family-cfo', has: (s) => s.accounts.length > 0 },
];

/** Per-member slots. Three, so one missing member fact never dominates a score. */
const MEMBER_SLOTS: { key: string; label: string; labelKey: string; href: (m: CompletenessMember) => string; has: (m: CompletenessMember, s: CompletenessSnapshot) => boolean }[] = [
  {
    key: 'name', label: 'A name Bubaly can use', labelKey: 'graphCompleteness.aNameBubalyCanUse',
    href: () => '/dashboard/family',
    has: (m) => (m.name ?? '').trim().length > 0,
  },
  {
    key: 'birthday', label: 'A birthday', labelKey: 'graphCompleteness.aBirthday',
    href: () => '/dashboard/family',
    has: (m) => Boolean(m.birthday && String(m.birthday).trim()),
  },
  {
    // "Linked" means the graph can reason about this person at all: a class, a
    // team, a routine, a car they drive or a doctor they see. A member with a
    // name and nothing else is a node with no edges, which is precisely the
    // state the twin exists to leave behind.
    key: 'linked', label: 'Something they do', labelKey: 'graphCompleteness.somethingTheyDo',
    href: () => '/dashboard/graph',
    has: (m, s) =>
      s.classes.some((c) => c.member_id === m.id)
      || s.teams.some((t) => t.member_id === m.id)
      || s.routines.some((r) => r.member_id === m.id)
      || s.providers.some((p) => p.member_id === m.id)
      || s.vehicles.some((v) => v.primary_driver === m.id),
  },
];

/**
 * X7 — score the household graph 0–100 and say exactly what is missing.
 *
 * An empty household scores 0 with the household slots listed, rather than
 * dividing by zero or scoring 100 for knowing nothing. That matters: "we know
 * everything about a family of nobody" is the kind of vacuous 100% that makes a
 * metric useless the moment somebody checks it.
 */
export function graphCompleteness(snapshot: CompletenessSnapshot): GraphCompleteness {
  const slots: CompletenessSlot[] = [];

  for (const slot of HOUSEHOLD_SLOTS) {
    slots.push({
      key: `household:${slot.key}`, scope: 'household',
      label: slot.label, labelKey: slot.labelKey, href: slot.href,
      filled: slot.has(snapshot),
    });
  }

  for (const member of snapshot.members) {
    for (const slot of MEMBER_SLOTS) {
      slots.push({
        key: `member:${member.id}:${slot.key}`, scope: 'member',
        label: slot.label, labelKey: slot.labelKey, href: slot.href(member),
        memberId: member.id,
        memberName: (member.name ?? '').trim() || undefined,
        filled: slot.has(member, snapshot),
      });
    }
  }

  const expected = slots.length;
  const filled = slots.filter((s) => s.filled).length;
  return {
    score: expected > 0 ? Math.round((filled / expected) * 100) : 0,
    filled,
    expected,
    // Household gaps first: knowing where home is unlocks more reasoning than
    // knowing one child's birthday, so it is the better thing to ask for first.
    missing: slots.filter((s) => !s.filled).sort((a, b) => (a.scope === b.scope ? 0 : a.scope === 'household' ? -1 : 1)),
  };
}
