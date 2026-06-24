// Vacation Readiness Score — Bubaly's proprietary 0–100 trip-readiness metric.
// Pure + unit-tested. The UI/API feed it simple counts; it returns a weighted
// score, a per-factor breakdown, and concrete recommendations to improve.

export type ReadinessInput = {
  hasDates: boolean;
  membersCount: number;
  // booking progress
  lodgingTotal: number; lodgingBooked: number;
  transportTotal: number; transportBooked: number; // flights + ground
  activitiesTotal: number; activitiesBooked: number;
  reservationsTotal: number; reservationsBooked: number;
  // prep
  packingTotal: number; packingPacked: number;
  documentsCount: number;
  emergencyContactsCount: number;
  // money
  budgetPlannedCents: number;
  itineraryDays: number;       // days with at least one itinerary item
  tripDays: number;            // total days of the trip
  isInternational: boolean;
};

export type ReadinessFactor = {
  key: string;
  label: string;
  score: number;   // 0..100 for this factor
  weight: number;  // relative weight
  recommendation?: string;
};

export type ReadinessResult = {
  score: number;   // 0..100 overall
  level: 'not_started' | 'getting_there' | 'almost_ready' | 'ready';
  factors: ReadinessFactor[];
  recommendations: string[];
};

const pct = (done: number, total: number) => (total <= 0 ? 0 : Math.round((Math.min(done, total) / total) * 100));
const clamp = (n: number) => Math.max(0, Math.min(100, n));

export function computeReadiness(i: ReadinessInput): ReadinessResult {
  const factors: ReadinessFactor[] = [];

  // 1. Basics — dates set
  factors.push({
    key: 'dates', label: 'Trip dates', weight: 1,
    score: i.hasDates ? 100 : 0,
    recommendation: i.hasDates ? undefined : 'Set your travel dates to unlock the countdown and daily plan.',
  });

  // 2. Lodging booked
  factors.push({
    key: 'lodging', label: 'Lodging booked', weight: 2,
    score: i.lodgingTotal === 0 ? 0 : pct(i.lodgingBooked, i.lodgingTotal),
    recommendation: i.lodgingTotal === 0 ? 'Add where you are staying.'
      : i.lodgingBooked < i.lodgingTotal ? 'Confirm and mark your lodging as booked.' : undefined,
  });

  // 3. Transportation booked (flights + ground)
  factors.push({
    key: 'transport', label: 'Transportation booked', weight: 2,
    score: i.transportTotal === 0 ? 0 : pct(i.transportBooked, i.transportTotal),
    recommendation: i.transportTotal === 0 ? 'Add flights or how you will get around.'
      : i.transportBooked < i.transportTotal ? 'Book and confirm your remaining transportation.' : undefined,
  });

  // 4. Reservations + activities locked in
  const planTotal = i.activitiesTotal + i.reservationsTotal;
  const planBooked = i.activitiesBooked + i.reservationsBooked;
  factors.push({
    key: 'reservations', label: 'Reservations & activities', weight: 1.5,
    score: planTotal === 0 ? 0 : pct(planBooked, planTotal),
    recommendation: planTotal === 0 ? 'Plan a few activities or reservations.'
      : planBooked < planTotal ? 'Lock in your key reservations.' : undefined,
  });

  // 5. Itinerary built out
  factors.push({
    key: 'itinerary', label: 'Daily itinerary', weight: 1.5,
    score: i.tripDays <= 0 ? (i.itineraryDays > 0 ? 100 : 0) : pct(i.itineraryDays, i.tripDays),
    recommendation: i.itineraryDays === 0 ? 'Block out what each day looks like.' : undefined,
  });

  // 6. Packing progress
  factors.push({
    key: 'packing', label: 'Packing progress', weight: 1.5,
    score: i.packingTotal === 0 ? 0 : pct(i.packingPacked, i.packingTotal),
    recommendation: i.packingTotal === 0 ? 'Generate a packing list so nothing is forgotten.'
      : i.packingPacked < i.packingTotal ? 'Keep checking off your packing list.' : undefined,
  });

  // 7. Documents (weight higher for international)
  const docTarget = i.isInternational ? Math.max(i.membersCount, 1) : 1;
  factors.push({
    key: 'documents', label: 'Travel documents', weight: i.isInternational ? 2 : 1,
    score: clamp(pct(i.documentsCount, docTarget)),
    recommendation: i.documentsCount < docTarget
      ? (i.isInternational ? 'Upload passports/visas for each traveler.' : 'Store tickets and confirmations in one place.') : undefined,
  });

  // 8. Emergency contacts
  factors.push({
    key: 'emergency', label: 'Emergency info', weight: 1,
    score: i.emergencyContactsCount >= 2 ? 100 : i.emergencyContactsCount === 1 ? 60 : 0,
    recommendation: i.emergencyContactsCount < 2 ? 'Add emergency contacts (doctor, insurance, local).' : undefined,
  });

  // 9. Budget
  factors.push({
    key: 'budget', label: 'Budget planned', weight: 1,
    score: i.budgetPlannedCents > 0 ? 100 : 0,
    recommendation: i.budgetPlannedCents > 0 ? undefined : 'Set a budget so we can flag overruns.',
  });

  const totalWeight = factors.reduce((s, f) => s + f.weight, 0);
  const score = Math.round(factors.reduce((s, f) => s + f.score * f.weight, 0) / totalWeight);

  const level: ReadinessResult['level'] =
    score >= 90 ? 'ready' : score >= 65 ? 'almost_ready' : score >= 30 ? 'getting_there' : 'not_started';

  const recommendations = factors
    .filter((f) => f.recommendation && f.score < 100)
    .sort((a, b) => (b.weight * (100 - b.score)) - (a.weight * (100 - a.score)))
    .map((f) => f.recommendation!) as string[];

  return { score: clamp(score), level, factors, recommendations };
}
