// Marketplace pickup & hand-off — pure engine, no I/O.
//
// Coordinates the physical exchange after a deal is struck: suggested SAFE
// public meetup spots, sensible meet-time slots, hand-off code handling, and
// status/label helpers. The DB writes live in server actions; this is the
// single source of truth for the safety copy + code rules. Fully tested.

export type HandoffStatus = 'proposed' | 'confirmed' | 'completed' | 'cancelled';
export type HandoffRole = 'buyer' | 'seller';
export type LocationKind = 'public_spot' | 'seller_place' | 'buyer_place' | 'other';

/** Curated SAFE meetup suggestions — public, well-lit, camera-covered places.
 *  The first is a police "safe exchange zone", the gold standard for handoffs. */
export const SAFE_SPOTS: { label: string; kind: LocationKind; hint: string }[] = [
  { label: 'Police-station safe-exchange zone', kind: 'public_spot', hint: 'Many departments have a monitored lot for online-sale handoffs.' },
  { label: 'Grocery-store entrance', kind: 'public_spot', hint: 'Busy, well-lit, cameras — easy for both sides to find.' },
  { label: 'Public library', kind: 'public_spot', hint: 'Calm, indoors, staff nearby.' },
  { label: 'Coffee shop', kind: 'public_spot', hint: 'Grab a table; great for handing off small items.' },
  { label: 'Bank lobby / ATM vestibule', kind: 'public_spot', hint: 'Cameras everywhere — good for higher-value items.' },
  { label: 'Mall food court', kind: 'public_spot', hint: 'Crowded and central.' },
];

/** True for a spot our safety copy considers a public, monitored place. */
export function isSafePublicSpot(kind: LocationKind): boolean {
  return kind === 'public_spot';
}

/** A short, human-friendly hand-off code (unambiguous chars: no 0/O/1/I). */
export function generateHandoffCode(rand: () => number = Math.random): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(rand() * alphabet.length)];
  return out;
}

/** Normalize a typed code for comparison (case/space/dash-insensitive). */
export function normalizeCode(input: string): string {
  return (input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function codesMatch(input: string, expected: string | null | undefined): boolean {
  if (!expected) return false;
  const a = normalizeCode(input);
  return a.length > 0 && a === normalizeCode(expected);
}

/** A few sensible upcoming meet slots (today evening if still early, then the
 *  next two mornings/afternoons) as ISO strings, given "now". Deterministic. */
export function suggestedMeetTimes(now: Date = new Date()): { iso: string; label: string }[] {
  const out: { iso: string; label: string }[] = [];
  const at = (dayOffset: number, hour: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + dayOffset);
    d.setHours(hour, 0, 0, 0);
    return d;
  };
  const push = (d: Date, label: string) => out.push({ iso: d.toISOString(), label });

  // Today early-evening if it's before 4pm.
  if (now.getHours() < 16) push(at(0, 18), 'Today, 6:00 PM');
  push(at(1, 10), 'Tomorrow, 10:00 AM');
  push(at(1, 18), 'Tomorrow, 6:00 PM');
  push(at(2, 14), 'In 2 days, 2:00 PM');
  return out;
}

/** Which party may act next, given status + the proposer's role. Confirming is
 *  the OTHER party's job; the proposer can only cancel/reschedule their own. */
export function canConfirm(status: HandoffStatus, viewer: HandoffRole, proposerRole: HandoffRole): boolean {
  return status === 'proposed' && viewer !== proposerRole;
}
export function canCancel(status: HandoffStatus): boolean {
  return status === 'proposed' || status === 'confirmed';
}
export function canComplete(status: HandoffStatus): boolean {
  return status === 'confirmed';
}

export function statusLabel(status: HandoffStatus): string {
  switch (status) {
    case 'proposed':  return 'Pickup proposed';
    case 'confirmed': return 'Pickup confirmed';
    case 'completed': return 'Handed off';
    case 'cancelled': return 'Pickup cancelled';
  }
}

/** Human one-liner for where + when, from either side. */
export function meetSummary(meatAtIso: string | null, locationLabel: string | null): string {
  const where = locationLabel?.trim() || 'a spot to be decided';
  if (!meatAtIso) return `At ${where}`;
  const d = new Date(meatAtIso);
  const when = d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `${when} · ${where}`;
}
