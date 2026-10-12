// lib/autopilot/audience.ts — who an Autopilot suggestion is for.
//
// A suggestion is a COPY of a source row as the scan saw it: a subscription's
// name and amount, a renewal's title, an insurance policy's type and insurer.
// The scan runs on the service role, so the copy is made past every rule that
// narrows the source; `autopilot_suggestions` is then read under 0085's
// family-wide policy. Without a rule here the copy reached people the source
// refuses — a guest was pushed "$15.99 charge: Netflix tomorrow" although the
// applied 0481 `subscriptions_tracked_not_a_guests_read` refuses them the row.
//
// One rule, used by the scan to address the push, by the notifications
// generator to address a card's reminder, and by every screen that lists
// suggestions (Home's "Completed by Bubaly" included):
//
//   not-guests      subscription charges and unused-subscription flags, and
//                   renewals — the two tables 0481 refuses a guest
//   policy-readers  an insurance renewal — the managers, and the member the
//                   policy names (the Insurance Hub's recordsInScope; held 0517)
//   everyone        anything else
//
// Pure and client-safe: the home dashboard, the Autopilot module and the
// resolution service all import it.
import { isManager } from '@/lib/constants/roles';

export type SuggestionAudience = 'everyone' | 'not-guests' | 'policy-readers';

export type AudienceRow = {
  kind?: string | null;
  source_kind?: string | null;
  member_id?: string | null;
};

export type AudienceViewer = { role: string | null | undefined; memberId: string | null | undefined };

const NOT_GUESTS = new Set(['subscriptions_tracked', 'renewals']);

export function suggestionAudience(row: AudienceRow): SuggestionAudience {
  if (row.source_kind === 'family_insurance_policies' || row.kind === 'insurance') return 'policy-readers';
  if (row.kind === 'finance' || (row.source_kind && NOT_GUESTS.has(row.source_kind))) return 'not-guests';
  return 'everyone';
}

/** Whether `viewer` may read this suggestion. */
export function suggestionVisibleTo(row: AudienceRow, viewer: AudienceViewer): boolean {
  switch (suggestionAudience(row)) {
    case 'policy-readers':
      return isManager(viewer.role) || (!!row.member_id && row.member_id === viewer.memberId);
    case 'not-guests':
      return viewer.role !== 'guest';
    default:
      return true;
  }
}

/** The member ids a notice about this suggestion goes to, from the active roster. */
export function audienceMemberIds(
  audience: Exclude<SuggestionAudience, 'everyone'>,
  roster: { id: string; role: string }[],
  memberId: string | null,
): string[] {
  return roster
    .filter((m) => suggestionVisibleTo(
      { kind: audience === 'policy-readers' ? 'insurance' : 'finance', member_id: memberId },
      { role: m.role, memberId: m.id },
    ))
    .map((m) => m.id);
}

/**
 * The member a reminder made from this card is assigned to — the scan's
 * auto-created one and a manager's "Add reminder" alike.
 *
 * An insurance card's `member_id` says whose policy it is, which is who may
 * READ it; it does not make the renewal that member's errand. Assigned to
 * them, a policy naming a child was reminded to the child alone and the
 * parents who renew it heard nothing. So the reminder carries no member, and
 * its notice goes to the card's readers (`reminderNoticeMemberIds`).
 */
export function reminderMemberFor(row: AudienceRow): string | null {
  return suggestionAudience(row) === 'policy-readers' ? null : row.member_id ?? null;
}

/**
 * The members told when a reminder made from this card comes due, or null
 * when the card is everyone's — then it is addressed like any reminder (its
 * member, or the family). Never the family for a narrower card: a renewal's
 * reminder is not a guest's, an insurance renewal's is the managers' and the
 * member the policy names.
 */
export function reminderNoticeMemberIds(row: AudienceRow, roster: { id: string; role: string }[]): string[] | null {
  const audience = suggestionAudience(row);
  return audience === 'everyone' ? null : audienceMemberIds(audience, roster, row.member_id ?? null);
}

/**
 * A PostgREST `or` filter for the cards whose audience is narrower than
 * everyone. A pre-filter for a read, built from the same names as
 * `suggestionAudience`, which stays the rule.
 */
export const NARROWER_THAN_EVERYONE_FILTER =
  `kind.in.(insurance,finance),source_kind.in.(family_insurance_policies,${[...NOT_GUESTS].join(',')})`;
