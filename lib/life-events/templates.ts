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
    // M25: the families who have Bubaly's actions turned off still get the
    // holiday season as a dated checklist rather than nothing at all.
    key: 'holidays', title: 'The Holidays', icon: 'gift', defaultLeadDays: 45,
    description: 'Gatherings, cooking, gifts and travel — the season planned instead of survived.',
    items: [
      { title: 'Agree who is hosting and who is travelling', category: 'plan', offsetDays: -40 },
      { title: 'Set the gift budget', category: 'plan', offsetDays: -38 },
      { title: 'Book travel or guest rooms', category: 'book', offsetDays: -35 },
      { title: 'Write the guest list and send invitations', category: 'notify', offsetDays: -30 },
      { title: 'Order gifts that need shipping time', category: 'buy', offsetDays: -25 },
      { title: 'Plan the holiday menu around the diets in the house', category: 'plan', offsetDays: -18 },
      { title: 'Send holiday cards', category: 'celebrate', offsetDays: -18 },
      { title: 'Order anything that has to be collected (turkey, cake, flowers)', category: 'buy', offsetDays: -14 },
      { title: 'Do the big holiday shop', category: 'buy', offsetDays: -4 },
      { title: 'Wrap the gifts', category: 'celebrate', offsetDays: -2 },
      { title: 'Prep what can be cooked ahead', category: 'plan', offsetDays: -1 },
      { title: 'Take the family photo', category: 'celebrate', offsetDays: 0 },
      { title: 'Send thank-you notes', category: 'notify', offsetDays: 7 },
    ],
  },
  {
    // M25. Readiness is not a purchase — most of this checklist is knowing
    // things, which is why it ends with telling everyone rather than buying.
    key: 'emergency_prep', title: 'Emergency Readiness', icon: 'shield-alert', defaultLeadDays: 30,
    description: 'A kit, current documents and a plan everyone in the house has actually been told.',
    items: [
      { title: 'Agree the meeting point and the out-of-area contact', category: 'plan', offsetDays: -28 },
      { title: 'Check passports, IDs and insurance are in date', category: 'document', offsetDays: -25 },
      { title: 'Photograph or scan the critical documents', category: 'document', offsetDays: -21 },
      { title: 'Build the emergency kit: water, food, torch, batteries', category: 'buy', offsetDays: -18 },
      { title: 'Add a first-aid kit and a week of medication', category: 'health', offsetDays: -14 },
      { title: 'Pack a go-bag per person', category: 'home', offsetDays: -12 },
      { title: 'Add pet food, carrier and vet records to the kit', category: 'buy', offsetDays: -10 },
      { title: 'Test the smoke and carbon-monoxide alarms', category: 'home', offsetDays: -7 },
      { title: 'Locate the water, gas and power shut-offs', category: 'home', offsetDays: -7 },
      { title: 'Write the emergency contact card for each child', category: 'notify', offsetDays: -4 },
      { title: 'Walk the whole family through the plan', category: 'notify', offsetDays: 0 },
      { title: 'Diary the six-month kit and document review', category: 'plan', offsetDays: 3 },
    ],
  },
  {
    // M34: the summer that arrives every year and is booked every year late.
    key: 'camp', title: 'Camp / Summer Care', icon: 'tent', defaultLeadDays: 60,
    description: 'Places booked, forms in, kit labelled — before the good camps fill up.',
    items: [
      { title: 'Agree which weeks need cover', category: 'plan', offsetDays: -60 },
      { title: 'Shortlist camps and compare costs', category: 'plan', offsetDays: -55 },
      { title: 'Register and pay the deposit', category: 'book', offsetDays: -50 },
      { title: 'Submit the health form and immunisation records', category: 'document', offsetDays: -35 },
      { title: 'Arrange transport or the carpool', category: 'plan', offsetDays: -21 },
      { title: 'Book the weeks nobody is covering yet', category: 'book', offsetDays: -21 },
      { title: 'Buy the kit list', category: 'buy', offsetDays: -14 },
      { title: 'Label everything', category: 'home', offsetDays: -5 },
      { title: 'Confirm drop-off time and what to bring on day one', category: 'plan', offsetDays: -2 },
      { title: 'Pack the bag', category: 'home', offsetDays: -1 },
      { title: 'Check in after the first day', category: 'notify', offsetDays: 1 },
    ],
  },
  {
    // M34: the transition families handle worst, because it starts as a worry
    // rather than a date. The checklist gives it a shape.
    key: 'aging_parent', title: 'Caring for a Parent', icon: 'heart-handshake', defaultLeadDays: 45,
    description: 'Medical, legal, financial and practical — the care conversation with a checklist under it.',
    items: [
      { title: 'Have the conversation about what they want', category: 'plan', offsetDays: -45 },
      { title: 'List the medications, doses and prescribing doctors', category: 'health', offsetDays: -40 },
      { title: 'Collect the medical history and insurance details', category: 'document', offsetDays: -35 },
      { title: 'Find out what legal paperwork exists (will, power of attorney)', category: 'document', offsetDays: -30 },
      { title: 'Agree who in the family does what', category: 'plan', offsetDays: -28 },
      { title: 'Assess the home for falls and access', category: 'home', offsetDays: -21 },
      { title: 'Research care options and costs', category: 'plan', offsetDays: -18 },
      { title: 'Book the appointment with the doctor', category: 'book', offsetDays: -14 },
      { title: 'Set up the medication reminders', category: 'health', offsetDays: -7 },
      { title: 'Share the contact list with everyone involved', category: 'notify', offsetDays: -3 },
      { title: 'Set the weekly check-in', category: 'plan', offsetDays: 7 },
      { title: 'Review how it is going after a month', category: 'plan', offsetDays: 30 },
    ],
  },
  {
    // M34: a renovation hands off to Home Projects on launch — see
    // lib/life-events/launch.ts. The checklist is the part Home Projects
    // does not carry: living through it.
    key: 'renovation', title: 'Home Renovation', icon: 'hammer', defaultLeadDays: 60,
    description: 'Quotes, permits, and a household that still functions while the kitchen does not.',
    items: [
      { title: 'Write down the scope and what "done" looks like', category: 'plan', offsetDays: -60 },
      { title: 'Set the budget and the contingency', category: 'plan', offsetDays: -56 },
      { title: 'Get three quotes', category: 'plan', offsetDays: -45 },
      { title: 'Check permits and any approvals needed', category: 'document', offsetDays: -40 },
      { title: 'Choose the contractor and sign the contract', category: 'document', offsetDays: -30 },
      { title: 'Tell the insurer about the work', category: 'notify', offsetDays: -25 },
      { title: 'Order the long-lead materials', category: 'buy', offsetDays: -21 },
      { title: 'Plan where the family cooks, washes and sleeps during the work', category: 'plan', offsetDays: -14 },
      { title: 'Warn the neighbours about noise and deliveries', category: 'notify', offsetDays: -7 },
      { title: 'Clear and protect the work area', category: 'home', offsetDays: -3 },
      { title: 'Walk the site with the contractor on day one', category: 'plan', offsetDays: 0 },
      { title: 'Do the snagging walk-through before the final payment', category: 'plan', offsetDays: 30 },
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
