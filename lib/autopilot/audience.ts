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
// One rule, used by the scan to address the push and by every screen that
// lists suggestions:
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
