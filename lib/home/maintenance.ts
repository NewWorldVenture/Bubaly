// lib/home/maintenance.ts
// Pure homeowner domain logic shared by the Home & Maintenance UI, server actions,
// and the AI features. No DB/network here so it's unit-tested directly. Covers:
// warranty expiry status, asset age/remaining-life, default maintenance cadences
// per asset type (the backbone of forecasting), the seasonal checklist, and the
// asset-type → contractor-trade mapping used by "find a pro".

export type Tone = 'danger' | 'warning' | 'success' | 'neutral' | 'brand';

const DAY = 86_400_000;

export function daysUntil(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const t = new Date(dateStr).getTime();
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - Date.now()) / DAY);
}

export type WarrantyStatus = { tone: Tone; label: string; daysLeft: number | null; active: boolean };

/** Status for a warranty/coverage end date. ≤0 expired, ≤45d expiring, else active. */
export function warrantyStatus(expiresOn: string | null | undefined): WarrantyStatus {
  const days = daysUntil(expiresOn);
  if (days === null) return { tone: 'neutral', label: 'No end date', daysLeft: null, active: true };
  if (days < 0) return { tone: 'danger', label: `Expired ${Math.abs(days)}d ago`, daysLeft: days, active: false };
  if (days <= 45) return { tone: 'warning', label: `Expires in ${days}d`, daysLeft: days, active: true };
  return { tone: 'success', label: `${days}d left`, daysLeft: days, active: true };
}

/** Whole years since an install/purchase date (0 if missing/future). */
export function assetAgeYears(asset: { installed_on?: string | null; purchased_on?: string | null }): number {
  const ref = asset.installed_on ?? asset.purchased_on;
  if (!ref) return 0;
  const t = new Date(ref).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / (365.25 * DAY)));
}

export type LifeEstimate = { percentUsed: number; yearsLeft: number; tone: Tone; label: string };

/** Remaining useful life from age vs expected lifespan. */
export function lifeRemaining(asset: {
  installed_on?: string | null; purchased_on?: string | null; expected_life_years?: number | null; category?: string | null;
}): LifeEstimate | null {
  const expected = asset.expected_life_years ?? (asset.category ? TYPICAL_LIFESPAN_YEARS[asset.category] : undefined);
  if (!expected || expected <= 0) return null;
  const age = assetAgeYears(asset);
  const yearsLeft = Math.max(0, expected - age);
  const percentUsed = Math.min(100, Math.round((age / expected) * 100));
  const tone: Tone = percentUsed >= 90 ? 'danger' : percentUsed >= 70 ? 'warning' : 'success';
  const label = yearsLeft <= 0 ? 'Past expected life' : `~${yearsLeft} yr${yearsLeft === 1 ? '' : 's'} of life left`;
  return { percentUsed, yearsLeft, tone, label };
}

/** Typical service life (years) by asset category — a sensible default for life math. */
export const TYPICAL_LIFESPAN_YEARS: Record<string, number> = {
  hvac: 18, furnace: 18, ac: 15, water_heater: 10, roof: 25, dishwasher: 10,
  refrigerator: 13, washer: 11, dryer: 13, oven: 15, range: 15, microwave: 9,
  garbage_disposal: 12, sump_pump: 10, garage_door: 15, deck: 20, fence: 18,
  gutters: 25, generator: 25, softener: 15, smoke_detector: 10,
};

export type MaintenanceCadence = { task: string; intervalDays: number; trade: string };

/** Default recurring maintenance per asset category. Drives the AI forecast and
 *  the one-tap "schedule recommended tasks" flow. */
export const DEFAULT_CADENCES: Record<string, MaintenanceCadence[]> = {
  hvac: [
    { task: 'Replace air filter', intervalDays: 90, trade: 'hvac' },
    { task: 'Professional HVAC service / tune-up', intervalDays: 365, trade: 'hvac' },
  ],
  furnace: [{ task: 'Replace furnace filter', intervalDays: 90, trade: 'hvac' }, { task: 'Furnace inspection', intervalDays: 365, trade: 'hvac' }],
  ac: [{ task: 'AC tune-up before summer', intervalDays: 365, trade: 'hvac' }],
  water_heater: [{ task: 'Flush water heater / check anode', intervalDays: 365, trade: 'plumbing' }],
  roof: [{ task: 'Roof inspection', intervalDays: 365, trade: 'roofing' }],
  gutters: [{ task: 'Clean gutters', intervalDays: 180, trade: 'general' }],
  dishwasher: [{ task: 'Clean filter & run cleaner cycle', intervalDays: 180, trade: 'appliance' }],
  refrigerator: [{ task: 'Vacuum condenser coils; replace water filter', intervalDays: 180, trade: 'appliance' }],
  washer: [{ task: 'Clean washer; inspect hoses', intervalDays: 180, trade: 'appliance' }],
  dryer: [{ task: 'Clean dryer vent (fire safety)', intervalDays: 365, trade: 'appliance' }],
  sump_pump: [{ task: 'Test sump pump before spring rains', intervalDays: 365, trade: 'plumbing' }],
  smoke_detector: [{ task: 'Test detectors & replace batteries', intervalDays: 180, trade: 'general' }],
  garbage_disposal: [{ task: 'Clean & deodorize disposal', intervalDays: 180, trade: 'plumbing' }],
  generator: [{ task: 'Run/test generator; change oil', intervalDays: 365, trade: 'electrical' }],
  softener: [{ task: 'Refill water softener salt', intervalDays: 90, trade: 'plumbing' }],
};

/** Asset category → the contractor trade that services it (for find-a-pro). */
export const TRADE_FOR_CATEGORY: Record<string, string> = {
  hvac: 'hvac', furnace: 'hvac', ac: 'hvac', water_heater: 'plumbing', sump_pump: 'plumbing',
  garbage_disposal: 'plumbing', softener: 'plumbing', roof: 'roofing', gutters: 'general',
  dishwasher: 'appliance', refrigerator: 'appliance', washer: 'appliance', dryer: 'appliance',
  oven: 'appliance', range: 'appliance', microwave: 'appliance', generator: 'electrical',
  garage_door: 'general', deck: 'general', fence: 'general', smoke_detector: 'electrical',
};

export const ASSET_CATEGORIES: { value: string; label: string }[] = [
  { value: 'hvac', label: 'HVAC' }, { value: 'furnace', label: 'Furnace' }, { value: 'ac', label: 'Air Conditioner' },
  { value: 'water_heater', label: 'Water Heater' }, { value: 'roof', label: 'Roof' }, { value: 'gutters', label: 'Gutters' },
  { value: 'refrigerator', label: 'Refrigerator' }, { value: 'dishwasher', label: 'Dishwasher' }, { value: 'washer', label: 'Washer' },
  { value: 'dryer', label: 'Dryer' }, { value: 'oven', label: 'Oven/Range' }, { value: 'microwave', label: 'Microwave' },
  { value: 'garbage_disposal', label: 'Garbage Disposal' }, { value: 'sump_pump', label: 'Sump Pump' },
  { value: 'garage_door', label: 'Garage Door' }, { value: 'generator', label: 'Generator' },
  { value: 'softener', label: 'Water Softener' }, { value: 'smoke_detector', label: 'Smoke/CO Detector' },
  { value: 'deck', label: 'Deck' }, { value: 'fence', label: 'Fence' }, { value: 'other', label: 'Other' },
];

export const TRADES: { value: string; label: string }[] = [
  { value: 'hvac', label: 'HVAC' }, { value: 'plumbing', label: 'Plumbing' }, { value: 'electrical', label: 'Electrical' },
  { value: 'roofing', label: 'Roofing' }, { value: 'appliance', label: 'Appliance Repair' }, { value: 'general', label: 'General / Handyman' },
  { value: 'landscaping', label: 'Landscaping' }, { value: 'pest', label: 'Pest Control' },
];

export type Season = 'spring' | 'summer' | 'fall' | 'winter';

export function currentSeason(date = new Date()): Season {
  const m = date.getMonth(); // 0-11
  if (m <= 1 || m === 11) return 'winter';
  if (m <= 4) return 'spring';
  if (m <= 7) return 'summer';
  return 'fall';
}

/** Curated seasonal homeowner checklist — the "what should I do this season" list. */
export const SEASONAL_CHECKLIST: Record<Season, string[]> = {
  spring: [
    'Service the AC before peak summer', 'Clean gutters and check downspouts',
    'Inspect the roof for winter damage', 'Test the sump pump', 'Reseal deck/driveway cracks',
  ],
  summer: [
    'Replace HVAC filters', 'Clean refrigerator coils', 'Check exterior caulking and weatherstripping',
    'Inspect and clean the dryer vent', 'Power-wash siding and walkways',
  ],
  fall: [
    'Service the furnace before winter', 'Clean gutters after leaf fall', 'Flush the water heater',
    'Winterize outdoor faucets and irrigation', 'Test smoke & CO detectors',
  ],
  winter: [
    'Replace HVAC filters', 'Reverse ceiling fans', 'Check for ice dams and roof snow load',
    'Inspect attic insulation', 'Keep faucets dripping in deep freezes',
  ],
};

/** Sum of asset purchase prices — a simple home-inventory value for insurance. */
export function inventoryValue(assets: { purchase_price?: number | null }[]): number {
  return assets.reduce((sum, a) => sum + (Number(a.purchase_price) || 0), 0);
}
