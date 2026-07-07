// lib/life-events/templates.ts — Life-event playbooks (T9, pure + tested).
//
// Big family moments (a new baby, a move, the start of school, a trip) come with
// the same known checklist every time. These templates turn a one-tap "Start"
// into a real, dated plan: each item has an offset relative to the event date, so
// launching a template on a chosen date materializes a scheduled checklist. This
// is the DOM-free core — the catalog + the date math; the server persists the
// plan + items to Supabase and the module renders + checks them off.

export type LifeEventItemCategory =
  | 'plan' | 'buy' | 'book' | 'notify' | 'document' | 'health' | 'home' | 'celebrate';

export type TemplateItem = {
  title: string;
  category: LifeEventItemCategory;
  /** Days relative to the event date. Negative = before the event, 0 = on it,
   *  positive = after. */
  offsetDays: number;
  note?: string;
};

export type LifeEventTemplate = {
  key: string;
  title: string;
  icon: string;          // resolved to a lucide icon in the UI layer
  description: string;
  /** Sensible default lead time when the family hasn't picked a date. */
  defaultLeadDays: number;
  items: TemplateItem[];
};

export const LIFE_EVENT_TEMPLATES: LifeEventTemplate[] = [
  {
    key: 'new_baby', title: 'New Baby', icon: 'baby', defaultLeadDays: 60,
    description: 'From the hospital bag to the pediatrician — everything a new arrival needs.',
    items: [
      { title: 'Choose a pediatrician', category: 'health', offsetDays: -45 },
      { title: 'Tour the birth center / hospital', category: 'plan', offsetDays: -40 },
      { title: 'Set up the nursery', category: 'home', offsetDays: -30 },
      { title: 'Install the car seat', category: 'home', offsetDays: -21, note: 'Have it checked at a local inspection station.' },
      { title: 'Pack the hospital bag', category: 'buy', offsetDays: -14 },
      { title: 'Prewash newborn clothes & bedding', category: 'home', offsetDays: -14 },
      { title: 'Stock diapers, wipes & formula', category: 'buy', offsetDays: -10 },
      { title: 'Arrange a meal train', category: 'plan', offsetDays: -7 },
      { title: 'Finalize the birth plan', category: 'document', offsetDays: -7 },
      { title: 'Add baby to health insurance', category: 'document', offsetDays: 3 },
      { title: 'File for the birth certificate & SSN', category: 'document', offsetDays: 5 },
      { title: 'Schedule the first pediatrician visit', category: 'health', offsetDays: 3 },
      { title: 'Send birth announcements', category: 'celebrate', offsetDays: 14 },
    ],
  },
  {
    key: 'moving', title: 'Moving Home', icon: 'truck', defaultLeadDays: 45,
    description: 'Boxes, utilities, address changes — a move without the last-minute scramble.',
    items: [
      { title: 'Book movers or a truck', category: 'book', offsetDays: -30 },
      { title: 'Declutter room by room', category: 'home', offsetDays: -28 },
      { title: 'Gather packing supplies', category: 'buy', offsetDays: -21 },
      { title: 'Notify your landlord / list the house', category: 'notify', offsetDays: -30 },
      { title: 'Transfer utilities (power, water, internet)', category: 'notify', offsetDays: -14 },
      { title: 'File a USPS change of address', category: 'document', offsetDays: -10 },
      { title: 'Update address with bank, work & school', category: 'notify', offsetDays: -10 },
      { title: 'Pack non-essentials', category: 'home', offsetDays: -7 },
      { title: 'Label boxes by room', category: 'home', offsetDays: -5 },
      { title: 'Confirm the moving day plan', category: 'plan', offsetDays: -2 },
      { title: 'Deep clean the old place', category: 'home', offsetDays: 1 },
      { title: 'Update driver’s license & registration', category: 'document', offsetDays: 14 },
    ],
  },
  {
    key: 'school_start', title: 'School Start', icon: 'graduation-cap', defaultLeadDays: 30,
    description: 'Supplies, forms, routines — ready for the first day.',
    items: [
      { title: 'Buy school supplies', category: 'buy', offsetDays: -21 },
      { title: 'Submit immunization records', category: 'document', offsetDays: -21 },
      { title: 'Complete enrollment / re-enrollment forms', category: 'document', offsetDays: -18 },
      { title: 'Shop for clothes & shoes', category: 'buy', offsetDays: -14 },
      { title: 'Meet the teacher / attend orientation', category: 'plan', offsetDays: -7 },
      { title: 'Set the transportation plan (bus/carpool)', category: 'plan', offsetDays: -7 },
      { title: 'Ease into the bedtime routine', category: 'plan', offsetDays: -7 },
      { title: 'Label supplies & belongings', category: 'home', offsetDays: -3 },
      { title: 'Plan the first week of lunches', category: 'plan', offsetDays: -2 },
      { title: 'Arrange after-school care', category: 'book', offsetDays: -14 },
      { title: 'Lay out first-day outfit & backpack', category: 'home', offsetDays: -1 },
      { title: 'Take a first-day photo', category: 'celebrate', offsetDays: 0 },
    ],
  },
  {
    key: 'vacation', title: 'Family Vacation', icon: 'plane', defaultLeadDays: 45,
    description: 'From idea to packed bags — nothing forgotten at home.',
    items: [
      { title: 'Book travel (flights / route)', category: 'book', offsetDays: -45 },
      { title: 'Book lodging', category: 'book', offsetDays: -42 },
      { title: 'Check passports & IDs are valid', category: 'document', offsetDays: -40 },
      { title: 'Arrange a pet / house sitter', category: 'book', offsetDays: -21 },
      { title: 'Buy travel insurance', category: 'document', offsetDays: -21 },
      { title: 'Plan the itinerary & bookings', category: 'plan', offsetDays: -14 },
      { title: 'Refill medications for the trip', category: 'health', offsetDays: -10 },
      { title: 'Pause mail & deliveries', category: 'notify', offsetDays: -5 },
      { title: 'Pack bags', category: 'home', offsetDays: -2, note: 'Use the packing list in Trips.' },
      { title: 'Set the home to away mode (thermostat, lights)', category: 'home', offsetDays: -1 },
      { title: 'Charge devices & download offline maps', category: 'plan', offsetDays: -1 },
      { title: 'Share the itinerary with a trusted contact', category: 'notify', offsetDays: -1 },
    ],
  },
  {
    key: 'new_pet', title: 'New Pet', icon: 'paw-print', defaultLeadDays: 21,
    description: 'Welcome a new furry family member — set up and settled.',
    items: [
      { title: 'Pet-proof the home', category: 'home', offsetDays: -10 },
      { title: 'Buy food, bowls, bed & crate', category: 'buy', offsetDays: -7 },
      { title: 'Buy a collar, leash & ID tag', category: 'buy', offsetDays: -7 },
      { title: 'Choose a vet & book the first visit', category: 'health', offsetDays: -5 },
      { title: 'Set up a feeding & walk schedule', category: 'plan', offsetDays: -2 },
      { title: 'Prepare a quiet arrival space', category: 'home', offsetDays: -1 },
      { title: 'Microchip & register the pet', category: 'document', offsetDays: 7 },
      { title: 'Start vaccinations', category: 'health', offsetDays: 10 },
      { title: 'Book training or classes', category: 'book', offsetDays: 14 },
    ],
  },
  {
    key: 'new_job', title: 'New Job / Schedule Change', icon: 'briefcase', defaultLeadDays: 21,
    description: 'A new routine handled — coverage, commute, and calendars aligned.',
    items: [
      { title: 'Add the new schedule to the calendar', category: 'plan', offsetDays: -14 },
      { title: 'Line up childcare / coverage', category: 'book', offsetDays: -14 },
      { title: 'Plan the commute', category: 'plan', offsetDays: -7 },
      { title: 'Sort out work wardrobe', category: 'buy', offsetDays: -7 },
      { title: 'Enroll in benefits & payroll', category: 'document', offsetDays: -3 },
      { title: 'Update emergency contacts', category: 'notify', offsetDays: -3 },
      { title: 'Prep the first-week meals', category: 'plan', offsetDays: -1 },
      { title: 'Confirm start details (time, place, contact)', category: 'plan', offsetDays: -1 },
      { title: 'Review the new routine after week one', category: 'plan', offsetDays: 7 },
    ],
  },
];

export const TEMPLATES_BY_KEY: Record<string, LifeEventTemplate> = Object.fromEntries(
  LIFE_EVENT_TEMPLATES.map((t) => [t.key, t]),
);

export function getTemplate(key: string): LifeEventTemplate | undefined {
  return TEMPLATES_BY_KEY[key];
}

/** Add whole days to a YYYY-MM-DD date in UTC, returning YYYY-MM-DD. */
export function addDays(dateIso: string, days: number): string {
  const d = new Date(`${dateIso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export type MaterializedItem = {
  title: string;
  category: LifeEventItemCategory;
  note: string | null;
  due_on: string;   // YYYY-MM-DD
  sort: number;
};

/** Materialize a template into dated checklist items for a chosen event date.
 *  Items are returned in chronological order (earliest due first). */
export function buildPlanItems(template: LifeEventTemplate, eventDateIso: string): MaterializedItem[] {
  return template.items
    .map((it) => ({
      title: it.title,
      category: it.category,
      note: it.note ?? null,
      due_on: addDays(eventDateIso, it.offsetDays),
      offsetDays: it.offsetDays,
    }))
    .sort((a, b) => a.offsetDays - b.offsetDays)
    .map((it, i) => ({ title: it.title, category: it.category, note: it.note, due_on: it.due_on, sort: i }));
}
