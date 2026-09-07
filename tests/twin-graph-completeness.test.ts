// X7 — how complete the household graph is, and what would improve it.
import { describe, it, expect } from 'vitest';
import {
  EMPTY_COMPLETENESS_SNAPSHOT, graphCompleteness, type CompletenessSnapshot,
} from '@/lib/twin/completeness';
import enUS from '@/lib/i18n/messages/en-US.json';

const snapshot = (over: Partial<CompletenessSnapshot> = {}): CompletenessSnapshot =>
  ({ ...EMPTY_COMPLETENESS_SNAPSHOT, ...over });

describe('graphCompleteness', () => {
  it('scores an empty household 0 and lists the household gaps', () => {
    // NOT 100. "We know everything about a family of nobody" is the vacuous
    // full marks that makes a completeness metric useless.
    const c = graphCompleteness(snapshot());
    expect(c.score).toBe(0);
    expect(c.filled).toBe(0);
    expect(c.expected).toBe(4);
    expect(c.missing.map((m) => m.key)).toEqual([
      'household:members', 'household:home_place', 'household:routines', 'household:accounts',
    ]);
  });

  it('scores a fully known household 100 with nothing missing', () => {
    const c = graphCompleteness(snapshot({
      members: [{ id: 'm1', name: 'Ada', birthday: '1990-01-01' }],
      places: [{ id: 'p1' }],
      accounts: [{ id: 'a1' }],
      routines: [{ id: 'r1', member_id: 'm1' }],
    }));
    expect(c.score).toBe(100);
    expect(c.missing).toEqual([]);
  });

  it('adds three slots per member', () => {
    const two = graphCompleteness(snapshot({
      members: [{ id: 'm1', name: 'Ada' }, { id: 'm2', name: 'Bo' }],
    }));
    expect(two.expected).toBe(4 + 2 * 3);
  });

  it('names the member a slot belongs to', () => {
    const c = graphCompleteness(snapshot({ members: [{ id: 'm1', name: 'Ada' }] }));
    const birthday = c.missing.find((m) => m.key === 'member:m1:birthday');
    expect(birthday?.scope).toBe('member');
    expect(birthday?.memberId).toBe('m1');
    expect(birthday?.memberName).toBe('Ada');
  });

  it('treats a blank name as missing and leaves memberName off', () => {
    const c = graphCompleteness(snapshot({ members: [{ id: 'm1', name: '   ' }] }));
    const name = c.missing.find((m) => m.key === 'member:m1:name');
    expect(name).toBeDefined();
    expect(name?.memberName).toBeUndefined();
  });

  it('counts a member as linked through any of the five relationships', () => {
    const linkedBy = (over: Partial<CompletenessSnapshot>) =>
      graphCompleteness(snapshot({ members: [{ id: 'm1', name: 'Ada' }], ...over }))
        .missing.some((m) => m.key === 'member:m1:linked');

    expect(linkedBy({})).toBe(true);
    expect(linkedBy({ classes: [{ id: 'c', member_id: 'm1' }] })).toBe(false);
    expect(linkedBy({ teams: [{ id: 't', member_id: 'm1' }] })).toBe(false);
    expect(linkedBy({ routines: [{ id: 'r', member_id: 'm1' }] })).toBe(false);
    expect(linkedBy({ providers: [{ id: 'p', member_id: 'm1' }] })).toBe(false);
    expect(linkedBy({ vehicles: [{ id: 'v', primary_driver: 'm1' }] })).toBe(false);
    // Somebody else's class does not link this member.
    expect(linkedBy({ classes: [{ id: 'c', member_id: 'm2' }] })).toBe(true);
  });

  it('does not penalise a household for having no pets', () => {
    const withPets = graphCompleteness(snapshot({ pets: [{ id: 'p1' }] }));
    const without = graphCompleteness(snapshot());
    expect(withPets.expected).toBe(without.expected);
    expect(withPets.score).toBe(without.score);
  });

  it('asks for household gaps before member gaps', () => {
    const c = graphCompleteness(snapshot({ members: [{ id: 'm1', name: 'Ada' }] }));
    const firstMemberIndex = c.missing.findIndex((m) => m.scope === 'member');
    const lastHouseholdIndex = c.missing.map((m) => m.scope).lastIndexOf('household');
    expect(lastHouseholdIndex).toBeLessThan(firstMemberIndex);
  });

  it('gives every missing slot a route to fixing it', () => {
    // A completeness score with no way to raise it is a guilt trip.
    const c = graphCompleteness(snapshot({ members: [{ id: 'm1', name: null }] }));
    expect(c.missing.length).toBeGreaterThan(0);
    for (const slot of c.missing) expect(slot.href.startsWith('/')).toBe(true);
  });

  it('gives every slot label a catalogue key that matches the English', () => {
    const catalogue = enUS as Record<string, string>;
    const c = graphCompleteness(snapshot({ members: [{ id: 'm1', name: null }] }));
    for (const slot of c.missing) expect(catalogue[slot.labelKey]).toBe(slot.label);
  });

  it('rounds the score to a whole percentage', () => {
    const c = graphCompleteness(snapshot({
      members: [{ id: 'm1', name: 'Ada' }],   // name filled, birthday + linked missing
      places: [{ id: 'p1' }],
    }));
    // 7 slots, 3 filled (members, home_place, name) → 42.857… → 43
    expect(c.expected).toBe(7);
    expect(c.filled).toBe(3);
    expect(c.score).toBe(43);
  });
});
