// lib/auto/renewals.ts
// Pure helpers for the Auto command center: renewal/expiry status, vehicle
// labels, and a unified "upcoming renewals" aggregation across licenses,
// registrations, inspection stickers, and insurance. No DB/network — unit-tested.

export type Tone = 'danger' | 'warning' | 'success' | 'neutral' | 'brand';

const DAY = 86_400_000;

/**
 * Whole days from the family's today to a date-only expiry, both as day keys.
 *
 * `expires_on` is a DATE column: a day on the family's wall, not an instant.
 * Parsing it as UTC midnight and comparing with `Date.now()` (rounded up)
 * moved every badge a day for part of every day — "Expired 1d ago" on the
 * expiry day itself from 5pm in Los Angeles, and "Renew in 0d" for a Sydney
 * registration that expired yesterday. `todayKey` is the family's day
 * (`todayKeyFor(ctx)` on the server, `useFamilyClock().todayKey()` in a
 * client), and the answer is a calendar-day difference with nothing to round.
 */
export function daysUntil(dateStr: string | null | undefined, todayKey: string): number | null {
  if (!dateStr) return null;
  const target = Date.parse(`${dateStr.slice(0, 10)}T00:00:00Z`);
  const today = Date.parse(`${todayKey.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(target) || Number.isNaN(today)) return null;
  return Math.round((target - today) / DAY);
}

export type RenewalStatus = { tone: Tone; label: string; daysLeft: number | null; expired: boolean };

/** Status for any renewal/expiry date on the family's `todayKey`. <0 expired, ≤30d due soon, else valid. */
export function renewalStatus(expiresOn: string | null | undefined, todayKey: string): RenewalStatus {
  const days = daysUntil(expiresOn, todayKey);
  if (days === null) return { tone: 'neutral', label: 'No date', daysLeft: null, expired: false };
  if (days < 0) return { tone: 'danger', label: `Expired ${Math.abs(days)}d ago`, daysLeft: days, expired: true };
  if (days <= 30) return { tone: 'warning', label: `Renew in ${days}d`, daysLeft: days, expired: false };
  if (days <= 60) return { tone: 'brand', label: `${days}d left`, daysLeft: days, expired: false };
  return { tone: 'success', label: `${days}d left`, daysLeft: days, expired: false };
}

export function vehicleLabel(v: {
  nickname?: string | null; year?: number | null; make?: string | null; model?: string | null;
}): string {
  if (v.nickname) return v.nickname;
  const parts = [v.year ? String(v.year) : '', v.make ?? '', v.model ?? ''].filter(Boolean);
  return parts.length ? parts.join(' ') : 'Vehicle';
}

export const BODY_TYPES = ['sedan', 'suv', 'truck', 'van', 'coupe', 'wagon', 'ev', 'motorcycle', 'other'];
export const FUEL_TYPES = ['gas', 'diesel', 'hybrid', 'electric'];
export const RENTAL_STATUSES = ['upcoming', 'active', 'returned', 'cancelled'];
export const INSPECTION_TYPES = ['safety', 'emissions', 'both'];

export type RenewalKind = 'license' | 'registration' | 'inspection' | 'insurance';

export type RenewalItem = {
  kind: RenewalKind;
  id: string;
  label: string;
  subject: string | null; // vehicle label or license holder
  expiresOn: string;
  status: RenewalStatus;
  href: string;
};

const KIND_LABEL: Record<RenewalKind, string> = {
  license: "Driver's license", registration: 'Registration', inspection: 'Inspection', insurance: 'Insurance',
};
const KIND_HREF: Record<RenewalKind, string> = {
  license: '/dashboard/auto/licenses', registration: '/dashboard/auto/registration',
  inspection: '/dashboard/auto/registration', insurance: '/dashboard/auto/insurance',
};

/** Ids of rows a later-expiring row with the same key has replaced (a
 *  registration renewed as a new record). A row with no key is never paired. */
function replacedByLater<T extends { id: string; expires_on: string | null }>(rows: readonly T[], key: (row: T) => string | null): Set<string> {
  const latest = new Map<string, string>();
  for (const r of rows) {
    const k = key(r);
    const day = r.expires_on?.slice(0, 10);
    if (k === null || !day) continue;
    if (!latest.has(k) || day > latest.get(k)!) latest.set(k, day);
  }
  const replaced = new Set<string>();
  for (const r of rows) {
    const k = key(r);
    const day = r.expires_on?.slice(0, 10);
    if (k !== null && day && day < latest.get(k)!) replaced.add(r.id);
  }
  return replaced;
}

/** Build one chronological list of everything that needs renewing, soonest first.
 *  `subjectFor` resolves a vehicle/holder name for each source row; `todayKey`
 *  is the family's day the statuses are counted from.
 *
 *  A renewal is a record still in force for a car still on the road. An
 *  inactive policy (the family switched insurers), a record of a vehicle
 *  `currentVehicle` does not answer for (sold, or no longer on file), and a
 *  registration or inspection a later-expiring one of the same car (and
 *  inspection type) has replaced are history: listed, they said "Expired" and
 *  counted as due for good. */
export function buildRenewals(sources: {
  licenses: { id: string; holder_name: string; expires_on: string | null }[];
  registrations: { id: string; vehicle_id: string | null; expires_on: string | null }[];
  inspections: { id: string; vehicle_id: string | null; expires_on: string | null; inspection_type: string }[];
  policies: { id: string; provider: string | null; vehicle_id: string | null; expires_on: string | null; is_active?: boolean | null }[];
  vehicleName: (id: string | null) => string | null;
  /** The vehicles still on the road; omitted, every vehicle counts. */
  currentVehicle?: (id: string) => boolean;
  todayKey: string;
}): RenewalItem[] {
  const items: RenewalItem[] = [];
  const push = (kind: RenewalKind, id: string, expiresOn: string | null, subject: string | null, extra?: string) => {
    if (!expiresOn) return;
    items.push({
      kind, id, expiresOn, subject,
      label: extra ? `${KIND_LABEL[kind]} · ${extra}` : KIND_LABEL[kind],
      status: renewalStatus(expiresOn, sources.todayKey),
      href: KIND_HREF[kind],
    });
  };
  const onTheRoad = (vehicleId: string | null) => vehicleId === null || !sources.currentVehicle || sources.currentVehicle(vehicleId);
  const renewedRegistrations = replacedByLater(sources.registrations, (r) => r.vehicle_id);
  const renewedInspections = replacedByLater(sources.inspections, (i) => (i.vehicle_id ? `${i.vehicle_id}:${i.inspection_type}` : null));
  for (const l of sources.licenses) push('license', l.id, l.expires_on, l.holder_name);
  for (const r of sources.registrations) {
    if (onTheRoad(r.vehicle_id) && !renewedRegistrations.has(r.id)) push('registration', r.id, r.expires_on, sources.vehicleName(r.vehicle_id));
  }
  for (const i of sources.inspections) {
    if (onTheRoad(i.vehicle_id) && !renewedInspections.has(i.id)) push('inspection', i.id, i.expires_on, sources.vehicleName(i.vehicle_id), i.inspection_type);
  }
  for (const p of sources.policies) {
    if (p.is_active !== false && onTheRoad(p.vehicle_id)) push('insurance', p.id, p.expires_on, sources.vehicleName(p.vehicle_id) ?? p.provider);
  }
  return items.sort((a, b) => new Date(a.expiresOn).getTime() - new Date(b.expiresOn).getTime());
}

/** Count of renewals that are expired or due within `withinDays`. */
export function dueSoonCount(items: RenewalItem[], withinDays = 30): number {
  return items.filter((i) => i.status.daysLeft !== null && i.status.daysLeft <= withinDays).length;
}
