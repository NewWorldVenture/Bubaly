// Trips that are planned, booked or under way, and the travel preferences
// the family has recorded ("window seats", "we always rent a car"). Passport
// numbers, itineraries and booking references stay in their own tables; a
// planner needs the dates and the destination, and that is all it gets.
import 'server-only';
import { fenceUntrusted, sanitizeUntrusted } from '@/lib/ai/safety/untrusted';
import { recallFacts } from '@/lib/services/memory';
import { listTrips } from '@/lib/services/trips';
import { ok } from '@/lib/services/types';
import type { SliceDefinition } from '../policy';
import { dayKeyLabel } from '../render';

const MAX_TRIPS = 10;
const MAX_FACTS = 8;

const TRAVEL_RE = /\b(travel|trip|vacation|holiday|fly|flight|airline|seat|hotel|airbnb|rent(al)? car|pack|luggage|suitcase|passport|road ?trip|camp)\b/i;

export type TravelSliceData = {
  trips: { id: string; title: string; destination: string | null; kind: string; status: string; startDate: string | null; endDate: string | null; international: boolean; daysUntil: number | null }[];
  preferences: { label: string; value: string }[];
};

export const travelSlice: SliceDefinition = {
  name: 'travel',
  title: 'Travel',
  async load(scope, env) {
    const [trips, facts] = await Promise.all([
      listTrips(scope, { limit: MAX_TRIPS }),
      recallFacts(scope, { limit: 300 }),
    ]);
    if (!trips.ok) return trips;
    if (!facts.ok) return facts;

    const todayMs = Date.parse(`${env.todayKey}T00:00:00Z`);
    const data: TravelSliceData = {
      trips: trips.data.map((t) => ({
        id: t.id, title: t.title, destination: t.destination, kind: t.kind, status: t.status,
        startDate: t.start_date, endDate: t.end_date, international: t.is_international,
        daysUntil: t.start_date ? Math.round((Date.parse(`${t.start_date}T00:00:00Z`) - todayMs) / 86_400_000) : null,
      })),
      preferences: facts.data
        .filter((f) => f.category === 'preference' && TRAVEL_RE.test(`${f.label} ${f.value}`))
        .slice(0, MAX_FACTS)
        .map((f) => ({ label: f.label, value: f.value })),
    };

    const lines: string[] = [];
    for (const t of data.trips) {
      const bits = [`- ${fenceUntrusted('trip', t.title)}`];
      if (t.destination) bits.push(`to ${fenceUntrusted('destination', t.destination)}`);
      if (t.startDate) bits.push(`${dayKeyLabel(t.startDate)}${t.endDate ? `–${dayKeyLabel(t.endDate)}` : ''}`);
      if (t.daysUntil !== null) bits.push(t.daysUntil < 0 ? '(under way)' : t.daysUntil === 0 ? '(today)' : `(in ${t.daysUntil} day${t.daysUntil === 1 ? '' : 's'})`);
      bits.push(`[${sanitizeUntrusted(t.status, 12)}${t.international ? ', international' : ''}]`);
      lines.push(bits.join(' '));
    }
    if (!data.trips.length) lines.push('- No upcoming trips.');
    for (const p of data.preferences) lines.push(`- Preference: ${fenceUntrusted('fact', `${p.label}: ${p.value}`)}`);

    return ok({ data, count: data.trips.length + data.preferences.length, lines });
  },
};
