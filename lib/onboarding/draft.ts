// lib/onboarding/draft.ts — pure helpers for the transactional onboarding wizard.
//
// The wizard collects everything into an in-memory (and sessionStorage-persisted)
// DRAFT and writes NOTHING to the database until the user reaches the end and
// commits. These helpers manage the draft's member list and produce small
// deterministic summaries, so they're unit-tested here; the server action does
// the single atomic write at the end.

import type { MemberRole } from '@/lib/constants/roles';

export type DraftMemberKind = 'local' | 'invite';

/**
 * A person captured during onboarding before any DB write. `local` members are
 * managed profiles with NO email/login (e.g. a young child or a grandparent who
 * won't sign in); `invite` members will receive an email join link.
 */
export interface DraftMember {
  /** Client-only id for stable list rendering (not a DB id). */
  id: string;
  kind: DraftMemberKind;
  /** Person's name (local members). Invites use the email as their label. */
  name: string;
  /** Email (invite members only). */
  email: string;
  role: MemberRole;
  color?: string;
  /** Optional ISO date (local members only). */
  birthday?: string;
}

export const MEMBER_COLORS = [
  '#7c6dff', '#f4996e', '#4ac99b', '#f0bf5f',
  '#f57171', '#6aa9ff', '#b07cff', '#5fd0c5',
];

/**
 * Every role can be assigned to a managed, no-login member — the whole point of
 * the new flow is letting a parent capture family members who don't have an
 * email address (kids, grandparents, caregivers) and give each the right role.
 */
export const LOCAL_MEMBER_ROLES: MemberRole[] = ['adult', 'teen', 'child', 'caregiver', 'guest'];

/** Roles offered when inviting someone by email (parent stays with the owner). */
export const INVITE_ROLES: MemberRole[] = ['adult', 'teen', 'caregiver', 'guest'];

/** Pick the next palette colour, cycling deterministically by list length. */
export function nextMemberColor(members: readonly DraftMember[]): string {
  return MEMBER_COLORS[members.length % MEMBER_COLORS.length];
}

let _seq = 0;
/** Small unique-ish id for client list keys (deterministic-friendly in tests). */
export function draftId(): string {
  _seq += 1;
  return `m${Date.now().toString(36)}_${_seq}`;
}

/** Case-insensitive check that an invite for this email is already captured. */
export function hasInviteEmail(members: readonly DraftMember[], email: string): boolean {
  const e = email.trim().toLowerCase();
  if (!e) return false;
  return members.some((m) => m.kind === 'invite' && m.email.trim().toLowerCase() === e);
}

/** Build a managed (no-login) member, assigning a colour if none was given. */
export function makeLocalMember(
  input: { name: string; role: MemberRole; birthday?: string; color?: string },
  existing: readonly DraftMember[],
): DraftMember {
  return {
    id: draftId(),
    kind: 'local',
    name: input.name.trim(),
    email: '',
    role: input.role,
    birthday: input.birthday?.trim() || undefined,
    color: input.color ?? nextMemberColor(existing),
  };
}

/** Build an email-invite member. */
export function makeInviteMember(
  input: { email: string; role: MemberRole },
): DraftMember {
  return {
    id: draftId(),
    kind: 'invite',
    name: '',
    email: input.email.trim().toLowerCase(),
    role: input.role,
  };
}

/** Append a member immutably. */
export function addMember(members: readonly DraftMember[], member: DraftMember): DraftMember[] {
  return [...members, member];
}

/** Remove a member by id immutably. */
export function removeMember(members: readonly DraftMember[], id: string): DraftMember[] {
  return members.filter((m) => m.id !== id);
}

/** The label shown for a member row: their name, or their email for invites. */
export function draftMemberLabel(m: DraftMember): string {
  return m.kind === 'invite' ? m.email : m.name;
}

export interface MemberSummary { local: number; invites: number; text: string }

/** A short human summary, e.g. "3 profiles · 1 invite". */
export function summarizeMembers(members: readonly DraftMember[]): MemberSummary {
  const local = members.filter((m) => m.kind === 'local').length;
  const invites = members.filter((m) => m.kind === 'invite').length;
  const parts: string[] = [];
  if (local > 0) parts.push(`${local} profile${local === 1 ? '' : 's'}`);
  if (invites > 0) parts.push(`${invites} invite${invites === 1 ? '' : 's'}`);
  return { local, invites, text: parts.join(' · ') || 'No one added yet' };
}
