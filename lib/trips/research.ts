// lib/trips/research.ts — destination research prompt + parse + deterministic
// fallback for the AI Trip Intelligence feature. PURE (no Supabase/network).
//
// The route gathers the destination, who's going, the family's stated interests
// and a weather summary; this builds the grounded prompt and parses the model's
// JSON into typed recommendations. When AI is unconfigured or returns junk, the
// fallback still returns useful, never-fabricated generic guidance.

export interface TripResearchInput {
  destination: string;
  interests?: string | null;
  members?: string[];
  startDate?: string | null;
  endDate?: string | null;
  weatherSummary?: string | null;
}

export interface RestaurantRec {
  name: string;
  cuisine: string;
  why: string;
  priceLevel?: string;
}
export interface ActivityRec {
  name: string;
  category: string;
  why: string;
}
export interface TripRecommendations {
  overview: string;
  restaurants: RestaurantRec[];
  activities: ActivityRec[];
  tips: string[];
}

export function buildTripResearchPrompt(input: TripResearchInput): { system: string; user: string } {
  const who = input.members?.length ? input.members.join(' and ') : 'the family';
  const dateLine = input.startDate
    ? `Dates: ${input.startDate}${input.endDate && input.endDate !== input.startDate ? ` to ${input.endDate}` : ''}.`
    : 'Dates: a few days from now.';
  const interestLine = input.interests?.trim()
    ? `What they enjoy: ${input.interests.trim()}.`
    : 'Preferences: a mix of great food, local culture, and a relaxed pace.';
  const weatherLine = input.weatherSummary?.trim() ? `Expected weather: ${input.weatherSummary.trim()}.` : '';

  const system = `You are the Bubaly Family Travel Concierge. You give warm, specific, practical recommendations for a family visiting a destination, tailored to their stated interests. Recommend REAL, well-known places when you are confident they exist in the destination; otherwise describe the TYPE of place to look for (never invent fake-sounding specific names). Keep it family-appropriate.

Return ONLY valid JSON (no markdown), in this exact shape:
{
  "overview": "1-2 warm sentences about the destination for this family",
  "restaurants": [{ "name": "...", "cuisine": "...", "why": "one short sentence", "priceLevel": "$|$$|$$$" }],
  "activities": [{ "name": "...", "category": "outdoors|culture|food|family|nightlife|shopping", "why": "one short sentence" }],
  "tips": ["short practical tip", "..."]
}
Provide 4-6 restaurants, 4-6 activities, and 3-5 tips.`;

  const user = `Destination: ${input.destination}.
Who's going: ${who}.
${dateLine}
${interestLine}
${weatherLine}
Give recommendations tuned to their interests.`;

  return { system, user };
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

/** Parse the model's JSON into typed recommendations, or null if unusable. */
export function parseTripResearch(text: string): TripRecommendations | null {
  if (!text) return null;
  let raw: unknown;
  try {
    const match = text.match(/\{[\s\S]*\}/);
    raw = JSON.parse(match?.[0] ?? text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;

  const restaurants: RestaurantRec[] = Array.isArray(o.restaurants)
    ? o.restaurants.slice(0, 8).map((r) => {
        const x = (r ?? {}) as Record<string, unknown>;
        return {
          name: asString(x.name).trim(),
          cuisine: asString(x.cuisine, 'Local').trim(),
          why: asString(x.why).trim(),
          priceLevel: asString(x.priceLevel).trim() || undefined,
        };
      }).filter((r) => r.name)
    : [];

  const activities: ActivityRec[] = Array.isArray(o.activities)
    ? o.activities.slice(0, 8).map((a) => {
        const x = (a ?? {}) as Record<string, unknown>;
        return {
          name: asString(x.name).trim(),
          category: asString(x.category, 'family').trim(),
          why: asString(x.why).trim(),
        };
      }).filter((a) => a.name)
    : [];

  const tips: string[] = Array.isArray(o.tips)
    ? o.tips.map((t) => asString(t).trim()).filter(Boolean).slice(0, 6)
    : [];

  if (restaurants.length === 0 && activities.length === 0 && tips.length === 0) return null;

  return {
    overview: asString(o.overview).trim() || `Here are some ideas for your trip to ${''}`.trim(),
    restaurants,
    activities,
    tips,
  };
}

/**
 * Deterministic, never-fabricated fallback when AI is off. Returns guidance by
 * TYPE of place (so we never invent fake business names) tuned lightly to the
 * stated interests.
 */
export function fallbackTripResearch(input: TripResearchInput): TripRecommendations {
  const dest = input.destination;
  const interests = (input.interests ?? '').toLowerCase();
  const likesOutdoors = /outdoor|hike|park|beach|nature|walk/.test(interests);
  const likesFood = /food|eat|restaurant|dining|foodie|cuisine/.test(interests);
  const likesHistory = /history|museum|culture|art|architecture/.test(interests);

  const restaurants: RestaurantRec[] = [
    { name: `A top-rated local restaurant in ${dest}`, cuisine: 'Local specialty', why: 'Ask a local or check reviews for the signature regional dish.', priceLevel: '$$' },
    { name: 'A family-friendly brunch spot', cuisine: 'American', why: 'Great for an easy start before a busy day.', priceLevel: '$$' },
    { name: 'A well-reviewed dinner place near your hotel', cuisine: 'Seasonal', why: 'Short walk back keeps the evening relaxed.', priceLevel: '$$$' },
    { name: 'A casual spot for a quick bite', cuisine: 'Cafe', why: 'Handy between activities.', priceLevel: '$' },
  ];

  const activities: ActivityRec[] = [
    { name: `Walk the historic district of ${dest}`, category: 'culture', why: 'The best free way to feel a city.' },
    { name: 'Visit the top-rated local museum or landmark', category: 'culture', why: 'A signature stop most visitors love.' },
    { name: 'Find a scenic park or waterfront', category: 'outdoors', why: 'A relaxed break with room to roam.' },
    { name: 'Browse a local market or main shopping street', category: 'shopping', why: 'Souvenirs and people-watching in one stop.' },
  ];
  if (likesOutdoors) activities.unshift({ name: `Best outdoor spot near ${dest}`, category: 'outdoors', why: 'You said you love being outside.' });
  if (likesHistory) activities.unshift({ name: `A guided history or architecture tour of ${dest}`, category: 'culture', why: 'Matches your interest in history & culture.' });
  if (likesFood) restaurants.unshift({ name: `A food tour or famous eatery in ${dest}`, cuisine: 'Regional', why: 'Perfect for the foodies in the group.', priceLevel: '$$' });

  return {
    overview: `${dest} has plenty to offer — here are family-friendly ideas to start planning. Confirm hours and book popular restaurants ahead.`,
    restaurants: restaurants.slice(0, 6),
    activities: activities.slice(0, 6),
    tips: [
      'Book popular restaurants a day or two ahead, especially for dinner.',
      'Check opening hours and any reservation requirements before you go.',
      input.weatherSummary ? `Pack for the forecast: ${input.weatherSummary}.` : 'Check the local forecast and pack accordingly.',
      'Keep one relaxed block each day so nobody gets overtired.',
    ],
  };
}
