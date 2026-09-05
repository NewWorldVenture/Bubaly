// lib/closet/outfits.ts — pure, deterministic closet + outfit engine.
//
// The AI-first differentiator for the Closet is that it KNOWS what each family
// member owns and picks a wearable outfit for today from THEIR items — by
// warmth for the temperature, formality for the occasion, the season tags,
// and a laundry-aware rotation — with a reason for every pick. Nothing is
// invented: every suggestion is a real item in the closet.

import type { OutfitOccasion, WardrobeCategory, WardrobeStatus } from '@/lib/database.types';

export type Slot = 'top' | 'bottom' | 'onepiece' | 'outerwear' | 'shoes' | 'accessory';
export type Season = 'spring' | 'summer' | 'fall' | 'winter';

export const WARDROBE_CATEGORIES: { value: WardrobeCategory; label: string; emoji: string; slot: Slot }[] = [
  { value: 'top', label: 'Top', emoji: '👕', slot: 'top' },
  { value: 'bottom', label: 'Bottom', emoji: '👖', slot: 'bottom' },
  { value: 'dress', label: 'Dress / one-piece', emoji: '👗', slot: 'onepiece' },
  { value: 'outerwear', label: 'Outerwear', emoji: '🧥', slot: 'outerwear' },
  { value: 'shoes', label: 'Shoes', emoji: '👟', slot: 'shoes' },
  { value: 'accessory', label: 'Accessory', emoji: '🧢', slot: 'accessory' },
  { value: 'uniform', label: 'Uniform', emoji: '🎽', slot: 'onepiece' },
  { value: 'sleepwear', label: 'Sleepwear', emoji: '🌙', slot: 'onepiece' },
  { value: 'activewear', label: 'Activewear', emoji: '🏃', slot: 'top' },
  { value: 'swim', label: 'Swim', emoji: '🩱', slot: 'onepiece' },
];

export const WARDROBE_STATUSES: { value: WardrobeStatus; label: string; emoji: string }[] = [
  { value: 'active', label: 'In closet', emoji: '✅' },
  { value: 'laundry', label: 'In the laundry', emoji: '🧺' },
  { value: 'storage', label: 'In storage', emoji: '📦' },
  { value: 'outgrown', label: 'Outgrown', emoji: '📏' },
  { value: 'donated', label: 'Donated', emoji: '💝' },
  { value: 'lost', label: 'Lost', emoji: '❓' },
];

export const SEASONS: { value: Season; label: string; emoji: string }[] = [
  { value: 'spring', label: 'Spring', emoji: '🌱' },
  { value: 'summer', label: 'Summer', emoji: '☀️' },
  { value: 'fall', label: 'Fall', emoji: '🍂' },
  { value: 'winter', label: 'Winter', emoji: '❄️' },
];

/** Formality target per occasion (1 = lounge, 5 = black tie). */
export const OCCASIONS: { value: OutfitOccasion; label: string; emoji: string; formality: number }[] = [
  { value: 'everyday', label: 'Everyday', emoji: '🙂', formality: 2 },
  { value: 'school', label: 'School', emoji: '🎒', formality: 2 },
  { value: 'work', label: 'Work', emoji: '💼', formality: 4 },
  { value: 'sport', label: 'Sport / active', emoji: '⚽', formality: 1 },
  { value: 'dressy', label: 'Dressy', emoji: '✨', formality: 5 },
  { value: 'party', label: 'Party', emoji: '🎉', formality: 4 },
  { value: 'outdoor', label: 'Outdoor', emoji: '🥾', formality: 1 },
  { value: 'sleep', label: 'Sleep', emoji: '😴', formality: 1 },
];

export const categoryMeta = (c: WardrobeCategory) => WARDROBE_CATEGORIES.find((x) => x.value === c) ?? WARDROBE_CATEGORIES[0];
export const statusMeta = (s: WardrobeStatus) => WARDROBE_STATUSES.find((x) => x.value === s) ?? WARDROBE_STATUSES[0];
export const occasionMeta = (o: OutfitOccasion) => OCCASIONS.find((x) => x.value === o) ?? OCCASIONS[0];

export type WardrobeItemLike = {
  id: string;
  member_id: string;
  name: string;
  category: WardrobeCategory;
  warmth: number;
  formality: number;
  seasons: string[];
  status: WardrobeStatus;
  last_worn_on: string | null;
  wear_count: number;
  price_cents: number | null;
  color?: string | null;
};

export type OutfitLogLike = { member_id: string; worn_on: string; item_ids: string[] };

const DAY_MS = 86_400_000;

function dateOnly(v: string | Date): Date {
  if (typeof v === 'string') return new Date(`${v.slice(0, 10)}T00:00:00`);
  return new Date(v.getFullYear(), v.getMonth(), v.getDate());
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function dayDiff(from: string | Date, to: string | Date): number {
  return Math.round((dateOnly(to).getTime() - dateOnly(from).getTime()) / DAY_MS);
}

/** Meteorological season for a date (northern hemisphere). */
export function seasonFor(date: Date): Season {
  const m = date.getMonth();
  if (m >= 2 && m <= 4) return 'spring';
  if (m >= 5 && m <= 7) return 'summer';
  if (m >= 8 && m <= 10) return 'fall';
  return 'winter';
}

/** Target warmth (1 light … 5 heavy) for an outdoor temperature in °C. */
export function warmthForTemp(tempC: number): number {
  if (tempC >= 27) return 1;
  if (tempC >= 21) return 2;
  if (tempC >= 14) return 3;
  if (tempC >= 6) return 4;
  return 5;
}

/** Temperature band an outfit is comfortable in, for saving suggestions. */
export function tempBand(tempC: number): { min: number; max: number } {
  return { min: Math.round(tempC - 4), max: Math.round(tempC + 4) };
}

export type ScoreContext = { targetWarmth: number; targetFormality: number; season: Season; today: Date };

/** Score a single active item for the context (higher is better) with reasons. */
export function scoreItem(item: WardrobeItemLike, ctx: ScoreContext): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 100;
  const slot = categoryMeta(item.category).slot;

  const warmthGap = Math.abs(item.warmth - ctx.targetWarmth);
  const warmthPenalty = slot === 'outerwear' ? 10 : slot === 'accessory' || slot === 'shoes' ? 6 : 18;
  score -= warmthGap * warmthPenalty;
  if (warmthGap === 0) reasons.push('right warmth for today');
  else if (warmthGap >= 2) reasons.push(item.warmth > ctx.targetWarmth ? 'too warm' : 'too light');

  const formalityGap = Math.abs(item.formality - ctx.targetFormality);
  score -= formalityGap * 12;
  if (formalityGap === 0) reasons.push('matches the occasion');
  else if (formalityGap >= 2) reasons.push(item.formality > ctx.targetFormality ? 'a bit dressy' : 'a bit casual');

  if (item.seasons.length === 0 || item.seasons.includes(ctx.season)) {
    score += 10;
    if (item.seasons.includes(ctx.season)) reasons.push(`a ${ctx.season} piece`);
  } else {
    score -= 25;
    reasons.push('out of season');
  }

  if (!item.last_worn_on) {
    score += 8;
    reasons.push('not worn yet');
  } else {
    const since = dayDiff(item.last_worn_on, ctx.today);
    if (since < 2) { score -= 30; reasons.push('worn in the last two days'); }
    else if (since < 7) { score -= 10; }
    else { score += 5; reasons.push(`last worn ${since} days ago`); }
  }
  return { score, reasons };
}

export type OutfitPick<T extends WardrobeItemLike = WardrobeItemLike> = { item: T; slot: Slot; score: number; reasons: string[] };
export type OutfitSuggestion<T extends WardrobeItemLike = WardrobeItemLike> = {
  picks: OutfitPick<T>[];
  missing: Slot[];
  targetWarmth: number;
  targetFormality: number;
  season: Season;
  summary: string;
};

function best<T extends WardrobeItemLike>(cands: T[], ctx: ScoreContext, slot: Slot): OutfitPick<T> | null {
  let top: OutfitPick<T> | null = null;
  for (const item of cands) {
    if (categoryMeta(item.category).slot !== slot) continue;
    const { score, reasons } = scoreItem(item, ctx);
    if (!top || score > top.score) top = { item, slot, score, reasons };
  }
  return top;
}

/**
 * Build today's outfit for a member from what they actually own. Chooses a
 * one-piece (dress / uniform / sleepwear / swim) or a top + bottom, adds
 * outerwear when it's cool, shoes always, and an accessory when a good one
 * exists. Reports the slots it could not fill so the UI can say what to buy.
 */
export function suggestOutfit<T extends WardrobeItemLike>(
  items: T[],
  input: { memberId: string; tempC: number; occasion: OutfitOccasion; date?: Date },
): OutfitSuggestion<T> {
  const today = input.date ?? new Date();
  const ctx: ScoreContext = {
    targetWarmth: warmthForTemp(input.tempC),
    targetFormality: occasionMeta(input.occasion).formality,
    season: seasonFor(today),
    today,
  };
  const wardrobe = items.filter((i) => i.member_id === input.memberId && i.status === 'active');
  const occasionCategory = (i: T) => {
    if (input.occasion === 'sleep') return i.category === 'sleepwear';
    if (input.occasion === 'sport') return i.category !== 'sleepwear' && i.category !== 'swim' && i.category !== 'dress';
    return i.category !== 'sleepwear' && i.category !== 'swim';
  };
  const cands = wardrobe.filter(occasionCategory);

  const picks: OutfitPick<T>[] = [];
  const missing: Slot[] = [];

  const onePiece = best(cands, ctx, 'onepiece');
  const top = best(cands, ctx, 'top');
  const bottom = best(cands, ctx, 'bottom');
  const separatesScore = top && bottom ? (top.score + bottom.score) / 2 : null;
  const preferOnePiece = onePiece && (separatesScore === null || onePiece.score + (input.occasion === 'dressy' ? 10 : 0) >= separatesScore);

  if (preferOnePiece && onePiece) picks.push(onePiece);
  else if (top && bottom) picks.push(top, bottom);
  else if (top || bottom) { picks.push((top ?? bottom)!); missing.push(top ? 'bottom' : 'top'); }
  else if (onePiece) picks.push(onePiece);
  else missing.push('top', 'bottom');

  if (ctx.targetWarmth >= 3 && input.occasion !== 'sleep') {
    const outer = best(cands, ctx, 'outerwear');
    if (outer) picks.push(outer); else missing.push('outerwear');
  }
  if (input.occasion !== 'sleep') {
    const shoes = best(cands, ctx, 'shoes');
    if (shoes) picks.push(shoes); else missing.push('shoes');
    // Accessories are optional: only add one that suits the weather (a beanie
    // in mild weather is a miss) and scores like a confident pick.
    const accessory = best(cands, ctx, 'accessory');
    if (accessory && accessory.score >= 95 && Math.abs(accessory.item.warmth - ctx.targetWarmth) <= 1) picks.push(accessory);
  }

  const names = picks.map((p) => p.item.name);
  const summary = names.length
    ? `${names.join(' + ')}${missing.length ? ` — nothing suitable for: ${missing.join(', ')}` : ''}`
    : 'Nothing in the closet fits today yet — add a few items to get suggestions.';
  return { picks, missing, targetWarmth: ctx.targetWarmth, targetFormality: ctx.targetFormality, season: ctx.season, summary };
}

/** Active items not worn in `days` (never worn counts once they are older than `days`). */
export function neglectedItems(items: WardrobeItemLike[], today: Date, days = 120): WardrobeItemLike[] {
  return items.filter((i) => {
    if (i.status !== 'active') return false;
    if (i.last_worn_on) return dayDiff(i.last_worn_on, today) >= days;
    return i.wear_count === 0;
  });
}

export function costPerWear(item: Pick<WardrobeItemLike, 'price_cents' | 'wear_count'>): number | null {
  if (item.price_cents === null || item.price_cents === undefined) return null;
  return Math.round(item.price_cents / Math.max(1, item.wear_count));
}

export type ClosetSummary = {
  active: number;
  laundry: number;
  retire: number;
  wornThisWeek: number;
  mostWorn: { name: string; count: number }[];
  avgCostPerWearCents: number | null;
  text: string;
};

export function closetSummary(items: WardrobeItemLike[], logs: OutfitLogLike[], today: Date): ClosetSummary {
  const active = items.filter((i) => i.status === 'active').length;
  const laundry = items.filter((i) => i.status === 'laundry').length;
  const retire = items.filter((i) => i.status === 'outgrown').length;
  const wornThisWeek = logs.filter((l) => { const d = dayDiff(l.worn_on, today); return d >= 0 && d < 7; }).length;
  const mostWorn = [...items]
    .filter((i) => i.wear_count > 0)
    .sort((a, b) => b.wear_count - a.wear_count)
    .slice(0, 3)
    .map((i) => ({ name: i.name, count: i.wear_count }));
  const priced = items.map(costPerWear).filter((v): v is number => v !== null);
  const avgCostPerWearCents = priced.length ? Math.round(priced.reduce((a, b) => a + b, 0) / priced.length) : null;
  const text = active === 0
    ? 'Closet is empty'
    : laundry > 0 || retire > 0
      ? `${active} ready · ${laundry} in laundry${retire ? ` · ${retire} outgrown` : ''}`
      : `${active} items ready to wear`;
  return { active, laundry, retire, wornThisWeek, mostWorn, avgCostPerWearCents, text };
}

/** Weather code → short label (mirrors the Weather module's buckets). */
export function weatherLabelFromTemp(tempC: number): string {
  if (tempC >= 27) return 'hot';
  if (tempC >= 21) return 'warm';
  if (tempC >= 14) return 'mild';
  if (tempC >= 6) return 'cool';
  return 'cold';
}
