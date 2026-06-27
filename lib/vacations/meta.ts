// Vacation Planner — display metadata for enums. Pure, no deps.
import type {
  VacationKind, VacationStatus, VacItemKind, VacDayPart, VacTransportKind,
  VacLodgingKind, VacBudgetCategory, VacPackCategory, VacDocKind, VacRecoKind,
} from '@/lib/database.types';

export const VACATION_KINDS: { value: VacationKind; label: string; emoji: string }[] = [
  { value: 'domestic', label: 'Domestic trip', emoji: '🧳' },
  { value: 'international', label: 'International', emoji: '🌍' },
  { value: 'road_trip', label: 'Road trip', emoji: '🚗' },
  { value: 'flight', label: 'Flight trip', emoji: '✈️' },
  { value: 'cruise', label: 'Cruise', emoji: '🛳️' },
  { value: 'theme_park', label: 'Theme park', emoji: '🎢' },
  { value: 'camping', label: 'Camping', emoji: '🏕️' },
  { value: 'staycation', label: 'Staycation', emoji: '🏡' },
  { value: 'other', label: 'Other', emoji: '📍' },
];

export const VACATION_STATUSES: { value: VacationStatus; label: string; tone: string }[] = [
  { value: 'planning', label: 'Planning', tone: 'text-blue-300 bg-blue-500/15' },
  { value: 'booked', label: 'Booked', tone: 'text-violet-300 bg-violet-500/15' },
  { value: 'active', label: 'Active', tone: 'text-emerald-300 bg-emerald-500/15' },
  { value: 'completed', label: 'Completed', tone: 'text-zinc-300 bg-zinc-500/15' },
  { value: 'cancelled', label: 'Cancelled', tone: 'text-rose-300 bg-rose-500/15' },
];

export const ITEM_KINDS: { value: VacItemKind; label: string; emoji: string }[] = [
  { value: 'activity', label: 'Activity', emoji: '🎟️' },
  { value: 'reservation', label: 'Reservation', emoji: '📅' },
  { value: 'meal', label: 'Meal', emoji: '🍽️' },
  { value: 'travel', label: 'Travel', emoji: '🚕' },
  { value: 'reminder', label: 'Reminder', emoji: '⏰' },
  { value: 'note', label: 'Note', emoji: '📝' },
  { value: 'free_time', label: 'Free time', emoji: '🌴' },
];

export const DAY_PARTS: { value: VacDayPart; label: string; emoji: string }[] = [
  { value: 'morning', label: 'Morning', emoji: '🌅' },
  { value: 'afternoon', label: 'Afternoon', emoji: '☀️' },
  { value: 'evening', label: 'Evening', emoji: '🌙' },
  { value: 'all_day', label: 'All day', emoji: '🗓️' },
];

export const TRANSPORT_KINDS: { value: VacTransportKind; label: string; emoji: string }[] = [
  { value: 'car', label: 'Car / rental', emoji: '🚗' },
  { value: 'train', label: 'Train', emoji: '🚆' },
  { value: 'bus', label: 'Bus', emoji: '🚌' },
  { value: 'ferry', label: 'Ferry', emoji: '⛴️' },
  { value: 'rideshare', label: 'Rideshare', emoji: '🚙' },
  { value: 'shuttle', label: 'Shuttle', emoji: '🚐' },
  { value: 'subway', label: 'Subway / metro', emoji: '🚇' },
  { value: 'walk', label: 'Walking', emoji: '🚶' },
  { value: 'bike', label: 'Bike', emoji: '🚲' },
  { value: 'other', label: 'Other', emoji: '➡️' },
];

export const LODGING_KINDS: { value: VacLodgingKind; label: string; emoji: string }[] = [
  { value: 'hotel', label: 'Hotel', emoji: '🏨' },
  { value: 'airbnb', label: 'Airbnb / vacation rental', emoji: '🏠' },
  { value: 'resort', label: 'Resort', emoji: '🏖️' },
  { value: 'cabin', label: 'Cabin', emoji: '🛖' },
  { value: 'campground', label: 'Campground', emoji: '🏕️' },
  { value: 'cruise_cabin', label: 'Cruise cabin', emoji: '🛳️' },
  { value: 'hostel', label: 'Hostel', emoji: '🛏️' },
  { value: 'family', label: 'Family / friends', emoji: '👨‍👩‍👧' },
  { value: 'rental', label: 'Rental', emoji: '🔑' },
  { value: 'other', label: 'Other', emoji: '📍' },
];

export const BUDGET_CATEGORIES: { value: VacBudgetCategory; label: string; emoji: string }[] = [
  { value: 'flights', label: 'Flights', emoji: '✈️' },
  { value: 'lodging', label: 'Lodging', emoji: '🏨' },
  { value: 'transportation', label: 'Transportation', emoji: '🚗' },
  { value: 'activities', label: 'Activities', emoji: '🎟️' },
  { value: 'food', label: 'Food', emoji: '🍽️' },
  { value: 'shopping', label: 'Shopping', emoji: '🛍️' },
  { value: 'insurance', label: 'Insurance', emoji: '🛡️' },
  { value: 'fees', label: 'Fees', emoji: '🧾' },
  { value: 'misc', label: 'Miscellaneous', emoji: '📦' },
];

export const PACK_CATEGORIES: { value: VacPackCategory; label: string; emoji: string }[] = [
  { value: 'clothes', label: 'Clothes', emoji: '👕' },
  { value: 'toiletries', label: 'Toiletries', emoji: '🧴' },
  { value: 'electronics', label: 'Electronics', emoji: '🔌' },
  { value: 'medications', label: 'Medications', emoji: '💊' },
  { value: 'documents', label: 'Documents', emoji: '📄' },
  { value: 'sports', label: 'Sports gear', emoji: '🏀' },
  { value: 'beach', label: 'Beach gear', emoji: '🏖️' },
  { value: 'ski', label: 'Ski gear', emoji: '⛷️' },
  { value: 'camping', label: 'Camping gear', emoji: '🏕️' },
  { value: 'baby', label: 'Baby / kids', emoji: '🍼' },
  { value: 'snacks', label: 'Snacks', emoji: '🍪' },
  { value: 'other', label: 'Other', emoji: '📦' },
];

export const DOC_KINDS: { value: VacDocKind; label: string; emoji: string }[] = [
  { value: 'passport', label: 'Passport', emoji: '🛂' },
  { value: 'id', label: 'ID', emoji: '🪪' },
  { value: 'visa', label: 'Visa', emoji: '📑' },
  { value: 'ticket', label: 'Ticket', emoji: '🎫' },
  { value: 'boarding_pass', label: 'Boarding pass', emoji: '✈️' },
  { value: 'hotel_confirmation', label: 'Hotel confirmation', emoji: '🏨' },
  { value: 'rental_confirmation', label: 'Rental confirmation', emoji: '🚗' },
  { value: 'insurance', label: 'Insurance', emoji: '🛡️' },
  { value: 'itinerary', label: 'Itinerary', emoji: '🗺️' },
  { value: 'medical', label: 'Medical', emoji: '⚕️' },
  { value: 'other', label: 'Other', emoji: '📄' },
];

export const RECO_META: Record<VacRecoKind, { label: string; emoji: string }> = {
  missing_reservation: { label: 'Missing reservation', emoji: '📅' },
  packing: { label: 'Packing suggestion', emoji: '🧳' },
  budget_warning: { label: 'Budget warning', emoji: '💸' },
  weather_warning: { label: 'Weather warning', emoji: '🌧️' },
  travel_conflict: { label: 'Travel conflict', emoji: '⚠️' },
  activity_suggestion: { label: 'Activity idea', emoji: '🎯' },
  restaurant: { label: 'Restaurant idea', emoji: '🍴' },
  document_missing: { label: 'Document needed', emoji: '📄' },
  suggestion: { label: 'Suggestion', emoji: '💡' },
};

export const dollars = (cents: number | null | undefined): string =>
  cents == null ? '—' : `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

export const lookup = <V extends string>(arr: { value: V; label: string; emoji: string }[], v: V) =>
  arr.find((x) => x.value === v) ?? { value: v, label: v, emoji: '•' };
