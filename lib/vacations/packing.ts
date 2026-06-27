// AI-free packing template engine: generate a smart family packing list from
// trip kind, weather, activities, and member mix. The AI route can augment this,
// but families get a great list with zero AI cost. Pure + unit-tested.
import type { VacationKind, VacPackCategory } from '@/lib/database.types';

export type PackSuggestion = { name: string; category: VacPackCategory; quantity: number };

export type PackingContext = {
  kind: VacationKind;
  nights: number;
  hasChildren: boolean;
  hasBaby: boolean;
  isInternational: boolean;
  maxTempC?: number | null;
  minTempC?: number | null;
  rainy?: boolean;
  activities?: string[]; // free-text activity names, matched case-insensitively
};

const base = (nights: number): PackSuggestion[] => [
  { name: 'Underwear', category: 'clothes', quantity: Math.min(nights + 2, 14) },
  { name: 'Socks', category: 'clothes', quantity: Math.min(nights + 2, 14) },
  { name: 'T-shirts / tops', category: 'clothes', quantity: Math.min(nights + 1, 10) },
  { name: 'Pants / shorts', category: 'clothes', quantity: Math.min(Math.ceil(nights / 2) + 1, 7) },
  { name: 'Pajamas', category: 'clothes', quantity: 2 },
  { name: 'Toothbrush & toothpaste', category: 'toiletries', quantity: 1 },
  { name: 'Deodorant', category: 'toiletries', quantity: 1 },
  { name: 'Shampoo & body wash', category: 'toiletries', quantity: 1 },
  { name: 'Phone charger', category: 'electronics', quantity: 1 },
  { name: 'Daily medications', category: 'medications', quantity: 1 },
  { name: 'First-aid basics', category: 'medications', quantity: 1 },
];

/** Build a deduped, prioritized packing list for the trip context. */
export function suggestPacking(ctx: PackingContext): PackSuggestion[] {
  const list: PackSuggestion[] = [...base(Math.max(ctx.nights, 1))];
  const acts = (ctx.activities ?? []).map((a) => a.toLowerCase()).join(' ');
  const add = (name: string, category: VacPackCategory, quantity = 1) => list.push({ name, category, quantity });

  if (ctx.isInternational) {
    add('Passport', 'documents');
    add('Travel adapter', 'electronics');
    add('Local currency / cards', 'documents');
  }
  if (ctx.rainy) { add('Umbrella', 'other'); add('Rain jacket', 'clothes'); }
  if (ctx.maxTempC != null && ctx.maxTempC >= 27) { add('Sunscreen', 'toiletries'); add('Sunglasses', 'other'); add('Hat / cap', 'clothes'); }
  if (ctx.minTempC != null && ctx.minTempC <= 5) { add('Warm coat', 'clothes'); add('Gloves & beanie', 'clothes'); add('Thermal layers', 'clothes'); }

  switch (ctx.kind) {
    case 'cruise': add('Formal outfit', 'clothes'); add('Motion sickness bands', 'medications'); add('Swimsuit', 'beach', ctx.hasChildren ? 4 : 2); break;
    case 'theme_park': add('Comfortable walking shoes', 'clothes'); add('Refillable water bottle', 'other'); add('Portable battery pack', 'electronics'); add('Poncho', 'other'); break;
    case 'camping': add('Tent', 'camping'); add('Sleeping bags', 'camping', ctx.hasChildren ? 4 : 2); add('Headlamp / flashlight', 'camping'); add('Bug spray', 'toiletries'); add('Camp stove', 'camping'); break;
    case 'road_trip': add('Snacks for the car', 'snacks'); add('Car phone mount', 'electronics'); add('Travel games', 'other'); break;
    default: break;
  }

  if (/beach|ocean|swim|pool|snorkel/.test(acts) || ctx.kind === 'theme_park') {
    add('Swimsuit', 'beach', ctx.hasChildren ? 4 : 2);
    add('Beach towel', 'beach', ctx.hasChildren ? 4 : 2);
    add('Flip-flops / sandals', 'beach');
  }
  if (/ski|snowboard|snow/.test(acts)) { add('Ski jacket & pants', 'ski'); add('Goggles', 'ski'); add('Hand warmers', 'ski'); }
  if (/hik/.test(acts)) { add('Hiking boots', 'sports'); add('Daypack', 'sports'); }
  if (/golf|tennis|bike|run|gym/.test(acts)) { add('Sports gear', 'sports'); }

  if (ctx.hasChildren) { add('Kids snacks', 'snacks'); add('Activity / coloring books', 'baby'); add("Kids' extra clothes", 'clothes', 4); }
  if (ctx.hasBaby) { add('Diapers', 'baby'); add('Wipes', 'baby'); add('Baby formula / food', 'baby'); add('Stroller', 'baby'); add('Baby monitor', 'baby'); }

  // dedupe by name (keep highest quantity)
  const byName = new Map<string, PackSuggestion>();
  for (const s of list) {
    const prev = byName.get(s.name.toLowerCase());
    if (!prev || s.quantity > prev.quantity) byName.set(s.name.toLowerCase(), s);
  }
  return [...byName.values()];
}
