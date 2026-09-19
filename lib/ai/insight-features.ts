import type { InsightKind } from '@/lib/ai/insights';

// Which feature each grounded insight belongs to.
//
// `/api/ai/insights` takes a `kind` and answers with a model. Every kind is
// reached from an "AI Assist" button on ONE module page, and those pages are
// `requireFeature`-gated — but the endpoint behind them was not, so a family
// below the plan could ask for any kind by POSTing the name. Twenty-five of
// these belong to a paid feature.
//
// Gating on the whole set would be no gate at all: `refuseUnlessEntitled`
// admits a caller entitled to ANY href it is given, and every family is
// entitled to something. So the gate is per kind, and this is the map.
//
// It is DERIVED, not authored: each entry is the `requireFeature` href of the
// page that renders `<AiInsight kind="…">`, found by walking each page's
// imports. `tests/insight-kinds-are-gated-like-their-pages.test.ts` re-derives
// it from the pages and fails if the two drift — so moving a button between
// modules updates the map or breaks the build, rather than silently ungating a
// paid insight.
//
// A kind absent from this map is rendered only on pages that are not gated;
// it passes through, which is what its page does too.
export const INSIGHT_FEATURE_HREFS: Partial<Record<InsightKind, readonly string[]>> = {
  announcements: ['/dashboard/announcements'],
  behavior: ['/dashboard/behavior'],
  binder: ['/dashboard/binder'],
  care: ['/dashboard/care'],
  career: ['/dashboard/career'],
  closet: ['/dashboard/closet'],
  declutter: ['/dashboard/declutter'],
  expenses: ['/dashboard/expenses'],
  goals: ['/dashboard/goals'],
  homework: ['/dashboard/homework'],
  insurance: ['/dashboard/insurance'],
  inventory: ['/dashboard/inventory'],
  language: ['/dashboard/language'],
  meals: ['/dashboard/meals'],
  medical: ['/dashboard/dental', '/dashboard/medical'],
  medications: ['/dashboard/medications'],
  memories: ['/dashboard/trip-memories'],
  moving: ['/dashboard/moving'],
  notifications: ['/dashboard/notifications'],
  pantry: ['/dashboard/pantry'],
  pets: ['/dashboard/pets'],
  projects: ['/dashboard/projects'],
  renewals: ['/dashboard/renewals'],
  rewards: ['/dashboard/rewards'],
  rides: ['/dashboard/rides'],
  school: ['/dashboard/school'],
  screen_time: ['/dashboard/screen-time'],
  signups: ['/dashboard/signups'],
  sleep: ['/dashboard/sleep'],
  sports: ['/dashboard/sports'],
  subscriptions: ['/dashboard/subscriptions'],
  tax: ['/dashboard/tax-vault'],
  timetable: ['/dashboard/timetable'],
  trips: ['/dashboard/trips'],
  utilities: ['/dashboard/utilities'],
  votes: ['/dashboard/voting'],
  watchlist: ['/dashboard/watchlist'],
};
