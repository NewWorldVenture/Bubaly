import { describe, expect, it } from 'vitest';
import {
  MEMBER_COLORS, LOCAL_MEMBER_ROLES, INVITE_ROLES,
  nextMemberColor, hasInviteEmail, makeLocalMember, makeInviteMember,
  addMember, removeMember, draftMemberLabel, summarizeMembers,
  type DraftMember,
} from '@/lib/onboarding/draft';

describe('role catalogs', () => {
  it('local members can be any non-parent role (incl. no-email roles)', () => {
    expect(LOCAL_MEMBER_ROLES).toEqual(['adult', 'teen', 'child', 'caregiver', 'guest']);
  });
  it('invites exclude child (managed) and parent (owner)', () => {
    expect(INVITE_ROLES).toEqual(['adult', 'teen', 'caregiver', 'guest']);
    expect(INVITE_ROLES).not.toContain('child');
    expect(INVITE_ROLES).not.toContain('parent');
  });
});

describe('nextMemberColor', () => {
  it('cycles deterministically by list length', () => {
    expect(nextMemberColor([])).toBe(MEMBER_COLORS[0]);
    const four = Array.from({ length: 4 }, () => makeLocalMember({ name: 'x', role: 'child' }, []));
    expect(nextMemberColor(four)).toBe(MEMBER_COLORS[4]);
    const full = Array.from({ length: MEMBER_COLORS.length }, () => makeLocalMember({ name: 'x', role: 'child' }, []));
    expect(nextMemberColor(full)).toBe(MEMBER_COLORS[0]); // wraps
  });
});

describe('makeLocalMember', () => {
  it('builds a managed member with trimmed name, role, colour', () => {
    const m = makeLocalMember({ name: '  Ava  ', role: 'child' }, []);
    expect(m.kind).toBe('local');
    expect(m.name).toBe('Ava');
    expect(m.email).toBe('');
    expect(m.role).toBe('child');
    expect(m.color).toBe(MEMBER_COLORS[0]);
  });
  it('captures an optional birthday and supports any role', () => {
    const gp = makeLocalMember({ name: 'Grandpa Joe', role: 'guest', birthday: '1950-04-02' }, []);
    expect(gp.role).toBe('guest');
    expect(gp.birthday).toBe('1950-04-02');
    const cg = makeLocalMember({ name: 'Nanny', role: 'caregiver' }, []);
    expect(cg.role).toBe('caregiver');
    expect(cg.birthday).toBeUndefined();
  });
});

describe('makeInviteMember', () => {
  it('normalizes email to lowercase', () => {
    const m = makeInviteMember({ email: '  Spouse@Example.COM ', role: 'adult' });
    expect(m.kind).toBe('invite');
    expect(m.email).toBe('spouse@example.com');
    expect(m.role).toBe('adult');
  });
});

describe('hasInviteEmail', () => {
  it('detects duplicate invites case-insensitively', () => {
    const list = [makeInviteMember({ email: 'a@b.com', role: 'adult' })];
    expect(hasInviteEmail(list, 'A@B.com')).toBe(true);
    expect(hasInviteEmail(list, 'c@d.com')).toBe(false);
    expect(hasInviteEmail(list, '')).toBe(false);
  });
  it('ignores local members', () => {
    const list = [makeLocalMember({ name: 'Ava', role: 'child' }, [])];
    expect(hasInviteEmail(list, 'a@b.com')).toBe(false);
  });
});

describe('add/remove member', () => {
  it('appends and removes immutably', () => {
    const a = makeLocalMember({ name: 'Ava', role: 'child' }, []);
    const b = makeInviteMember({ email: 'mom@x.com', role: 'adult' });
    const one = addMember([], a);
    const two = addMember(one, b);
    expect(two).toHaveLength(2);
    expect(one).toHaveLength(1); // original untouched
    const back = removeMember(two, a.id);
    expect(back).toHaveLength(1);
    expect(back[0].id).toBe(b.id);
  });
});

describe('draftMemberLabel', () => {
  it('uses name for local, email for invite', () => {
    expect(draftMemberLabel(makeLocalMember({ name: 'Ava', role: 'child' }, []))).toBe('Ava');
    expect(draftMemberLabel(makeInviteMember({ email: 'x@y.com', role: 'adult' }))).toBe('x@y.com');
  });
});

describe('summarizeMembers', () => {
  it('counts and pluralizes', () => {
    const members: DraftMember[] = [
      makeLocalMember({ name: 'Ava', role: 'child' }, []),
      makeLocalMember({ name: 'Max', role: 'teen' }, []),
      makeInviteMember({ email: 'mom@x.com', role: 'adult' }),
    ];
    const s = summarizeMembers(members);
    expect(s.local).toBe(2);
    expect(s.invites).toBe(1);
    expect(s.text).toBe('2 profiles · 1 invite');
  });
  it('handles empty', () => {
    expect(summarizeMembers([]).text).toBe('No one added yet');
  });
});
