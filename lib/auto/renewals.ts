// lib/auto/renewals.ts
// Pure helpers for the Auto command center: renewal/expiry status, vehicle
// labels, and a unified "upcoming renewals" aggregation across licenses,
// registrations, inspection stickers, and insurance. No DB/network — unit-tested.

export type Tone = 'danger' | 'warning' | 'success' | 'neutral' | 'brand';

const DAY = 86_400_000;

export function daysUntil(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const t = new Date(dateStr).getTime();
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - Date.now()) / DAY);
}

export type RenewalStatus = { tone: Tone; label: string; daysLeft: number | null; expired: boolean };

/** Status for any renewal/expiry date. ≤0 expired, ≤30d due soon, else valid. */
export function renewalStatus(expiresOn: string | null | undefined): RenewalStatus {
  const days = daysUntil(expiresOn);
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

/** Build one chronological list of everything that needs renewing, soonest first.
 *  `subjectFor` resolves a vehicle/holder name for each source row. */
export function buildRenewals(sources: {
  licenses: { id: string; holder_name: string; expires_on: string | null }[];
  registrations: { id: string; vehicle_id: string | null; expires_on: string | null }[];
  inspections: { id: string; vehicle_id: string | null; expires_on: string | null; inspection_type: string }[];
  policies: { id: string; provider: string | null; vehicle_id: string | null; expires_on: string | null }[];
  vehicleName: (id: string | null) => string | null;
}): RenewalItem[] {
  const items: RenewalItem[] = [];
  const push = (kind: RenewalKind, id: string, expiresOn: string | null, subject: string | null, extra?: string) => {
    if (!expiresOn) return;
    items.push({
      kind, id, expiresOn, subject,
      label: extra ? `${KIND_LABEL[kind]} · ${extra}` : KIND_LABEL[kind],
      status: renewalStatus(expiresOn),
      href: KIND_HREF[kind],
    });
  };
  for (const l of sources.licenses) push('license', l.id, l.expires_on, l.holder_name);
  for (const r of sources.registrations) push('registration', r.id, r.expires_on, sources.vehicleName(r.vehicle_id));
  for (const i of sources.inspections) push('inspection', i.id, i.expires_on, sources.vehicleName(i.vehicle_id), i.inspection_type);
  for (const p of sources.policies) push('insurance', p.id, p.expires_on, sources.vehicleName(p.vehicle_id) ?? p.provider);
  return items.sort((a, b) => new Date(a.expiresOn).getTime() - new Date(b.expiresOn).getTime());
}

/** Count of renewals that are expired or due within `withinDays`. */
export function dueSoonCount(items: RenewalItem[], withinDays = 30): number {
  return items.filter((i) => i.status.daysLeft !== null && i.status.daysLeft <= withinDays).length;
}
